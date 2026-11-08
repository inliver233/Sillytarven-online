import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';
import fetch from 'node-fetch';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-usage-'));
globalThis.DATA_ROOT = dataRoot;
after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

// Prices as fetched from models.dev (fresh, so nothing is downloaded during the tests).
fs.mkdirSync(path.join(dataRoot, '_global'), { recursive: true });
fs.writeFileSync(path.join(dataRoot, '_global', 'model-prices.json'), JSON.stringify({
    fetchedAt: Date.now(),
    providers: {
        'google-vertex': { 'gemini-4-argon': { input: 2, output: 10, cache_read: 0.1 } },
        google: { 'gemini-pro-latest': { input: 2, output: 12, cache_read: 0.2, tiers: [{ input: 4, output: 18, cache_read: 0.4, tier: { type: 'context', size: 200000 } }] } },
        anthropic: { 'claude-sonnet-4-5': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
    },
}));

const { UsageReader, findPrice, priceUsage, meterGeneration, router, startUsageMeter } = await import('../src/usage-meter.js');
const { forwardFetchResponse } = await import('../src/util.js');
startUsageMeter();

const sse = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
/** Feeds text in awkward pieces: split inside lines and inside multi-byte characters. */
function feedInPieces(reader, text) {
    const bytes = Buffer.from(text, 'utf8');
    for (let i = 0; i < bytes.length; i += 7) reader.feed(bytes.subarray(i, i + 7));
    reader.end();
}

test('usage is read from Gemini, OpenAI-style and Claude answers, streamed or not', () => {
    const gemini = new UsageReader();
    feedInPieces(gemini, sse([
        { candidates: [{ content: { parts: [{ text: '你好，' }] } }], usageMetadata: { promptTokenCount: 300000, candidatesTokenCount: 5 } },
        { candidates: [{ content: { parts: [{ text: '旅行者。' }] } }], usageMetadata: { promptTokenCount: 300000, cachedContentTokenCount: 250000, candidatesTokenCount: 11000, thoughtsTokenCount: 3000 } },
    ]));
    assert.deepEqual(gemini.result(), { input: 300000, cached: 250000, cacheWrite: 0, output: 14000, reasoning: 3000 });

    const openai = new UsageReader();
    feedInPieces(openai, `${sse([
        { choices: [{ delta: { content: 'Hi' } }] },
        { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 1000 }, completion_tokens_details: { reasoning_tokens: 100 } } },
    ])}data: [DONE]\n\n`);
    assert.deepEqual(openai.result(), { input: 1200, cached: 1000, cacheWrite: 0, output: 300, reasoning: 100 });

    const openrouter = new UsageReader();
    openrouter.observe({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0042 } });
    assert.equal(openrouter.result().reportedCost, 0.0042);

    const claude = new UsageReader();
    feedInPieces(claude, [
        'event: message_start', `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 1000, output_tokens: 1 } } })}`, '',
        'event: content_block_delta', `data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: 'usage of words' } })}`, '',
        'event: message_delta', `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 700 } })}`, '',
    ].join('\n'));
    assert.deepEqual(claude.result(), { input: 5050, cached: 4000, cacheWrite: 1000, output: 700, reasoning: 0 });

    const nothing = new UsageReader();
    feedInPieces(nothing, sse([{ choices: [{ delta: { content: 'a relay that reports no usage' } }] }]));
    assert.equal(nothing.result(), null);
});

