import assert from 'node:assert/strict';
import test from 'node:test';

import { ScrollCoordinator, ScrollPriority } from '../public/scripts/util/scroll-coordinator.js';

test('higher priority preempts and aborts lower priority ownership', () => {
    const coordinator = new ScrollCoordinator();
    const hydration = coordinator.claim('hydration', ScrollPriority.HYDRATION);
    const jump = coordinator.claim('jump', ScrollPriority.EXPLICIT_JUMP);

    assert.equal(hydration.abortController.signal.aborted, true);
    assert.equal(coordinator.isActive(hydration), false);
    assert.equal(coordinator.isActive(jump), true);
});

test('equal and lower priorities are rejected without disturbing active work', () => {
    const coordinator = new ScrollCoordinator();
    const streaming = coordinator.claim('streaming', ScrollPriority.STREAMING);
    assert.equal(coordinator.claim('equal', ScrollPriority.STREAMING), null);
    assert.equal(coordinator.claim('hydration', ScrollPriority.HYDRATION), null);
    assert.equal(coordinator.isActive(streaming), true);
});

test('user input cancels active work and makes stale tokens unable to write', () => {
    const coordinator = new ScrollCoordinator();
    const token = coordinator.claim('streaming', ScrollPriority.STREAMING);
    assert.equal(coordinator.cancelForUserInput(), true);
    assert.equal(token.abortController.signal.aborted, true);
    assert.equal(coordinator.isActive(token), false);
    assert.equal(coordinator.cancelForUserInput(), false);
});

test('release and preemption run registered cleanup exactly once', () => {
    const coordinator = new ScrollCoordinator();
    let removedAnchors = 0;
    const token = coordinator.claim('hydration', ScrollPriority.HYDRATION);
    token.addCleanup(() => removedAnchors++);
    coordinator.release(token);
    coordinator.release(token);
    assert.equal(removedAnchors, 1);

    const next = coordinator.claim('streaming', ScrollPriority.STREAMING);
    next.addCleanup(() => removedAnchors++);
    coordinator.claim('gesture', ScrollPriority.USER_INPUT);
    assert.equal(removedAnchors, 2);
});

test('invalid claims fail closed', () => {
    const coordinator = new ScrollCoordinator();
    assert.equal(coordinator.claim('', ScrollPriority.HYDRATION), null);
    assert.equal(coordinator.claim('bad', Number.NaN), null);
});
