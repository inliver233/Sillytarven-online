import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../config.yaml', import.meta.url)));

const {
    router,
    tokenizerTestHooks,
} = await import('../src/endpoints/tokenizers.js');

const TOKENIZER_TYPES = [
    ['SentencePieceTokenizer', tokenizerTestHooks.SentencePieceTokenizer],
    ['WebTokenizer', tokenizerTestHooks.WebTokenizer],
];

function deferred() {
    let resolve;
    const promise = new Promise(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

async function withTokenizerServer(callback) {
    const app = express();
    app.use(express.json());
    app.use('/api/tokenizers', router);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    try {
        const address = server.address();
        return await callback(`http://127.0.0.1:${address.port}/api/tokenizers`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

async function postJson(baseUrl, path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const responseBody = response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : await response.text();
    return { response, body: responseBody };
}

test('tokenizer wrappers single-flight concurrent first loads and publish only complete instances', async t => {
    for (const [name, TokenizerClass] of TOKENIZER_TYPES) {
        await t.test(name, async () => {
            const loadGate = deferred();
            const instance = { ready: true };
            let loads = 0;
            const tokenizer = new TokenizerClass(`${name}.model`, undefined, async () => {
                loads++;
                await loadGate.promise;
                return instance;
            });

            const pending = Array.from({ length: 8 }, () => tokenizer.get());
            assert.equal(pending.every(promise => promise === pending[0]), true);
            await Promise.resolve();
            assert.equal(loads, 1);

            loadGate.resolve();
            const loaded = await Promise.all(pending);
            assert.equal(loaded.every(value => value === instance), true);
            assert.equal(await tokenizer.get(), instance);
            assert.equal(loads, 1);
        });
    }
});

test('tokenizer wrappers clear failed loads for retry without logging failure contents', async t => {
    const secret = 'private prompt text must not be logged';
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);

    try {
        for (const [name, TokenizerClass] of TOKENIZER_TYPES) {
            await t.test(name, async () => {
                const recovered = { ready: true };
                let loads = 0;
                const tokenizer = new TokenizerClass(`${name}.model`, undefined, async () => {
                    loads++;
                    if (loads === 1) {
                        throw new Error(secret);
                    }
                    return recovered;
                });

                const first = tokenizer.get();
                const shared = tokenizer.get();
                assert.equal(shared, first);
                assert.deepEqual(await Promise.all([first, shared]), [null, null]);
                assert.equal(loads, 1);

                assert.equal(await tokenizer.get(), recovered);
                assert.equal(loads, 2);
            });
        }
    } finally {
        console.warn = originalWarn;
    }

    assert.equal(JSON.stringify(warnings).includes(secret), false);
    assert.equal(warnings.length, TOKENIZER_TYPES.length);
    for (const warning of warnings) {
        assert.equal(warning[0], 'Tokenizer operation failed.');
        assert.deepEqual(Object.keys(warning[1]).sort(), ['model', 'size', 'type']);
    }
});

test('OpenAI count validates message arrays and counts structured values deterministically', async () => {
    await withTokenizerServer(async baseUrl => {
        const invalidObject = await postJson(baseUrl, '/openai/count?model=gpt-4', { role: 'user', content: 'hello' });
        assert.equal(invalidObject.response.status, 400);

        const invalidItem = await postJson(baseUrl, '/openai/count?model=gpt-4', ['not-a-message']);
        assert.equal(invalidItem.response.status, 400);

        const empty = await postJson(baseUrl, '/openai/count?model=gpt-4', []);
        assert.equal(empty.response.status, 200);
        assert.deepEqual(empty.body, { token_count: 3 });

        const messages = [{
            role: 'user',
            content: [
                { type: 'text', text: 'inspect this' },
                { image_url: { detail: 'low', url: 'data:image/png;base64,AAAA' }, type: 'image_url' },
            ],
            tool_calls: [{
                type: 'function',
                function: { arguments: '{"city":"Paris"}', name: 'weather' },
                id: 'call-1',
            }],
            metadata: { z: 2, a: 1 },
            name: 'structured-message',
        }];
        const normalized = tokenizerTestHooks.normalizeTokenCountMessages(messages);
        assert.deepEqual(messages[0].metadata, { z: 2, a: 1 });
        assert.equal(normalized[0].metadata, '{"a":1,"z":2}');

        const structured = await postJson(baseUrl, '/openai/count?model=gpt-4', messages);
        const preNormalized = await postJson(baseUrl, '/openai/count?model=gpt-4', normalized);
        assert.equal(structured.response.status, 200);
        assert.deepEqual(structured.body, preNormalized.body);
        assert.ok(structured.body.token_count > empty.body.token_count);
    });
});
