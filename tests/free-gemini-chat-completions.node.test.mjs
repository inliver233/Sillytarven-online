import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';

import express from 'express';

import { createFreeGeminiChannel, updateFreeGeminiChannel } from '../src/free-gemini-channels.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../config.yaml', import.meta.url)));

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
    await new Promise(resolve => server.close(resolve));
}

async function readRequestJson(request) {
    let body = '';
    for await (const chunk of request) {
        body += chunk;
    }
    return JSON.parse(body);
}

async function createChatAppServer() {
    const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((request, _response, next) => {
        request.user = { directories: {}, profile: { handle: 'member' } };
        next();
    });
    app.use('/api/backends/chat-completions', chatCompletionsRouter);
    return http.createServer(app);
}

test('free Gemini uses server-side credentials and normalizes the first upstream request', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-chat-'));
    globalThis.DATA_ROOT = dataRoot;

    const upstreamRequests = [];
    const generationBodies = [];
    const upstream = http.createServer(async (request, response) => {
        upstreamRequests.push(request.url);
        response.setHeader('Content-Type', 'application/json');

        if (request.method === 'GET' && request.url === '/v1beta/models?key=server-secret') {
            response.end(JSON.stringify({
                models: [
                    {
                        name: 'models/gemini-test',
                        supportedGenerationMethods: ['generateContent'],
                        inputTokenLimit: 100,
                        outputTokenLimit: 80,
                    },
                    {
                        name: 'models/gemini-null-methods',
                        supportedGenerationMethods: null,
                    },
                    {
                        name: 'models/gemini-missing-methods',
                    },
                    {
                        name: 'models/embedding-only',
                        supportedGenerationMethods: ['embedContent'],
                    },
                ],
            }));
            return;
        }

        if (request.method === 'POST' && request.url === '/v1beta/models/gemini-test:generateContent?key=server-secret') {
            generationBodies.push(await readRequestJson(request));
            response.end(JSON.stringify({
                candidates: [{ content: { parts: [{ text: '福利渠道可用' }] } }],
            }));
            return;
        }

        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'unexpected request' }));
    });

    const appServer = await createChatAppServer();

    try {
        const upstreamUrl = await listen(upstream);
        const appUrl = await listen(appServer);
        const channel = await createFreeGeminiChannel({
            name: 'free-gemini',
            url: upstreamUrl,
            key: 'server-secret',
            maxOutputTokens: 40,
        });

        const statusResponse = await fetch(`${appUrl}/api/backends/chat-completions/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'free-gemini',
                free_gemini_channel_id: channel.id,
                reverse_proxy: 'http://127.0.0.1:1',
                proxy_password: 'attacker-value',
            }),
        });
        assert.equal(statusResponse.status, 200);
        assert.deepEqual(await statusResponse.json(), {
            data: [
                {
                    id: 'gemini-test',
                    channel_id: channel.id,
                    channel_name: 'free-gemini',
                    inputTokenLimit: 100,
                    outputTokenLimit: 40,
                },
                {
                    id: 'gemini-null-methods',
                    channel_id: channel.id,
                    channel_name: 'free-gemini',
                    inputTokenLimit: null,
                    outputTokenLimit: 40,
                },
                {
                    id: 'gemini-missing-methods',
                    channel_id: channel.id,
                    channel_name: 'free-gemini',
                    inputTokenLimit: null,
                    outputTokenLimit: 40,
                },
            ],
        });

        const generateResponse = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'free-gemini',
                free_gemini_channel_id: channel.id,
                reverse_proxy: 'http://127.0.0.1:1',
                proxy_password: 'attacker-value',
                model: 'gemini-test',
                messages: [
                    { role: 'user', content: '你好' },
                    { role: 'assistant', content: '上次回答' },
                ],
                max_tokens: 99999,
                temperature: 1,
                top_p: 1,
                top_k: 100,
                seed: null,
                stream: false,
                custom_include_body: 'generationConfig:\n  topK: 32\n  maxOutputTokens: 70\n  temperature: 0.25',
                custom_exclude_body: '- safetySettings',
            }),
        });
        assert.equal(generateResponse.status, 200);
        const generated = await generateResponse.json();
        assert.equal(generated.choices[0].message.content, '福利渠道可用');
        assert.equal(generationBodies.length, 1);
        assert.equal(generationBodies[0].generationConfig.maxOutputTokens, 40);
        assert.equal(generationBodies[0].generationConfig.topK, 32);
        assert.equal(generationBodies[0].generationConfig.temperature, 0.25);
        assert.equal(Object.hasOwn(generationBodies[0], 'safetySettings'), false);
        assert.equal(Object.hasOwn(generationBodies[0].generationConfig, 'seed'), false);
        assert.equal(generationBodies[0].contents.at(-2).role, 'model');
        assert.equal(generationBodies[0].contents.at(-2).parts[0].text, '上次回答');
        assert.deepEqual(generationBodies[0].contents.at(-1), {
            role: 'user',
            parts: [{ text: 'Continue the previous response.' }],
        });

        const lowerClampResponse = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'free-gemini',
                free_gemini_channel_id: channel.id,
                model: 'gemini-test',
                messages: [{ role: 'user', content: 'lower clamp' }],
                max_tokens: 0,
                top_k: -10,
                stream: false,
            }),
        });
        assert.equal(lowerClampResponse.status, 200);
        assert.equal(generationBodies.length, 2);
        assert.equal(generationBodies[1].generationConfig.maxOutputTokens, 1);
        assert.equal(generationBodies[1].generationConfig.topK, 1);
        assert.deepEqual(generationBodies[1].contents.at(-1), {
            role: 'user',
            parts: [{ text: 'lower clamp' }],
        });
        assert.equal(generationBodies[1].contents.some(content => content.parts?.some(part => part.text === 'Continue the previous response.')), false);

        const defaultLimitResponse = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'free-gemini',
                free_gemini_channel_id: channel.id,
                model: 'gemini-test',
                messages: [{ role: 'user', content: 'use the channel output limit' }],
                stream: false,
            }),
        });
        assert.equal(defaultLimitResponse.status, 200);
        assert.equal(generationBodies.length, 3);
        assert.equal(generationBodies[2].generationConfig.maxOutputTokens, 40);

        const generationCountBeforeInvalidRequests = generationBodies.length;
        const emptyModelResponse = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'free-gemini',
                free_gemini_channel_id: channel.id,
                model: '   ',
                messages: [{ role: 'user', content: 'must not reach upstream' }],
                stream: false,
            }),
        });
        assert.equal(emptyModelResponse.status, 400);
        assert.equal((await emptyModelResponse.json()).error.code, 'FREE_GEMINI_INVALID_MODEL');
        assert.equal(generationBodies.length, generationCountBeforeInvalidRequests);

        const emptyContentsResponse = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'free-gemini',
                free_gemini_channel_id: channel.id,
                model: 'gemini-test',
                messages: [{ role: 'user', content: '' }],
                stream: false,
            }),
        });
        assert.equal(emptyContentsResponse.status, 400);
        assert.equal((await emptyContentsResponse.json()).error.code, 'FREE_GEMINI_INVALID_CONTENTS');
        assert.equal(generationBodies.length, generationCountBeforeInvalidRequests);

        assert.deepEqual(upstreamRequests, [
            '/v1beta/models?key=server-secret',
            '/v1beta/models/gemini-test:generateContent?key=server-secret',
            '/v1beta/models/gemini-test:generateContent?key=server-secret',
            '/v1beta/models/gemini-test:generateContent?key=server-secret',
        ]);
        assert.equal(JSON.stringify(upstreamRequests).includes('attacker-value'), false);
    } finally {
        await Promise.allSettled([close(appServer), close(upstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('free Gemini sends each model with its configured request format', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-formats-'));
    globalThis.DATA_ROOT = dataRoot;

    const generationRequests = [];
    const upstream = http.createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'GET' && request.url === '/v1beta/models?key=format-secret') {
            response.end(JSON.stringify({
                models: [
                    { name: 'models/native-model', supportedGenerationMethods: ['generateContent'], outputTokenLimit: 100 },
                    { name: 'models/openai-model', supportedGenerationMethods: ['generateContent'], outputTokenLimit: 80 },
                ],
            }));
            return;
        }
        if (request.method === 'POST') {
            const body = await readRequestJson(request);
            generationRequests.push({ url: request.url, authorization: request.headers.authorization, body });
            if (request.url === '/v1beta/models/native-model:generateContent?key=format-secret') {
                response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'native' }] } }] }));
                return;
            }
            if (request.url === '/v1/chat/completions') {
                if (body.stream) {
                    response.setHeader('Content-Type', 'text/event-stream');
                    response.end('data: {"choices":[{"delta":{"content":"streamed"}}]}\n\ndata: [DONE]\n\n');
                    return;
                }
                response.end(JSON.stringify({ choices: [{ message: { content: 'openai' } }] }));
                return;
            }
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'unexpected request' }));
    });
    const appServer = await createChatAppServer();

    try {
        const upstreamUrl = await listen(upstream);
        const appUrl = await listen(appServer);
        const channel = await createFreeGeminiChannel({
            name: 'per-model-formats',
            url: upstreamUrl,
            key: 'format-secret',
            maxOutputTokens: 50,
            modelRequestFormats: {
                'native-model': 'gemini',
                'openai-model': 'openai',
            },
        });

        const generate = async model => {
            const result = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: 'free-gemini',
                    free_gemini_channel_id: channel.id,
                    model,
                    messages: [{ role: 'user', content: `use ${model}` }],
                    max_tokens: 70,
                    stream: false,
                    ...(model === 'openai-model' ? {
                        custom_include_body: 'model: policy-bypass\nmax_tokens: 99999\nstream: true',
                    } : {}),
                }),
            });
            assert.equal(result.status, 200);
            return await result.json();
        };

        assert.equal((await generate('native-model')).choices[0].message.content, 'native');
        assert.equal((await generate('openai-model')).choices[0].message.content, 'openai');
        assert.equal(generationRequests[0].url, '/v1beta/models/native-model:generateContent?key=format-secret');
        assert.equal(generationRequests[0].authorization, undefined);
        assert.equal(generationRequests[0].body.generationConfig.maxOutputTokens, 50);
        assert.equal(generationRequests[1].url, '/v1/chat/completions');
        assert.equal(generationRequests[1].authorization, 'Bearer format-secret');
        assert.equal(generationRequests[1].body.model, 'openai-model');
        assert.deepEqual(generationRequests[1].body.messages, [{ role: 'user', content: 'use openai-model' }]);
        assert.equal(generationRequests[1].body.max_tokens, 50);
        assert.equal(generationRequests[1].body.stream, false);
        assert.equal(Object.hasOwn(generationRequests[1].body, 'contents'), false);

        const streamResponse = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'free-gemini',
                free_gemini_channel_id: channel.id,
                model: 'openai-model',
                messages: [{ role: 'user', content: 'stream' }],
                stream: true,
            }),
        });
        assert.equal(streamResponse.status, 200);
        assert.match(await streamResponse.text(), /"choices":\[\{"delta":\{"content":"streamed"\}/);
        assert.equal(generationRequests[2].url, '/v1/chat/completions');
        assert.equal(generationRequests[2].body.stream, true);
    } finally {
        await Promise.allSettled([close(appServer), close(upstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('free Gemini aggregates by priority while an explicit channel gates model policy', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-routing-'));
    globalThis.DATA_ROOT = dataRoot;

    function makeUpstream(label, modelIds = ['common', 'only-low']) {
        return http.createServer(async (request, response) => {
            response.setHeader('Content-Type', 'application/json');
            if (request.method === 'GET') {
                response.end(JSON.stringify({
                    models: modelIds.map((id, index) => ({
                        name: `models/${id}`,
                        supportedGenerationMethods: ['generateContent'],
                        outputTokenLimit: 100 + index * 100,
                    })),
                }));
                return;
            }
            await readRequestJson(request);
            response.end(JSON.stringify({
                candidates: [{ content: { parts: [{ text: label }] } }],
            }));
        });
    }

    const highUpstream = makeUpstream('high');
    const lowUpstream = makeUpstream('low');
    const allowUpstream = makeUpstream('allow', ['common', 'only-allow']);
    const appServer = await createChatAppServer();

    try {
        const highUrl = await listen(highUpstream);
        const lowUrl = await listen(lowUpstream);
        const allowUrl = await listen(allowUpstream);
        const appUrl = await listen(appServer);
        const high = await createFreeGeminiChannel({
            name: 'high',
            url: highUrl,
            key: 'high-secret',
            priority: 100,
            modelPolicy: 'denylist',
            models: ['only-low'],
        });
        const low = await createFreeGeminiChannel({
            name: 'low',
            url: lowUrl,
            key: 'low-secret',
            priority: 10,
        });
        const allow = await createFreeGeminiChannel({
            name: 'allow',
            url: allowUrl,
            key: 'allow-secret',
            priority: 200,
            modelPolicy: 'allowlist',
            models: ['only-allow', 'phantom'],
        });

        const statusResponse = await fetch(`${appUrl}/api/backends/chat-completions/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_completion_source: 'free-gemini' }),
        });
        assert.equal(statusResponse.status, 200);
        const status = await statusResponse.json();
        assert.equal(status.data.find(model => model.id === 'common').channel_id, high.id);
        assert.equal(status.data.find(model => model.id === 'only-low').channel_id, low.id);
        assert.equal(status.data.find(model => model.id === 'only-allow').channel_id, allow.id);
        assert.equal(status.data.some(model => model.id === 'phantom'), false);

        const selectedStatusResponse = await fetch(`${appUrl}/api/backends/chat-completions/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'free-gemini',
                free_gemini_channel_id: high.id,
            }),
        });
        assert.equal(selectedStatusResponse.status, 200);
        const preferredStatus = (await selectedStatusResponse.json()).data;
        assert.equal(preferredStatus.find(model => model.id === 'common').channel_id, high.id);
        assert.equal(preferredStatus.find(model => model.id === 'only-allow').channel_id, allow.id);
        assert.equal(preferredStatus.some(model => model.id === 'only-low'), false);

        const allowlistedStatusResponse = await fetch(`${appUrl}/api/backends/chat-completions/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'free-gemini',
                free_gemini_channel_id: allow.id,
            }),
        });
        assert.equal(allowlistedStatusResponse.status, 200);
        const allowlistedStatus = (await allowlistedStatusResponse.json()).data;
        assert.deepEqual(allowlistedStatus.map(model => model.id), ['only-allow']);

        async function generate(model, preferredId) {
            const result = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: 'free-gemini',
                    free_gemini_channel_id: preferredId,
                    model,
                    messages: [{ role: 'user', content: 'test' }],
                    max_tokens: 10,
                    stream: false,
                }),
            });
            return { response: result, body: await result.json() };
        }

        const preferredLow = await generate('common', low.id);
        assert.equal(preferredLow.response.status, 200);
        assert.equal(preferredLow.body.choices[0].message.content, 'low');

        const deniedPreferred = await generate('only-low', high.id);
        assert.equal(deniedPreferred.response.status, 400);
        assert.equal(deniedPreferred.body.error.code, 'FREE_GEMINI_NO_ROUTE');

        const allowedFallback = await generate('only-allow', high.id);
        assert.equal(allowedFallback.response.status, 200);
        assert.equal(allowedFallback.body.choices[0].message.content, 'allow');

        const phantom = await generate('phantom', allow.id);
        assert.equal(phantom.response.status, 400);
        assert.equal(phantom.body.error.code, 'FREE_GEMINI_NO_ROUTE');

        const missing = await generate('missing-model', high.id);
        assert.equal(missing.response.status, 400);
        assert.equal(missing.body.error.code, 'FREE_GEMINI_NO_ROUTE');

        const invalidPreference = await generate('common', 'missing-channel');
        assert.equal(invalidPreference.response.status, 404);
        assert.equal(invalidPreference.body.error.code, 'FREE_GEMINI_CHANNEL_UNAVAILABLE');
    } finally {
        await Promise.allSettled([close(appServer), close(highUpstream), close(lowUpstream), close(allowUpstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('free Gemini denylist updates persistently block and then restore the only model route', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-denylist-route-'));
    globalThis.DATA_ROOT = dataRoot;
    const model = 'denylist-toggle-model';
    let modelListRequests = 0;
    let generationRequests = 0;

    const upstream = http.createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'GET') {
            modelListRequests++;
            response.end(JSON.stringify({
                models: [{ name: `models/${model}`, supportedGenerationMethods: ['generateContent'] }],
            }));
            return;
        }

        generationRequests++;
        await readRequestJson(request);
        response.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'route restored after denylist update' }] } }],
        }));
    });
    const appServer = await createChatAppServer();

    try {
        const upstreamUrl = await listen(upstream);
        const appUrl = await listen(appServer);
        const channel = await createFreeGeminiChannel({
            name: 'denylist-only-route',
            url: upstreamUrl,
            key: 'denylist-secret',
            modelPolicy: 'denylist',
            models: [model],
        });

        async function generate() {
            const response = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: 'free-gemini',
                    free_gemini_channel_id: channel.id,
                    model,
                    messages: [{ role: 'user', content: 'test the persisted denylist' }],
                    max_tokens: 10,
                    stream: false,
                }),
            });
            return { response, body: await response.json() };
        }

        const denied = await generate();
        assert.equal(denied.response.status, 400);
        assert.equal(denied.body.error.code, 'FREE_GEMINI_NO_ROUTE');
        assert.equal(modelListRequests, 0);
        assert.equal(generationRequests, 0);

        const updated = await updateFreeGeminiChannel(channel.id, {
            modelPolicy: 'denylist',
            models: [],
        });
        assert.equal(updated.modelPolicy, 'denylist');
        assert.deepEqual(updated.models, []);

        const restored = await generate();
        assert.equal(restored.response.status, 200);
        assert.equal(restored.body.choices[0].message.content, 'route restored after denylist update');
        assert.equal(modelListRequests, 1);
        assert.equal(generationRequests, 1);
    } finally {
        await Promise.allSettled([close(appServer), close(upstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('free Gemini retries transient model discovery and preserves its final upstream status', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-discovery-errors-'));
    globalThis.DATA_ROOT = dataRoot;
    const statuses = [429, 502, 503, 504];
    const attempts = new Map();

    const upstream = http.createServer((request, response) => {
        const key = new URL(request.url, 'http://127.0.0.1').searchParams.get('key');
        const status = Number(key?.replace('discovery-key-', ''));
        attempts.set(status, (attempts.get(status) || 0) + 1);
        response.statusCode = status;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ error: { message: `discovery failed with ${status}` } }));
    });
    const appServer = await createChatAppServer();

    try {
        const upstreamUrl = await listen(upstream);
        const appUrl = await listen(appServer);
        const channels = new Map();
        for (const status of statuses) {
            const model = `discovery-${status}`;
            channels.set(status, await createFreeGeminiChannel({
                name: model,
                url: upstreamUrl,
                key: `discovery-key-${status}`,
                modelPolicy: 'allowlist',
                models: [model],
                maxRetries: 1,
                timeoutMs: 5000,
            }));
        }

        for (const status of statuses) {
            const model = `discovery-${status}`;
            const result = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: 'free-gemini',
                    free_gemini_channel_id: channels.get(status).id,
                    model,
                    messages: [{ role: 'user', content: 'preserve discovery errors' }],
                    stream: false,
                }),
            });
            const body = await result.json();
            assert.equal(result.status, status);
            assert.equal(body.error.code, 'FREE_GEMINI_MODELS_FAILED');
            assert.equal(attempts.get(status), 2);
        }
    } finally {
        await Promise.allSettled([close(appServer), close(upstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('free Gemini retries only retryable failures and returns machine-readable 422 errors', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-errors-'));
    globalThis.DATA_ROOT = dataRoot;
    const attempts = new Map();

    const upstream = http.createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'GET') {
            response.end(JSON.stringify({
                models: ['retry', 'blocked', 'empty', 'whitespace', 'teapot', 'leak', 'stream-error'].map(id => ({
                    name: `models/${id}`,
                    supportedGenerationMethods: ['generateContent'],
                })),
            }));
            return;
        }

        await readRequestJson(request);
        const model = request.url.match(/\/models\/([^:]+):/)?.[1];
        attempts.set(model, (attempts.get(model) || 0) + 1);
        if (model === 'retry' && attempts.get(model) === 1) {
            response.statusCode = 503;
            response.end('temporarily unavailable');
            return;
        }
        if (model === 'blocked') {
            response.end(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }));
            return;
        }
        if (model === 'empty') {
            response.end(JSON.stringify({ candidates: [{ content: { parts: [] } }] }));
            return;
        }
        if (model === 'whitespace') {
            response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: ' \n\t ' }] } }] }));
            return;
        }
        if (model === 'teapot') {
            response.statusCode = 418;
            response.end('not json');
            return;
        }
        if (model === 'leak') {
            response.statusCode = 400;
            response.end(JSON.stringify({
                error: {
                    code: 'BAD_KEY',
                    message: 'encoded credential: secret%2fkey; fully encoded: %73%65%63%72%65%74%2f%6b%65%79; mixed: %73ecret%2fkey; nested: secret%252525252Fkey; unrelated: %3Cscript%3Ealert%281%29%3C%2Fscript%3E; https://private.example/path?key=secret%2Fkey',
                },
            }));
            return;
        }
        if (model === 'stream-error') {
            response.statusCode = 503;
            response.end('stream failed');
            return;
        }
        response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'retried' }] } }] }));
    });
    const appServer = await createChatAppServer();

    try {
        const upstreamUrl = await listen(upstream);
        const appUrl = await listen(appServer);
        await createFreeGeminiChannel({
            url: upstreamUrl,
            key: 'secret/key',
            maxRetries: 1,
        });

        async function generate(model, stream = false) {
            const result = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: 'free-gemini',
                    model,
                    messages: [{ role: 'user', content: 'test' }],
                    max_tokens: 10,
                    stream,
                }),
            });
            return { response: result, body: await result.json() };
        }

        const retried = await generate('retry');
        assert.equal(retried.response.status, 200);
        assert.equal(retried.body.choices[0].message.content, 'retried');
        assert.equal(attempts.get('retry'), 2);

        const blocked = await generate('blocked');
        assert.equal(blocked.response.status, 422);
        assert.equal(blocked.body.error.code, 'FREE_GEMINI_SAFETY_BLOCKED');

        const empty = await generate('empty');
        assert.equal(empty.response.status, 422);
        assert.equal(empty.body.error.code, 'FREE_GEMINI_EMPTY_OUTPUT');

        const whitespace = await generate('whitespace');
        assert.equal(whitespace.response.status, 422);
        assert.equal(whitespace.body.error.code, 'FREE_GEMINI_EMPTY_OUTPUT');

        const teapot = await generate('teapot');
        assert.equal(teapot.response.status, 502);
        assert.equal(teapot.body.error.code, 'FREE_GEMINI_UPSTREAM_ERROR');
        assert.equal(attempts.get('teapot'), 1);

        const leaked = await generate('leak');
        assert.equal(leaked.response.status, 400);
        assert.equal(leaked.body.error.code, 'FREE_GEMINI_UPSTREAM_ERROR');
        const leakedBody = JSON.stringify(leaked.body);
        assert.equal(leakedBody.includes('secret'), false);
        assert.equal(leakedBody.includes('secret%2fkey'), false);
        assert.equal(leakedBody.includes('secret%2Fkey'), false);
        assert.equal(leakedBody.includes('%73%65%63%72%65%74'), false);
        assert.equal(leakedBody.includes('%73ecret'), false);
        assert.equal(leakedBody.includes('secret%252525252Fkey'), false);
        assert.equal(leakedBody.includes('%3Cscript%3Ealert%281%29%3C%2Fscript%3E'), true);
        assert.equal(leakedBody.includes('<script>'), false);
        assert.equal(leakedBody.includes('private.example'), false);
        assert.equal(attempts.get('leak'), 1);

        const streamError = await generate('stream-error', true);
        assert.equal(streamError.response.status, 503);
        assert.equal(streamError.body.error.code, 'FREE_GEMINI_UPSTREAM_ERROR');
        assert.equal(attempts.get('stream-error'), 2);
    } finally {
        await Promise.allSettled([close(appServer), close(upstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('free Gemini rejects empty contents before cold model discovery and still routes normal text', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-cold-validation-'));
    globalThis.DATA_ROOT = dataRoot;
    let modelListRequests = 0;
    let generationRequests = 0;

    const upstream = http.createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'GET') {
            modelListRequests++;
            response.end(JSON.stringify({
                models: [{ name: 'models/cold-model', supportedGenerationMethods: ['generateContent'] }],
            }));
            return;
        }

        generationRequests++;
        await readRequestJson(request);
        response.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'cold route works' }] } }],
        }));
    });
    const appServer = await createChatAppServer();

    try {
        const upstreamUrl = await listen(upstream);
        const appUrl = await listen(appServer);
        await createFreeGeminiChannel({ url: upstreamUrl, key: 'cold-secret' });

        async function generate(messages) {
            return fetch(`${appUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: 'free-gemini',
                    model: 'cold-model',
                    messages,
                    max_tokens: 10,
                    stream: false,
                }),
            });
        }

        const emptyMessages = await generate([]);
        assert.equal(emptyMessages.status, 400);
        assert.equal((await emptyMessages.json()).error.code, 'FREE_GEMINI_INVALID_CONTENTS');

        const emptyConvertedContents = await generate([{ role: 'user', content: '' }]);
        assert.equal(emptyConvertedContents.status, 400);
        assert.equal((await emptyConvertedContents.json()).error.code, 'FREE_GEMINI_INVALID_CONTENTS');

        assert.equal(modelListRequests, 0);
        assert.equal(generationRequests, 0);

        const normalText = await generate([{ role: 'user', content: 'route after local validation' }]);
        assert.equal(normalText.status, 200);
        assert.equal((await normalText.json()).choices[0].message.content, 'cold route works');
        assert.equal(modelListRequests, 1);
        assert.equal(generationRequests, 1);
    } finally {
        await Promise.allSettled([close(appServer), close(upstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('free Gemini removes invalid image and schema configuration before the first upstream request', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-config-normalization-'));
    globalThis.DATA_ROOT = dataRoot;
    const generationBodies = [];

    const upstream = http.createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'GET') {
            response.end(JSON.stringify({
                models: [{
                    name: 'models/gemini-2.5-flash-image',
                    supportedGenerationMethods: ['generateContent'],
                }],
            }));
            return;
        }

        generationBodies.push(await readRequestJson(request));
        response.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'normalized' }] } }],
        }));
    });
    const appServer = await createChatAppServer();

    try {
        const upstreamUrl = await listen(upstream);
        const appUrl = await listen(appServer);
        await createFreeGeminiChannel({ url: upstreamUrl, key: 'config-secret', maxRetries: 0 });

        async function generate(extra = {}) {
            const result = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: 'free-gemini',
                    model: 'gemini-2.5-flash-image',
                    messages: [{ role: 'user', content: 'normalize config' }],
                    max_tokens: 10,
                    stream: false,
                    ...extra,
                }),
            });
            assert.equal(result.status, 200);
            await result.json();
        }

        await generate({ request_images: true });
        const missingImageParameters = generationBodies[0].generationConfig;
        assert.equal(Object.hasOwn(missingImageParameters, 'imageConfig'), false);
        assert.equal(JSON.stringify(missingImageParameters).includes('undefined'), false);

        await generate({
            request_images: true,
            request_image_aspect_ratio: '16:9',
        });
        assert.deepEqual(generationBodies[1].generationConfig.imageConfig, { aspectRatio: '16:9' });

        const schema = {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
        };
        await generate({ responseMimeType: 'application/json', responseSchema: schema });
        assert.equal(generationBodies[2].generationConfig.responseMimeType, 'application/json');
        assert.deepEqual(generationBodies[2].generationConfig.responseSchema, schema);

        await generate({ responseMimeType: 'text/plain', responseSchema: schema });
        assert.equal(generationBodies[3].generationConfig.responseMimeType, 'text/plain');
        assert.equal(Object.hasOwn(generationBodies[3].generationConfig, 'responseSchema'), false);

        await generate({ responseSchema: schema });
        assert.equal(Object.hasOwn(generationBodies[4].generationConfig, 'responseMimeType'), false);
        assert.equal(Object.hasOwn(generationBodies[4].generationConfig, 'responseSchema'), false);
        assert.equal(generationBodies.length, 5);
    } finally {
        await Promise.allSettled([close(appServer), close(upstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('free Gemini exhausts retries on a 503 channel before failing over to the next model route', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-generation-failover-'));
    globalThis.DATA_ROOT = dataRoot;
    const generationOrder = [];
    const attempts = { primary: 0, secondary: 0 };

    function makeUpstream(label, generate) {
        return http.createServer(async (request, response) => {
            response.setHeader('Content-Type', 'application/json');
            if (request.method === 'GET') {
                response.end(JSON.stringify({
                    models: [{ name: 'models/shared-503', supportedGenerationMethods: ['generateContent'] }],
                }));
                return;
            }

            await readRequestJson(request);
            generationOrder.push(label);
            attempts[label]++;
            generate(response);
        });
    }

    const primaryUpstream = makeUpstream('primary', response => {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: { message: 'primary unavailable' } }));
    });
    const secondaryUpstream = makeUpstream('secondary', response => {
        response.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'secondary recovered the request' }] } }],
        }));
    });
    const appServer = await createChatAppServer();

    try {
        const primaryUrl = await listen(primaryUpstream);
        const secondaryUrl = await listen(secondaryUpstream);
        const appUrl = await listen(appServer);
        const primary = await createFreeGeminiChannel({
            name: 'primary',
            url: primaryUrl,
            key: 'primary-secret',
            priority: 100,
            maxRetries: 2,
        });
        await createFreeGeminiChannel({
            name: 'secondary',
            url: secondaryUrl,
            key: 'secondary-secret',
            priority: 10,
            maxRetries: 0,
        });

        const result = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'free-gemini',
                free_gemini_channel_id: primary.id,
                model: 'shared-503',
                messages: [{ role: 'user', content: 'fail over after retries' }],
                max_tokens: 10,
                stream: false,
            }),
        });

        assert.equal(result.status, 200);
        assert.equal((await result.json()).choices[0].message.content, 'secondary recovered the request');
        assert.deepEqual(generationOrder, ['primary', 'primary', 'primary', 'secondary']);
        assert.deepEqual(attempts, { primary: 3, secondary: 1 });
    } finally {
        await Promise.allSettled([close(appServer), close(primaryUpstream), close(secondaryUpstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('free Gemini fails over on 429 and transient network errors but not deterministic 400 responses', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-failure-classes-'));
    globalThis.DATA_ROOT = dataRoot;
    const generationOrder = [];
    const models = ['route-429', 'route-network', 'route-400'];

    function modelFromRequest(request) {
        return request.url.match(/\/models\/([^:]+):/)?.[1];
    }

    const primaryUpstream = http.createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'GET') {
            response.end(JSON.stringify({
                models: models.map(id => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })),
            }));
            return;
        }

        await readRequestJson(request);
        const model = modelFromRequest(request);
        generationOrder.push(`primary:${model}`);
        if (model === 'route-network') {
            request.socket.destroy();
            return;
        }
        response.statusCode = model === 'route-429' ? 429 : 400;
        response.end(JSON.stringify({ error: { message: `${model} rejected by primary` } }));
    });
    const secondaryUpstream = http.createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'GET') {
            response.end(JSON.stringify({
                models: models.map(id => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })),
            }));
            return;
        }

        await readRequestJson(request);
        const model = modelFromRequest(request);
        generationOrder.push(`secondary:${model}`);
        response.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: `secondary:${model}` }] } }],
        }));
    });
    const appServer = await createChatAppServer();

    try {
        const primaryUrl = await listen(primaryUpstream);
        const secondaryUrl = await listen(secondaryUpstream);
        const appUrl = await listen(appServer);
        await createFreeGeminiChannel({
            name: 'failure-primary',
            url: primaryUrl,
            key: 'primary-secret',
            priority: 100,
            maxRetries: 0,
        });
        await createFreeGeminiChannel({
            name: 'failure-secondary',
            url: secondaryUrl,
            key: 'secondary-secret',
            priority: 10,
            maxRetries: 0,
        });

        async function generate(model) {
            const response = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: 'free-gemini',
                    model,
                    messages: [{ role: 'user', content: model }],
                    max_tokens: 10,
                    stream: false,
                }),
            });
            return { response, body: await response.json() };
        }

        const rateLimited = await generate('route-429');
        assert.equal(rateLimited.response.status, 200);
        assert.equal(rateLimited.body.choices[0].message.content, 'secondary:route-429');

        const networkFailure = await generate('route-network');
        assert.equal(networkFailure.response.status, 200);
        assert.equal(networkFailure.body.choices[0].message.content, 'secondary:route-network');

        const deterministicFailure = await generate('route-400');
        assert.equal(deterministicFailure.response.status, 400);
        assert.equal(deterministicFailure.body.error.code, 'FREE_GEMINI_UPSTREAM_ERROR');

        assert.deepEqual(generationOrder, [
            'primary:route-429',
            'secondary:route-429',
            'primary:route-network',
            'secondary:route-network',
            'primary:route-400',
        ]);
    } finally {
        await Promise.allSettled([close(appServer), close(primaryUpstream), close(secondaryUpstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('free Gemini user preference only reorders eligible channels and does not disable fallback', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-preference-order-'));
    globalThis.DATA_ROOT = dataRoot;
    const generationOrder = [];
    const models = ['preference-success', 'preference-fallback'];

    function makeUpstream(label, shouldFail) {
        return http.createServer(async (request, response) => {
            response.setHeader('Content-Type', 'application/json');
            if (request.method === 'GET') {
                response.end(JSON.stringify({
                    models: models.map(id => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })),
                }));
                return;
            }

            await readRequestJson(request);
            const model = request.url.match(/\/models\/([^:]+):/)?.[1];
            generationOrder.push(`${label}:${model}`);
            if (shouldFail(model)) {
                response.statusCode = 503;
                response.end(JSON.stringify({ error: { message: `${label} unavailable` } }));
                return;
            }
            response.end(JSON.stringify({
                candidates: [{ content: { parts: [{ text: `${label}:${model}` }] } }],
            }));
        });
    }

    const highUpstream = makeUpstream('high', () => false);
    const lowUpstream = makeUpstream('low', model => model === 'preference-fallback');
    const appServer = await createChatAppServer();

    try {
        const highUrl = await listen(highUpstream);
        const lowUrl = await listen(lowUpstream);
        const appUrl = await listen(appServer);
        const high = await createFreeGeminiChannel({
            name: 'preference-high',
            url: highUrl,
            key: 'high-secret',
            priority: 100,
            maxRetries: 0,
        });
        const low = await createFreeGeminiChannel({
            name: 'preference-low',
            url: lowUrl,
            key: 'low-secret',
            priority: 10,
            maxRetries: 0,
        });

        async function generate(model, preferredId) {
            const response = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: 'free-gemini',
                    free_gemini_channel_id: preferredId,
                    model,
                    messages: [{ role: 'user', content: model }],
                    max_tokens: 10,
                    stream: false,
                }),
            });
            return { response, body: await response.json() };
        }

        const defaultOrder = await generate('preference-success');
        assert.equal(defaultOrder.response.status, 200);
        assert.equal(defaultOrder.body.choices[0].message.content, 'high:preference-success');

        const preferredOrder = await generate('preference-success', low.id);
        assert.equal(preferredOrder.response.status, 200);
        assert.equal(preferredOrder.body.choices[0].message.content, 'low:preference-success');

        const preferredFallback = await generate('preference-fallback', low.id);
        assert.equal(preferredFallback.response.status, 200);
        assert.equal(preferredFallback.body.choices[0].message.content, 'high:preference-fallback');

        assert.deepEqual(generationOrder, [
            'high:preference-success',
            'low:preference-success',
            'low:preference-fallback',
            'high:preference-fallback',
        ]);
        assert.notEqual(high.id, low.id);
    } finally {
        await Promise.allSettled([close(appServer), close(highUpstream), close(lowUpstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('ordinary MakerSuite streaming preserves an upstream 429 status and body before any SSE bytes are sent', async () => {
    const upstreamBody = JSON.stringify({ error: { code: 429, message: 'ordinary makersuite rate limit' } });
    let generationRequests = 0;
    const upstream = http.createServer(async (request, response) => {
        generationRequests++;
        await readRequestJson(request);
        response.statusCode = 429;
        response.setHeader('Content-Type', 'application/json');
        response.end(upstreamBody);
    });
    const appServer = await createChatAppServer();

    try {
        const upstreamUrl = await listen(upstream);
        const appUrl = await listen(appServer);
        const result = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'makersuite',
                reverse_proxy: upstreamUrl,
                proxy_password: 'ordinary-proxy-key',
                model: 'gemini-ordinary',
                messages: [{ role: 'user', content: 'do not remap ordinary streaming errors' }],
                max_tokens: 10,
                stream: true,
            }),
        });

        assert.equal(result.status, 429);
        assert.equal(await result.text(), upstreamBody);
        assert.equal(generationRequests, 1);
    } finally {
        await Promise.allSettled([close(appServer), close(upstream)]);
    }
});

test('free Gemini deadline remains active while reading the response body and does not retry a deadline abort', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-deadline-'));
    globalThis.DATA_ROOT = dataRoot;
    let generationAttempts = 0;

    const upstream = http.createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'GET') {
            response.end(JSON.stringify({
                models: [{ name: 'models/slow-body', supportedGenerationMethods: ['generateContent'] }],
            }));
            return;
        }

        generationAttempts++;
        await readRequestJson(request);
        response.writeHead(200);
        response.flushHeaders();
        const timer = setTimeout(() => {
            response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'too late' }] } }] }));
        }, 5500);
        response.once('close', () => clearTimeout(timer));
    });
    const appServer = await createChatAppServer();

    try {
        const upstreamUrl = await listen(upstream);
        const appUrl = await listen(appServer);
        await createFreeGeminiChannel({
            url: upstreamUrl,
            key: 'secret',
            timeoutMs: 5000,
            maxRetries: 3,
        });

        const result = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'free-gemini',
                model: 'slow-body',
                messages: [{ role: 'user', content: 'test deadline' }],
                max_tokens: 10,
                stream: false,
            }),
        });
        assert.equal(result.status, 504);
        assert.equal((await result.json()).error.code, 'FREE_GEMINI_TIMEOUT');
        assert.equal(generationAttempts, 1);
    } finally {
        await Promise.allSettled([close(appServer), close(upstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('free Gemini preserves time for an equal-timeout fallback after the first route hangs', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-timeout-failover-'));
    globalThis.DATA_ROOT = dataRoot;
    const generationOrder = [];
    const model = 'shared-timeout';

    function makeUpstream(label, generate) {
        return http.createServer(async (request, response) => {
            response.setHeader('Content-Type', 'application/json');
            if (request.method === 'GET') {
                response.end(JSON.stringify({
                    models: [{ name: `models/${model}`, supportedGenerationMethods: ['generateContent'] }],
                }));
                return;
            }

            await readRequestJson(request);
            generationOrder.push(label);
            generate(response);
        });
    }

    const primaryUpstream = makeUpstream('primary', () => {
        // Deliberately leave the response pending until the application aborts this route.
    });
    const secondaryUpstream = makeUpstream('secondary', response => {
        response.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'secondary completed after timeout' }] } }],
        }));
    });
    const appServer = await createChatAppServer();

    try {
        const primaryUrl = await listen(primaryUpstream);
        const secondaryUrl = await listen(secondaryUpstream);
        const appUrl = await listen(appServer);
        const primary = await createFreeGeminiChannel({
            name: 'timeout-primary',
            url: primaryUrl,
            key: 'primary-secret',
            priority: 100,
            timeoutMs: 5000,
            maxRetries: 0,
        });
        await createFreeGeminiChannel({
            name: 'timeout-secondary',
            url: secondaryUrl,
            key: 'secondary-secret',
            priority: 10,
            timeoutMs: 5000,
            maxRetries: 0,
        });

        const startedAt = Date.now();
        const result = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'free-gemini',
                free_gemini_channel_id: primary.id,
                model,
                messages: [{ role: 'user', content: 'use the fallback within the shared deadline' }],
                max_tokens: 10,
                stream: false,
            }),
        });
        const elapsedMs = Date.now() - startedAt;

        assert.equal(result.status, 200);
        assert.equal((await result.json()).choices[0].message.content, 'secondary completed after timeout');
        assert.deepEqual(generationOrder, ['primary', 'secondary']);
        assert.ok(elapsedMs < 6000, `expected a bounded request duration, got ${elapsedMs}ms`);
    } finally {
        await Promise.allSettled([close(appServer), close(primaryUpstream), close(secondaryUpstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('free Gemini does not fail over on malformed HTTP 200 bodies but still fails over on HTTP 503', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-malformed-failover-'));
    globalThis.DATA_ROOT = dataRoot;
    const generationOrder = [];
    const models = ['malformed-200', 'real-503'];

    function modelFromRequest(request) {
        return request.url.match(/\/models\/([^:]+):/)?.[1];
    }

    const primaryUpstream = http.createServer(async (request, response) => {
        if (request.method === 'GET') {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({
                models: models.map(id => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })),
            }));
            return;
        }

        await readRequestJson(request);
        const model = modelFromRequest(request);
        generationOrder.push(`primary:${model}`);
        if (model === 'malformed-200') {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'text/plain');
            response.end('not a Gemini JSON response');
            return;
        }
        response.statusCode = 503;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ error: { message: 'primary temporarily unavailable' } }));
    });
    const secondaryUpstream = http.createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'GET') {
            response.end(JSON.stringify({
                models: models.map(id => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })),
            }));
            return;
        }

        await readRequestJson(request);
        const model = modelFromRequest(request);
        generationOrder.push(`secondary:${model}`);
        response.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: `secondary:${model}` }] } }],
        }));
    });
    const appServer = await createChatAppServer();

    try {
        const primaryUrl = await listen(primaryUpstream);
        const secondaryUrl = await listen(secondaryUpstream);
        const appUrl = await listen(appServer);
        const primary = await createFreeGeminiChannel({
            name: 'malformed-primary',
            url: primaryUrl,
            key: 'primary-secret',
            priority: 100,
            maxRetries: 0,
        });
        await createFreeGeminiChannel({
            name: 'malformed-secondary',
            url: secondaryUrl,
            key: 'secondary-secret',
            priority: 10,
            maxRetries: 0,
        });

        async function generate(model) {
            const response = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: 'free-gemini',
                    free_gemini_channel_id: primary.id,
                    model,
                    messages: [{ role: 'user', content: model }],
                    max_tokens: 10,
                    stream: false,
                }),
            });
            return { response, body: await response.json() };
        }

        const malformed = await generate('malformed-200');
        assert.equal(malformed.response.status, 502);
        assert.equal(malformed.body.error.code, 'FREE_GEMINI_INVALID_RESPONSE');
        assert.deepEqual(generationOrder, ['primary:malformed-200']);

        const unavailable = await generate('real-503');
        assert.equal(unavailable.response.status, 200);
        assert.equal(unavailable.body.choices[0].message.content, 'secondary:real-503');
        assert.deepEqual(generationOrder, [
            'primary:malformed-200',
            'primary:real-503',
            'secondary:real-503',
        ]);
    } finally {
        await Promise.allSettled([close(appServer), close(primaryUpstream), close(secondaryUpstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('ordinary Vertex streaming preserves an upstream 429 status and body before any SSE bytes are sent', async () => {
    const upstreamBody = JSON.stringify({ error: { code: 429, message: 'ordinary vertex rate limit' } });
    const upstreamRequests = [];
    const upstream = http.createServer(async (request, response) => {
        upstreamRequests.push(request.url);
        await readRequestJson(request);
        response.statusCode = 429;
        response.setHeader('Content-Type', 'application/json');
        response.end(upstreamBody);
    });
    const appServer = await createChatAppServer();

    try {
        const upstreamUrl = await listen(upstream);
        const appUrl = await listen(appServer);
        const result = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'vertexai',
                reverse_proxy: upstreamUrl,
                proxy_password: 'ordinary-vertex-proxy-key',
                model: 'gemini-vertex',
                messages: [{ role: 'user', content: 'preserve the Vertex streaming error' }],
                max_tokens: 10,
                stream: true,
            }),
        });

        assert.equal(result.status, 429);
        assert.equal(await result.text(), upstreamBody);
        assert.deepEqual(upstreamRequests, [
            '/v1/publishers/google/models/gemini-vertex:streamGenerateContent?alt=sse',
        ]);
    } finally {
        await Promise.allSettled([close(appServer), close(upstream)]);
    }
});

test('free Gemini status returns fast channel models within the discovery cap when another channel hangs', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-status-discovery-cap-'));
    globalThis.DATA_ROOT = dataRoot;
    let fastModelRequests = 0;
    let hangingModelRequests = 0;

    const fastUpstream = http.createServer((request, response) => {
        fastModelRequests++;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
            models: [{
                name: 'models/fast-status-model',
                supportedGenerationMethods: ['generateContent'],
            }],
        }));
    });
    const hangingUpstream = http.createServer((request, response) => {
        hangingModelRequests++;
        request.once('close', () => response.destroy());
        // Keep both the response headers and body pending beyond the discovery cap.
    });
    const appServer = await createChatAppServer();

    try {
        const fastUrl = await listen(fastUpstream);
        const hangingUrl = await listen(hangingUpstream);
        const appUrl = await listen(appServer);
        const fastChannel = await createFreeGeminiChannel({
            name: 'fast-status',
            url: fastUrl,
            key: 'fast-secret',
            priority: 10,
            timeoutMs: 5000,
            maxRetries: 0,
        });
        await createFreeGeminiChannel({
            name: 'hanging-status',
            url: hangingUrl,
            key: 'hanging-secret',
            priority: 100,
            timeoutMs: 5000,
            maxRetries: 0,
        });

        const startedAt = Date.now();
        const result = await fetch(`${appUrl}/api/backends/chat-completions/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_completion_source: 'free-gemini' }),
        });
        const elapsedMs = Date.now() - startedAt;

        assert.equal(result.status, 200);
        assert.deepEqual(await result.json(), {
            data: [{
                id: 'fast-status-model',
                channel_id: fastChannel.id,
                channel_name: 'fast-status',
                inputTokenLimit: null,
                outputTokenLimit: 65536,
            }],
        });
        assert.equal(fastModelRequests, 1);
        assert.equal(hangingModelRequests, 1);
        assert.ok(elapsedMs < 3500, `status aggregation exceeded the discovery cap: ${elapsedMs}ms`);
    } finally {
        hangingUpstream.closeAllConnections?.();
        await Promise.allSettled([close(appServer), close(fastUpstream), close(hangingUpstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('free Gemini streaming fails over before committing an empty 200 when the first route has no body byte', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-stream-first-byte-failover-'));
    globalThis.DATA_ROOT = dataRoot;
    const generationOrder = [];
    const model = 'shared-stream-first-byte';

    function sendModels(response) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
            models: [{ name: `models/${model}`, supportedGenerationMethods: ['generateContent'] }],
        }));
    }

    const primaryUpstream = http.createServer(async (request, response) => {
        if (request.method === 'GET') {
            sendModels(response);
            return;
        }

        await readRequestJson(request);
        generationOrder.push('primary');
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.flushHeaders();
        request.once('close', () => response.destroy());
        // Headers are available, but no body byte is sent before the candidate budget expires.
    });
    const secondaryEvent = 'data: {"candidates":[{"content":{"parts":[{"text":"secondary streamed answer"}]}}]}\n\n';
    const secondaryUpstream = http.createServer(async (request, response) => {
        if (request.method === 'GET') {
            sendModels(response);
            return;
        }

        await readRequestJson(request);
        generationOrder.push('secondary');
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(secondaryEvent);
    });
    const appServer = await createChatAppServer();

    try {
        const primaryUrl = await listen(primaryUpstream);
        const secondaryUrl = await listen(secondaryUpstream);
        const appUrl = await listen(appServer);
        const primary = await createFreeGeminiChannel({
            name: 'stream-primary',
            url: primaryUrl,
            key: 'primary-secret',
            priority: 100,
            timeoutMs: 5000,
            maxRetries: 0,
        });
        await createFreeGeminiChannel({
            name: 'stream-secondary',
            url: secondaryUrl,
            key: 'secondary-secret',
            priority: 10,
            timeoutMs: 5000,
            maxRetries: 0,
        });

        const startedAt = Date.now();
        const result = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'free-gemini',
                free_gemini_channel_id: primary.id,
                model,
                messages: [{ role: 'user', content: 'stream with a safe fallback' }],
                max_tokens: 10,
                stream: true,
            }),
        });
        const body = await result.text();
        const elapsedMs = Date.now() - startedAt;

        assert.equal(result.status, 200);
        assert.equal(body, secondaryEvent);
        assert.deepEqual(generationOrder, ['primary', 'secondary']);
        assert.ok(elapsedMs < 6000, `stream failover exceeded the bounded deadline: ${elapsedMs}ms`);
    } finally {
        primaryUpstream.closeAllConnections?.();
        await Promise.allSettled([close(appServer), close(primaryUpstream), close(secondaryUpstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('free Gemini streaming does not try a second route after the first route emits SSE', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-stream-committed-'));
    globalThis.DATA_ROOT = dataRoot;
    const generationOrder = [];
    const model = 'shared-stream-committed';
    const primaryEvent = 'data: {"candidates":[{"content":{"parts":[{"text":"primary committed answer"}]}}]}\n\n';

    function makeUpstream(label) {
        return http.createServer(async (request, response) => {
            if (request.method === 'GET') {
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({
                    models: [{ name: `models/${model}`, supportedGenerationMethods: ['generateContent'] }],
                }));
                return;
            }

            await readRequestJson(request);
            generationOrder.push(label);
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.end(label === 'primary'
                ? primaryEvent
                : 'data: {"candidates":[{"content":{"parts":[{"text":"duplicate secondary answer"}]}}]}\n\n');
        });
    }

    const primaryUpstream = makeUpstream('primary');
    const secondaryUpstream = makeUpstream('secondary');
    const appServer = await createChatAppServer();

    try {
        const primaryUrl = await listen(primaryUpstream);
        const secondaryUrl = await listen(secondaryUpstream);
        const appUrl = await listen(appServer);
        const primary = await createFreeGeminiChannel({
            name: 'committed-primary',
            url: primaryUrl,
            key: 'primary-secret',
            priority: 100,
            timeoutMs: 5000,
            maxRetries: 0,
        });
        await createFreeGeminiChannel({
            name: 'committed-secondary',
            url: secondaryUrl,
            key: 'secondary-secret',
            priority: 10,
            timeoutMs: 5000,
            maxRetries: 0,
        });

        const result = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'free-gemini',
                free_gemini_channel_id: primary.id,
                model,
                messages: [{ role: 'user', content: 'do not duplicate an established stream' }],
                max_tokens: 10,
                stream: true,
            }),
        });

        assert.equal(result.status, 200);
        assert.equal(await result.text(), primaryEvent);
        assert.deepEqual(generationOrder, ['primary']);
    } finally {
        await Promise.allSettled([close(appServer), close(primaryUpstream), close(secondaryUpstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('free Gemini emits a safe machine-readable SSE error after a committed stream fails', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-stream-error-event-'));
    globalThis.DATA_ROOT = dataRoot;
    const generationOrder = [];
    const model = 'stream-error-event';
    const primaryEvent = 'data: {"candidates":[{"content":{"parts":[{"text":"partial answer"}]}}]}\n\n';

    function sendModels(response) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
            models: [{ name: `models/${model}`, supportedGenerationMethods: ['generateContent'] }],
        }));
    }

    const primaryUpstream = http.createServer(async (request, response) => {
        if (request.method === 'GET') {
            sendModels(response);
            return;
        }

        await readRequestJson(request);
        generationOrder.push('primary');
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(primaryEvent);
        setTimeout(() => response.destroy(new Error('sensitive-upstream-detail')), 20);
    });
    const secondaryUpstream = http.createServer(async (request, response) => {
        if (request.method === 'GET') {
            sendModels(response);
            return;
        }

        await readRequestJson(request);
        generationOrder.push('secondary');
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('data: {"candidates":[{"content":{"parts":[{"text":"duplicate answer"}]}}]}\n\n');
    });
    const appServer = await createChatAppServer();

    try {
        const primaryUrl = await listen(primaryUpstream);
        const secondaryUrl = await listen(secondaryUpstream);
        const appUrl = await listen(appServer);
        const primary = await createFreeGeminiChannel({
            name: 'stream-error-primary',
            url: primaryUrl,
            key: 'primary-secret',
            priority: 100,
            maxRetries: 0,
        });
        await createFreeGeminiChannel({
            name: 'stream-error-secondary',
            url: secondaryUrl,
            key: 'secondary-secret',
            priority: 10,
            maxRetries: 0,
        });

        const result = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'free-gemini',
                free_gemini_channel_id: primary.id,
                model,
                messages: [{ role: 'user', content: 'stream a partial result' }],
                stream: true,
            }),
        });
        const body = await result.text();
        const events = body.trim().split('\n\n');
        const errorEvent = JSON.parse(events.at(-1).replace(/^data: /, ''));

        assert.equal(result.status, 200);
        assert.equal(`${events[0]}\n\n`, primaryEvent);
        assert.deepEqual(errorEvent, {
            error: {
                code: 'FREE_GEMINI_STREAM_FAILED',
                message: '免费 Gemini 流式响应转发失败。',
            },
        });
        assert.equal(body.includes('primary-secret'), false);
        assert.equal(body.includes('sensitive-upstream-detail'), false);
        assert.deepEqual(generationOrder, ['primary']);
    } finally {
        await Promise.allSettled([close(appServer), close(primaryUpstream), close(secondaryUpstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});
