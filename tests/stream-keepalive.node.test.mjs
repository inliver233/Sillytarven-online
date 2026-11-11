import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import express from 'express';

import { isAwaitingStreamContent, keepStreamAlive } from '../src/stream-keepalive.js';
import { forwardFetchResponse } from '../src/util.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const IDLE_MS = 40;
const SLOW_MS = 160;

const app = express();
const keep = response => keepStreamAlive(response, { idleMs: IDLE_MS });

app.get('/slow-ok', async (_request, response) => {
    keep(response);
    await sleep(SLOW_MS);
    response.status(200);
    response.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    response.end('data: [DONE]\n\n');
});
app.get('/slow-error', async (_request, response) => {
    keep(response);
    await sleep(SLOW_MS);
    assert.equal(isAwaitingStreamContent(response), true);
    response.status(429).send({ error: { message: 'quota exceeded' } });
});
app.get('/slow-error-flag', async (_request, response) => {
    keep(response);
    await sleep(SLOW_MS);
    response.setHeader('X-Late', '1');
    response.status(400).send({ error: true });
});
app.get('/slow-upstream-error', async (_request, response) => {
    keep(response);
    await sleep(SLOW_MS);
    await forwardFetchResponse(new Response('{"error":{"message":"upstream boom"}}', { status: 500, statusText: 'Internal Server Error' }), response);
});
app.get('/fast-error', async (_request, response) => {
    keep(response);
    response.status(429).send({ error: { message: 'quota exceeded' } });
});

const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
});
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
after(() => new Promise(resolve => server.close(resolve)));

async function get(path) {
    const response = await fetch(base + path);
    return { status: response.status, type: response.headers.get('content-type'), buffering: response.headers.get('x-accel-buffering'), text: await response.text() };
}
const events = text => text.split('\n\n').filter(Boolean);

test('a slow stream gets keepalive comments first, then its content', async () => {
    const { status, type, buffering, text } = await get('/slow-ok');
    assert.equal(status, 200);
    assert.match(type, /text\/event-stream/);
    assert.equal(buffering, 'no');
    const list = events(text);
    assert.ok(list.filter(event => event === ': keepalive').length >= 1, text);
    assert.deepEqual(list.filter(event => event !== ': keepalive'), ['data: {"choices":[{"delta":{"content":"hi"}}]}', 'data: [DONE]']);
});

test('an error sent after the keepalive goes into the stream', async () => {
    const { status, text } = await get('/slow-error');
    assert.equal(status, 200);
    const last = events(text).at(-1);
    assert.deepEqual(JSON.parse(last.slice('data: '.length)), { error: { message: 'quota exceeded' } });
});

test('a bare error flag becomes a message, and late headers are ignored', async () => {
    const { text } = await get('/slow-error-flag');
    const last = JSON.parse(events(text).at(-1).slice('data: '.length));
    assert.equal(last.error.message, '生成失败（400）');
});

test('an upstream error forwarded after the keepalive goes into the stream', async () => {
    const { status, text } = await get('/slow-upstream-error');
    assert.equal(status, 200);
    const last = JSON.parse(events(text).at(-1).slice('data: '.length));
    assert.equal(last.error.message, 'upstream boom');
});

test('a quick answer is untouched', async () => {
    const { status, type, text } = await get('/fast-error');
    assert.equal(status, 429);
    assert.match(type, /application\/json/);
    assert.deepEqual(JSON.parse(text), { error: { message: 'quota exceeded' } });
});
