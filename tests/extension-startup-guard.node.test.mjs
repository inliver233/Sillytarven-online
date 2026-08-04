import assert from 'node:assert/strict';
import test from 'node:test';

import { ExtensionStartupGuard } from '../public/scripts/util/extension-startup-guard.js';

class MemoryStorage {
    values = new Map();
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(key, value); }
    removeItem(key) { this.values.delete(key); }
}

test('startup guard recovers only unsettled third-party extensions for one user', () => {
    const storage = new MemoryStorage();
    let now = 1000;
    const first = new ExtensionStartupGuard({ storage, userId: 'alice', now: () => now });
    assert.equal(first.begin('system-extension'), false);
    assert.equal(first.begin('third-party/chatu8'), true);
    assert.equal(first.begin('third-party/gallery'), true);
    first.settle('third-party/gallery');

    const aliceRecovery = new ExtensionStartupGuard({ storage, userId: 'alice', now: () => now }).recover();
    assert.deepEqual(aliceRecovery, ['third-party/chatu8']);
    assert.deepEqual(new ExtensionStartupGuard({ storage, userId: 'alice', now: () => now }).recover(), []);
    assert.deepEqual(new ExtensionStartupGuard({ storage, userId: 'bob', now: () => now }).recover(), []);

    first.begin('third-party/expired');
    now += 3 * 60 * 1000;
    assert.deepEqual(new ExtensionStartupGuard({ storage, userId: 'alice', now: () => now }).recover(), []);
});

test('startup guard schedules cleanup after the stability window', () => {
    const storage = new MemoryStorage();
    const guard = new ExtensionStartupGuard({ storage, userId: 'alice', settleWindowMs: 1234 });
    guard.begin('third-party/chatu8');
    let scheduledDelay = 0;
    guard.scheduleSettle('third-party/chatu8', (callback, delay) => {
        scheduledDelay = delay;
        callback();
        return 1;
    });
    assert.equal(scheduledDelay, 1234);
    assert.deepEqual(guard.recover(), []);
});
