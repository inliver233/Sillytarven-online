import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';

import { getConfigValue } from './util.js';
import {
    CLIENT_PERFORMANCE_COUNTERS,
    CLIENT_PERFORMANCE_OPERATIONS,
    MAX_CLIENT_PERFORMANCE_BATCH,
    MAX_CLIENT_PERFORMANCE_COUNTER_BYTES,
    MAX_CLIENT_PERFORMANCE_COUNTER_NAME_LENGTH,
    MAX_CLIENT_PERFORMANCE_COUNTERS,
} from '../public/scripts/performance-contract.js';

const REQUEST_STARTED_AT = Symbol('performanceRequestStartedAt');
const REQUEST_TIMER = Symbol('performanceRequestTimer');
const METRIC_NAME = /^[a-z][a-z0-9_-]{0,47}$/;
const CACHE_STATES = new Set(['hit', 'miss', 'stale', 'bypass', 'disabled']);
const DEFAULT_SERVER_OPERATIONS = [
    'settings-get',
    'characters-all',
    'chats-recent',
    'chat-get-range',
    'chat-save-tail',
    'group-chat-get-range',
    'group-chat-save-tail',
    'version',
];
const DEFAULT_CLIENT_OPERATIONS = CLIENT_PERFORMANCE_OPERATIONS;

function toFiniteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clampNumber(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, toFiniteNumber(value, minimum)));
}

function percentile(sortedValues, percentileValue) {
    if (!sortedValues.length) {
        return 0;
    }

    const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(percentileValue * sortedValues.length) - 1));
    return sortedValues[index];
}

function summarizeValues(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) {
        return { count: 0, average: 0, p50: 0, p95: 0, max: 0 };
    }

    const total = sorted.reduce((sum, value) => sum + value, 0);
    return {
        count: sorted.length,
        average: Number((total / sorted.length).toFixed(3)),
        p50: Number(percentile(sorted, 0.5).toFixed(3)),
        p95: Number(percentile(sorted, 0.95).toFixed(3)),
        max: Number(sorted[sorted.length - 1].toFixed(3)),
    };
}

function sanitizeNumberRecord(record, maximum = Number.MAX_SAFE_INTEGER) {
    const sanitized = {};
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return sanitized;
    }

    for (const [name, rawValue] of Object.entries(record)) {
        if (!METRIC_NAME.test(name)) {
            continue;
        }
        const value = Number(rawValue);
        if (!Number.isFinite(value) || value < 0) {
            continue;
        }
        sanitized[name] = Math.min(maximum, value);
    }

    return sanitized;
}

function sanitizeClientCounters(operation, counters, contract) {
    const rawCounters = counters ?? {};
    if (!rawCounters || typeof rawCounters !== 'object' || Array.isArray(rawCounters)) {
        return null;
    }
    let serialized;
    try {
        serialized = JSON.stringify(rawCounters);
    } catch {
        return null;
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_CLIENT_PERFORMANCE_COUNTER_BYTES) {
        return null;
    }

    const entries = Object.entries(rawCounters);
    if (entries.length > MAX_CLIENT_PERFORMANCE_COUNTERS) {
        return null;
    }
    const allowedNames = contract.get(operation) ?? new Set();
    const sanitized = {};
    for (const [name, value] of entries) {
        if (name.length > MAX_CLIENT_PERFORMANCE_COUNTER_NAME_LENGTH
            || !METRIC_NAME.test(name)
            || !allowedNames.has(name)
            || typeof value !== 'number'
            || !Number.isFinite(value)
            || value < 0) {
            return null;
        }
        sanitized[name] = Math.min(Number.MAX_SAFE_INTEGER, value);
    }
    return sanitized;
}

