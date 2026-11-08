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
const configPath = path.join(dataRoot, 'config.yaml');
fs.writeFileSync(configPath, 'dataRoot: ./data\n');
const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(configPath);

// Prices as fetched from models.dev (fresh, so nothing is downloaded during the tests).
fs.mkdirSync(path.join(dataRoot, '_global'), { recursive: true });
fs.writeFileSync(path.join(dataRoot, '_global', 'model-prices.json'), JSON.stringify({
    fetchedAt: Date.now(),
    providers: {
        'google-vertex': { 'gemini-4-argon': { input: 2, output: 10, cache_read: 0.1 } },
        google: { 'gemini-4-argon': { input: 2, output: 10, cache_read: 0.1 }, 'gemini-pro-latest': { input: 2, output: 12, cache_read: 0.2, tiers: [{ input: 4, output: 18, cache_read: 0.4, tier: { type: 'context', size: 200000 } }] } },
        anthropic: { 'claude-sonnet-4-5': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
        opencode: { 'gemini-4-argon': { input: 2.5, output: 12 } },
    },
    catalog: [{ provider: 'opencode', name: 'OpenCode Zen', base: 'opencode.ai/inference/openai/v1' }],
}));

const { UsageReader, applyPricing, catalogPrice, findPrice, officialNames, officialPrice, priceUsage, pricingHint, meterGeneration, relayStreamsUsage, router, startUsageMeter } = await import('../src/usage-meter.js');
const { resetRelayBilling } = await import('../src/relay-billing.js');
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

test('relay model names are matched to official models; the names hint at prices', () => {
    assert.deepEqual(officialNames('【次哈-0.11】 抗截断-pg-gemini-4-argon-high'), ['gemini-4-argon-high', 'gemini-4-argon']);
    assert.equal(officialNames('流式保活抗截断-gemini-3.8-flash')[0], 'gemini-3.8-flash');
    assert.equal(officialNames('[公益]火山方舟/deepseek-v4.1-flash')[0], 'deepseek-v4.1-flash');
    assert.equal(officialNames('gemini-4-argon/fc')[0], 'gemini-4-argon');
    assert.equal(officialNames('(build)AISTUDIO-gemini-4-argon')[0], 'gemini-4-argon');
    assert.equal(officialPrice('[z1]gemini-4-argon-high-ci').model, 'gemini-4-argon');
    assert.equal(officialPrice('gemini-pro-latest').model, 'gemini-pro-latest', 'a real name is kept');
    assert.equal(officialPrice('my-own-model'), null);

    assert.deepEqual(pricingHint(['[0.06/次][官逆] gemini-4-argon']), { mode: 'call', currency: 'CNY', value: 0.06 });
    assert.deepEqual(pricingHint(['【次哈-0.11】 gemini-4-argon']), { mode: 'call', currency: 'CNY', value: 0.11 });
    assert.deepEqual(pricingHint(['gemini-3.8-flash', '[公益]鬼/minimax-m3']), { mode: 'free' });
    assert.equal(pricingHint(['pg-gemini-3.8-flash']), null);
});

test('the user\'s own prices for a relay, and the prices models.dev lists for its address', () => {
    const usage = { input: 300000, cached: 0, cacheWrite: 0, output: 10000, reasoning: 0 };
    assert.deepEqual(applyPricing({ mode: 'free' }, 'x', usage, 7.2), { cost: 0 });
    assert.equal(applyPricing({ mode: 'call', currency: 'CNY', value: 0.72 }, 'x', usage, 7.2).cost.toFixed(4), '0.1000');
    assert.equal(applyPricing({ mode: 'token', currency: 'USD', input: 1, output: 4 }, 'x', usage, 7.2).cost.toFixed(4), (0.3 + 0.04).toFixed(4));
    assert.equal(applyPricing({ mode: 'ratio', ratio: 0.5 }, '抗截断-pg-gemini-4-argon', usage, 7.2).cost.toFixed(4), ((0.6 + 0.1) * 0.5).toFixed(4));
    // Over 200k tokens of context: the long-context prices
    assert.equal(applyPricing({ mode: 'ratio', ratio: 0.5 }, 'pg-gemini-pro-latest', usage, 7.2).cost.toFixed(4), ((1.2 + 0.18) * 0.5).toFixed(4));
    assert.equal(applyPricing({ mode: 'ratio', ratio: 1 }, 'my-own-model', usage, 7.2), null);

    assert.equal(catalogPrice('https://opencode.ai/inference/openai/v1', 'gemini-4-argon').name, 'OpenCode Zen');
    assert.equal(catalogPrice('https://opencode.ai/inference/openai/v1/', 'gemini-4-argon-high').cost.input, 2.5);
    assert.equal(catalogPrice('https://relay.example/v1', 'gemini-4-argon'), null);
});

test('relays: spending read from new-api, sub2api and gpt-load is shared out; gcli2api is recognised as free', async t => {
    resetRelayBilling();
    // One fake relay per project, each charging $0.05 per generation in its own way.
    const spent = { 'new-api': 1, sub2api: 2, 'gpt-load': 3 };
    /** Requests the relays got other than generations (probes, readings) */
    const asked = [];
    const relay = http.createServer((request, response) => {
        const [, kind, ...rest] = request.url.split('/');
        const route = `/${rest.join('/')}`;
        if (!route.startsWith('/v1/chat/completions')) asked.push(`${kind}${route}`);
        const json = value => {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(value));
        };
        if (route.startsWith('/v1/chat/completions')) {
            spent[kind] = (spent[kind] ?? 0) + 0.05;
            return json({});
        }
        if (kind === 'new-api' && route === '/api/status') return json({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 7 } });
        if (kind === 'new-api' && route === '/v1/dashboard/billing/usage' && request.headers.authorization === 'Bearer sk-new') return json({ object: 'list', total_usage: spent['new-api'] * 7 * 100 });
        if (kind === 'sub2api' && route === '/v1/usage' && request.headers.authorization === 'Bearer sk-sub') return json({ mode: 'unrestricted', unit: 'USD', remaining: 10, usage: { total: { actual_cost: spent.sub2api } } });
        if (kind === 'gpt-load' && route === '/v1/user/balance' && request.headers.authorization === 'Bearer sk-load') return json({ is_active: true, balance: 0, used: spent['gpt-load'], total: 0 });
        if (kind === 'gcli' && route === '/version/info') return json({ success: true, version: 'd61bcf8', full_hash: 'd61bcf8e8', message: 'x', date: '2026-11-07' });
        response.writeHead(404).end();
    });
    await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => relay.close(resolve)));
    const relayBase = `http://127.0.0.1:${relay.address().port}`;

    const upstream = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        setTimeout(() => response.end(sse([{ choices: [{ delta: { content: 'hi' } }] }, { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } }])), 150);
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => upstream.close(resolve)));

    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle: 'relay-test' }, directories: {} };
        next();
    });
    app.post('/generate', async (request, response) => {
        meterGeneration(request, response);
        // The relay books the generation when it is done.
        const answer = await fetch(`http://127.0.0.1:${upstream.address().port}/`);
        await fetch(`${request.body.reverse_proxy.replace(/\/v1$/, '')}/v1/chat/completions`, { method: 'POST' });
        return forwardFetchResponse(answer, response);
    });
    app.use('/api/usage', router);
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;

    const generate = (id, kind, key, meter = true) => fetch(`${base}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Usage-Id': id, ...(meter ? { 'X-Usage-Meter': 'on' } : {}) },
        body: JSON.stringify({ chat_completion_source: 'openai', model: '抗截断-pg-gemini-4-argon', stream: true, reverse_proxy: `${relayBase}/${kind}/v1`, proxy_password: key }),
    }).then(response => response.text());
    const settled = async id => {
        for (let i = 0; i < 100; i++) {
            const data = await (await fetch(`${base}/api/usage/summary?id=${id}`)).json();
            if (data.item && !data.item.pending) return data;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`${id} never settled`);
    };

    // The meter off (the default): tokens recorded, the relay asked nothing.
    await generate('off-1', 'new-api', 'sk-new', false);
    const off = await settled('off-1');
    assert.deepEqual([off.item.priced, off.item.input, off.item.relay.kind], [null, 1000, null]);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(asked, [], 'nothing but the generation reached the relay');
    const request = (url, meter) => ({ get: name => (name === 'x-usage-meter' && meter ? 'on' : undefined), body: { custom_url: url } });
    assert.equal(relayStreamsUsage(request(`${relayBase}/new-api/v1`, true)), false, 'not recognised yet');

    for (const [kind, key] of [['new-api', 'sk-new'], ['sub2api', 'sk-sub'], ['gpt-load', 'sk-load']]) {
        // The first generation through a relay: it is recognised afterwards, and its reading becomes the baseline.
        await generate(`${kind}-1`, kind, key);
        const first = await settled(`${kind}-1`);
        assert.deepEqual([first.item.priced, first.item.relay.kind], [null, kind]);
        await new Promise(resolve => setTimeout(resolve, 100));
        await generate(`${kind}-2`, kind, key);
        const { item } = await settled(`${kind}-2`);
        assert.equal(item.priced, 'relay', kind);
        assert.equal(item.cost.toFixed(4), '0.0500', kind);
    }

    // Recognised relays that support it are asked for the tokens in streamed answers, if the meter is on.
    assert.equal(relayStreamsUsage(request(`${relayBase}/new-api/v1`, true)), true);
    assert.equal(relayStreamsUsage(request(`${relayBase}/new-api/v1`, false)), false);

    // gcli2api: recognised, free quota, nothing to read: tokens only.
    await generate('gcli-1', 'gcli', 'sk-x');
    const gcli = await settled('gcli-1');
    assert.deepEqual([gcli.item.priced, gcli.item.cost, gcli.item.input], [null, null, 1000]);
    const described = Object.fromEntries(gcli.relays.map(item => [item.label ?? item.address, item]));
    assert.equal(described.gcli2api.free, true);
    assert.equal(described.sub2api.billing, true);
    assert.equal(described.sub2api.remaining, 10);
    assert.equal(described['new-api / one-api'].billing, true);
    assert.equal(described.gcli2api.official, 'gemini-4-argon');

    // The user's own price for a relay without reports: applied from then on.
    await fetch(`${base}/api/usage/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rate: 7.2, address: described.gcli2api.address, pricing: { mode: 'call', currency: 'CNY', value: 0.36 } }),
    });
    await generate('gcli-2', 'gcli', 'sk-x');
    const priced = await settled('gcli-2');
    assert.equal(priced.item.priced, 'custom');
    assert.equal(priced.item.cost.toFixed(3), '0.050');
    assert.equal(priced.today.cost.toFixed(3), '0.200', 'three relay readings and one own price');
});
