import assert from 'node:assert/strict';
import test from 'node:test';

import { runStrictStartupTasks, startBackgroundStartupTask } from '../public/scripts/util/startup-orchestration.js';

function deferred() {
    let resolve;
    const promise = new Promise(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

test('strict startup tasks begin together and wait for every result', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started = [];
    let completed = false;

    const runPromise = runStrictStartupTasks(gates.map((gate, index) => async () => {
        started.push(index);
        await gate.promise;
        return index;
    }));
    void runPromise.then(() => { completed = true; });

    await Promise.resolve();
    assert.deepEqual(started, [0, 1, 2]);

    gates[0].resolve();
    gates[1].resolve();
    await Promise.resolve();
    assert.equal(completed, false);

    gates[2].resolve();
    assert.deepEqual(await runPromise, [0, 1, 2]);
    assert.equal(completed, true);
});

test('strict startup tasks propagate failures after starting every task', async () => {
    const expected = new Error('startup failed');
    const started = [];

    const runPromise = runStrictStartupTasks([
        () => {
            started.push('failing');
            throw expected;
        },
        () => {
            started.push('later');
        },
    ]);

    await assert.rejects(runPromise, error => error === expected);
    assert.deepEqual(started, ['failing', 'later']);
});

test('strict startup tasks propagate asynchronous rejections', async () => {
    const gate = deferred();
    const expected = new Error('async startup failed');
    const started = [];

    const runPromise = runStrictStartupTasks([
        async () => {
            started.push('failing');
            await gate.promise;
            throw expected;
        },
        async () => {
            started.push('peer');
            await Promise.resolve();
            return 'completed';
        },
    ]);

    await Promise.resolve();
    assert.deepEqual(started, ['failing', 'peer']);

    gate.resolve();
    await assert.rejects(runPromise, error => error === expected);
});

test('startup task helpers reject invalid arguments before starting work', async () => {
    let started = false;

    assert.throws(() => runStrictStartupTasks(null), /array of functions/);
    assert.throws(() => runStrictStartupTasks([
        () => { started = true; },
        null,
    ]), /array of functions/);
    assert.throws(() => startBackgroundStartupTask(null), /must be functions/);
    assert.throws(() => startBackgroundStartupTask(() => { started = true; }, null), /must be functions/);

    await Promise.resolve();
    assert.equal(started, false);
});

test('background startup task returns immediately and handles rejection', async () => {
    const gate = deferred();
    const expected = new Error('background failed');
    const errors = [];
    let started = false;

    const result = startBackgroundStartupTask(async () => {
        started = true;
        await gate.promise;
        throw expected;
    }, error => errors.push(error));

    assert.equal(result, undefined);
    assert.equal(started, false);

    await Promise.resolve();
    assert.equal(started, true);
    assert.deepEqual(errors, []);

    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, [expected]);
});

test('background startup task contains rejected error handlers without unhandled rejection', async () => {
    const taskError = new Error('background failed');
    const handlerError = new Error('handler failed');
    const loggedErrors = [];
    const unhandledRejections = [];
    const originalConsoleError = console.error;
    const onUnhandledRejection = reason => unhandledRejections.push(reason);
    let observedTaskError;

    console.error = (...args) => loggedErrors.push(args);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
        startBackgroundStartupTask(async () => {
            await Promise.resolve();
            throw taskError;
        }, async error => {
            observedTaskError = error;
            await Promise.resolve();
            throw handlerError;
        });

        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(observedTaskError, taskError);
        assert.deepEqual(loggedErrors, [['Background startup error handler failed:', handlerError]]);
        assert.deepEqual(unhandledRejections, []);
    } finally {
        process.off('unhandledRejection', onUnhandledRejection);
        console.error = originalConsoleError;
    }
});