function aggregateSamples(operation, samples) {
    const duration = summarizeValues(samples.map(sample => sample.durationMs));
    const requestBytes = summarizeValues(samples.map(sample => sample.requestBytes));
    const responseBytes = summarizeValues(samples.map(sample => sample.responseBytes));
    const phases = {};
    const counterTotals = {};
    const cacheStates = {};

    for (const sample of samples) {
        for (const [name, value] of Object.entries(sample.phases)) {
            phases[name] ??= [];
            phases[name].push(value);
        }
        for (const [name, value] of Object.entries(sample.counters)) {
            counterTotals[name] = (counterTotals[name] ?? 0) + value;
        }
        if (sample.cacheState) {
            cacheStates[sample.cacheState] = (cacheStates[sample.cacheState] ?? 0) + 1;
        }
    }

    return {
        operation,
        source: samples[0]?.source ?? 'server',
        count: samples.length,
        errors: samples.filter(sample => sample.statusCode >= 400).length,
        lastRecordedAt: samples.at(-1)?.recordedAt ?? null,
        duration,
        requestBytes,
        responseBytes,
        phases: Object.fromEntries(Object.entries(phases).map(([name, values]) => [name, summarizeValues(values)])),
        counters: counterTotals,
        cacheStates,
    };
}

/**
 * Bounded, content-free performance sample collector.
 */
export class PerformanceMonitor {
    /**
     * @param {object} [options] Monitor options
     * @param {boolean} [options.enabled] Whether samples are recorded
     * @param {number} [options.capacity] Maximum samples retained per operation
     * @param {number} [options.capacityBytes] Maximum serialized bytes retained per operation
     * @param {number} [options.clientSamplesPerMinute] Per-user client sample limit
     * @param {string[]} [options.serverOperations] Allowed server operation names
     * @param {string[]} [options.clientOperations] Allowed client operation names
     * @param {Record<string, string[]>} [options.clientCounterNames] Allowed counters per client operation
     */
    constructor({
        enabled = true,
        capacity = 200,
        capacityBytes = 256 * 1024,
        clientSamplesPerMinute = 120,
        serverOperations = DEFAULT_SERVER_OPERATIONS,
        clientOperations = DEFAULT_CLIENT_OPERATIONS,
        clientCounterNames = CLIENT_PERFORMANCE_COUNTERS,
    } = {}) {
        this.enabled = Boolean(enabled);
        this.capacity = Math.floor(clampNumber(capacity, 10, 2000));
        this.capacityBytes = Math.floor(clampNumber(capacityBytes, 256, 4 * 1024 * 1024));
        this.clientSamplesPerMinute = Math.floor(clampNumber(clientSamplesPerMinute, 10, 2000));
        this.serverOperations = new Set(serverOperations.filter(name => METRIC_NAME.test(name)));
        this.clientOperations = new Set(clientOperations.filter(name => METRIC_NAME.test(name)));
        this.clientCounterNames = new Map(Object.entries(clientCounterNames).map(([operation, names]) => [
            operation,
            new Set(Array.isArray(names) ? names.filter(name => METRIC_NAME.test(name)) : []),
        ]));
        this.samples = new Map();
        this.sampleBytes = new Map();
        this.clientRateLimits = new Map();
        this.startedAt = Date.now();
    }

