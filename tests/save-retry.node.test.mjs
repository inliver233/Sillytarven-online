import assert from 'node:assert/strict';
import test from 'node:test';

import { isOwnRevisionConflict, sendWithRetry } from '../public/scripts/util/save-retry.js';

const noWait = () => Promise.resolve();
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a dropped connection or a passing outage is retried, then the answer comes back', async () => {
    for (const failure of [
        () => { throw new TypeError('Failed to fetch'); },
        () => new Response('', { status: 503 }),
        () => new Response('', { status: 524 }),
        () => json(423, { code: 'user_quiescing' }),
    ]) {
        let calls = 0;
        const response = await sendWithRetry(async () => (++calls === 1 ? failure() : json(200, { result: 'ok' })), { wait: noWait });
        assert.equal(response.status, 200);
        assert.equal(calls, 2);
    }
});

test('real answers are not retried', async () => {
    for (const status of [400, 409, 413, 500]) {
        let calls = 0;
        const response = await sendWithRetry(async () => { calls++; return json(status, { error: 'x' }); }, { wait: noWait });
        assert.equal(response.status, status);
        assert.equal(calls, 1, String(status));
    }
    let calls = 0;
    const frozen = await sendWithRetry(async () => { calls++; return json(423, { code: 'user_data_frozen' }); }, { wait: noWait });
    assert.equal(frozen.status, 423);
    assert.equal(calls, 1);
});

test('it gives up after two retries: the last answer or error goes back', async () => {
    let calls = 0;
    const response = await sendWithRetry(async () => { calls++; return new Response('', { status: 502 }); }, { wait: noWait });
    assert.equal(response.status, 502);
    assert.equal(calls, 3);
    calls = 0;
    await assert.rejects(sendWithRetry(async () => { calls++; throw new TypeError('Failed to fetch'); }, { wait: noWait }), TypeError);
    assert.equal(calls, 3);
    // Aborted on purpose: no retry
    calls = 0;
    await assert.rejects(sendWithRetry(async () => { calls++; throw new DOMException('stop', 'AbortError'); }, { wait: noWait }));
    assert.equal(calls, 1);
});

test('a refusal whose stored revision is the one this save proposed is its own earlier try', () => {
    const conflict = new Response('', { status: 409 });
    assert.equal(isOwnRevisionConflict(conflict, { error: 'revision_conflict', currentRevision: 'abc' }, 'abc'), true);
    assert.equal(isOwnRevisionConflict(conflict, { error: 'revision_conflict', currentRevision: 'other' }, 'abc'), false);
    assert.equal(isOwnRevisionConflict(new Response('', { status: 400 }), { error: 'revision_conflict', currentRevision: 'abc' }, 'abc'), false);
});
