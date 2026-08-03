/* eslint-disable playwright/expect-expect -- Node test runner uses assert. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { forwardFetchResponse, setConfigFilePath } from '../src/util.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
setConfigFilePath(path.join(projectRoot, 'default', 'config.yaml'));

function listen(server) {
    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.once('error', reject);
    });
}

function close(server) {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

function serverUrl(server) {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
}

async function within(promise, milliseconds, message) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), milliseconds);
                timer.unref();
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function readJsonRequest(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function customRequest(customUrl, overrides = {}) {
    return {
        chat_completion_source: 'custom',
        custom_url: customUrl,
        model: 'stage2-integration-model',
        messages: [{ role: 'user', content: 'Return a compact result.' }],
        max_tokens: 64,
        temperature: 0.2,
        stream: false,
        json_schema: {
            name: 'stage2_result',
            strict: true,
            value: {
                type: 'object',
                properties: {
                    answer: { type: 'string' },
                },
                required: ['answer'],
                additionalProperties: false,
            },
        },
        ...overrides,
    };
}

async function postGenerate(baseUrl, body) {
    return await fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

test('forwardFetchResponse rejects when an upstream body closes without end or error', async () => {
    const body = new PassThrough();
    const target = new PassThrough();
    target.socket = new EventEmitter();
    const chunks = [];
    target.on('error', () => {});
    target.on('data', chunk => chunks.push(Buffer.from(chunk)));

    const forwarding = forwardFetchResponse({
        status: 200,
        statusText: 'OK',
        ok: true,
        body,
    }, target);
    body.write('partial');
    body.destroy();

    await assert.rejects(
        within(forwarding, 1000, 'forwarding did not settle after upstream close'),
        error => error?.code === 'ERR_STREAM_PREMATURE_CLOSE',
    );
    assert.equal(target.destroyed, true);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'partial');
});

test('Stage2 chat-completions protocol integration', async (t) => {
    const userRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-stage2-protocol-'));
    t.after(async () => {
        await fs.promises.rm(userRoot, { recursive: true, force: true });
    });
    await fs.promises.writeFile(path.join(userRoot, 'secrets.json'), '{}', 'utf8');

    const { router } = await import('../src/endpoints/backends/chat-completions.js');
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = {
            profile: { handle: 'stage2-integration-user' },
            directories: { root: userRoot },
        };
        next();
    });
    app.use('/api/backends/chat-completions', router);

    const applicationServer = http.createServer(app);
    await listen(applicationServer);
    t.after(async () => {
        applicationServer.closeIdleConnections();
        applicationServer.closeAllConnections();
        await within(close(applicationServer), 1000, 'application server did not close');
    });
    const applicationUrl = serverUrl(applicationServer);

    await t.test('CUSTOM normal request sends json_schema response format to the upstream', async () => {
        let capturedPath;
        let capturedBody;
        const upstream = http.createServer(async (request, response) => {
            capturedPath = request.url;
            capturedBody = await readJsonRequest(request);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' } }] }));
        });
        await listen(upstream);
        try {
            const response = await postGenerate(applicationUrl, customRequest(serverUrl(upstream)));
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), {
                choices: [{ message: { content: '{"answer":"ok"}' } }],
            });
            assert.equal(capturedPath, '/chat/completions');
            assert.deepEqual(capturedBody.response_format, {
                type: 'json_schema',
                json_schema: {
                    name: 'stage2_result',
                    strict: true,
                    schema: {
                        type: 'object',
                        properties: {
                            answer: { type: 'string' },
                        },
                        required: ['answer'],
                        additionalProperties: false,
                    },
                },
            });
        } finally {
            await close(upstream);
        }
    });

    await t.test('CUSTOM streaming request sends schema and forwards the upstream SSE body', async () => {
        let capturedBody;
        const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
        const upstream = http.createServer(async (request, response) => {
            capturedBody = await readJsonRequest(request);
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(sse);
        });
        await listen(upstream);
        try {
            const response = await postGenerate(applicationUrl, customRequest(serverUrl(upstream), { stream: true }));
            assert.equal(response.status, 200);
            assert.equal(await response.text(), sse);
            assert.equal(capturedBody.stream, true);
            assert.equal(capturedBody.response_format.type, 'json_schema');
            assert.equal(capturedBody.response_format.json_schema.name, 'stage2_result');
            assert.deepEqual(capturedBody.response_format.json_schema.schema.properties, {
                answer: { type: 'string' },
            });
        } finally {
            await close(upstream);
        }
    });

    await t.test('CUSTOM streaming request aborts the downstream response on premature upstream close', async () => {
        const upstream = http.createServer(async (request, response) => {
            await readJsonRequest(request);
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.flushHeaders();
            response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
            setTimeout(() => response.socket?.destroy(), 20).unref();
        });
        await listen(upstream);
        try {
            const response = await postGenerate(applicationUrl, customRequest(serverUrl(upstream), { stream: true }));
            await assert.rejects(response.text(), /aborted|terminated|premature|socket/i);
        } finally {
            upstream.closeIdleConnections();
            upstream.closeAllConnections();
            await close(upstream);
        }
    });

    await t.test('Claude Opus 4.7 sends multipart adaptive summarized thinking without sampling fields', async () => {
        let capturedPath;
        let capturedBody;
        const upstream = http.createServer(async (request, response) => {
            capturedPath = request.url;
            capturedBody = await readJsonRequest(request);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ content: [{ type: 'text', text: 'described' }] }));
        });
        await listen(upstream);
        try {
            const response = await postGenerate(applicationUrl, {
                chat_completion_source: 'claude',
                reverse_proxy: serverUrl(upstream),
                proxy_password: 'local-test-key',
                model: 'claude-opus-4-7-20260801',
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Describe this image.' },
                        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
                    ],
                }],
                max_tokens: 4096,
                reasoning_effort: 'high',
                include_reasoning: true,
                temperature: 0.7,
                top_p: 0.8,
                top_k: 20,
                stream: false,
            });
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), {
                choices: [{ message: { content: 'described' } }],
                content: [{ type: 'text', text: 'described' }],
            });
            assert.match(capturedPath, /\/messages$/);
            assert.deepEqual(capturedBody.thinking, { type: 'adaptive', display: 'summarized' });
            assert.deepEqual(capturedBody.output_config, { effort: 'high' });
            assert.equal(Object.hasOwn(capturedBody, 'temperature'), false);
            assert.equal(Object.hasOwn(capturedBody, 'top_p'), false);
            assert.equal(Object.hasOwn(capturedBody, 'top_k'), false);
            assert.deepEqual(capturedBody.messages, [{
                role: 'user',
                content: [
                    { type: 'text', text: 'Describe this image.' },
                    {
                        type: 'image',
                        source: { type: 'base64', media_type: 'image/png', data: 'AQID' },
                    },
                ],
            }]);
        } finally {
            await close(upstream);
        }
    });

    await t.test('closing the client aborts the in-flight CUSTOM upstream stream', async () => {
        let markUpstreamClosed;
        let clientRequest;
        const upstreamClosed = new Promise(resolve => { markUpstreamClosed = resolve; });
        const upstreamConnections = new Set();
        const upstream = http.createServer(async (request, response) => {
            await readJsonRequest(request);
            response.once('close', markUpstreamClosed);
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.write('data: partial\n\n');
        });
        upstream.on('connection', socket => {
            upstreamConnections.add(socket);
            socket.once('close', () => upstreamConnections.delete(socket));
        });
        await listen(upstream);
        try {
            const payload = JSON.stringify(customRequest(serverUrl(upstream), { stream: true }));
            const endpoint = new URL('/api/backends/chat-completions/generate', applicationUrl);
            await within(new Promise((resolve, reject) => {
                clientRequest = http.request(endpoint, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'content-length': Buffer.byteLength(payload),
                    },
                }, clientResponse => {
                    clientResponse.once('data', () => {
                        clientResponse.destroy();
                        resolve();
                    });
                });
                clientRequest.once('error', reject);
                clientRequest.end(payload);
            }), 2000, 'client did not receive upstream response data');
            await within(upstreamClosed, 2000, 'upstream connection remained open after the client closed');
        } finally {
            clientRequest?.destroy();
            upstream.closeIdleConnections();
            upstream.closeAllConnections();
            for (const socket of upstreamConnections) socket.destroy();
            await within(close(upstream), 1000, 'abort-test upstream server did not close');
        }
    });

    await t.test('CUSTOM streaming route preserves 403 JSON and 502 text error bodies', async () => {
        const cases = [
            {
                status: 403,
                contentType: 'application/json',
                body: JSON.stringify({ error: { message: 'Forbidden by upstream' } }),
            },
            {
                status: 502,
                contentType: 'text/plain',
                body: 'upstream gateway unavailable',
            },
        ];

        for (const item of cases) {
            const upstream = http.createServer(async (request, response) => {
                await readJsonRequest(request);
                response.writeHead(item.status, { 'content-type': item.contentType });
                response.end(item.body);
            });
            await listen(upstream);
            try {
                const response = await postGenerate(applicationUrl, customRequest(serverUrl(upstream), { stream: true }));
                assert.equal(response.status, item.status);
                assert.equal(await response.text(), item.body);
            } finally {
                await close(upstream);
            }
        }
    });
});
