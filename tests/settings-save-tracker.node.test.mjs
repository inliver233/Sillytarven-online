import assert from 'node:assert/strict';
import test from 'node:test';

import {
    requireSettingsSaveSuccess,
    SettingsSaveQueue,
    SettingsSaveTracker,
} from '../public/scripts/util/settings-save-tracker.js';

test('settings save tracker skips only enabled exact confirmed payloads', () => {
    const tracker = new SettingsSaveTracker();
    const payload = JSON.stringify({ power_user: { theme: 'dark' } });

    assert.equal(tracker.isUnchanged(payload, true), false);
    assert.equal(tracker.commit(payload), true);
    assert.equal(tracker.isUnchanged(payload, false), false);
    assert.equal(tracker.isUnchanged(payload, true), true);
    assert.equal(tracker.isUnchanged(`${payload} `, true), false);
});

test('settings save tracker clears stale and oversized baselines', () => {
    const tracker = new SettingsSaveTracker({ maxBaselineLength: 4 });

    assert.equal(tracker.commit('1234'), true);
    assert.equal(tracker.isUnchanged('1234', true), true);
    tracker.clear();
    assert.equal(tracker.isUnchanged('1234', true), false);

    assert.equal(tracker.commit('12345'), false);
    assert.equal(tracker.isUnchanged('12345', true), false);
});

test('settings save tracker validates limits and serialized input', () => {
    assert.throws(() => new SettingsSaveTracker({ maxBaselineLength: -1 }), /non-negative finite number/);
    const tracker = new SettingsSaveTracker();
    assert.throws(() => tracker.isUnchanged(null, true), /must be a string/);
    assert.throws(() => tracker.commit({}), /must be a string/);
});

test('settings save response requires both HTTP success and the exact success contract', async () => {
    const response = (ok, status, body) => ({
        ok,
        status,
        statusText: ok ? 'OK' : 'Failed',
        json: async () => body,
    });

    assert.deepEqual(await requireSettingsSaveSuccess(response(true, 200, { result: 'ok' })), { result: 'ok' });
    await assert.rejects(requireSettingsSaveSuccess(response(false, 507, { result: 'ok' })), /HTTP 507/);
    await assert.rejects(requireSettingsSaveSuccess(response(true, 200, { error: 'write_failed' })), /invalid success response/i);
    await assert.rejects(requireSettingsSaveSuccess({ ok: true, status: 200, json: async () => { throw new Error('invalid JSON'); } }), /invalid success response/i);
});

test('settings save queue preserves request order and continues after a failure', async () => {
    const queue = new SettingsSaveQueue();
    const order = [];
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const first = queue.enqueue(async () => {
        order.push('first-start');
        await firstGate;
        order.push('first-end');
        throw new Error('first failed');
    });
    const second = queue.enqueue(async () => {
        order.push('second');
        return 'saved latest';
    });

    await Promise.resolve();
    assert.deepEqual(order, ['first-start']);
    releaseFirst();
    await assert.rejects(first, /first failed/);
    assert.equal(await second, 'saved latest');
    assert.deepEqual(order, ['first-start', 'first-end', 'second']);
    assert.equal(queue.pending, 0);
});
