import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { createFreeGeminiChannel } from '../src/free-gemini-channels.js';
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

test('free Gemini status and generation use only server-side channel credentials', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-chat-'));
    globalThis.DATA_ROOT = dataRoot;

    const upstreamRequests = [];
    const upstream = http.createServer((request, response) => {
        upstreamRequests.push(request.url);
        response.setHeader('Content-Type', 'application/json');

        if (request.method === 'GET' && request.url === '/v1beta/models?key=server-secret') {
            response.end(JSON.stringify({
                models: [{
                    name: 'models/gemini-test',
                    supportedGenerationMethods: ['generateContent'],
                }],
            }));
            return;
        }

        if (request.method === 'POST' && request.url === '/v1beta/models/gemini-test:generateContent?key=server-secret') {
            response.end(JSON.stringify({
                candidates: [{ content: { parts: [{ text: '福利渠道可用' }] } }],
            }));
            return;
        }

        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'unexpected request' }));
    });

    const { router: chatCompletionsRouter } = await import('../src/endpoints/backends/chat-completions.js');
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((request, _response, next) => {
        request.user = { directories: {}, profile: { handle: 'member' } };
        next();
    });
    app.use('/api/backends/chat-completions', chatCompletionsRouter);
    const appServer = http.createServer(app);

    try {
        const upstreamUrl = await listen(upstream);
        const appUrl = await listen(appServer);
        const channel = await createFreeGeminiChannel({
            name: 'free-gemini',
            url: upstreamUrl,
            key: 'server-secret',
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
        assert.deepEqual(await statusResponse.json(), { data: [{ id: 'gemini-test' }] });

        const generateResponse = await fetch(`${appUrl}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'free-gemini',
                free_gemini_channel_id: channel.id,
                reverse_proxy: 'http://127.0.0.1:1',
                proxy_password: 'attacker-value',
                model: 'gemini-test',
                messages: [{ role: 'user', content: '你好' }],
                max_tokens: 32,
                temperature: 1,
                top_p: 1,
                stream: false,
            }),
        });
        assert.equal(generateResponse.status, 200);
        const generated = await generateResponse.json();
        assert.equal(generated.choices[0].message.content, '福利渠道可用');
        assert.deepEqual(upstreamRequests, [
            '/v1beta/models?key=server-secret',
            '/v1beta/models/gemini-test:generateContent?key=server-secret',
        ]);
        assert.equal(JSON.stringify(upstreamRequests).includes('attacker-value'), false);
    } finally {
        await Promise.allSettled([close(appServer), close(upstream)]);
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});
