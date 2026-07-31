import assert from 'node:assert/strict';
import test from 'node:test';

import { LatestTaskScheduler } from '../public/scripts/util/latest-task-scheduler.js';

function deferred() {
    let resolve;
    const promise = new Promise(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function fakeTimers() {
    let nextId = 0;
    const callbacks = new Map();
    return {
        setTimeoutFn(callback) {
            const id = ++nextId;
            callbacks.set(id, callback);
            return id;
        },
        clearTimeoutFn(id) {
            callbacks.delete(id);
        },
        runPending() {
            const pending = [...callbacks.values()];
            callbacks.clear();
            pending.forEach(callback => callback());
        },
        get size() {
            return callbacks.size;
        },
    };
}

test('latest task scheduler debounces requests into one versioned commit', async () => {
    const timers = fakeTimers();
    const runs = [];
    const commits = [];
    const scheduler = new LatestTaskScheduler({
        delayMs: 250,
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
        run: async details => {
            runs.push(details);
            return 'latest';
        },
        commit: (result, details) => commits.push({ result, ...details }),
    });

    assert.equal(scheduler.schedule(), 1);
    assert.equal(scheduler.schedule(), 2);
    assert.equal(scheduler.schedule(), 3);
    assert.equal(timers.size, 1);
    timers.runPending();
    await scheduler.flush();

    assert.deepEqual(runs, [{ version: 3, requestCount: 3 }]);
    assert.deepEqual(commits, [{ result: 'latest', version: 3, requestCount: 3 }]);
});

test('latest task scheduler is single-flight and skips a superseded result', async () => {
    const timers = fakeTimers();
    const firstRun = deferred();
    const runs = [];
    const commits = [];
    const discards = [];
    let active = 0;
    let maxActive = 0;
    const scheduler = new LatestTaskScheduler({
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
        run: async details => {
            runs.push(details);
            active++;
            maxActive = Math.max(maxActive, active);
            if (runs.length === 1) {
                await firstRun.promise;
            }
            active--;
            return details.version;
        },
        commit: result => commits.push(result),
        onDiscard: (result, details) => discards.push({ result, ...details }),
    });

    scheduler.schedule();
    timers.runPending();
    await Promise.resolve();
    scheduler.schedule();
    firstRun.resolve();
    await scheduler.flush();

    assert.equal(maxActive, 1);
    assert.deepEqual(runs, [
        { version: 1, requestCount: 1 },
        { version: 2, requestCount: 1 },
    ]);
    assert.deepEqual(commits, [2]);
    assert.deepEqual(discards, [{ result: 1, version: 1, requestCount: 1 }]);
});

test('latest task scheduler cancellation invalidates queued and active work', async () => {
    const timers = fakeTimers();
    const activeRun = deferred();
    const commits = [];
    const discards = [];
    let runs = 0;
    const scheduler = new LatestTaskScheduler({
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
        run: async () => {
            runs++;
            await activeRun.promise;
            return runs;
        },
        commit: result => commits.push(result),
        onDiscard: result => discards.push(result),
    });

    scheduler.schedule();
    scheduler.cancel();
    timers.runPending();
    await scheduler.flush();
    assert.equal(runs, 0);

    scheduler.schedule();
    timers.runPending();
    await Promise.resolve();
    scheduler.cancel();
    activeRun.resolve();
    await scheduler.flush();
    assert.equal(runs, 1);
    assert.deepEqual(commits, []);
    assert.deepEqual(discards, [1]);
});

test('latest task scheduler reports the latest error and remains reusable', async () => {
    const errors = [];
    const commits = [];
    let shouldFail = true;
    const scheduler = new LatestTaskScheduler({
        run: async () => {
            if (shouldFail) {
                throw new Error('dry run failed');
            }
            return 'recovered';
        },
        commit: result => commits.push(result),
        onError: error => errors.push(error.message),
    });

    scheduler.schedule();
    await scheduler.flush();
    shouldFail = false;
    scheduler.schedule();
    await scheduler.flush();

    assert.deepEqual(errors, ['dry run failed']);
    assert.deepEqual(commits, ['recovered']);
});

test('latest task scheduler validates callbacks and timer hooks', () => {
    assert.throws(() => new LatestTaskScheduler({}), /task callbacks must be functions/);
    assert.throws(() => new LatestTaskScheduler({
        run: async () => {},
        commit: () => {},
        setTimeoutFn: null,
    }), /timer hooks must be functions/);
});