    /**
     * Record a sanitized server sample.
     * @param {string} operation Operation name
     * @param {object} sample Raw sample
     * @returns {boolean} Whether the sample was accepted
     */
    recordServerSample(operation, sample) {
        if (!this.enabled || !this.serverOperations.has(operation)) {
            return false;
        }

        return this.#record(operation, {
            source: 'server',
            durationMs: clampNumber(sample?.durationMs, 0, 10 * 60 * 1000),
            statusCode: Math.floor(clampNumber(sample?.statusCode, 0, 599)),
            requestBytes: Math.floor(clampNumber(sample?.requestBytes, 0, Number.MAX_SAFE_INTEGER)),
            responseBytes: Math.floor(clampNumber(sample?.responseBytes, 0, Number.MAX_SAFE_INTEGER)),
            phases: sanitizeNumberRecord(sample?.phases, 10 * 60 * 1000),
            counters: sanitizeNumberRecord(sample?.counters),
            cacheState: CACHE_STATES.has(sample?.cacheState) ? sample.cacheState : null,
        });
    }

    /**
     * Accept a bounded batch of browser timings without retaining user identity.
     * @param {string} rateLimitKey Trusted server-side user key used only for rate limiting
     * @param {unknown} rawSamples Client-provided samples
     * @returns {{accepted: number, rejected: number, rateLimited: boolean}}
     */
    recordClientBatch(rateLimitKey, rawSamples) {
        const rawCount = Array.isArray(rawSamples) ? rawSamples.length : 0;
        const samples = Array.isArray(rawSamples) ? rawSamples.slice(0, MAX_CLIENT_PERFORMANCE_BATCH) : [];
        if (!this.enabled) {
            return { accepted: 0, rejected: rawCount, rateLimited: false };
        }

        const now = Date.now();
        const key = String(rateLimitKey || 'anonymous');
        const currentWindow = this.clientRateLimits.get(key);
        const rate = !currentWindow || now - currentWindow.startedAt >= 60_000
            ? { startedAt: now, count: 0 }
            : currentWindow;
        const available = Math.max(0, this.clientSamplesPerMinute - rate.count);
        const acceptedSamples = samples.slice(0, available);
        rate.count += acceptedSamples.length;
        this.clientRateLimits.set(key, rate);
        this.#pruneRateLimits(now);

        let accepted = 0;
        for (const sample of acceptedSamples) {
            const operation = typeof sample?.operation === 'string' ? sample.operation : '';
            const durationMs = Number(sample?.durationMs);
            if (!this.clientOperations.has(operation) || !Number.isFinite(durationMs) || durationMs < 0) {
                continue;
            }
            const counters = sanitizeClientCounters(operation, sample?.counters, this.clientCounterNames);
            if (counters === null) {
                continue;
            }
            const didRecord = this.#record(operation, {
                source: 'client',
                durationMs: clampNumber(durationMs, 0, 10 * 60 * 1000),
                statusCode: 0,
                requestBytes: 0,
                responseBytes: 0,
                phases: {},
                counters,
                cacheState: null,
            });
            accepted += Number(didRecord);
        }

        return {
            accepted,
            rejected: rawCount - accepted,
            rateLimited: rawCount > available,
        };
    }

    /**
     * Return aggregate-only statistics suitable for the admin panel.
     * @returns {{enabled: boolean, capacity: number, startedAt: number, generatedAt: number, operations: object[]}}
     */
    getSummary() {
        const operations = [...this.samples.entries()]
            .map(([operation, samples]) => aggregateSamples(operation, samples))
            .sort((left, right) => left.operation.localeCompare(right.operation));
        return {
            enabled: this.enabled,
            capacity: this.capacity,
            capacityBytes: this.capacityBytes,
            startedAt: this.startedAt,
            generatedAt: Date.now(),
            operations,
        };
    }

    /** Clear retained samples and rate-limit windows. */
    clear() {
        this.samples.clear();
        this.sampleBytes.clear();
        this.clientRateLimits.clear();
        this.startedAt = Date.now();
    }

    #record(operation, sample) {
        const bucket = this.samples.get(operation) ?? [];
        const recorded = { ...sample, recordedAt: Date.now() };
        const recordedBytes = Buffer.byteLength(JSON.stringify(recorded), 'utf8');
        if (recordedBytes > this.capacityBytes) {
            return false;
        }
        let bucketBytes = this.sampleBytes.get(operation) ?? 0;
        bucket.push(recorded);
        bucketBytes += recordedBytes;
        while (bucket.length > this.capacity || bucketBytes > this.capacityBytes) {
            const removed = bucket.shift();
            bucketBytes -= Buffer.byteLength(JSON.stringify(removed), 'utf8');
        }
        this.samples.set(operation, bucket);
        this.sampleBytes.set(operation, bucketBytes);
        return true;
    }

    #pruneRateLimits(now) {
        if (this.clientRateLimits.size <= 1000) {
            return;
        }
        for (const [key, value] of this.clientRateLimits) {
            if (now - value.startedAt >= 60_000 || this.clientRateLimits.size > 1000) {
                this.clientRateLimits.delete(key);
            }
            if (this.clientRateLimits.size <= 1000) {
                break;
            }
        }
    }
}

class EndpointPerformanceTimer {
    constructor(request, operation, monitor) {
        this.request = request;
        this.operation = operation;
        this.monitor = monitor;
        this.phases = {};
        this.counters = {};
        this.cacheState = null;
        this.activeStops = new Set();
        this.finished = false;
        const requestStartedAt = Number(request?.[REQUEST_STARTED_AT]);
        if (Number.isFinite(requestStartedAt)) {
            this.addDuration('queue', Math.max(0, performance.now() - requestStartedAt));
        }
    }

