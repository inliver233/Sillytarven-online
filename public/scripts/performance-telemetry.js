import {
    CLIENT_PERFORMANCE_COUNTERS,
    CLIENT_PERFORMANCE_OPERATIONS,
    MAX_CLIENT_PERFORMANCE_COUNTER_BYTES,
    MAX_CLIENT_PERFORMANCE_COUNTER_NAME_LENGTH,
    MAX_CLIENT_PERFORMANCE_COUNTERS,
} from './performance-contract.js';

const ALLOWED_OPERATIONS = new Set(CLIENT_PERFORMANCE_OPERATIONS);
const recordedMilestones = new Set();
const pendingSamples = [];
const MAX_PENDING_SAMPLES = 50;
let requestHeadersProvider = null;
let flushTimer = null;
let initialized = false;
let telemetryEnabled = false;
let performanceObserver = null;

function sanitizeCounters(operation, counters) {
    const result = {};
    if (!counters || typeof counters !== 'object' || Array.isArray(counters)) {
        return null;
    }
    const entries = Object.entries(counters);
    let serializedCounters;
    try {
        serializedCounters = JSON.stringify(counters);
    } catch {
        return null;
    }
    if (entries.length > MAX_CLIENT_PERFORMANCE_COUNTERS
        || serializedCounters.length > MAX_CLIENT_PERFORMANCE_COUNTER_BYTES) {
        return null;
    }
    const allowedCounters = new Set(CLIENT_PERFORMANCE_COUNTERS[operation] ?? []);
    for (const [name, rawValue] of entries) {
        const value = Number(rawValue);
        if (name.length > MAX_CLIENT_PERFORMANCE_COUNTER_NAME_LENGTH
            || !allowedCounters.has(name)
            || !/^[a-z][a-z0-9_-]{0,47}$/.test(name)
            || typeof rawValue !== 'number'
            || !Number.isFinite(value)
            || value < 0) {
            return null;
        }
        result[name] = Math.min(Number.MAX_SAFE_INTEGER, value);
    }
    return result;
}

function scheduleFlush(delay = 5000) {
    if (!telemetryEnabled || flushTimer || !pendingSamples.length) {
        return;
    }
    flushTimer = setTimeout(() => {
        flushTimer = null;
        const run = () => flushPerformanceSamples();
        if ('requestIdleCallback' in window) {
            window.requestIdleCallback(run, { timeout: 2000 });
        } else {
            run();
        }
    }, delay);
    flushTimer?.unref?.();
}

export async function flushPerformanceSamples() {
    if (!telemetryEnabled || !pendingSamples.length || typeof requestHeadersProvider !== 'function') {
        return;
    }

    const samples = pendingSamples.splice(0, 20);
    try {
        const response = await fetch('/api/performance/client', {
            method: 'POST',
            headers: requestHeadersProvider(),
            body: JSON.stringify({ samples }),
            cache: 'no-store',
        });
        if (!response.ok) {
            const permanentClientError = response.status >= 400
                && response.status < 500
                && ![408, 429].includes(response.status);
            if (permanentClientError) {
                return;
            }
            throw new Error(`Performance telemetry HTTP ${response.status}`);
        }
        let result;
        try {
            result = await response.json();
        } catch {
            return;
        }
        const accepted = Number(result?.accepted);
        const rejected = Number(result?.rejected);
        if (!Number.isInteger(accepted) || accepted < 0
            || !Number.isInteger(rejected) || rejected < 0
            || accepted + rejected !== samples.length) {
            return;
        }
    } catch {
        pendingSamples.unshift(...samples);
        if (pendingSamples.length > MAX_PENDING_SAMPLES) {
            pendingSamples.length = MAX_PENDING_SAMPLES;
        }
    }

    if (pendingSamples.length) {
        scheduleFlush(10_000);
    }
}

/**
 * Start bounded browser performance collection. No message, setting, role, or user content is collected.
 * @param {() => Record<string, string>} headersProvider Authenticated request header provider
 * @param {boolean} [enabled] Canonical server telemetry setting
 */
export function initializePerformanceTelemetry(headersProvider, enabled = true) {
    if (!enabled) {
        telemetryEnabled = false;
        initialized = false;
        requestHeadersProvider = null;
        pendingSamples.length = 0;
        recordedMilestones.clear();
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        performanceObserver?.disconnect?.();
        performanceObserver = null;
        return;
    }

    telemetryEnabled = true;
    requestHeadersProvider = headersProvider;
    if (initialized) {
        return;
    }
    initialized = true;

    if (!('PerformanceObserver' in window)) {
        return;
    }
    try {
        performanceObserver = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                recordPerformanceSample('ui-long-task', entry.duration);
            }
        });
        performanceObserver.observe({ type: 'longtask', buffered: true });
    } catch {
        // Long Task API is optional (notably absent in Safari).
        performanceObserver = null;
    }
}

/**
 * Record a one-time duration from navigation start to a named startup milestone.
 * @param {'first-ui'|'settings-ready'|'characters-ready'|'chat-input-ready'} milestone Milestone name
 */
export function recordStartupMilestone(milestone) {
    if (!telemetryEnabled) {
        return;
    }
    const operation = `startup-${milestone}`;
    if (!ALLOWED_OPERATIONS.has(operation) || recordedMilestones.has(operation)) {
        return;
    }
    recordedMilestones.add(operation);

    try {
        const markName = `st-${milestone}`;
        performance.mark(markName);
        performance.measure(operation, { start: 0, end: markName });
    } catch {
        // Performance marks are diagnostic only and must never block startup.
    }
    recordPerformanceSample(operation, performance.now());
}

/**
 * Queue a sanitized performance duration for the local administrator aggregate.
 * @param {string} operation Whitelisted operation
 * @param {number} durationMs Duration in milliseconds
 * @param {Record<string, number>} [counters] Numeric counters only
 */
export function recordPerformanceSample(operation, durationMs, counters = {}) {
    const duration = Number(durationMs);
    if (!telemetryEnabled || !ALLOWED_OPERATIONS.has(operation) || !Number.isFinite(duration) || duration < 0) {
        return;
    }
    const sanitizedCounters = sanitizeCounters(operation, counters);
    if (sanitizedCounters === null) {
        return;
    }
    pendingSamples.push({
        operation,
        durationMs: Math.min(10 * 60 * 1000, duration),
        counters: sanitizedCounters,
    });
    if (pendingSamples.length > MAX_PENDING_SAMPLES) {
        pendingSamples.splice(0, pendingSamples.length - MAX_PENDING_SAMPLES);
    }
    scheduleFlush();
}

export function getPerformanceTelemetryStatus() {
    return {
        enabled: telemetryEnabled,
        initialized,
        pending: pendingSamples.length,
        observerInstalled: Boolean(performanceObserver),
    };
}
