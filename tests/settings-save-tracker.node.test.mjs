import assert from 'node:assert/strict';
import test from 'node:test';

import { SettingsSaveTracker } from '../public/scripts/util/settings-save-tracker.js';

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