    addDuration(name, durationMs) {
        if (METRIC_NAME.test(name) && Number.isFinite(Number(durationMs)) && Number(durationMs) >= 0) {
            this.phases[name] = (this.phases[name] ?? 0) + Number(durationMs);
        }
    }

    startPhase(name) {
        if (!METRIC_NAME.test(name)) {
            return () => {};
        }
        const startedAt = performance.now();
        let stopped = false;
        const stop = () => {
            if (stopped) {
                return;
            }
            stopped = true;
            this.activeStops.delete(stop);
            this.addDuration(name, performance.now() - startedAt);
        };
        this.activeStops.add(stop);
        return stop;
    }

    measureSync(name, callback) {
        const stop = this.startPhase(name);
        try {
            return callback();
        } finally {
            stop();
        }
    }

    async measureAsync(name, callback) {
        const stop = this.startPhase(name);
        try {
            return await callback();
        } finally {
            stop();
        }
    }

    setCounter(name, value) {
        if (METRIC_NAME.test(name) && Number.isFinite(Number(value)) && Number(value) >= 0) {
            this.counters[name] = Number(value);
        }
    }

    increment(name, amount = 1) {
        this.setCounter(name, (this.counters[name] ?? 0) + Number(amount));
    }

    setCacheState(state) {
        this.cacheState = CACHE_STATES.has(state) ? state : null;
    }

    finish(totalMs, response) {
        if (this.finished) {
            return;
        }
        this.finished = true;
        for (const stop of [...this.activeStops]) {
            stop();
        }

        const requestBytes = Number(this.request?.get?.('content-length') ?? this.request?.headers?.['content-length'] ?? 0);
        const responseBytes = Number(response?.getHeader?.('content-length') ?? 0);
        this.monitor.recordServerSample(this.operation, {
            durationMs: totalMs,
            statusCode: response?.statusCode ?? 0,
            requestBytes,
            responseBytes,
            phases: this.phases,
            counters: this.counters,
            cacheState: this.cacheState,
        });

        if (!this.monitor.enabled || response?.headersSent) {
            return;
        }

        const timings = [`app;dur=${toFiniteNumber(totalMs).toFixed(1)}`];
        for (const [name, duration] of Object.entries(this.phases).slice(0, 8)) {
            timings.push(`${name};dur=${duration.toFixed(1)}`);
        }
        if (this.cacheState) {
            timings.push(`cache;desc="${this.cacheState}"`);
        }
        const existing = response.getHeader?.('Server-Timing');
        const value = [...(existing ? [String(existing)] : []), ...timings].join(', ');
        response.setHeader?.('Server-Timing', value.slice(0, 1024));
    }
}

const enabled = getConfigValue('performance.telemetry.enabled', true, 'boolean');
const capacity = getConfigValue('performance.telemetry.samplesPerOperation', 200, 'number');
const capacityBytes = getConfigValue('performance.telemetry.bytesPerOperation', 256 * 1024, 'number');
const clientSamplesPerMinute = getConfigValue('performance.telemetry.clientSamplesPerMinute', 120, 'number');

export const performanceMonitor = new PerformanceMonitor({ enabled, capacity, capacityBytes, clientSamplesPerMinute });

/**
 * Capture a request start time before body parsing and authentication work.
 */
export function performanceRequestStartMiddleware(request, _response, next) {
    request[REQUEST_STARTED_AT] = performance.now();
    next();
}

/**
 * Attach an operation timer to the current request.
 * @param {import('express').Request} request Express request
 * @param {string} operation Whitelisted operation name
 * @returns {EndpointPerformanceTimer} Timer
 */
export function beginEndpointPerformance(request, operation) {
    const timer = new EndpointPerformanceTimer(request, operation, performanceMonitor);
    request[REQUEST_TIMER] = timer;
    return timer;
}

/**
 * response-time callback that preserves its legacy header and finalizes endpoint telemetry.
 */
export function finalizeRequestPerformance(request, response, totalMs) {
    if (!response.getHeader('X-Response-Time')) {
        response.setHeader('X-Response-Time', `${Number(totalMs).toFixed(3)}ms`);
    }
    request[REQUEST_TIMER]?.finish(totalMs, response);
}
