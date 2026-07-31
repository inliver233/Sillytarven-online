import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = {};

const {
    flushPerformanceSamples,
    getPerformanceTelemetryStatus,
    initializePerformanceTelemetry,
    recordPerformanceSample,
    recordStartupMilestone,
} = await import('../public/scripts/performance-telemetry.js');

test('disabled browser telemetry installs nothing, queues nothing, and sends nothing', async () => {
    let observers = 0;
    let requests = 0;
    globalThis.PerformanceObserver = class {
        constructor() { observers += 1; }
        observe() {}
        disconnect() {}
    };
    globalThis.fetch = async () => {
        requests += 1;
        return { ok: true, status: 202, json: async () => ({ accepted: 1, rejected: 0, rateLimited: false }) };
    };

    initializePerformanceTelemetry(() => ({ 'content-type': 'application/json' }), false);
    recordPerformanceSample('ui-long-task', 5);
    await flushPerformanceSamples();
    assert.deepEqual(getPerformanceTelemetryStatus(), { enabled: false, initialized: false, pending: 0, observerInstalled: false });
    assert.equal(observers, 0);
    assert.equal(requests, 0);
});

test('browser telemetry records shared operations and consumes accepted/rejected responses', async () => {
    performance.clearMarks();
    performance.clearMeasures();
    const batches = [];
    globalThis.fetch = async (_url, options) => {
        const batch = JSON.parse(options.body);
        batches.push(batch);
        return {
            ok: true,
            status: 202,
            json: async () => ({ accepted: batch.samples.length - 1, rejected: 1, rateLimited: false }),
        };
    };
    initializePerformanceTelemetry(() => ({ 'content-type': 'application/json' }), true);

    assert.doesNotThrow(() => recordPerformanceSample('not-allowed', 5, { secret: 1 }));
    assert.doesNotThrow(() => recordPerformanceSample('ui-long-task', Number.NaN));
    assert.doesNotThrow(() => recordPerformanceSample('regex-chat-refresh', 12, { requests: 3, merged: 2 }));
    assert.doesNotThrow(() => recordPerformanceSample('prompt-token-dry-run', 25, { requests: 4, merged: 3 }));
    assert.doesNotThrow(() => recordPerformanceSample('settings-save-serialize', 1, { characters: 30_000, noop: 1 }));
    recordStartupMilestone('settings-ready');
    recordStartupMilestone('settings-ready');
    recordStartupMilestone('not-allowed');

    const measures = performance.getEntriesByName('startup-settings-ready', 'measure');
    assert.equal(measures.length, 1);
    assert.ok(measures[0].duration >= 0);
    assert.equal(performance.getEntriesByName('startup-not-allowed', 'measure').length, 0);
    await flushPerformanceSamples();
    assert.equal(batches.length, 1);
    assert.equal(getPerformanceTelemetryStatus().pending, 0);
});

test('browser telemetry drops permanent 4xx batches instead of retrying forever', async () => {
    initializePerformanceTelemetry(() => ({ 'content-type': 'application/json' }), false);
    let requests = 0;
    globalThis.fetch = async () => {
        requests += 1;
        return { ok: false, status: 400, json: async () => ({ error: 'invalid_telemetry' }) };
    };
    initializePerformanceTelemetry(() => ({ 'content-type': 'application/json' }), true);
    recordPerformanceSample('ui-long-task', 10);
    await flushPerformanceSamples();
    assert.equal(requests, 1);
    assert.equal(getPerformanceTelemetryStatus().pending, 0);
});
