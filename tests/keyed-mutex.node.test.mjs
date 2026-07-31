import assert from 'node:assert/strict';
import test from 'node:test';

import { KeyedMutex } from '../src/keyed-mutex.js';

function deferred() {
    let resolve;
    const promise = new Promise(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

test('keyed mutex serializes one key while allowing different keys to run', async () => {
    const mutex = new KeyedMutex();
    const releaseFirst = deferred();
    const events = [];

    const first = mutex.runExclusive('same', async () => {
        events.push('first-start');
        await releaseFirst.promise;
        events.push('first-end');
    });
    const second = mutex.runExclusive('same', async () => {
        events.push('second');
    });
    const other = mutex.runExclusive('other', async () => {
        events.push('other');
    });

    await other;
    assert.deepEqual(events, ['first-start', 'other']);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first-start', 'other', 'first-end', 'second']);
});

test('keyed mutex releases a key after callback failure', async () => {
    const mutex = new KeyedMutex();
    await assert.rejects(mutex.runExclusive('chat', async () => {
        throw new Error('write failed');
    }), /write failed/);
    assert.equal(await mutex.runExclusive('chat', async () => 'recovered'), 'recovered');
});

test('keyed mutex validates keys and callbacks', async () => {
    const mutex = new KeyedMutex();
    await assert.rejects(mutex.runExclusive('', async () => {}), /non-empty string/);
    await assert.rejects(mutex.runExclusive('chat', null), /callback must be a function/);
});
