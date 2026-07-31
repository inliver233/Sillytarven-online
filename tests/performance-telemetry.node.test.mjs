import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = {};

const {
    initializePerformanceTelemetry,
    recordPerformanceSample,
    recordStartupMilestone,
} = await import('../public/scripts/performance-telemetry.js');

test('browser telemetry records whitelisted startup marks and ignores invalid samples', () => {
    performance.clearMarks();
    performance.clearMeasures();
    initializePerformanceTelemetry(() => ({ 'content-type': 'application/json' }));

    assert.doesNotThrow(() => recordPerformanceSample('not-allowed', 5, { secret: 1 }));
    assert.doesNotThrow(() => recordPerformanceSample('ui-long-task', Number.NaN));
    assert.doesNotThrow(() => recordPerformanceSample('regex-chat-refresh', 12, { requests: 3, merged: 2 }));
    assert.doesNotThrow(() => recordPerformanceSample('prompt-token-dry-run', 25, { requests: 4, merged: 3 }));
    recordStartupMilestone('settings-ready');
    recordStartupMilestone('settings-ready');
    recordStartupMilestone('not-allowed');

    const measures = performance.getEntriesByName('startup-settings-ready', 'measure');
    assert.equal(measures.length, 1);
    assert.ok(measures[0].duration >= 0);
    assert.equal(performance.getEntriesByName('startup-not-allowed', 'measure').length, 0);
});
