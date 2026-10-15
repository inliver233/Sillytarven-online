import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { createFishAudioRouter } = await import('../src/endpoints/fish-audio.js');

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4093, 7)]);
const servers = [];
after(() => Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))));

async function listen(handler) {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    server.on('connection', socket => server.once('close', () => socket.destroy()));
    return `http://127.0.0.1:${server.address().port}`;
}

/** The upstream fake replies with whatever the current test installs. */
let upstreamHandler;
const upstreamRequests = [];
const upstreamBase = await listen(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const entry = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString(), closed: false };
    response.on('close', () => { entry.closed = true; });
    upstreamRequests.push(entry);
    upstreamHandler(request, response, entry);
});

const app = express();
app.use(express.json());
app.use('/fish', createFishAudioRouter({
    apiBase: upstreamBase,
    readKey: request => request.get('x-test-key') ?? '',
    voicesTimeoutMs: 2_000,
    synthesizeTimeoutMs: 2_000,
}));
const appBase = await listen(app);

beforeEach(() => {
    upstreamRequests.length = 0;
    upstreamHandler = (_request, response) => response.writeHead(500).end();
});

function post(route, body, { key = 'secret-key', signal } = {}) {
    return fetch(`${appBase}/fish/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { 'x-test-key': key } : {}) },
        body: JSON.stringify(body ?? {}),
        signal,
    });
}

const speech = (extra = {}) => ({ text: '你好', reference_id: 'voice-1', model: 's2.1-pro', latency: 'balanced', speed: 1.25, temperature: 0.5, top_p: 0.6, ...extra });

test('synthesis forwards the documented request and streams the MP3 back', async () => {
    upstreamHandler = (_request, response) => {
        // The API does not document its audio media type; a generic one must still work.
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        response.end(MP3);
    };
    const response = await post('synthesize', speech());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), MP3);

    const [sent] = upstreamRequests;
    assert.equal(sent.url, '/v1/tts');
    assert.equal(sent.headers.authorization, 'Bearer secret-key');
    assert.equal(sent.headers.model, 's2.1-pro');
    assert.deepEqual(JSON.parse(sent.body), {
        text: '你好', reference_id: 'voice-1', format: 'mp3', latency: 'balanced', temperature: 0.5, top_p: 0.6, prosody: { speed: 1.25 },
    });
});

test('every documented model is accepted, including drama-3', async () => {
    upstreamHandler = (_request, response) => response.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    for (const model of ['s1', 's2-pro', 's2.1-pro', 's2.1-pro-free', 'drama-3']) {
        const response = await post('synthesize', speech({ model }));
        assert.equal(response.status, 200, model);
        await response.arrayBuffer();
    }
});

test('audio starts reaching the browser before the upstream finishes', async () => {
    let finish;
    upstreamHandler = (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        response.write(MP3);
        finish = () => response.end(MP3);
    };
    const response = await post('synthesize', speech());
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.ok(first.value.length > 0, 'first audio bytes arrived while upstream was still open');
    finish();
    let total = first.value.length;
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) total += chunk.value.length;
    assert.equal(total, MP3.length * 2);
});

test('responses that are not MP3 audio are rejected without leaking their content', async () => {
    const cases = [
        ['text/html', '<html>secret page</html>'],
        ['application/json', '{"message":"oops"}'],
        ['application/octet-stream', 'definitely not audio'],
        ['audio/mpeg', ''],
    ];
    for (const [type, body] of cases) {
        upstreamHandler = (_request, response) => response.writeHead(200, { 'Content-Type': type }).end(body);
        const response = await post('synthesize', speech());
        assert.equal(response.status, 502, type);
        const { error } = await response.json();
        assert.match(error, /^Fish Audio returned (a non-audio response|empty audio)\.$/, type);
    }
});

test('upstream errors map to safe statuses and messages', async () => {
    const cases = [
        [401, 400, 'Fish Audio rejected the API key.'],
        [402, 402, 'Fish Audio credits are exhausted.'],
        [422, 422, 'Fish Audio rejected the synthesis parameters.'],
        [500, 502, 'Fish Audio request failed (HTTP 500).'],
    ];
    for (const [upstreamStatus, status, message] of cases) {
        upstreamHandler = (_request, response) => response.writeHead(upstreamStatus, { 'Content-Type': 'text/html' }).end('<b>key=secret-key</b>');
        const response = await post('synthesize', speech());
        assert.equal(response.status, status, String(upstreamStatus));
        assert.deepEqual(await response.json(), { error: message });
    }
    upstreamHandler = (_request, response) => response.writeHead(429, { 'Retry-After': '12' }).end();
    const limited = await post('synthesize', speech());
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '12');
});

test('invalid input never reaches Fish Audio', async () => {
    const cases = [
        [speech({ model: 'drama-3-preview' }), /model/],
        [speech({ text: '   ' }), /Text/],
        [speech({ reference_id: '../model' }), /reference ID/],
        [speech({ speed: 3 }), /Speed/],
        [speech({ top_p: '0.5' }), /Top P/],
        [speech({ latency: 'fast' }), /Latency/],
    ];
    for (const [body, message] of cases) {
        const response = await post('synthesize', body);
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, message);
    }
    const noKey = await post('synthesize', speech(), { key: '' });
    assert.equal(noKey.status, 400);
    assert.match((await noKey.json()).error, /API key/);
    assert.equal(upstreamRequests.length, 0);
});

test('a hung upstream times out instead of holding the request open', async () => {
    upstreamHandler = () => {};
    const started = Date.now();
    const response = await post('synthesize', speech());
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: 'Fish Audio request timed out.' });
    assert.ok(Date.now() - started < 5_000);
    await waitFor(() => upstreamRequests[0]?.closed);
});

test('closing the browser request cancels the upstream synthesis', async () => {
    upstreamHandler = (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        response.write(MP3);
    };
    const controller = new AbortController();
    const response = await post('synthesize', speech(), { signal: controller.signal });
    await response.body.getReader().read();
    controller.abort();
    await waitFor(() => upstreamRequests[0]?.closed);
});

test('voice listing pages through owned voices and keeps only usable ones', async () => {
    upstreamHandler = (request, response) => {
        const page = Number(new URL(request.url, 'http://x').searchParams.get('page_number'));
        const items = page === 1
            ? [
                { _id: 'a1', title: '温柔女声', type: 'tts', state: 'trained', languages: ['zh'] },
                { _id: 'a2', title: 'Training', type: 'tts', state: 'training' },
                { _id: 'a3', title: 'Old', type: 'svc', state: 'trained' },
            ]
            : [
                { _id: 'b1', title: 'Removed', type: 'tts', state: 'trained', dmca_taken_down: true },
                { _id: 'b2', title: 'Narrator', type: 'tts', state: 'trained', languages: ['en'] },
                { _id: '../bad', title: 'Bad', type: 'tts', state: 'trained' },
            ];
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ items, has_more: page === 1, total: 6 }));
    };
    const response = await post('voices');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        voices: [{ id: 'a1', name: '温柔女声', lang: 'zh' }, { id: 'b2', name: 'Narrator', lang: 'en' }],
        complete: true,
    });
    assert.deepEqual(upstreamRequests.map(entry => new URL(entry.url, 'http://x').searchParams.get('self')), ['true', 'true']);
});

async function waitFor(condition, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) assert.fail('condition was not met in time');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
