import assert from 'node:assert/strict';
import test from 'node:test';

import { DrawerSwitchCoordinator } from '../public/scripts/util/drawer-switch-coordinator.js';

function createHarness() {
    let now = 0;
    let nextId = 1;
    const timers = new Map();
    const coordinator = new DrawerSwitchCoordinator({
        now: () => now,
        setTimeoutFn: (callback, delay) => {
            const id = nextId++;
            timers.set(id, { callback, due: now + delay });
            return id;
        },
        clearTimeoutFn: id => timers.delete(id),
    });
    return {
        coordinator,
        advance(ms) {
            now += ms;
            for (const [id, timer] of [...timers]) {
                if (timer.due <= now) {
                    timers.delete(id);
                    timer.callback();
                }
            }
        },
        timerCount: () => timers.size,
    };
}

test('rapid switches invalidate the previous waiter and only open the latest target', async () => {
    const harness = createHarness();
    const first = harness.coordinator.begin({ closing: true, settleMs: 125 });
    const firstResult = harness.coordinator.waitForSettle(first);
    const second = harness.coordinator.begin();
    const secondResult = harness.coordinator.waitForSettle(second);

    assert.equal(await firstResult, false);
    assert.equal(harness.timerCount(), 1);
    harness.advance(125);
    assert.equal(await secondResult, true);
    assert.equal(harness.coordinator.isActive(second), true);
});

test('inliver immediate switching skips the remaining close wait', async () => {
    const harness = createHarness();
    const token = harness.coordinator.begin({ closing: true, settleMs: 125 });
    assert.equal(await harness.coordinator.waitForSettle(token, { immediate: true }), true);
    assert.equal(harness.timerCount(), 0);
});

test('outside cancellation resolves pending work and blocks stale DOM writes', async () => {
    const harness = createHarness();
    const token = harness.coordinator.begin({ closing: true, settleMs: 125 });
    const result = harness.coordinator.waitForSettle(token);
    harness.coordinator.cancel();

    assert.equal(await result, false);
    assert.equal(harness.coordinator.isActive(token), false);
    assert.equal(harness.timerCount(), 0);
});
