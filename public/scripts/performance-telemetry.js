const ALLOWED_OPERATIONS = new Set([
    'startup-first-ui',
    'startup-settings-ready',
    'startup-characters-ready',
    'startup-chat-input-ready',
    'ui-long-task',
    'chat-load-more-frame',
    'regex-chat-refresh',
    'prompt-token-dry-run',
    'settings-save-serialize',
]);
const recordedMilestones = new Set();
const pendingSamples = [];
const MAX_PENDING_SAMPLES = 50;
let requestHeadersProvider = null;
let flushTimer = null;
let initialized = false;

function sanitizeCounters(counters) {
    const result = {};
    if (!counters || typeof counters !== 'object' || Array.isArray(counters)) {
        return result;
    }
    for (const [name, rawValue] of Object.entries(counters)) {
        const value = Number(rawValue);
        if (/^[a-z][a-z0-9_-]{0,47}$/.test(name) && Number.isFinite(value) && value >= 0) {
            result[name] = Math.min(Number.MAX_SAFE_INTEGER, value);
        }
    }
    return result;
}

function scheduleFlush(delay = 5000) {
    if (flushTimer || !pendingSamples.length) {
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

async function flushPerformanceSamples() {
    if (!pendingSamples.length || typeof requestHeadersProvider !== 'function') {
        scheduleFlush(5000);
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
            throw new Error(`Performance telemetry HTTP ${response.status}`);
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
 */
export function initializePerformanceTelemetry(headersProvider) {
    requestHeadersProvider = headersProvider;
    if (initialized) {
        return;
    }
    initialized = true;

    if (!('PerformanceObserver' in window)) {
        return;
    }
    try {
        const observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                recordPerformanceSample('ui-long-task', entry.duration);
            }
        });
        observer.observe({ type: 'longtask', buffered: true });
    } catch {
        // Long Task API is optional (notably absent in Safari).
    }
}

/**
 * Record a one-time duration from navigation start to a named startup milestone.
 * @param {'first-ui'|'settings-ready'|'characters-ready'|'chat-input-ready'} milestone Milestone name
 */
export function recordStartupMilestone(milestone) {
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
    if (!ALLOWED_OPERATIONS.has(operation) || !Number.isFinite(duration) || duration < 0) {
        return;
    }
    pendingSamples.push({
        operation,
        durationMs: Math.min(10 * 60 * 1000, duration),
        counters: sanitizeCounters(counters),
    });
    if (pendingSamples.length > MAX_PENDING_SAMPLES) {
        pendingSamples.splice(0, pendingSamples.length - MAX_PENDING_SAMPLES);
    }
    scheduleFlush();
}
