/* eslint-disable playwright/expect-expect -- Node test runner uses assert. */
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Response } from 'node-fetch';
import { parse as parseYaml } from 'yaml';

import { forwardFetchResponse, setConfigFilePath } from '../src/util.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const defaultConfigPath = path.join(root, 'default', 'config.yaml');
setConfigFilePath(defaultConfigPath);

const {
    cachingAtDepthForOpenRouterClaude,
    calculateClaudeBudgetTokens,
} = await import('../src/prompt-converters.js');
const {
    normalizeRecurseLimit,
} = await import('../public/scripts/reasoning-tools/feature-gate.js');

function source(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function matchPart(text, pattern, index = 0) {
    return text.match(pattern)?.[index] ?? '';
}

function createTargetResponse() {
    const response = new PassThrough();
    response.statusCode = 200;
    response.statusMessage = '';
    response.socket = new EventEmitter();
    response.forwardedHeaders = [];
    response.setHeader = (name, value) => response.forwardedHeaders.push([name, value]);
    return response;
}

async function collectBody(response) {
    const chunks = [];
    response.on('data', chunk => chunks.push(Buffer.from(chunk)));
    await once(response, 'finish');
    return Buffer.concat(chunks).toString('utf8');
}

async function forwardResponse(upstream) {
    const target = createTargetResponse();
    const bodyPromise = collectBody(target);
    await forwardFetchResponse(upstream, target);
    return { target, body: await bodyPromise };
}

test('forwardFetchResponse preserves 403 JSON and 502 text error bodies', async () => {
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = message => warnings.push(message);
    try {
        const json = JSON.stringify({ error: { message: 'Forbidden' } });
        const forbidden = await forwardResponse(new Response(json, { status: 403, statusText: 'Forbidden' }));
        assert.equal(forbidden.target.statusCode, 403);
        assert.equal(forbidden.body, json);
        assert.match(warnings[0], /403 Forbidden/);
        assert.match(warnings[0], /Forbidden/);

        const gateway = await forwardResponse(new Response('upstream unavailable', { status: 502, statusText: 'Bad Gateway' }));
        assert.equal(gateway.target.statusCode, 502);
        assert.equal(gateway.body, 'upstream unavailable');
        assert.match(warnings[1], /502 Bad Gateway: upstream unavailable/);
    } finally {
        console.warn = originalWarn;
    }
});

test('forwardFetchResponse maps 401 to 400 without changing body or reason', async () => {
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
        const result = await forwardResponse(new Response('unauthorized', { status: 401, statusText: 'Unauthorized' }));
        assert.equal(result.target.statusCode, 400);
        assert.equal(result.target.statusMessage, 'Unauthorized');
        assert.equal(result.body, 'unauthorized');
    } finally {
        console.warn = originalWarn;
    }
});

test('forwardFetchResponse streams successful bodies and resolves after closing the target', async () => {
    const target = createTargetResponse();
    const bodyPromise = collectBody(target);
    await forwardFetchResponse(new Response('data: first\n\ndata: second\n\n', {
        status: 200,
        statusText: 'OK',
    }), target);
    assert.equal(await bodyPromise, 'data: first\n\ndata: second\n\n');
    assert.equal(target.statusCode, 200);
    assert.equal(target.writableEnded, true);
});

test('forwardFetchResponse destroys the upstream stream when the client closes', async () => {
    const upstreamBody = new PassThrough();
    const upstream = {
        status: 200,
        statusText: 'OK',
        ok: true,
        body: upstreamBody,
    };
    const target = createTargetResponse();
    const forwarding = forwardFetchResponse(upstream, target);
    upstreamBody.write('partial');
    target.socket.emit('close');
    await forwarding;
    assert.equal(upstreamBody.destroyed, true);
    assert.equal(target.writableEnded, true);
});

test('forwardFetchResponse does not copy unsafe or entity headers from upstream', async () => {
    const result = await forwardResponse(new Response('decoded text', {
        status: 200,
        headers: {
            'content-encoding': 'gzip',
            'content-length': '999',
            'set-cookie': 'session=upstream',
            connection: 'close',
        },
    }));
    assert.equal(result.body, 'decoded text');
    assert.deepEqual(result.target.forwardedHeaders, []);
});