test('official prices: cache, context tiers, and none through a reverse proxy or for relays', () => {
    const vertex = findPrice('vertexai', 'gemini-4-argon');
    assert.equal(vertex.provider, 'google-vertex');
    // 50k plain + 250k cached input, 14k output (thinking included)
    assert.equal(priceUsage(vertex.cost, { input: 300000, cached: 250000, cacheWrite: 0, output: 14000, reasoning: 3000 }).toFixed(4), (0.1 + 0.025 + 0.14).toFixed(4));
    const pro = findPrice('makersuite', 'models/gemini-pro-latest');
    assert.equal(priceUsage(pro.cost, { input: 100000, cached: 0, cacheWrite: 0, output: 1000, reasoning: 0 }).toFixed(4), (0.2 + 0.012).toFixed(4));
    assert.equal(priceUsage(pro.cost, { input: 300000, cached: 0, cacheWrite: 0, output: 1000, reasoning: 0 }).toFixed(4), (1.2 + 0.018).toFixed(4));
    const sonnet = findPrice('claude', 'claude-sonnet-4-5');
    assert.equal(priceUsage(sonnet.cost, { input: 5050, cached: 4000, cacheWrite: 1000, output: 700, reasoning: 0 }).toFixed(6), ((50 * 3 + 4000 * 0.3 + 1000 * 3.75 + 700 * 15) / 1e6).toFixed(6));
    assert.equal(findPrice('vertexai', 'gemini-4-argon', { reverse_proxy: 'https://relay.example' }), null);
    assert.equal(findPrice('custom', 'gemini-4-argon'), null);
    assert.equal(findPrice('vertexai', '抗截断-pg-gemini-4-argon'), null);
});

test('a generation is metered from the stream and can be read back by its id', async t => {
    // The AI service: streams Gemini-style events.
    const upstream = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(sse([{ candidates: [{ content: { parts: [{ text: 'a' }] } }], usageMetadata: { promptTokenCount: 100000, candidatesTokenCount: 10 } }]));
        setTimeout(() => response.end(sse([{ candidates: [{ content: { parts: [{ text: 'b' }] } }], usageMetadata: { promptTokenCount: 100000, candidatesTokenCount: 2000, thoughtsTokenCount: 500 } }])), 20);
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => upstream.close(resolve)));

    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle: 'meter-test' } };
        next();
    });
    app.post('/generate', async (request, response) => {
        meterGeneration(request, response);
        if (request.body.fail) return response.send({ error: { message: 'quota' } });
        const answer = await fetch(`http://127.0.0.1:${upstream.address().port}/`);
        return forwardFetchResponse(answer, response);
    });
    app.use('/api/usage', router);
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;

    const generate = (id, body) => fetch(`${base}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Usage-Id': id },
        body: JSON.stringify({ chat_completion_source: 'vertexai', model: 'gemini-4-argon', stream: true, ...body }),
    }).then(response => response.text());
    const summary = async id => {
        // Recorded when the response closes; give it a moment.
        for (let i = 0; i < 50; i++) {
            const data = await (await fetch(`${base}/api/usage/summary?id=${id}`)).json();
            if (!id || data.item) return data;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error(`no entry ${id}`);
    };

    const text = await generate('first-1');
    assert.match(text, /"text":"b"/, 'the answer itself passes through unchanged');
    const first = await summary('first-1');
    assert.deepEqual(
        { input: first.item.input, output: first.item.output, reasoning: first.item.reasoning, priced: first.item.priced, provider: first.item.provider },
        { input: 100000, output: 2500, reasoning: 500, priced: 'official', provider: 'google-vertex' },
    );
    assert.equal(first.item.cost.toFixed(4), (0.2 + 0.025).toFixed(4));

    // A relay: tokens, no price. A failure answered as { error }: not counted.
    await generate('relay-1', { chat_completion_source: 'custom', model: '抗截断-pg-gemini-4-argon' });
    const relay = await summary('relay-1');
    assert.equal(relay.item.cost, null);
    assert.equal(relay.item.input, 100000);
    await generate('failed-1', { fail: true });

    const { today, days } = await summary('');
    assert.equal(today.requests, 2);
    assert.equal(today.priced, 1);
    assert.equal(today.cost.toFixed(4), (0.225).toFixed(4));
    assert.equal(today.input, 200000);
    assert.deepEqual(Object.keys(today.models).sort(), ['custom|抗截断-pg-gemini-4-argon', 'vertexai|gemini-4-argon']);
    assert.equal(days.length, 7);
    assert.equal(days.at(-1).requests, 2);
    assert.equal(days.at(-1).models, undefined);
});
