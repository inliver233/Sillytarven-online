import assert from 'node:assert/strict';
import test from 'node:test';

import {
    requireSettingsSaveSuccess,
    SettingsSaveQueue,
    SettingsSaveTracker,
} from '../public/scripts/util/settings-save-tracker.js';

test('settings save tracker skips only exact confirmed payloads', async () => {
    const tracker = new SettingsSaveTracker();
    const payload = JSON.stringify({ power_user: { theme: 'dark' } });

    assert.equal(tracker.isUnchanged(await tracker.fingerprint(payload)), false);
    assert.equal(tracker.commit(await tracker.fingerprint(payload)), true);
    assert.equal(tracker.isUnchanged(await tracker.fingerprint(payload)), true);
    assert.equal(tracker.isUnchanged(await tracker.fingerprint(`${payload} `)), false);
    assert.equal(tracker.isUnchanged(await tracker.fingerprint(payload.replace('dark', 'dalk'))), false);
});

test('settings save tracker compares large payloads by hash without keeping them', async () => {
    const tracker = new SettingsSaveTracker({ maxBaselineLength: 4 });
    const big = JSON.stringify({ prompt: '很长的设置'.repeat(1000) });

    const fingerprint = await tracker.fingerprint(big);
    assert.equal(fingerprint.text, null);
    assert.match(fingerprint.hash, /^[0-9a-f]{64}$/);
    assert.equal(tracker.commit(fingerprint), true);
    assert.equal(tracker.isUnchanged(await tracker.fingerprint(big)), true);
    assert.equal(tracker.isUnchanged(await tracker.fingerprint(big.replace('很长', '很短'))), false);

    // Small and large payloads never match each other
    assert.equal(tracker.commit(await tracker.fingerprint('1234')), true);
    assert.equal(tracker.isUnchanged(await tracker.fingerprint('1234')), true);
    assert.equal(tracker.isUnchanged(await tracker.fingerprint(big)), false);
});

test('settings save tracker clears stale baselines and never skips without a hash', async () => {
    const tracker = new SettingsSaveTracker();
    assert.equal(tracker.commit(await tracker.fingerprint('1234')), true);
    tracker.clear();
    assert.equal(tracker.isUnchanged(await tracker.fingerprint('1234')), false);

    for (const hash of [async () => null, async () => { throw new Error('no crypto'); }]) {
        const noHash = new SettingsSaveTracker({ maxBaselineLength: 4, hash });
        assert.equal(noHash.commit(await noHash.fingerprint('1234')), true);
        const fingerprint = await noHash.fingerprint('12345');
        assert.equal(noHash.commit(fingerprint), false);
        assert.equal(noHash.isUnchanged(fingerprint), false);
        assert.equal(noHash.isUnchanged(await noHash.fingerprint('1234')), false);
    }
});

test('settings save tracker validates limits and serialized input', async () => {
    assert.throws(() => new SettingsSaveTracker({ maxBaselineLength: -1 }), /non-negative finite number/);
    const tracker = new SettingsSaveTracker();
    await assert.rejects(tracker.fingerprint(null), /must be a string/);
    assert.equal(tracker.isUnchanged(null), false);
    assert.equal(tracker.commit(null), false);
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