test('all 19 forwardFetchResponse production callers await or return the promise', () => {
    const productionFiles = [
        'src/endpoints/backends/chat-completions.js',
        'src/endpoints/backends/kobold.js',
        'src/endpoints/backends/text-completions.js',
        'src/endpoints/novelai.js',
        'src/endpoints/speech.js',
        'src/middleware/corsProxy.js',
    ];
    const calls = productionFiles.flatMap(file => [...source(file).matchAll(/^(.*forwardFetchResponse\([^\n]+)$/gm)]
        .map(match => ({ file, line: match[1].trim() })));
    assert.equal(calls.length, 19);
    for (const call of calls) {
        assert.match(call.line, /^(?:return\s+)?await\s+forwardFetchResponse\(/, `${call.file}: ${call.line}`);
    }
});

test('JSON Schema reaches normal, streaming, quiet, raw, group, and both recursion paths', () => {
    const script = source('public/script.js');
    assert.match(script, /generateQuietPrompt\(\{[^}]*jsonSchema = null/s);
    assert.match(script, /Generate\('quiet', generateOptions\)/);
    assert.match(script, /generateRaw\(\{[^}]*jsonSchema = null/s);
    assert.match(script, /sendOpenAIRequest\('quiet', generateData, abortController\.signal, \{ jsonSchema \}\)/);
    assert.match(script, /sendGenerationRequest\(type, generate_data, \{ jsonSchema \}\)/);
    assert.match(script, /sendStreamingRequest\(type, generate_data, \{ jsonSchema \}\)/);
    assert.match(script, /generateGroupWrapper\(false, type, \{[^}]*jsonSchema[^}]*\}\)/);
    const recursiveCalls = [...script.matchAll(/return Generate\('normal', \{([^}]+)\}, dryRun\);/g)];
    assert.equal(recursiveCalls.length, 2);
    recursiveCalls.forEach(call => assert.match(call[1], /\bjsonSchema\b/));

    const openai = source('public/scripts/openai.js');
    assert.match(openai, /createGenerationParameters\([^\n]+\{ jsonSchema \}\)/);
    assert.match(openai, /generate_data\.json_schema = jsonSchema/);
    const backend = source('src/endpoints/backends/chat-completions.js');
    assert.match(backend, /CHAT_COMPLETION_SOURCES\.CUSTOM[\s\S]+?bodyParams\['response_format'\] = \{[\s\S]+?type: 'json_schema'/);
});

test('recursive generation guards preserve input and schema at every recursion depth', () => {
    const script = source('public/script.js');
    assert.ok(script.includes('if (!(dryRun || depth || type == \'regenerate\''));
    assert.ok(script.includes('type !== \'quiet\' && !dryRun && !depth'));
    assert.ok(script.includes('type === undefined && main_api == \'openai\''));
    assert.ok(script.includes('oai_settings.send_if_empty.trim().length > 0 && !depth'));
    assert.doesNotMatch(script, /isReasoningToolsEnabled\(\) && depth/);
    assert.match(script, /canPerformToolCalls = !dryRun[^\n]+depth < ToolManager\.getRecurseLimit\(\)/);
});

test('recursion validation uses defaults, bounds, effective minimum, and does not rewrite user settings', () => {
    assert.equal(normalizeRecurseLimit(undefined, 5), 5);
    assert.equal(normalizeRecurseLimit(1, 5), 1);
    assert.equal(normalizeRecurseLimit('50', 5), 50);
    assert.equal(normalizeRecurseLimit(0, 5), 5);
    assert.equal(normalizeRecurseLimit(51, 5), 5);
    assert.equal(normalizeRecurseLimit(2.5, 5), 5);

    const tools = source('public/scripts/tool-calling.js');
    assert.match(tools, /Math\.min\(this\.#userRecurseLimit, this\.#instanceRecurseLimit\)/);
    assert.match(tools, /this\.#modernRecurseLimitEnabled[\s\S]+?: this\.RECURSE_LIMIT/);
    const configureBody = matchPart(tools, /static configureRecurseLimit\([^)]*\) \{([\s\S]+?)\n {4}\}/, 1);
    assert.doesNotMatch(configureBody, /oai_settings|saveSettings/);
});

test('feature gate defaults off while adaptive config defaults false and old missing config falls back true', () => {
    const config = parseYaml(source('default/config.yaml'));
    assert.equal(config.featureFlags.reasoningTools, false);
    assert.equal(config.toolCalling.recurseHardLimit, 50);
    assert.equal(config.claude.enableAdaptiveThinking, false);
    assert.equal(config.gemini.thoughtSignatures, true);
    const backend = source('src/endpoints/backends/chat-completions.js');
    assert.match(backend, /getConfigValue\('claude\.enableAdaptiveThinking', true, 'boolean'\)/);
});

test('OpenRouter legacy and feature-gated reasoning bodies both support reasoning effort', () => {
    const backend = source('src/endpoints/backends/chat-completions.js');
    assert.match(backend, /enableReasoningTools[\s\S]+?\{ reasoning: \{ exclude: !includeReasoning \} \}[\s\S]+?\{ include_reasoning: includeReasoning \}/);
    assert.match(backend, /if \(enableReasoningTools\) \{\s*bodyParams\['reasoning'\]\['effort'\] = request\.body\.reasoning_effort;\s*\} else \{\s*bodyParams\['reasoning'\] = \{ effort: request\.body\.reasoning_effort \};/);
});

test('Claude adaptive budgets, model options, and final Opus 4.7 semantics match the official final tree', () => {
    assert.equal(calculateClaudeBudgetTokens(10_000, 'min', true, true), 'low');
    assert.equal(calculateClaudeBudgetTokens(10_000, 'low', true, true), 'low');
    assert.equal(calculateClaudeBudgetTokens(10_000, 'medium', true, true), 'medium');
    assert.equal(calculateClaudeBudgetTokens(10_000, 'high', true, true), 'high');
    assert.equal(calculateClaudeBudgetTokens(10_000, 'max', true, true), 'max');
    assert.equal(calculateClaudeBudgetTokens(10_000, 'auto', true, true), null);
    assert.equal(calculateClaudeBudgetTokens(10_000, 'low', true, false), 1024);

    const index = source('public/index.html');
    assert.ok(index.includes('<option value="claude-opus-4-7">claude-opus-4-7</option>'));
    assert.ok(index.includes('<option value="claude-opus-4-6">claude-opus-4-6</option>'));
    assert.ok(index.includes('<option value="claude-sonnet-4-6">claude-sonnet-4-6</option>'));

    const openai = source('public/scripts/openai.js');
    assert.ok(openai.includes('/^claude-(sonnet-4-5|sonnet-4-6|opus-4-6|opus-4-7)/.test(value)'));
    assert.ok(openai.includes('$(\'#openai_max_context\').attr(\'max\', max_1mil);'));

    const backend = source('src/endpoints/backends/chat-completions.js');
    assert.match(backend, /useThinking = \/\^claude-\([^\n]+opus-4-7/);
    assert.match(backend, /useWebSearch = \/\^claude-\([^\n]+opus-4-7/);
    assert.match(backend, /useVerbosity = \/\^claude-\([^\n]+opus-4-7/);
    assert.match(backend, /noPrefillModel = \/\^claude-\([^\n]+opus-4-7/);
    assert.match(backend, /isAdaptiveModel = \/\^claude-\(opus-4-7\)\/\.test[^\n]+enableAdaptiveThinking/);
    assert.match(backend, /noSamplingModel = \/\^claude-\(opus-4-7\)\//);
    assert.match(backend, /if \(noSamplingModel\) \{\s*delete requestBody\.temperature;\s*delete requestBody\.top_p;\s*delete requestBody\.top_k;/);
    assert.match(backend, /requestBody\.thinking\.display = 'summarized'/);
});

test('OpenRouter cache depth skips system and safely ignores empty content', () => {
    const messages = [
        { role: 'user', content: 'old user' },
        { role: 'assistant', content: 'old assistant' },
        { role: 'system', content: 'hoisted system' },
        { role: 'user', content: [] },
        { role: 'assistant', content: [{ type: 'tool_call', id: 'tool-only' }] },
    ];
    assert.doesNotThrow(() => cachingAtDepthForOpenRouterClaude(messages, 0, '5m'));
    assert.deepEqual(messages[0].content, [{
        type: 'text',
        text: 'old user',
        cache_control: { type: 'ephemeral', ttl: '5m' },
    }]);
    assert.equal(messages[2].content, 'hoisted system');
    assert.deepEqual(messages[3].content, []);
});

test('tool protocol persists successes and failures, including error:true, while stealth remains terminal', () => {
    const tools = source('public/scripts/tool-calling.js');
    assert.match(tools, /return error;/);
    assert.match(tools, /result\.errors\.push\(toolResult\)/);
    assert.match(tools, /result\.invocations\.push\(\{[\s\S]+?result: toolResult\.toString\(\),[\s\S]+?error: true/);
    assert.match(tools, /error: false/);
    assert.match(tools, /if \(isStealth\) \{\s*result\.stealthCalls\.push\(name\)/);
    assert.match(tools, /reasoning: reasoningText \|\| null/);
});

test('interleaved reasoning preserves invocation snapshots and cleans provider/group metadata', () => {
    const openai = source('public/scripts/openai.js');
    assert.match(openai, /else if \(previousAssistantReasoning && !clone\.reasoning\) \{\s*clone\.reasoning = previousAssistantReasoning;/);
    assert.doesNotMatch(openai, /else if \(previousAssistantReasoning\) \{/);
    assert.match(openai, /isOtherGroupMember[\s\S]+?delete cloneInvocation\.signature;\s*delete cloneInvocation\.reasoning;/);
    assert.match(openai, /interleaved_reasoning_providers = \[\s*chat_completion_sources\.OPENROUTER,\s*chat_completion_sources\.CUSTOM/);
    assert.match(openai, /includeToolReasoning[\s\S]+?setToolCalls\(invocations, includeSignature, includeToolReasoning\)/);
});

test('stream intermediary finalization cancels pending rendering before tool-only deletion', () => {
    const script = source('public/script.js');
    const deletion = matchPart(script, /if \(hasToolCalls && shouldDeleteMessage\) \{([\s\S]+?)\n {16}\}/, 1);
    assert.ok(deletion.indexOf('streamRenderBuffer?.cancel();') >= 0);
    assert.ok(deletion.indexOf('streamRenderBuffer?.cancel();') < deletion.indexOf('await deleteLastMessage();'));
    assert.match(script, /finalizeIntermediaryMessage\([^}]+\{ unlockUI = true \}/);
    assert.match(script, /finalizeIntermediaryMessage\([^\n]+\{ unlockUI: false \}\)/);
});

test('multipart, streaming state, signatures, custom provider, and group contamination contracts are present', () => {
    const script = source('public/script.js');
    const reasoning = source('public/scripts/reasoning.js');
    const custom = source('public/scripts/custom-request.js');
    const openai = source('public/scripts/openai.js');
    const converters = source('src/prompt-converters.js');
    assert.match(script, /filter\(p => p\.type === 'text'\)\?\.map\(p => p\.text\)\?\.join\('\\n\\n'\)/);
    assert.match(reasoning, /filter\(part => part\.type === 'thinking'\)\?\.map\(part => part\.thinking\)\?\.join\('\\n\\n'\)/);
    assert.match(custom, /state = \{ reasoning: '', images: \[\], signature: '', toolSignatures: \{\} \}/);
    assert.match(openai, /reasoning_content[\s\S]+?message\?\.reasoning_details/);
    assert.match(openai, /state\.toolSignatures\[detail\.id\] = detail\.data/);
    assert.match(converters, /getConfigValue\('gemini\.thoughtSignatures', true, 'boolean'\)/);
    assert.match(converters, /if \(enableThoughtSignatures\)[\s\S]+?addDetail\(message\.signature\)/);
    assert.match(openai, /isOtherGroupMember[\s\S]+?reasoning = isSameModel && !isOtherGroupMember/);
});

test('paged group generation does not full-load history and preserves paging boundaries', () => {
    const groups = source('public/scripts/group-chats.js');
    const wrapper = matchPart(groups, /async function generateGroupWrapper[\s\S]+?\n}\n\n\/\*\*\n \* Gets the generation ID/);
    assert.ok(wrapper.length > 0);
    assert.doesNotMatch(wrapper, /loadGroupChat|\/api\/chats\/group\/get/);
    assert.match(wrapper, /await Generate\(generateType/);
    const script = source('public/script.js');
    assert.match(script, /fetchChatRange\([^)]*isGroup/);
    assert.match(script, /isOtherGroupMember = selected_group && coreChat\[i\]\.name !== name2/);
    assert.doesNotMatch(script, /isOtherGroupMember = isReasoningToolsEnabled/);
});

test('16 locales contain all new Reasoning and Tool Calling keys', () => {
    const localeDirectory = path.join(root, 'public', 'locales');
    const localeNames = ['ar-sa', 'de-de', 'es-es', 'fr-fr', 'is-is', 'it-it', 'ja-jp', 'ko-kr', 'nl-nl', 'pt-pt', 'ru-ru', 'th-th', 'uk-ua', 'vi-vn', 'zh-cn', 'zh-tw'];
    for (const localeName of localeNames) {
        const locale = JSON.parse(fs.readFileSync(path.join(localeDirectory, `${localeName}.json`), 'utf8'));
        for (const key of ['Interleaved Thinking', 'Since Last User Message', 'Active Tool Chain', 'Tool Call Recurse Limit']) {
            assert.equal(typeof locale[key], 'string', `${localeName}: ${key}`);
        }
    }
});
