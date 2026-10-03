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
/** Startup slices measured before the server said whether telemetry is on. */
const bufferedStartupSteps = [];
let lastStartupLapAt = null;
let startupLapsFinished = false;

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
    let failed = false;
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
        failed = true;
        pendingSamples.unshift(...samples);
        if (pendingSamples.length > MAX_PENDING_SAMPLES) {
            pendingSamples.length = MAX_PENDING_SAMPLES;
        }
    }

    if (pendingSamples.length) {
        // The rest of a batch follows shortly (a page load produces a few dozen
        // samples); only a failed upload waits longer before retrying.
        scheduleFlush(failed ? 10_000 : 1000);
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
        bufferedStartupSteps.length = 0;
        startupLapsFinished = true;
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
    for (const [operation, duration, counters] of bufferedStartupSteps.splice(0)) {
        recordPerformanceSample(operation, duration, counters);
    }

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
 * Ends one slice of the first page load: records the time since the previous
 * slice (the first one counts from navigation start). One clock read and an
 * array push, so it is safe on the startup path; samples go out with the
 * normal batched upload. Only the first page load is measured.
 * @param {string} step One of STARTUP_STEPS
 * @param {Record<string, number>} [counters] Numeric counters allowed for the step
 */
export function startupLap(step, counters = {}) {
    if (startupLapsFinished) {
        return;
    }
    const now = performance.now();
    const duration = now - (lastStartupLapAt ?? 0);
    lastStartupLapAt = now;
    const operation = `startup-step-${step}`;
    if (telemetryEnabled) {
        recordPerformanceSample(operation, duration, counters);
    } else if (!initialized && bufferedStartupSteps.length < 40) {
        bufferedStartupSteps.push([operation, duration, counters]);
    }
}

/**
 * Ends the last slice of the first page load; later laps are ignored.
 * @param {string} step One of STARTUP_STEPS
 */
export function finishStartupLaps(step) {
    startupLap(step);
    startupLapsFinished = true;
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
        // Long tasks are plentiful on slow devices; drop those before the one-off startup timings.
        const longTask = pendingSamples.findIndex(sample => sample.operation === 'ui-long-task');
        pendingSamples.splice(longTask >= 0 ? longTask : 0, 1);
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
