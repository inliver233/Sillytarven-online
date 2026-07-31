import assert from 'node:assert/strict';
import test from 'node:test';

import { RegexRefreshCoordinator } from '../public/scripts/extensions/regex/refresh-coordinator.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

test('regex refresh coordinator merges global, scoped, and preset changes until the panel or its parent closes', async () => {
    const batches = [];
    const coordinator = new RegexRefreshCoordinator(async details => batches.push(details));

    await coordinator.setPanelOpen(true);
    assert.equal(await coordinator.requestRefresh(), false); // global edit
    assert.equal(await coordinator.requestRefresh(), false); // scoped toggle
    assert.equal(await coordinator.requestRefresh(), false); // preset sort
    assert.deepEqual(batches, []);

    assert.equal(await coordinator.setPanelOpen(false), true); // Also covers hiding the parent Extensions drawer.
    assert.deepEqual(batches, [{ requestCount: 3 }]);
    assert.equal(await coordinator.flush(), false);
});

test('regex refresh coordinator refreshes immediately outside the settings panel', async () => {
    const batches = [];
    const coordinator = new RegexRefreshCoordinator(async details => batches.push(details));

    assert.equal(await coordinator.requestRefresh(), true);
    assert.deepEqual(batches, [{ requestCount: 1 }]);
});

test('regex refresh coordinator is single-flight and drains a mutation made during refresh', async () => {
    const firstRefresh = deferred();
    const batches = [];
    const coordinator = new RegexRefreshCoordinator(async details => {
        batches.push(details);
        if (batches.length === 1) {
            await firstRefresh.promise;
        }
    });

    const firstRequest = coordinator.requestRefresh();
    const concurrentFlush = coordinator.flush();
    const secondRequest = coordinator.requestRefresh();
    firstRefresh.resolve();

    assert.equal(await firstRequest, true);
    assert.equal(await concurrentFlush, true);
    assert.equal(await secondRequest, true);
    assert.deepEqual(batches, [{ requestCount: 1 }, { requestCount: 1 }]);
});

test('regex refresh coordinator retains dirty work after a failed refresh', async () => {
    const batches = [];
    let shouldFail = true;
    const coordinator = new RegexRefreshCoordinator(async details => {
        batches.push(details);
        if (shouldFail) {
            throw new Error('chat reload failed');
        }
    });

    await assert.rejects(coordinator.requestRefresh(), /chat reload failed/);
    shouldFail = false;
    assert.equal(await coordinator.flush(), true);
    assert.deepEqual(batches, [{ requestCount: 1 }, { requestCount: 1 }]);
});

test('regex refresh coordinator defers new work when the panel reopens mid-refresh', async () => {
    const firstRefresh = deferred();
    const batches = [];
    const coordinator = new RegexRefreshCoordinator(async details => {
        batches.push(details);
        if (batches.length === 1) {
            await firstRefresh.promise;
        }
    });

    const firstRequest = coordinator.requestRefresh();
    await coordinator.setPanelOpen(true);
    await coordinator.requestRefresh();
    firstRefresh.resolve();

    assert.equal(await firstRequest, true);
    assert.deepEqual(batches, [{ requestCount: 1 }]);
    assert.equal(await coordinator.setPanelOpen(false), true);
    assert.deepEqual(batches, [{ requestCount: 1 }, { requestCount: 1 }]);
});

test('regex refresh coordinator validates its callback', () => {
    assert.throws(() => new RegexRefreshCoordinator(null), /refresh must be a function/);
});
