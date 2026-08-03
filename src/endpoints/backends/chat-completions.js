import process from 'node:process';
import util from 'node:util';
import express from 'express';
import fetch from 'node-fetch';
import urlJoin from 'url-join';

import {
    AIMLAPI_HEADERS,
    AZURE_OPENAI_KEYS,
    CHAT_COMPLETION_SOURCES,
    GEMINI_SAFETY,
    OPENAI_REASONING_EFFORT_MAP,
    OPENAI_REASONING_EFFORT_MODELS,
    OPENAI_VERBOSITY_MODELS,
    OPENROUTER_HEADERS,
    VERTEX_SAFETY,
    ZAI_ENDPOINT,
} from '../../constants.js';
import {
    forwardFetchResponse,
    getConfigValue,
    tryParse,
    uuidv4,
    mergeObjectWithYaml,
    excludeKeysByYaml,
    color,
    trimTrailingSlash,
    flattenSchema,
} from '../../util.js';
import {
    convertClaudeMessages,
    convertGooglePrompt,
    convertTextCompletionPrompt,
    convertCohereMessages,
    convertMistralMessages,
    convertAI21Messages,
    convertXAIMessages,
    cachingAtDepthForOpenRouterClaude,
    cachingAtDepthForClaude,
    getPromptNames,
    calculateClaudeBudgetTokens,
    calculateGoogleBudgetTokens,
    postProcessPrompt,
    PROMPT_PROCESSING_TYPE,
    addAssistantPrefix,
    embedOpenRouterMedia,
    addReasoningContentToToolCalls,
    cachingSystemPromptForOpenRouter,
    addOpenRouterSignatures,
} from '../../prompt-converters.js';

import { readSecret, SECRET_KEYS } from '../secrets.js';
import {
    getTokenizerModel,
    getSentencepiceTokenizer,
    getTiktokenTokenizer,
    sentencepieceTokenizers,
    TEXT_COMPLETION_MODELS,
    webTokenizers,
    getWebTokenizer,
} from '../tokenizers.js';
import { getVertexAIAuth, getProjectIdFromServiceAccount } from '../google.js';
import {
    getFreeGeminiChannelModels,
    getFreeGeminiFetchAgent,
    isFreeGeminiModelAllowed,
    listEnabledFreeGeminiChannels,
} from '../../free-gemini-channels.js';

const API_OPENAI = 'https://api.openai.com/v1';
const API_CLAUDE = 'https://api.anthropic.com/v1';
const API_MISTRAL = 'https://api.mistral.ai/v1';
const API_COHERE_V1 = 'https://api.cohere.ai/v1';
const API_COHERE_V2 = 'https://api.cohere.ai/v2';
const API_PERPLEXITY = 'https://api.perplexity.ai';
const API_GROQ = 'https://api.groq.com/openai/v1';
const API_MAKERSUITE = 'https://generativelanguage.googleapis.com';
const API_VERTEX_AI = 'https://us-central1-aiplatform.googleapis.com';
const API_AI21 = 'https://api.ai21.com/studio/v1';
const API_CHUTES = 'https://llm.chutes.ai/v1';
const API_ELECTRONHUB = 'https://api.electronhub.ai/v1';
const API_NANOGPT = 'https://nano-gpt.com/api/v1';
const API_DEEPSEEK = 'https://api.deepseek.com/beta';
const API_XAI = 'https://api.x.ai/v1';
const API_AIMLAPI = 'https://api.aimlapi.com/v1';
const API_POLLINATIONS = 'https://text.pollinations.ai/openai';
const API_MOONSHOT = 'https://api.moonshot.ai/v1';
const API_FIREWORKS = 'https://api.fireworks.ai/inference/v1';
const API_COMETAPI = 'https://api.cometapi.com/v1';
const API_ZAI_COMMON = 'https://api.z.ai/api/paas/v4';
const API_ZAI_CODING = 'https://api.z.ai/api/coding/paas/v4';
const API_SILICONFLOW = 'https://api.siliconflow.com/v1';
const API_OPENROUTER = 'https://openrouter.ai/api/v1';

function getGeminiVersionBaseUrl(apiUrl, apiVersion) {
    const baseUrl = trimTrailingSlash(apiUrl.toString());
    return /\/v1(?:beta)?$/i.test(baseUrl) ? baseUrl : `${baseUrl}/${apiVersion}`;
}

function normalizeFreeGeminiModelId(value) {
    const modelId = String(value ?? '').trim().replace(/^models\//, '');
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/.test(modelId) ? modelId : '';
}

function redactPercentEncodedSecret(value, secret) {
    let layer = value;
    let spans = Array.from({ length: value.length }, (_, index) => ({ start: index, end: index + 1 }));
    const matches = [];

    // Decode only into a matching view. Spans always point back to the original
    // text, so unrelated percent-encoded content is returned byte-for-byte.
    for (let depth = 0; depth <= value.length; depth++) {
        let matchIndex = layer.indexOf(secret);
        while (matchIndex !== -1) {
            const endIndex = matchIndex + secret.length - 1;
            matches.push({ start: spans[matchIndex].start, end: spans[endIndex].end });
            matchIndex = layer.indexOf(secret, matchIndex + 1);
        }

        let decoded = '';
        const decodedSpans = [];
        let changed = false;
        for (let index = 0; index < layer.length;) {
            const byteMatch = layer.slice(index, index + 3).match(/^%([0-9a-f]{2})$/i);
            if (!byteMatch) {
                decoded += layer[index];
                decodedSpans.push(spans[index]);
                index++;
                continue;
            }

            const firstByte = Number.parseInt(byteMatch[1], 16);
            const byteCount = firstByte < 0x80 ? 1
                : firstByte >= 0xC2 && firstByte <= 0xDF ? 2
                    : firstByte >= 0xE0 && firstByte <= 0xEF ? 3
                        : firstByte >= 0xF0 && firstByte <= 0xF4 ? 4
                            : 0;
            const encodedLength = byteCount * 3;
            const encoded = layer.slice(index, index + encodedLength);
            if (!byteCount || encoded.length !== encodedLength
                || !/^(?:%[0-9a-f]{2})+$/i.test(encoded)) {
                decoded += layer[index];
                decodedSpans.push(spans[index]);
                index++;
                continue;
            }

            try {
                const character = decodeURIComponent(encoded);
                const sourceSpan = {
                    start: spans[index].start,
                    end: spans[index + encodedLength - 1].end,
                };
                decoded += character;
                for (let unit = 0; unit < character.length; unit++) decodedSpans.push(sourceSpan);
                index += encodedLength;
                changed = true;
            } catch {
                decoded += layer[index];
                decodedSpans.push(spans[index]);
                index++;
            }
        }
        if (!changed) break;
        layer = decoded;
        spans = decodedSpans;
    }

    if (matches.length === 0) return value;
    matches.sort((left, right) => left.start - right.start || left.end - right.end);
    const merged = [];
    for (const match of matches) {
        const previous = merged.at(-1);
        if (previous && match.start <= previous.end) {
            previous.end = Math.max(previous.end, match.end);
        } else {
            merged.push({ ...match });
        }
    }

    let redacted = '';
    let cursor = 0;
    for (const match of merged) {
        redacted += value.slice(cursor, match.start) + '[redacted]';
        cursor = match.end;
    }
    return redacted + value.slice(cursor);
}

function sanitizeFreeGeminiUpstreamMessage(value, apiKey) {
    let message = String(value ?? '').trim().slice(0, 4096).replace(/https?:\/\/\S+/gi, '[redacted-url]');
    if (apiKey) {
        message = redactPercentEncodedSecret(message, apiKey);
    }
    return message.replace(/\s+/g, ' ').slice(0, 500) || '上游请求失败。';
}

function writeFreeGeminiStreamError(response) {
    if (!response.headersSent || response.destroyed || response.writableEnded) {
        return;
    }
    try {
        response.write(`data: ${JSON.stringify({
            error: {
                code: 'FREE_GEMINI_STREAM_FAILED',
                message: '免费 Gemini 流式响应转发失败。',
            },
        })}\n\n`);
    } catch (error) {
        console.warn('Unable to write free Gemini SSE error:', error?.code || error?.name || 'stream_write_failed');
    }
}

function mapFreeGeminiUpstreamStatus(status) {
    return [400, 422, 429, 502, 503, 504].includes(status) ? status : 502;
}

function createFreeGeminiRouteError(message, code, status) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function getFreeGeminiOutputLimit(channel, model) {
    const limits = [65536];
    if (Number.isInteger(model?.outputTokenLimit) && model.outputTokenLimit > 0) {
        limits.push(model.outputTokenLimit);
    }
    if (Number.isInteger(channel?.maxOutputTokens) && channel.maxOutputTokens > 0) {
        limits.push(channel.maxOutputTokens);
    }
    return Math.min(...limits);
}

const FREE_GEMINI_CONTINUATION_TEXT = 'Continue the previous response.';
const FREE_GEMINI_MODEL_DISCOVERY_MAX_WAIT_MS = 2000;
const FREE_GEMINI_MINIMUM_CANDIDATE_BUDGET_MS = 1000;

async function waitForFreeGeminiModelDiscovery(promise, deadlineAt) {
    const remainingMs = Math.floor(deadlineAt - Date.now());
    if (remainingMs <= 0) {
        throw createFreeGeminiRouteError(
            '免费 Gemini 渠道模型发现超时。',
            'FREE_GEMINI_MODELS_TIMEOUT',
            504,
        );
    }

    let timeout;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(createFreeGeminiRouteError(
                    '免费 Gemini 渠道模型发现超时。',
                    'FREE_GEMINI_MODELS_TIMEOUT',
                    504,
                )), remainingMs);
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

function waitForFreeGeminiFirstStreamChunk(body, disconnectSignal) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            body.removeListener('data', onData);
            body.removeListener('error', onError);
            body.removeListener('end', onEnd);
            body.removeListener('close', onClose);
            disconnectSignal.removeEventListener('abort', onDisconnect);
        };
        const finish = (callback, value) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            callback(value);
        };
        const createStreamError = (message, cause) => {
            const error = new Error(message, cause ? { cause } : undefined);
            error.code = 'FREE_GEMINI_STREAM_FAILED';
            return error;
        };
        const onData = chunk => {
            const length = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk?.byteLength;
            if (!length) {
                return;
            }

            // Stop flowing synchronously and put the only buffered chunk back. The normal
            // streaming forwarder will resume the body and emit this chunk exactly once.
            body.pause();
            body.unshift(chunk);
            finish(resolve);
        };
        const onError = error => finish(reject, createStreamError('免费 Gemini 流式响应在首字节前失败。', error));
        const onEnd = () => finish(reject, createStreamError('免费 Gemini 流式响应在首字节前结束。'));
        const onClose = () => finish(reject, createStreamError('免费 Gemini 流式响应在首字节前关闭。'));
        const onDisconnect = () => finish(reject, createStreamError('客户端已断开连接。'));

        body.on('data', onData);
        body.once('error', onError);
        body.once('end', onEnd);
        body.once('close', onClose);
        disconnectSignal.addEventListener('abort', onDisconnect, { once: true });
        if (disconnectSignal.aborted) {
            onDisconnect();
        }
    });
}

function getFreeGeminiCandidateBudgetMs(channelTimeoutMs, remainingTotalMs, remainingCandidates) {
    const safeRemainingMs = Math.max(1, Math.floor(remainingTotalMs));
    const safeRemainingCandidates = Math.max(1, Math.trunc(remainingCandidates));
    const fairShareMs = Math.max(1, Math.floor(safeRemainingMs / safeRemainingCandidates));
    const reservePerLaterCandidateMs = Math.min(FREE_GEMINI_MINIMUM_CANDIDATE_BUDGET_MS, fairShareMs);
    const maximumCurrentBudgetMs = safeRemainingCandidates > 1
        ? safeRemainingMs - reservePerLaterCandidateMs * (safeRemainingCandidates - 1)
        : safeRemainingMs;
    const requestedBudgetMs = Math.max(FREE_GEMINI_MINIMUM_CANDIDATE_BUDGET_MS, fairShareMs);

    return Math.max(1, Math.floor(Math.min(
        channelTimeoutMs,
        safeRemainingMs,
        maximumCurrentBudgetMs,
        requestedBudgetMs,
    )));
}

function hasFreeGeminiContentPart(part) {
    if (!part || typeof part !== 'object') {
        return false;
    }
    if (typeof part.text === 'string' && part.text.trim().length > 0) {
        return true;
    }
    return Object.entries(part).some(([key, value]) => key !== 'text' && value != null);
}

function hasObviouslyConvertibleFreeGeminiMessage(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return false;
    }

    return messages.some(message => {
        if (!message || typeof message !== 'object') {
            return false;
        }

        if (!Array.isArray(message.content)) {
            if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
                return true;
            }
            if (typeof message.tool_call_id === 'string' && message.tool_call_id.trim().length > 0) {
                return true;
            }
            return message.content != null && String(message.content).trim().length > 0;
        }

        return message.content.some(part => {
            if (!part || typeof part !== 'object') {
                return false;
            }
            if (part.type === 'text') {
                return (typeof part.text === 'string' && part.text.trim().length > 0)
                    || (typeof message.name === 'string' && message.name.trim().length > 0);
            }
            if (part.type === 'tool_calls') {
                return Array.isArray(part.tool_calls) && part.tool_calls.length > 0;
            }
            if (part.type === 'tool_call_id') {
                return typeof part.tool_call_id === 'string' && part.tool_call_id.trim().length > 0;
            }
            if (['image_url', 'video_url', 'audio_url'].includes(part.type)) {
                const mediaUrl = String(part[part.type]?.url ?? '').trim();
                const separatorIndex = mediaUrl.indexOf(',');
                return mediaUrl.toLowerCase().startsWith('data:')
                    && separatorIndex >= 0
                    && separatorIndex < mediaUrl.length - 1;
            }
            return false;
        });
    });
}

function normalizeFreeGeminiGenerationConfig(generationConfig, channel, model) {
    const requestedTopK = Number(generationConfig.topK);
    if (generationConfig.topK == null || generationConfig.topK === '' || !Number.isFinite(requestedTopK)) {
        delete generationConfig.topK;
    } else {
        generationConfig.topK = Math.min(64, Math.max(1, Math.trunc(requestedTopK)));
    }

    const requestedMaxTokens = Number(generationConfig.maxOutputTokens);
    if (generationConfig.maxOutputTokens == null || generationConfig.maxOutputTokens === '' || !Number.isFinite(requestedMaxTokens)) {
        if (Number.isInteger(channel?.maxOutputTokens) && channel.maxOutputTokens > 0) {
            generationConfig.maxOutputTokens = getFreeGeminiOutputLimit(channel, model);
        } else {
            delete generationConfig.maxOutputTokens;
        }
    } else {
        generationConfig.maxOutputTokens = Math.min(
            Math.max(1, Math.trunc(requestedMaxTokens)),
            getFreeGeminiOutputLimit(channel, model),
        );
    }

    if (typeof generationConfig.responseMimeType === 'string') {
        generationConfig.responseMimeType = generationConfig.responseMimeType.trim();
        if (!generationConfig.responseMimeType) {
            delete generationConfig.responseMimeType;
        } else if (generationConfig.responseMimeType.toLowerCase() === 'application/json') {
            generationConfig.responseMimeType = 'application/json';
        }
    }
    if (generationConfig.responseSchema != null
        && generationConfig.responseMimeType !== 'application/json') {
        delete generationConfig.responseSchema;
    }

    // Optional or incompatible fields must not reach stricter Gemini-compatible proxies.
    for (const [key, value] of Object.entries(generationConfig)) {
        if (value == null) {
            delete generationConfig[key];
        }
    }
}

function normalizeFreeGeminiRequestBody(body, channel, model) {
    const generationConfig = body.generationConfig ??= {};
    normalizeFreeGeminiGenerationConfig(generationConfig, channel, model);
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
        delete body.tools;
        delete body.toolConfig;
    }
    if (!Array.isArray(body.systemInstruction?.parts)
        || !body.systemInstruction.parts.some(hasFreeGeminiContentPart)) {
        delete body.systemInstruction;
    }

    if (!Array.isArray(body.contents) || body.contents.length === 0) {
        return false;
    }
    const hasContents = body.contents.some(content =>
        Array.isArray(content?.parts) && content.parts.some(hasFreeGeminiContentPart));
    const finalTurn = body.contents.at(-1);
    const finalTurnHasContents = Array.isArray(finalTurn?.parts)
        && finalTurn.parts.some(hasFreeGeminiContentPart);
    if (!hasContents || !finalTurnHasContents) {
        return false;
    }

    // Keep the model turn intact and append a user turn before the first upstream request.
    // Calling this normalizer again is idempotent because the new final role is already user.
    if (finalTurn.role === 'model') {
        body.contents.push({
            role: 'user',
            parts: [{ text: FREE_GEMINI_CONTINUATION_TEXT }],
        });
    }
    return true;
}

function normalizeFreeGeminiRequest({ modelId, messages, generationConfig, body, channel, model }) {
    if (!String(modelId ?? '').trim()) {
        return { code: 'FREE_GEMINI_INVALID_MODEL', message: 'model 不能为空。' };
    }
    if (!Array.isArray(messages) || messages.length === 0) {
        return { code: 'FREE_GEMINI_INVALID_CONTENTS', message: 'contents 不能为空。' };
    }
    if (generationConfig) {
        normalizeFreeGeminiGenerationConfig(generationConfig, channel, model);
    }
    if (body && !normalizeFreeGeminiRequestBody(body, channel, model)) {
        return { code: 'FREE_GEMINI_INVALID_CONTENTS', message: 'contents 不能为空。' };
    }
    return null;
}

function toFreeGeminiStatusModel(channel, model) {
    return {
        id: model.id,
        channel_id: channel.id,
        channel_name: channel.name,
        inputTokenLimit: model.inputTokenLimit ?? null,
        outputTokenLimit: getFreeGeminiOutputLimit(channel, model),
    };
}

async function getFreeGeminiStatusModels(channelId, apiVersion) {
    const channels = await listEnabledFreeGeminiChannels();
    const requestedId = String(channelId ?? '').trim();
    const selectedChannel = requestedId ? channels.find(channel => channel.id === requestedId) : null;
    if (requestedId && !selectedChannel) {
        throw createFreeGeminiRouteError(
            '该免费 Gemini 渠道不存在或已停用。',
            'FREE_GEMINI_CHANNEL_UNAVAILABLE',
            404,
        );
    }
    if (channels.length === 0) {
        return [];
    }

    const orderedChannels = requestedId
        ? [...channels.filter(channel => channel.id === requestedId), ...channels.filter(channel => channel.id !== requestedId)]
        : channels;
    const discoveryDeadlineAt = Date.now() + FREE_GEMINI_MODEL_DISCOVERY_MAX_WAIT_MS;
    const results = await Promise.allSettled(orderedChannels.map(async channel => ({
        channel,
        models: await waitForFreeGeminiModelDiscovery(
            getFreeGeminiChannelModels(channel, { apiVersion }),
            discoveryDeadlineAt,
        ),
    })));
    const models = new Map();
    let firstError;
    for (const result of results) {
        if (result.status === 'rejected') {
            firstError ??= result.reason;
            continue;
        }
        for (const model of result.value.models) {
            if ((!selectedChannel || isFreeGeminiModelAllowed(selectedChannel, model.id))
                && isFreeGeminiModelAllowed(result.value.channel, model.id)
                && !models.has(model.id)) {
                models.set(model.id, toFreeGeminiStatusModel(result.value.channel, model));
            }
        }
    }
    if (models.size === 0 && firstError && results.every(result => result.status === 'rejected')) {
        throw firstError;
    }
    return [...models.values()];
}

async function resolveFreeGeminiRoutes(modelId, preferredChannelId, apiVersion, requestStartedAt) {
    const channels = await listEnabledFreeGeminiChannels();
    const preferredId = String(preferredChannelId ?? '').trim();
    const preferredChannel = preferredId ? channels.find(channel => channel.id === preferredId) : null;
    if (preferredId && !preferredChannel) {
        throw createFreeGeminiRouteError(
            '该免费 Gemini 渠道不存在或已停用。',
            'FREE_GEMINI_CHANNEL_UNAVAILABLE',
            404,
        );
    }
    if (preferredChannel && !isFreeGeminiModelAllowed(preferredChannel, modelId)) {
        return { routes: [], deadlineAt: requestStartedAt };
    }

    const ordered = preferredId
        ? [...channels.filter(channel => channel.id === preferredId), ...channels.filter(channel => channel.id !== preferredId)]
        : channels;
    const eligible = ordered.filter(channel => isFreeGeminiModelAllowed(channel, modelId));
    const maximumTimeoutMs = eligible.length > 0
        ? Math.max(...eligible.map(channel => channel.timeoutMs))
        : 0;
    const requestDeadlineAt = requestStartedAt + maximumTimeoutMs;
    const discoveryDeadlineAt = Math.min(
        requestDeadlineAt,
        Date.now() + FREE_GEMINI_MODEL_DISCOVERY_MAX_WAIT_MS,
    );
    const results = await Promise.allSettled(eligible.map(channel => waitForFreeGeminiModelDiscovery(
        getFreeGeminiChannelModels(channel, { apiVersion }),
        discoveryDeadlineAt,
    )));
    const routes = [];
    let firstError;
    for (let index = 0; index < eligible.length; index++) {
        const result = results[index];
        if (result.status === 'rejected') {
            firstError ??= result.reason;
            const detail = result.reason?.code || 'models_unavailable';
            console.warn(`Free Gemini channel model discovery failed (${detail}).`);
            continue;
        }
        const model = result.value.find(item => item.id === modelId);
        if (model) {
            routes.push({ channel: eligible[index], model });
        }
    }
    if (routes.length === 0 && firstError) {
        throw firstError;
    }

    const routedTimeoutMs = routes.length > 0
        ? Math.max(...routes.map(route => route.channel.timeoutMs))
        : maximumTimeoutMs;
    return {
        routes,
        deadlineAt: requestStartedAt + routedTimeoutMs,
    };
}

/**
 * Module-scoped Claude caching configuration values.
 */
const cacheTTL = getConfigValue('claude.extendedTTL', false, 'boolean') ? '1h' : '5m';
const enableSystemPromptCache = getConfigValue('claude.enableSystemPromptCache', false, 'boolean');
const cachingAtDepth = (() => {
    const value = getConfigValue('claude.cachingAtDepth', -1, 'number');
    return Number.isInteger(value) && value >= 0 ? value : -1;
})();

/**
 * Cache for cacheable (writing) OpenRouter model IDs.
 * @type {string[]}
 */
const openRouterCacheableModels = [];

/**
 * Checks if an OpenRouter model supports prompt cache writing.
 * Uses a cache to avoid repeated API calls.
 * @param {string} modelId - The OpenRouter model ID
 * @returns {Promise<boolean>} `true` if the model supports writing cache
 */
async function isOpenRouterModelCacheable(modelId) {
    if (openRouterCacheableModels.includes(modelId)) {
        return true;
    }

    try {
        const response = await fetch(`${API_OPENROUTER}/models`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
            console.warn(`OpenRouter models API returned ${response.status}: ${response.statusText}`);
            return false;
        }

        /** @type {any} */
        const data = await response.json();

        if (!Array.isArray(data?.data)) {
            console.warn('OpenRouter API response format unexpected');
            return false;
        }

        const model = data.data.find(m => m.id === modelId);
        const supportsCache = model?.pricing?.input_cache_write != null;

        if (supportsCache) {
            openRouterCacheableModels.push(modelId);
        }

        return supportsCache;
    } catch (error) {
        console.warn(`Failed to check OpenRouter cache support for ${modelId}:`, error.message);
        return false;
    }
}

/**
 * Gets OpenRouter transforms based on the request.
 * @param {import('express').Request} request Express request
 * @returns {string[] | undefined} OpenRouter transforms
 */
function getOpenRouterTransforms(request) {
    switch (request.body.middleout) {
        case 'on':
            return ['middle-out'];
        case 'off':
            return [];
        case 'auto':
            return undefined;
    }
}

/**
 * Gets OpenRouter plugins based on the request.
 * @param {import('express').Request} request
 * @returns {any[]} OpenRouter plugins
 */
function getOpenRouterPlugins(request) {
    const plugins = [];

    if (request.body.enable_web_search) {
        plugins.push({ 'id': 'web' });
    }

    return plugins;
}

/**
 * Hacky way to use JSON schema only if json_object format is supported.
 * @param {object} bodyParams Additional body parameters
 * @param {object[]} messages Array of messages
 * @param {object} jsonSchema JSON schema object
 */
function setJsonObjectFormat(bodyParams, messages, jsonSchema) {
    bodyParams['response_format'] = {
        type: 'json_object',
    };
    const message = {
        role: 'user',
        content: `JSON schema for the response:\n${JSON.stringify(jsonSchema.value, null, 4)}`,
    };
    messages.push(message);
}

/**
 * Sends a request to Claude API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendClaudeRequest(request, response) {
    const apiUrl = new URL(request.body.reverse_proxy || API_CLAUDE).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.CLAUDE);
    const divider = '-'.repeat(process.stdout.columns);

    if (!apiKey) {
        console.warn(color.red(`Claude API key is missing.\n${divider}`));
        return response.status(400).send({ error: true });
    }

    try {
        const controller = new AbortController();
        response.once('close', function () {
            controller.abort();
        });
        const additionalHeaders = {};
        const betaHeaders = ['output-128k-2025-02-19'];
        const useTools = Array.isArray(request.body.tools) && request.body.tools.length > 0;
        const useSystemPrompt = Boolean(request.body.use_sysprompt);
        const convertedPrompt = convertClaudeMessages(request.body.messages, request.body.assistant_prefill, useSystemPrompt, useTools, getPromptNames(request));
        const useThinking = /^claude-(3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5)/.test(request.body.model);
        const useWebSearch = /^claude-(3-5|3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5)/.test(request.body.model) && Boolean(request.body.enable_web_search);
        const isLimitedSampling = /^claude-(opus-4-1|sonnet-4-5|haiku-4-5|opus-4-5)/.test(request.body.model);
        const useVerbosity = /^claude-(opus-4-5)/.test(request.body.model);
        let fixThinkingPrefill = false;
        // Add custom stop sequences
        const stopSequences = [];
        if (Array.isArray(request.body.stop)) {
            stopSequences.push(...request.body.stop);
        }

        const requestBody = {
            /** @type {any} */ system: [],
            messages: convertedPrompt.messages,
            model: request.body.model,
            max_tokens: request.body.max_tokens,
            stop_sequences: stopSequences,
            temperature: request.body.temperature,
            top_p: request.body.top_p,
            top_k: request.body.top_k,
            stream: request.body.stream,
        };
        if (useSystemPrompt) {
            if (enableSystemPromptCache && Array.isArray(convertedPrompt.systemPrompt) && convertedPrompt.systemPrompt.length) {
                convertedPrompt.systemPrompt[convertedPrompt.systemPrompt.length - 1]['cache_control'] = { type: 'ephemeral', ttl: cacheTTL };
            }

            requestBody.system = convertedPrompt.systemPrompt;
        } else {
            delete requestBody.system;
        }
        if (useTools) {
            betaHeaders.push('tools-2024-05-16');
            requestBody.tool_choice = { type: request.body.tool_choice };
            requestBody.tools = request.body.tools
                .filter(tool => tool.type === 'function')
                .map(tool => tool.function)
                .map(fn => ({ name: fn.name, description: fn.description, input_schema: flattenSchema(fn.parameters, request.body.chat_completion_source) }));

            if (enableSystemPromptCache && requestBody.tools.length) {
                requestBody.tools[requestBody.tools.length - 1]['cache_control'] = { type: 'ephemeral', ttl: cacheTTL };
            }
        }

        // Structured output is a forced tool
        if (request.body.json_schema) {
            const jsonTool = {
                name: request.body.json_schema.name,
                description: request.body.json_schema.description || 'Well-formed JSON object',
                input_schema: request.body.json_schema.value,
            };
            requestBody.tools = [...(requestBody.tools || []), jsonTool];
            requestBody.tool_choice = { type: 'tool', name: request.body.json_schema.name };
        }

        if (useWebSearch) {
            const webSearchTool = [{
                'type': 'web_search_20250305',
                'name': 'web_search',
            }];
            requestBody.tools = [...webSearchTool, ...(requestBody.tools || [])];
        }

        if (cachingAtDepth !== -1) {
            cachingAtDepthForClaude(convertedPrompt.messages, cachingAtDepth, cacheTTL);
        }

        if (enableSystemPromptCache || cachingAtDepth !== -1) {
            betaHeaders.push('prompt-caching-2024-07-31');
            betaHeaders.push('extended-cache-ttl-2025-04-11');
        }

        if (isLimitedSampling) {
            if (requestBody.top_p < 1) {
                delete requestBody.temperature;
            } else {
                delete requestBody.top_p;
            }
        }

        const reasoningEffort = request.body.reasoning_effort;
        const budgetTokens = calculateClaudeBudgetTokens(requestBody.max_tokens, reasoningEffort, requestBody.stream);

        if (useThinking && Number.isInteger(budgetTokens)) {
            // No prefill when thinking
            fixThinkingPrefill = true;
            const minThinkTokens = 1024;
            if (requestBody.max_tokens <= minThinkTokens) {
                const newValue = requestBody.max_tokens + minThinkTokens;
                console.warn(color.yellow(`Claude thinking requires a minimum of ${minThinkTokens} response tokens.`));
                console.info(color.blue(`Increasing response length to ${newValue}.`));
                requestBody.max_tokens = newValue;
            }
            requestBody.thinking = {
                type: 'enabled',
                budget_tokens: budgetTokens,
            };

            // NO I CAN'T SILENTLY IGNORE THE TEMPERATURE.
            delete requestBody.temperature;
            delete requestBody.top_p;
            delete requestBody.top_k;
        }

        if (fixThinkingPrefill && convertedPrompt.messages.length && convertedPrompt.messages[convertedPrompt.messages.length - 1].role === 'assistant') {
            convertedPrompt.messages[convertedPrompt.messages.length - 1].role = 'user';
        }

        // Verbosity = 'effort' (same values as OpenAI)
        if (useVerbosity && request.body.verbosity) {
            betaHeaders.push('effort-2025-11-24');
            requestBody.output_config ??= {};
            requestBody.output_config.effort = request.body.verbosity;
        }

        if (betaHeaders.length) {
            additionalHeaders['anthropic-beta'] = betaHeaders.join(',');
        }

        console.debug('Claude request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/messages', {
            method: 'POST',
            signal: controller.signal,
            body: JSON.stringify(requestBody),
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'x-api-key': apiKey,
                ...additionalHeaders,
            },
        });

        if (request.body.stream) {
            // Pipe remote SSE stream to Express response
            forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const generateResponseText = await generateResponse.text();
                console.warn(color.red(`Claude API returned error: ${generateResponse.status} ${generateResponse.statusText}\n${generateResponseText}\n${divider}`));
                return response.status(500).send({ error: true });
            }

            /** @type {any} */
            const generateResponseJson = await generateResponse.json();
            const responseText = generateResponseJson?.content?.[0]?.text || '';
            console.debug('Claude response:', generateResponseJson);

            // Wrap it back to OAI format + save the original content
            const reply = { choices: [{ 'message': { 'content': responseText } }], content: generateResponseJson.content };
            return response.send(reply);
        }
    } catch (error) {
        console.error(color.red(`Error communicating with Claude: ${error}\n${divider}`));
        if (!response.headersSent) {
            return response.status(500).send({ error: true });
        }
    }
}

/**
 * Sends a request to Google AI API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendMakerSuiteRequest(request, response, options = {}) {
    const freeGeminiChannel = options.freeGeminiChannel;
    const deferFreeGeminiFailover = Boolean(freeGeminiChannel && options.deferFreeGeminiFailover);
    const returnFreeGeminiFailure = (status, payload, canFailover = false) => {
        if (deferFreeGeminiFailover && canFailover) {
            return { freeGeminiFailover: true, status, payload };
        }
        return response.status(status).send(payload);
    };
    const useVertexAi = request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.VERTEXAI;
    const apiName = freeGeminiChannel?.name || (useVertexAi ? 'Google Vertex AI' : 'Google AI Studio');
    let apiUrl;
    let apiKey;

    let authHeader;
    let authType;

    if (useVertexAi) {
        apiUrl = new URL(request.body.reverse_proxy || API_VERTEX_AI);

        try {
            const auth = await getVertexAIAuth(request);
            authHeader = auth.authHeader;
            authType = auth.authType;
            console.debug(`Using Vertex AI authentication type: ${authType}`);
        } catch (error) {
            console.warn(`${apiName} authentication failed: ${error.message}`);
            return response.status(400).send({ error: true, message: error.message });
        }
    } else {
        apiUrl = new URL(freeGeminiChannel?.url || request.body.reverse_proxy || API_MAKERSUITE);
        apiKey = freeGeminiChannel?.key || (request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MAKERSUITE));

        if (!apiKey && (!request.body.reverse_proxy || freeGeminiChannel)) {
            console.warn(`${apiName} API key is missing.`);
            return response.status(400).send({ error: true });
        }

        authHeader = `Bearer ${apiKey}`;
        authType = 'api_key';
    }

    const model = String(request.body.model ?? '').trim();
    const stream = Boolean(request.body.stream);
    const enableWebSearch = Boolean(request.body.enable_web_search);
    const requestImages = Boolean(request.body.request_images);
    const reasoningEffort = String(request.body.reasoning_effort);
    const includeReasoning = Boolean(request.body.include_reasoning);
    const aspectRatio = String(request.body.request_image_aspect_ratio ?? '').trim();
    const imageSize = String(request.body.request_image_resolution ?? '').trim();
    const isGemma = model.includes('gemma');
    const isLearnLM = model.includes('learnlm');

    const responseMimeType = request.body.responseMimeType ?? (request.body.json_schema ? 'application/json' : undefined);
    const responseSchema = request.body.responseSchema ?? (request.body.json_schema ? request.body.json_schema.value : undefined);

    const generationConfig = {
        stopSequences: request.body.stop,
        candidateCount: 1,
        maxOutputTokens: request.body.max_tokens,
        temperature: request.body.temperature,
        topP: request.body.top_p,
        topK: freeGeminiChannel ? request.body.top_k : (request.body.top_k || undefined),
        responseMimeType: responseMimeType,
        responseSchema: responseSchema,
        seed: request.body.seed,
    };
    if (freeGeminiChannel) {
        const normalizationError = normalizeFreeGeminiRequest({
            modelId: model,
            messages: request.body.messages,
            generationConfig,
            channel: freeGeminiChannel,
            model: options.freeGeminiModel,
        });
        if (normalizationError) {
            return response.status(400).send({ error: normalizationError });
        }
    }

    function getGeminiBody() {
        // #region UGLY MODEL LISTS AREA
        const imageGenerationModels = [
            'gemini-2.0-flash-exp',
            'gemini-2.0-flash-exp-image-generation',
            'gemini-2.0-flash-preview-image-generation',
            'gemini-2.5-flash-image-preview',
            'gemini-2.5-flash-image',
            'gemini-3-pro-image-preview',
        ];

        const isThinkingConfigModel = m => (/^gemini-2.5-(flash|pro)/.test(m) && !/-image(-preview)?$/.test(m)) || (/^gemini-3-(flash|pro)/.test(m));
        const isImageSizeModel = m => /^gemini-3/.test(m);

        const noSearchModels = [
            'gemini-2.0-flash-lite',
            'gemini-2.0-flash-lite-001',
            'gemini-2.0-flash-lite-preview-02-05',
            'gemini-robotics-er-1.5-preview',
        ];
        // #endregion

        if (!Array.isArray(generationConfig.stopSequences) || !generationConfig.stopSequences.length) {
            delete generationConfig.stopSequences;
        }

        const enableImageModality = requestImages && imageGenerationModels.includes(model);
        if (enableImageModality) {
            generationConfig.responseModalities = ['text', 'image'];
            // An explicit image request takes precedence over structured JSON output on free channels.
            if (freeGeminiChannel) {
                delete generationConfig.responseMimeType;
                delete generationConfig.responseSchema;
            }
            const imageConfig = {};
            if (imageSize && isImageSizeModel(model)) {
                imageConfig.imageSize = imageSize;
            }
            if (aspectRatio) {
                imageConfig.aspectRatio = aspectRatio;
            }
            if (Object.keys(imageConfig).length > 0) {
                generationConfig.imageConfig = imageConfig;
            }
        }

        const useSystemPrompt = !enableImageModality && !isGemma && request.body.use_sysprompt;

        const tools = [];
        const prompt = convertGooglePrompt(request.body.messages, model, useSystemPrompt, getPromptNames(request));
        const safetySettings = [...GEMINI_SAFETY, ...(useVertexAi ? VERTEX_SAFETY : [])];

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0 && !enableImageModality && !isGemma) {
            const functionDeclarations = [];
            const customTools = [];
            for (const tool of request.body.tools) {
                if (tool.type === 'function') {
                    if (tool.function.parameters?.$schema) {
                        delete tool.function.parameters.$schema;
                    }
                    if (tool.function.parameters?.properties && Object.keys(tool.function.parameters.properties).length === 0) {
                        delete tool.function.parameters;
                    }
                    functionDeclarations.push(tool.function);
                } else if (tool[tool.type]) {
                    customTools.push({ [tool.type]: tool[tool.type] });
                }
            }
            if (functionDeclarations.length > 0) {
                tools.push({ function_declarations: functionDeclarations });
            }
            // Custom tools are only supported when no function calling is present
            if (functionDeclarations.length === 0 && customTools.length > 0) {
                tools.push(...customTools);
            }
        }

        if (enableWebSearch && !enableImageModality && !isGemma && !isLearnLM && !noSearchModels.includes(model)) {
            // Tool use with function calling is unsupported
            if (!tools.some(t => t.function_declarations)) {
                tools.push({ google_search: {} });
            }
        }

        if (isThinkingConfigModel(model)) {
            const thinkingConfig = { includeThoughts: includeReasoning };

            const thinkingBudget = calculateGoogleBudgetTokens(generationConfig.maxOutputTokens, reasoningEffort, model);
            if (typeof thinkingBudget === 'number' && Number.isInteger(thinkingBudget)) {
                thinkingConfig.thinkingBudget = thinkingBudget;
            }

            if (typeof thinkingBudget === 'string' && thinkingBudget.length > 0) {
                thinkingConfig.thinkingLevel = thinkingBudget;
            }

            // Vertex doesn't allow mixing disabled thinking with includeThoughts
            if (useVertexAi && thinkingBudget === 0 && thinkingConfig.includeThoughts) {
                console.info('Thinking budget is 0, but includeThoughts is true. Thoughts will not be included in the response.');
                thinkingConfig.includeThoughts = false;
            }

            generationConfig.thinkingConfig = thinkingConfig;
        }

        let body = {
            contents: prompt.contents,
            safetySettings: safetySettings,
            generationConfig: generationConfig,
        };

        if (useSystemPrompt && Array.isArray(prompt.system_instruction.parts) && prompt.system_instruction.parts.length) {
            body.systemInstruction = prompt.system_instruction;
        }

        if (tools.length) {
            body.tools = tools;

            const toolChoice = request.body.tool_choice;
            let functionCallingConfig;

            // Translate OpenAI's `tool_choice` to Gemini's `functionCallingConfig`
            if (typeof toolChoice === 'string') {
                switch (toolChoice) {
                    case 'none':
                        functionCallingConfig = { mode: 'NONE' };
                        break;
                    case 'required':
                        functionCallingConfig = { mode: 'ANY' };
                        break;
                    case 'auto':
                        functionCallingConfig = { mode: 'AUTO' };
                        break;
                }
            } else if (typeof toolChoice === 'object' && toolChoice?.function?.name) {
                // Force a specific function call
                functionCallingConfig = {
                    mode: 'ANY',
                    allowedFunctionNames: [toolChoice.function.name],
                };
            }

            if (functionCallingConfig) {
                body.toolConfig = { functionCallingConfig };
            }
        }

        return body;
    }

    const body = getGeminiBody();
    if (freeGeminiChannel) {
        const normalizationError = normalizeFreeGeminiRequest({
            modelId: model,
            messages: request.body.messages,
            body,
            channel: freeGeminiChannel,
            model: options.freeGeminiModel,
        });
        if (normalizationError) {
            return response.status(400).send({ error: normalizationError });
        }
        console.debug(`${apiName} request prepared for model ${model}.`);
    } else {
        console.debug(`${apiName} request:`, body);
    }

    let freeGeminiTimedOut = false;
    const disconnectController = new AbortController();
    const abortOnResponseClose = () => disconnectController.abort();
    response.once('close', abortOnResponseClose);
    try {
        const apiVersion = getConfigValue('gemini.apiVersion', 'v1beta');
        const responseType = (stream ? 'streamGenerateContent' : 'generateContent');

        let url;
        let headers = {
            'Content-Type': 'application/json',
        };

        if (useVertexAi) {
            if (authType === 'express') {
                // For Express mode (API key authentication), use the key parameter
                const keyParam = authHeader.replace('Bearer ', '');
                const region = request.body.vertexai_region || 'us-central1';
                const projectId = request.body.vertexai_express_project_id;
                const baseUrl = region === 'global'
                    ? 'https://aiplatform.googleapis.com'
                    : `https://${region}-aiplatform.googleapis.com`;
                url = projectId
                    ? `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${responseType}?key=${keyParam}${stream ? '&alt=sse' : ''}`
                    : `${baseUrl}/v1/publishers/google/models/${model}:${responseType}?key=${keyParam}${stream ? '&alt=sse' : ''}`;
            } else if (authType === 'full') {
                // For Full mode (service account authentication), use project-specific URL
                // Get project ID from Service Account JSON
                const serviceAccountJson = readSecret(request.user.directories, SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT);
                if (!serviceAccountJson) {
                    console.warn('Vertex AI Service Account JSON is missing.');
                    return response.status(400).send({ error: true });
                }

                let projectId;
                try {
                    const serviceAccount = JSON.parse(serviceAccountJson);
                    projectId = getProjectIdFromServiceAccount(serviceAccount);
                } catch (error) {
                    console.error('Failed to extract project ID from Service Account JSON:', error);
                    return response.status(400).send({ error: true });
                }
                const region = request.body.vertexai_region || 'us-central1';
                // Handle global region differently - no region prefix in hostname
                if (region === 'global') {
                    url = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${responseType}${stream ? '?alt=sse' : ''}`;
                } else {
                    url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${responseType}${stream ? '?alt=sse' : ''}`;
                }
                headers['Authorization'] = authHeader;
            } else {
                // For proxy mode, use the original URL with Authorization header
                url = `${apiUrl.toString().replace(/\/$/, '')}/v1/publishers/google/models/${model}:${responseType}${stream ? '?alt=sse' : ''}`;
                headers['Authorization'] = authHeader;
            }
        } else {
            const versionBaseUrl = getGeminiVersionBaseUrl(apiUrl, apiVersion);
            const requestModel = freeGeminiChannel ? encodeURIComponent(model) : model;
            const requestKey = freeGeminiChannel ? encodeURIComponent(apiKey) : apiKey;
            url = `${versionBaseUrl}/models/${requestModel}:${responseType}?key=${requestKey}${stream ? '&alt=sse' : ''}`;
        }

        let generateResponse;
        const maxAttempts = freeGeminiChannel ? freeGeminiChannel.maxRetries + 1 : 1;
        const retryStatuses = new Set([429, 502, 503, 504]);
        const transientCodes = new Set([
            'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
            'ENETRESET', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
        ]);
        const requestStartedAt = Date.now();
        const channelDeadlineAt = freeGeminiChannel ? requestStartedAt + freeGeminiChannel.timeoutMs : Number.POSITIVE_INFINITY;
        const deadlineAt = freeGeminiChannel
            ? Math.min(channelDeadlineAt, options.freeGeminiDeadlineAt ?? Number.POSITIVE_INFINITY)
            : Number.POSITIVE_INFINITY;
        const createTimeoutError = () => {
            freeGeminiTimedOut = true;
            const error = new Error('免费 Gemini 渠道请求超时。');
            error.code = 'FREE_GEMINI_TIMEOUT';
            error.status = 504;
            error.freeGeminiFailover = true;
            return error;
        };
        const waitBeforeRetry = async (attempt) => {
            const remainingMs = deadlineAt - Date.now();
            if (remainingMs <= 0) {
                throw createTimeoutError();
            }
            const backoffMs = Math.min(1000, 100 * (2 ** attempt)) + Math.floor(Math.random() * 100);
            const delayMs = Math.min(backoffMs, remainingMs);
            await new Promise(resolve => {
                let timer;
                const finish = () => {
                    clearTimeout(timer);
                    disconnectController.signal.removeEventListener('abort', finish);
                    resolve();
                };
                timer = setTimeout(finish, delayMs);
                disconnectController.signal.addEventListener('abort', finish, { once: true });
                if (disconnectController.signal.aborted) {
                    finish();
                }
            });
            if (disconnectController.signal.aborted) {
                return false;
            }
            if (Date.now() >= deadlineAt) {
                throw createTimeoutError();
            }
            return true;
        };

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (disconnectController.signal.aborted) {
                return;
            }
            const remainingTimeoutMs = deadlineAt - Date.now();
            if (freeGeminiChannel && remainingTimeoutMs <= 0) {
                throw createTimeoutError();
            }
            const attemptController = new AbortController();
            const abortAttempt = () => attemptController.abort();
            disconnectController.signal.addEventListener('abort', abortAttempt, { once: true });
            let timedOut = false;
            const timeout = freeGeminiChannel ? setTimeout(() => {
                timedOut = true;
                freeGeminiTimedOut = true;
                attemptController.abort();
            }, remainingTimeoutMs) : null;
            let activeBody;
            let cleanedUp = false;
            const cleanupAttempt = () => {
                if (cleanedUp) {
                    return;
                }
                cleanedUp = true;
                if (timeout) {
                    clearTimeout(timeout);
                }
                disconnectController.signal.removeEventListener('abort', abortAttempt);
                activeBody?.removeListener('end', cleanupAttempt);
                activeBody?.removeListener('close', cleanupAttempt);
                activeBody?.removeListener('error', cleanupAttempt);
            };

            try {
                generateResponse = await fetch(url, {
                    body: JSON.stringify(body),
                    method: 'POST',
                    headers: headers,
                    signal: attemptController.signal,
                    agent: freeGeminiChannel ? getFreeGeminiFetchAgent(freeGeminiChannel) : undefined,
                    redirect: freeGeminiChannel ? 'error' : 'follow',
                    size: freeGeminiChannel ? 16 * 1024 * 1024 : 0,
                });
            } catch (error) {
                cleanupAttempt();
                if (disconnectController.signal.aborted) {
                    return;
                }
                const errorCode = error?.cause?.code || error?.code || error?.name;
                const retryable = freeGeminiChannel && !timedOut && transientCodes.has(errorCode);
                if (retryable && attempt + 1 < maxAttempts) {
                    console.warn(`Free Gemini transient request failure; retrying (${attempt + 1}/${freeGeminiChannel.maxRetries}).`);
                    if (!await waitBeforeRetry(attempt)) {
                        return;
                    }
                    continue;
                }
                if (freeGeminiChannel) {
                    const wrapped = new Error(timedOut ? '免费 Gemini 渠道请求超时。' : '免费 Gemini 渠道网络请求失败。');
                    wrapped.code = timedOut ? 'FREE_GEMINI_TIMEOUT' : 'FREE_GEMINI_NETWORK_ERROR';
                    wrapped.status = timedOut ? 504 : 502;
                    wrapped.freeGeminiFailover = timedOut || transientCodes.has(errorCode);
                    throw wrapped;
                }
                throw error;
            }

            if (freeGeminiChannel && retryStatuses.has(generateResponse.status) && attempt + 1 < maxAttempts) {
                cleanupAttempt();
                generateResponse.body?.destroy();
                console.warn(`Free Gemini upstream returned ${generateResponse.status}; retrying (${attempt + 1}/${freeGeminiChannel.maxRetries}).`);
                if (!await waitBeforeRetry(attempt)) {
                    return;
                }
                continue;
            }
            activeBody = generateResponse.body;
            if (activeBody) {
                activeBody.once('end', cleanupAttempt);
                activeBody.once('close', cleanupAttempt);
                activeBody.once('error', cleanupAttempt);
            } else {
                cleanupAttempt();
            }

            if (freeGeminiChannel && stream && generateResponse.ok) {
                try {
                    if (!activeBody) {
                        const error = new Error('免费 Gemini 流式响应缺少正文。');
                        error.code = 'FREE_GEMINI_STREAM_FAILED';
                        throw error;
                    }
                    await waitForFreeGeminiFirstStreamChunk(activeBody, disconnectController.signal);
                } catch (error) {
                    cleanupAttempt();
                    activeBody?.destroy();
                    if (disconnectController.signal.aborted) {
                        return;
                    }
                    if (timedOut || Date.now() >= deadlineAt) {
                        throw createTimeoutError();
                    }
                    const wrapped = new Error('免费 Gemini 流式响应在首字节前失败。', { cause: error });
                    wrapped.code = 'FREE_GEMINI_STREAM_FAILED';
                    wrapped.status = 502;
                    wrapped.freeGeminiFailover = true;
                    throw wrapped;
                }
            }
            break;
        }

        if (!generateResponse || disconnectController.signal.aborted) {
            return;
        }

        // Preserve the original MakerSuite/Vertex streaming proxy semantics: forward the
        // upstream status and body verbatim, including non-2xx responses.
        if (stream && !freeGeminiChannel) {
            try {
                return forwardFetchResponse(generateResponse, response);
            } catch (error) {
                console.error('Error forwarding streaming response:', error);
                if (!response.headersSent) {
                    return response.status(500).send({ error: true });
                }
                return;
            }
        }

        if (!generateResponse.ok) {
            const errorText = await generateResponse.text();
            const errorJson = tryParse(errorText);
            console.warn(`${apiName} API returned status ${generateResponse.status}.`);
            if (freeGeminiChannel) {
                const upstreamStatus = mapFreeGeminiUpstreamStatus(generateResponse.status);
                const upstreamMessage = errorJson?.error?.message ?? generateResponse.statusText;
                const upstreamCode = errorJson?.error?.code ?? errorJson?.error?.status;
                const payload = {
                    error: {
                        code: 'FREE_GEMINI_UPSTREAM_ERROR',
                        message: sanitizeFreeGeminiUpstreamMessage(upstreamMessage, apiKey),
                        ...(upstreamCode ? { upstream_code: sanitizeFreeGeminiUpstreamMessage(upstreamCode, apiKey).slice(0, 100) } : {}),
                    },
                };
                if (!disconnectController.signal.aborted && !response.headersSent) {
                    const canFailover = retryStatuses.has(generateResponse.status);
                    return returnFreeGeminiFailure(upstreamStatus, payload, canFailover);
                }
                return;
            }
            return response.status(500).send(errorJson ?? { error: true });
        }

        if (stream) {
            try {
                if (!disconnectController.signal.aborted) {
                    generateResponse.body?.once('error', error => {
                        console.error('Free Gemini stream failed after commitment:', error?.code || error?.name || 'stream_failed');
                        if (!response.writableEnded) {
                            writeFreeGeminiStreamError(response);
                            response.end();
                        }
                    });
                    return forwardFetchResponse(generateResponse, response);
                }
                generateResponse.body?.destroy();
                return;
            } catch (error) {
                if (disconnectController.signal.aborted) {
                    return;
                }
                console.error('Error forwarding streaming response:', error?.code || error?.name || 'stream_failed');
                if (!response.headersSent) {
                    return response.status(502).send({
                        error: { code: 'FREE_GEMINI_STREAM_FAILED', message: '免费 Gemini 流式响应转发失败。' },
                    });
                }
                if (!response.writableEnded) {
                    response.end();
                }
                return;
            }
        }

        const responseTextBody = await generateResponse.text();
        const generateResponseJson = tryParse(responseTextBody);
        if (!generateResponseJson || typeof generateResponseJson !== 'object') {
            if (freeGeminiChannel) {
                return returnFreeGeminiFailure(502, {
                    error: { code: 'FREE_GEMINI_INVALID_RESPONSE', message: '免费 Gemini 渠道返回了无效响应。' },
                });
            }
            return response.status(500).send({ error: true });
        }

        const candidates = generateResponseJson?.candidates;
        const hasPromptFeedback = generateResponseJson.promptFeedback
            && typeof generateResponseJson.promptFeedback === 'object'
            && !Array.isArray(generateResponseJson.promptFeedback);
        if (freeGeminiChannel && (Array.isArray(generateResponseJson)
            || (!Object.hasOwn(generateResponseJson, 'candidates') && !hasPromptFeedback)
            || (Object.hasOwn(generateResponseJson, 'candidates') && !Array.isArray(candidates)))) {
            return returnFreeGeminiFailure(502, {
                error: { code: 'FREE_GEMINI_INVALID_RESPONSE', message: '免费 Gemini 渠道返回了无效响应。' },
            });
        }
        if (!Array.isArray(candidates) || candidates.length === 0) {
            const blockReason = generateResponseJson?.promptFeedback?.blockReason;
            if (freeGeminiChannel) {
                return response.status(422).send({
                    error: {
                        code: blockReason ? 'FREE_GEMINI_SAFETY_BLOCKED' : 'FREE_GEMINI_NO_CANDIDATE',
                        message: blockReason ? '请求被 Gemini 安全策略阻止。' : 'Gemini 未返回候选结果。',
                    },
                });
            }
            let message = `${apiName} API returned no candidate`;
            if (blockReason) {
                message += `\nPrompt was blocked due to: ${blockReason}`;
            }
            return response.send({ error: { message } });
        }

        const responseContent = candidates[0].content ?? candidates[0].output;
        const responseParts = candidates[0]?.content?.parts ?? [];
        const functionCall = responseParts.some(part => part.functionCall);
        const inlineData = responseParts.some(part => part.inlineData);
        if (freeGeminiChannel) {
            console.debug(`${apiName} returned ${candidates.length} candidate(s).`);
        } else {
            console.debug(`${apiName} response:`, util.inspect(generateResponseJson, { depth: 5, colors: true }));
        }

        const responseText = typeof responseContent === 'string'
            ? responseContent
            : responseContent?.parts
                ?.filter(part => !part.thought && typeof part.text === 'string')
                ?.map(part => part.text)
                ?.join('\n\n');
        if ((!responseText || !responseText.trim()) && !functionCall && !inlineData) {
            const finishReason = String(candidates[0]?.finishReason ?? '').toUpperCase();
            const safetyBlocked = ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION'].includes(finishReason);
            if (freeGeminiChannel) {
                return response.status(422).send({
                    error: {
                        code: safetyBlocked ? 'FREE_GEMINI_SAFETY_BLOCKED' : 'FREE_GEMINI_EMPTY_OUTPUT',
                        message: safetyBlocked ? '响应被 Gemini 安全策略阻止。' : 'Gemini 返回了空输出。',
                    },
                });
            }
            return response.send({ error: { message: `${apiName} Candidate text empty` } });
        }

        const reply = { choices: [{ 'message': { 'content': responseText } }], responseContent };
        return response.send(reply);
    } catch (error) {
        if (freeGeminiChannel && (response.destroyed || response.writableEnded)) {
            return;
        }
        const errorDetails = freeGeminiChannel
            ? (error?.code || error?.cause?.code || error?.name || 'request_failed')
            : error;
        if (freeGeminiChannel && error?.name === 'AbortError' && !freeGeminiTimedOut) {
            return;
        }
        console.error(`Error communicating with ${apiName} API:`, freeGeminiTimedOut ? 'FREE_GEMINI_TIMEOUT' : errorDetails);
        if (!response.headersSent) {
            const status = freeGeminiTimedOut
                ? 504
                : freeGeminiChannel
                    ? (Number.isInteger(error?.status) ? error.status : 502)
                    : 500;
            const payload = freeGeminiChannel
                ? {
                    error: {
                        code: freeGeminiTimedOut ? 'FREE_GEMINI_TIMEOUT' : (error?.code || 'FREE_GEMINI_REQUEST_FAILED'),
                        message: freeGeminiTimedOut
                            ? '免费 Gemini 渠道请求超时。'
                            : error?.code === 'FREE_GEMINI_NETWORK_ERROR'
                                ? '免费 Gemini 渠道网络请求失败。'
                                : '免费 Gemini 请求失败。',
                    },
                }
                : { error: true };
            if (freeGeminiChannel) {
                return returnFreeGeminiFailure(status, payload, error?.freeGeminiFailover === true);
            }
            return response.status(status).send(payload);
        }
        if (!response.writableEnded) {
            response.end();
        }
    } finally {
        response.removeListener('close', abortOnResponseClose);
    }
}

/**
 * Sends a request to AI21 API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendAI21Request(request, response) {
    if (!request.body) return response.sendStatus(400);

    const apiKey = readSecret(request.user.directories, SECRET_KEYS.AI21);
    if (!apiKey) {
        console.warn('AI21 API key is missing.');
        return response.status(400).send({ error: true });
    }

    const bodyParams = {};
    const controller = new AbortController();
    response.once('close', function () {
        controller.abort();
    });
    // Hack to support JSON schema
    if (request.body.json_schema) {
        bodyParams.response_format = {
            type: 'json_object',
        };
        const message = {
            role: 'user',
            content: `JSON schema for the response:\n${JSON.stringify(request.body.json_schema.value, null, 4)}`,
        };
        request.body.messages.push(message);
    }
    const convertedPrompt = convertAI21Messages(request.body.messages, getPromptNames(request));
    const body = {
        messages: convertedPrompt,
        model: request.body.model,
        max_tokens: request.body.max_tokens,
        temperature: request.body.temperature,
        top_p: request.body.top_p,
        stop: request.body.stop,
        stream: request.body.stream,
        tools: request.body.tools,
        ...bodyParams,
    };
    const options = {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
    };

    console.debug('AI21 request:', body);

    try {
        const generateResponse = await fetch(API_AI21 + '/chat/completions', options);
        if (request.body.stream) {
            forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`AI21 API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('AI21 response:', generateResponseJson);
            return response.send(generateResponseJson);
        }
    } catch (error) {
        console.error('Error communicating with AI21 API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to MistralAI API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendMistralAIRequest(request, response) {
    const apiUrl = new URL(request.body.reverse_proxy || API_MISTRAL).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MISTRALAI);

    if (!apiKey) {
        console.warn('MistralAI API key is missing.');
        return response.status(400).send({ error: true });
    }

    try {
        const messages = convertMistralMessages(request.body.messages, getPromptNames(request));
        const controller = new AbortController();
        response.once('close', function () {
            controller.abort();
        });

        const requestBody = {
            'model': request.body.model,
            'messages': messages,
            'temperature': request.body.temperature,
            'top_p': request.body.top_p,
            'frequency_penalty': request.body.frequency_penalty,
            'presence_penalty': request.body.presence_penalty,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'safe_prompt': request.body.safe_prompt,
            'random_seed': request.body.seed === -1 ? undefined : request.body.seed,
            'stop': Array.isArray(request.body.stop) && request.body.stop.length > 0 ? request.body.stop : undefined,
        };

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            requestBody['tools'] = request.body.tools;
            requestBody['tool_choice'] = request.body.tool_choice;
        }

        if (request.body.json_schema) {
            requestBody['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    description: request.body.json_schema.description,
                    schema: request.body.json_schema.value,
                    strict: request.body.json_schema.strict ?? true,
                },
            };
        }

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
            timeout: 0,
        };

        console.debug('MisralAI request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);
        if (request.body.stream) {
            forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`MistralAI API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('MistralAI response:', generateResponseJson);
            return response.send(generateResponseJson);
        }
    } catch (error) {
        console.error('Error communicating with MistralAI API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to Cohere API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendCohereRequest(request, response) {
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.COHERE);
    const controller = new AbortController();
    response.once('close', function () {
        controller.abort();
    });

    if (!apiKey) {
        console.warn('Cohere API key is missing.');
        return response.status(400).send({ error: true });
    }

    try {
        const convertedHistory = convertCohereMessages(request.body.messages, getPromptNames(request));
        const tools = [];

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            tools.push(...request.body.tools);
            tools.forEach(tool => {
                if (tool?.function?.parameters?.$schema) {
                    delete tool.function.parameters.$schema;
                }
            });
        }

        // https://docs.cohere.com/reference/chat
        const requestBody = {
            stream: Boolean(request.body.stream),
            model: request.body.model,
            messages: convertedHistory.chatHistory,
            temperature: request.body.temperature,
            max_tokens: request.body.max_tokens,
            k: request.body.top_k,
            p: request.body.top_p,
            seed: request.body.seed,
            stop_sequences: request.body.stop,
            frequency_penalty: request.body.frequency_penalty,
            presence_penalty: request.body.presence_penalty,
            documents: [],
            tools: tools,
        };

        const canDoSafetyMode = String(request.body.model).endsWith('08-2024');
        if (canDoSafetyMode) {
            requestBody.safety_mode = 'OFF';
        }

        if (request.body.json_schema) {
            requestBody.response_format = {
                type: 'json_schema',
                schema: request.body.json_schema.value,
            };
        }

        console.debug('Cohere request:', requestBody);

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
            timeout: 0,
        };

        const apiUrl = API_COHERE_V2 + '/chat';

        if (request.body.stream) {
            const stream = await fetch(apiUrl, config);
            forwardFetchResponse(stream, response);
        } else {
            const generateResponse = await fetch(apiUrl, config);
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`Cohere API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('Cohere response:', generateResponseJson);
            return response.send(generateResponseJson);
        }
    } catch (error) {
        console.error('Error communicating with Cohere API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to DeepSeek API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendDeepSeekRequest(request, response) {
    const apiUrl = new URL(request.body.reverse_proxy || API_DEEPSEEK).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.DEEPSEEK);

    if (!apiKey && !request.body.reverse_proxy) {
        console.warn('DeepSeek API key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();
    response.once('close', function () {
        controller.abort();
    });

    try {
        let bodyParams = {};

        if (request.body.logprobs > 0) {
            bodyParams['top_logprobs'] = request.body.logprobs;
            bodyParams['logprobs'] = true;
        }

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;

            // DeepSeek doesn't permit empty required arrays
            bodyParams.tools.forEach(tool => {
                const required = tool?.function?.parameters?.required;
                if (Array.isArray(required) && required.length === 0) {
                    delete tool.function.parameters.required;
                }
            });
        }

        // Hack to support JSON schema
        if (request.body.json_schema) {
            bodyParams.response_format = {
                type: 'json_object',
            };
            const message = {
                role: 'user',
                content: `JSON schema for the response:\n${JSON.stringify(request.body.json_schema.value, null, 4)}`,
            };
            request.body.messages.push(message);
        }

        const processedMessages = addAssistantPrefix(postProcessPrompt(request.body.messages, PROMPT_PROCESSING_TYPE.SEMI_TOOLS, getPromptNames(request)), bodyParams.tools, 'prefix');

        if (/-reasoner/.test(request.body.model)) {
            addReasoningContentToToolCalls(processedMessages);
        }

        const requestBody = {
            'messages': processedMessages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'stop': request.body.stop,
            'seed': request.body.seed,
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };

        console.debug('DeepSeek request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`DeepSeek API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('DeepSeek response:', generateResponseJson);
            return response.send(generateResponseJson);
        }
    } catch (error) {
        console.error('Error communicating with DeepSeek API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to XAI API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendXaiRequest(request, response) {
    const apiUrl = new URL(request.body.reverse_proxy || API_XAI).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.XAI);

    if (!apiKey && !request.body.reverse_proxy) {
        console.warn('xAI API key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();
    response.once('close', function () {
        controller.abort();
    });

    try {
        let bodyParams = {};

        if (request.body.logprobs > 0) {
            bodyParams['top_logprobs'] = request.body.logprobs;
            bodyParams['logprobs'] = true;
        }

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        if (Array.isArray(request.body.stop) && request.body.stop.length > 0) {
            bodyParams['stop'] = request.body.stop;
        }

        if (request.body.reasoning_effort) {
            bodyParams['reasoning_effort'] = request.body.reasoning_effort === 'high' ? 'high' : 'low';
        }

        if (request.body.enable_web_search) {
            bodyParams['search_parameters'] = {
                mode: 'on',
                sources: [
                    { type: 'web', safe_search: false },
                    { type: 'news', safe_search: false },
                    { type: 'x' },
                ],
            };
        }

        if (request.body.json_schema) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    strict: request.body.json_schema.strict ?? true,
                    schema: request.body.json_schema.value,
                },
            };
        }

        const processedMessages = request.body.messages = convertXAIMessages(request.body.messages, getPromptNames(request));

        const requestBody = {
            'messages': processedMessages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'max_completion_tokens': request.body.max_completion_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'seed': request.body.seed,
            'n': request.body.n,
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };

        console.debug('xAI request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`xAI API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('xAI response:', generateResponseJson);
            return response.send(generateResponseJson);
        }
    } catch (error) {
        console.error('Error communicating with xAI API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to AI/ML API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendAimlapiRequest(request, response) {
    const apiUrl = API_AIMLAPI;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.AIMLAPI);

    if (!apiKey) {
        console.warn('AI/ML API key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();
    response.once('close', function () {
        controller.abort();
    });

    try {
        let bodyParams = {};

        if (request.body.logprobs > 0) {
            bodyParams['top_logprobs'] = request.body.logprobs;
            bodyParams['logprobs'] = true;
        }

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        if (Array.isArray(request.body.stop) && request.body.stop.length > 0) {
            bodyParams['stop'] = request.body.stop;
        }

        if (request.body.reasoning_effort) {
            bodyParams['reasoning_effort'] = request.body.reasoning_effort;
        }

        if (request.body.json_schema) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    description: request.body.json_schema.description,
                    schema: request.body.json_schema.value,
                    strict: request.body.json_schema.strict ?? true,
                },
            };
        }

        const requestBody = {
            'messages': request.body.messages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'seed': request.body.seed,
            'n': request.body.n,
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
                ...AIMLAPI_HEADERS,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };

        console.debug('AI/ML API request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`AI/ML API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('AI/ML API response:', generateResponseJson);
            return response.send(generateResponseJson);
        }
    } catch (error) {
        console.error('Error communicating with AI/ML API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to Electron Hub.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendElectronHubRequest(request, response) {
    const apiUrl = API_ELECTRONHUB;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.ELECTRONHUB);

    if (!apiKey) {
        console.warn('Electron Hub key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();
    response.once('close', function () {
        controller.abort();
    });

    try {
        let bodyParams = {};

        if (request.body.enable_web_search) {
            bodyParams['web_search'] = true;
        }

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        if (request.body.reasoning_effort) {
            bodyParams['reasoning_effort'] = request.body.reasoning_effort;
        }

        if (request.body.json_schema) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    description: request.body.json_schema.description,
                    schema: request.body.json_schema.value,
                    strict: request.body.json_schema.strict ?? true,
                },
            };
        }

        const isClaude = /^claude-/.test(request.body.model);

        if (Array.isArray(request.body.messages) && isClaude) {
            if (enableSystemPromptCache) {
                cachingSystemPromptForOpenRouter(request.body.messages, cacheTTL);
            }

            if (cachingAtDepth !== -1) {
                cachingAtDepthForOpenRouterClaude(request.body.messages, cachingAtDepth, cacheTTL);
            }
        }

        const requestBody = {
            'messages': request.body.messages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'top_k': request.body.top_k,
            'logit_bias': request.body.logit_bias,
            'seed': request.body.seed,
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };

        console.debug('Electron Hub request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn('Electron Hub returned error: ', errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('Electron Hub response:', generateResponseJson);
            return response.send(generateResponseJson);
        }
    }
    catch (error) {
        console.error('Error communicating with Electron Hub: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to Chutes.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendChutesRequest(request, response) {
    const apiUrl = API_CHUTES;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.CHUTES);

    if (!apiKey) {
        console.warn('Chutes key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();
    response.once('close', function () {
        controller.abort();
    });

    try {
        let bodyParams = {};

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        if (request.body.logprobs > 0) {
            bodyParams['top_logprobs'] = request.body.logprobs;
            bodyParams['logprobs'] = true;
        }

        if (request.body.json_schema) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    description: request.body.json_schema.description,
                    schema: request.body.json_schema.value,
                    strict: request.body.json_schema.strict ?? true,
                },
            };
        }

        const requestBody = {
            'messages': request.body.messages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'repetition_penalty': request.body.repetition_penalty,
            'min_p': request.body.min_p,
            'top_p': request.body.top_p,
            'top_k': request.body.top_k,
            'seed': request.body.seed,
            'stop': request.body.stop,
            'reasoning_effort': request.body.reasoning_effort,
            'logit_bias': request.body.logit_bias,
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };

        console.debug('Chutes request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn('Chutes returned error: ', errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('Chutes response:', generateResponseJson);
            return response.send(generateResponseJson);
        }
    }
    catch (error) {
        console.error('Error communicating with Chutes: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a chat completion request to Azure OpenAI.
 * @param {express.Request} request Express request object (contains request.body with all generate_data)
 * @param {express.Response} response Express response object
 */
async function sendAzureOpenAIRequest(request, response) {
    // 1. GATHER & VALIDATE SETTINGS
    const { azure_base_url, azure_deployment_name, azure_api_version } = request.body;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.AZURE_OPENAI);
    if (!azure_base_url || !azure_deployment_name || !azure_api_version || !apiKey) {
        return response.status(400).send({
            error: {
                message: 'Azure OpenAI configuration is incomplete. Please provide Base URL, Deployment Name, API Version, and API Key in the connection settings.',
            },
        });
    }

    // 2. PREPARE THE REQUEST
    const url = new URL(`/openai/deployments/${azure_deployment_name}/chat/completions`, azure_base_url);
    url.searchParams.set('api-version', azure_api_version);
    const endpointUrl = url.toString();

    // Create the base payload with all standard parameters
    const apiRequestBody = /** @type {any} */ ({});
    for (const key of AZURE_OPENAI_KEYS) {
        if (Object.hasOwn(request.body, key)) {
            apiRequestBody[key] = request.body[key];
        }
    }

    // Handle Structured Output (JSON Mode) by translating the custom `json_schema` object.
    if (request.body.json_schema) {
        apiRequestBody['response_format'] = {
            type: 'json_schema',
            json_schema: {
                name: request.body.json_schema.name,
                strict: request.body.json_schema.strict ?? true,
                schema: request.body.json_schema.value,
            },
        };
    }

    // Adjust logprobs for Azure OpenAI, which follows the OpenAI Chat Completions API spec.
    if (typeof apiRequestBody.logprobs === 'number' && apiRequestBody.logprobs > 0) {
        apiRequestBody.top_logprobs = apiRequestBody.logprobs;
        apiRequestBody.logprobs = true;
    }

    // Do not send reasoning effort to models which do not support it
    apiRequestBody['reasoning_effort'] = OPENAI_REASONING_EFFORT_MODELS.includes(request.body.model)
        ? OPENAI_REASONING_EFFORT_MAP[request.body.reasoning_effort] ?? request.body.reasoning_effort
        : undefined;

    const controller = new AbortController();
    response.once('close', () => controller.abort());

    const config = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'api-key': apiKey,
        },
        body: JSON.stringify(apiRequestBody),
        signal: controller.signal,
    };

    console.info(`Sending request to Azure OpenAI: ${endpointUrl}`);
    console.debug('Azure OpenAI Request Body:', apiRequestBody);
    try {
        const fetchResponse = await fetch(endpointUrl, config);

        if (request.body.stream) {
            return forwardFetchResponse(fetchResponse, response);
        }

        if (fetchResponse.ok) {
            /** @type {any} */
            const json = await fetchResponse.json();
            console.debug('Azure OpenAI response:', json);
            return response.send(json);
        }

        const text = await fetchResponse.text();
        const data = tryParse(text) || { error: { message: fetchResponse.statusText || 'Unknown error occurred' } };
        return response.status(500).send(data);
    } catch (error) {
        const message = error.name === 'AbortError'
            ? 'Request was aborted by the client.'
            : (error.message || 'An unknown network error occurred.');
        return response.status(500).send({ error: { message, ...error } });
    }
}

export const router = express.Router();

router.post('/status', async function (request, statusResponse) {
    try {
        if (!request.body) return statusResponse.sendStatus(400);

        let apiUrl = '';
        let apiKey = '';
        let headers = {};
        let queryParams = {};

        if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENAI) {
            apiUrl = new URL(request.body.reverse_proxy || API_OPENAI).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.OPENAI);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENROUTER) {
            apiUrl = 'https://openrouter.ai/api/v1';
            apiKey = readSecret(request.user.directories, SECRET_KEYS.OPENROUTER);
            // OpenRouter needs to pass the Referer and X-Title: https://openrouter.ai/docs#requests
            headers = { ...OPENROUTER_HEADERS };
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MISTRALAI) {
            apiUrl = new URL(request.body.reverse_proxy || API_MISTRAL).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MISTRALAI);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            apiUrl = request.body.custom_url;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.CUSTOM);
            headers = {};
            mergeObjectWithYaml(headers, request.body.custom_include_headers);
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.COHERE) {
            apiUrl = API_COHERE_V1;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.COHERE);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CHUTES) {
            apiUrl = API_CHUTES;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.CHUTES);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.ELECTRONHUB) {
            apiUrl = API_ELECTRONHUB;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.ELECTRONHUB);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.NANOGPT) {
            apiUrl = API_NANOGPT;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.NANOGPT);
            headers = {};
            queryParams = { detailed: true };
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.DEEPSEEK) {
            apiUrl = new URL(request.body.reverse_proxy || API_DEEPSEEK.replace('/beta', '')).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.DEEPSEEK);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.XAI) {
            apiUrl = new URL(request.body.reverse_proxy || API_XAI).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.XAI);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.AIMLAPI) {
            apiUrl = API_AIMLAPI;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.AIMLAPI);
            headers = { ...AIMLAPI_HEADERS };
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.POLLINATIONS) {
            apiUrl = 'https://text.pollinations.ai';
            apiKey = 'NONE';
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.GROQ) {
            apiUrl = API_GROQ;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.GROQ);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.COMETAPI) {
            apiUrl = API_COMETAPI;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.COMETAPI);
            headers = {};
            throw new Error('This provider is temporarily disabled.');
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MOONSHOT) {
            apiUrl = API_MOONSHOT;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.MOONSHOT);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.FIREWORKS) {
            apiUrl = API_FIREWORKS;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.FIREWORKS);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.FREE_GEMINI) {
            try {
                const apiVersion = getConfigValue('gemini.apiVersion', 'v1beta');
                const models = await getFreeGeminiStatusModels(request.body.free_gemini_channel_id, apiVersion);
                return statusResponse.send({ data: models });
            } catch (error) {
                const status = Number.isInteger(error?.status) ? error.status : 502;
                const code = error?.code || 'FREE_GEMINI_MODELS_FAILED';
                console.warn(`Free Gemini status failed (${code}).`);
                return statusResponse.status(status).send({
                    error: true,
                    code,
                    message: error?.message || '免费 Gemini 渠道连接失败。',
                });
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MAKERSUITE);
            apiUrl = new URL(request.body.reverse_proxy || API_MAKERSUITE);
            const apiVersion = getConfigValue('gemini.apiVersion', 'v1beta');
            const versionBaseUrl = getGeminiVersionBaseUrl(apiUrl, apiVersion);
            const modelsUrl = !apiKey && request.body.reverse_proxy
                ? `${versionBaseUrl}/models`
                : `${versionBaseUrl}/models?key=${apiKey}`;

            if (!apiKey && !request.body.reverse_proxy) {
                console.warn('Google AI Studio API key is missing.');
                return statusResponse.status(400).send({ error: true });
            }

            try {
                const response = await fetch(modelsUrl, {
                    signal: AbortSignal.timeout(15000),
                });

                if (response.ok) {
                    /** @type {any} */
                    const data = await response.json();
                    const models = data.models
                        ?.filter(model => model.supportedGenerationMethods == null
                            || model.supportedGenerationMethods.includes?.('generateContent') === true)
                        ?.map(model => ({ id: model.name.replace('models/', '') })) || [];
                    console.info('Available Google AI Studio model count:', models.length);
                    return statusResponse.send({ data: models });
                }
                console.warn('Google AI Studio models endpoint failed:', response.status, response.statusText);
                return statusResponse.send({ error: true, bypass: true, data: { data: [] } });
            } catch (error) {
                console.error('Error fetching Google AI Studio models:', error);
                return statusResponse.send({ error: true, bypass: true, data: { data: [] } });
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.AZURE_OPENAI) {
            const { azure_base_url, azure_deployment_name, azure_api_version } = request.body;
            const apiKey = readSecret(request.user.directories, SECRET_KEYS.AZURE_OPENAI);

            // 1) Validate configuration from the frontend
            if (!apiKey || !azure_base_url || !azure_deployment_name || !azure_api_version) {
                console.warn('Azure OpenAI status check failed: missing config from frontend.');
                return statusResponse.status(400).send({ error: true, message: 'Azure configuration is incomplete.' });
            }
            // 2) Build URLs using the URL API for consistency and robustness.
            const modelsUrl = new URL('/openai/models', azure_base_url);
            modelsUrl.searchParams.set('api-version', azure_api_version);

            const chatUrl = new URL(`/openai/deployments/${azure_deployment_name}/chat/completions`, azure_base_url);
            chatUrl.searchParams.set('api-version', azure_api_version);

            // Map common status codes to user-friendly error messages
            const azureStatusErrorMap = {
                400: 'API version may be invalid for this resource.',
                401: 'Invalid API key or insufficient permissions.',
                403: 'Invalid API key or insufficient permissions.',
                404: 'Endpoint URL appears incorrect (404).',
            };

            try {
                // ---- A) GET /models: fast sanity check for endpoint + api key + api version ----
                const apiConfigTest = await fetch(modelsUrl, {
                    method: 'GET',
                    headers: { 'api-key': apiKey, 'Accept': 'application/json' },
                });

                if (!apiConfigTest.ok) {
                    let errText = '';
                    try { errText = await apiConfigTest.text(); } catch { /* response body may be empty */ }

                    console.warn('Azure OpenAI GET /models failed:', apiConfigTest.status, apiConfigTest.statusText, errText || '');

                    const defaultMessage = `Azure Models endpoint error: ${apiConfigTest.statusText}`;
                    const message = azureStatusErrorMap[apiConfigTest.status] ?? defaultMessage;
                    return statusResponse.status(apiConfigTest.status).send({ error: true, message });
                }

                // ---- B) POST /chat/completions: verify deployment + read underlying model ID ----
                // Small, deterministic probe to minimize cost/latency
                const modelPayload = {
                    messages: [{ role: 'user', content: 'Say word Hi' }],
                    stream: false,
                    max_completion_tokens: 5,
                };

                const modelRequest = await fetch(chatUrl, {
                    method: 'POST',
                    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify(modelPayload),
                });

                let modelResponse;
                try {
                    modelResponse = await modelRequest.json();
                } catch {
                    modelResponse = { raw: 'Failed to parse JSON response from chat completions probe.' };
                }

                const modelId = /** @type {any} */ (modelResponse)?.model;
                if (!modelId) {
                    console.warn('Azure status check succeeded but could not find a model ID in the response.');
                    console.debug('Azure Response Body:', modelResponse);
                    // Keep a benign success to avoid UX disruption in the UI
                    return statusResponse.send({ data: [] });
                }

                console.info(color.green('Azure OpenAI connection successful. Detected model:'), modelId);
                // Consistent response format: always an array of { id }
                return statusResponse.send({ data: [{ id: modelId }] });
            } catch (error) {
                console.error('Azure OpenAI status check connection error:', error);
                return statusResponse.status(500).send({ error: true, message: 'Failed to connect to the Azure endpoint.' });
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.SILICONFLOW) {
            apiUrl = API_SILICONFLOW;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.SILICONFLOW);
            headers = {};
        } else {
            console.warn('This chat completion source is not supported yet.');
            return statusResponse.status(400).send({ error: true });
        }

        if (!apiKey && !request.body.reverse_proxy && request.body.chat_completion_source !== CHAT_COMPLETION_SOURCES.CUSTOM) {
            console.warn('Chat Completion API key is missing.');
            return statusResponse.status(400).send({ error: true });
        }

        const modelsUrl = new URL(urlJoin(apiUrl, '/models'));
        Object.keys(queryParams).forEach(key => {
            modelsUrl.searchParams.append(key, queryParams[key]);
        });
        const response = await fetch(modelsUrl, {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                ...headers,
            },
        });

        if (response.ok) {
            /** @type {any} */
            let data = await response.json();

            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.POLLINATIONS && Array.isArray(data)) {
                data = { data: data.map(model => ({ id: model.name, ...model })) };
            }

            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CHUTES && Array.isArray(data?.data)) {
                data.data = data.data
                    .filter(model => model?.id)
                    .map(model => {
                        if (model.pricing?.prompt !== undefined && model.pricing?.completion !== undefined) {
                            return {
                                ...model,
                                pricing: {
                                    ...model.pricing,
                                    input: model.pricing.prompt,
                                    output: model.pricing.completion,
                                },
                            };
                        }
                        return model;
                    });
            }

            statusResponse.send(data);

            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.COHERE && Array.isArray(data?.models)) {
                data.data = data.models.map(model => ({ id: model.name, ...model }));
            }

            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENROUTER && Array.isArray(data?.data)) {
                let models = [];

                data.data.forEach(model => {
                    const context_length = model.context_length;
                    const tokens_dollar = Number(1 / (1000 * model.pricing?.prompt));
                    const tokens_rounded = (Math.round(tokens_dollar * 1000) / 1000).toFixed(0);
                    models[model.id] = {
                        tokens_per_dollar: tokens_rounded + 'k',
                        context_length: context_length,
                    };
                });

                console.info('Available OpenRouter models:', models);
            } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MISTRALAI) {
                const models = data?.data;
                console.info(models);
            } else {
                const models = data?.data;

                if (Array.isArray(models)) {
                    const modelIds = models.filter(x => x && typeof x === 'object').map(x => x.id).sort();
                    console.info('Available models:', modelIds);
                } else {
                    console.warn('Chat Completion endpoint did not return a list of models.');
                }
            }
        }
        else {
            console.error('Chat Completion status check failed. Either Access Token is incorrect or API endpoint is down.');
            statusResponse.send({ error: true, data: { data: [] } });
        }
    } catch (e) {
        console.error(e);

        if (!statusResponse.headersSent) {
            statusResponse.send({ error: true });
        } else {
            statusResponse.end();
        }
    }
});

router.post('/bias', async function (request, response) {
    if (!request.body || !Array.isArray(request.body))
        return response.sendStatus(400);

    try {
        const result = {};
        const model = getTokenizerModel(String(request.query.model || ''));

        // no bias for claude
        if (model == 'claude') {
            return response.send(result);
        }

        let encodeFunction;

        if (sentencepieceTokenizers.includes(model)) {
            const tokenizer = getSentencepiceTokenizer(model);
            const instance = await tokenizer?.get();
            if (!instance) {
                console.error('Tokenizer not initialized:', model);
                return response.send({});
            }
            encodeFunction = (text) => new Uint32Array(instance.encodeIds(text));
        } else if (webTokenizers.includes(model)) {
            const tokenizer = getWebTokenizer(model);
            const instance = await tokenizer?.get();
            if (!instance) {
                console.warn('Tokenizer not initialized:', model);
                return response.send({});
            }
            encodeFunction = (text) => new Uint32Array(instance.encode(text));
        } else {
            const tokenizer = getTiktokenTokenizer(model);
            encodeFunction = (tokenizer.encode.bind(tokenizer));
        }

        for (const entry of request.body) {
            if (!entry || !entry.text) {
                continue;
            }

            try {
                const tokens = getEntryTokens(entry.text, encodeFunction);

                for (const token of tokens) {
                    result[token] = entry.value;
                }
            } catch {
                console.warn('Tokenizer failed to encode:', entry.text);
            }
        }

        // not needed for cached tokenizers
        //tokenizer.free();
        return response.send(result);

        /**
         * Gets tokenids for a given entry
         * @param {string} text Entry text
         * @param {(string) => Uint32Array} encode Function to encode text to token ids
         * @returns {Uint32Array} Array of token ids
         */
        function getEntryTokens(text, encode) {
            // Get raw token ids from JSON array
            if (text.trim().startsWith('[') && text.trim().endsWith(']')) {
                try {
                    const json = JSON.parse(text);
                    if (Array.isArray(json) && json.every(x => typeof x === 'number')) {
                        return new Uint32Array(json);
                    }
                } catch {
                    // ignore
                }
            }

            // Otherwise, get token ids from tokenizer
            return encode(text);
        }
    } catch (error) {
        console.error(error);
        return response.send({});
    }
});

router.post('/generate', async function (request, response) {
    try {
        if (!request.body) return response.status(400).send({ error: true });

        const postProcessingType = request.body.custom_prompt_post_processing;
        if (Array.isArray(request.body.messages) && postProcessingType) {
            console.info('Applying custom prompt post-processing of type', postProcessingType);
            request.body.messages = postProcessPrompt(
                request.body.messages,
                postProcessingType,
                getPromptNames(request));
        }

        if (request.body.json_schema?.value) {
            request.body.json_schema.value = flattenSchema(request.body.json_schema.value, request.body.chat_completion_source);
        }

        switch (request.body.chat_completion_source) {
            case CHAT_COMPLETION_SOURCES.CLAUDE: return await sendClaudeRequest(request, response);
            case CHAT_COMPLETION_SOURCES.AI21: return await sendAI21Request(request, response);
            case CHAT_COMPLETION_SOURCES.MAKERSUITE: return await sendMakerSuiteRequest(request, response);
            case CHAT_COMPLETION_SOURCES.FREE_GEMINI: {
                const modelId = normalizeFreeGeminiModelId(request.body.model);
                if (!modelId) {
                    return response.status(400).send({
                        error: { code: 'FREE_GEMINI_INVALID_MODEL', message: 'model 不能为空。' },
                    });
                }
                if (!hasObviouslyConvertibleFreeGeminiMessage(request.body.messages)) {
                    return response.status(400).send({
                        error: { code: 'FREE_GEMINI_INVALID_CONTENTS', message: 'contents 不能为空。' },
                    });
                }
                const apiVersion = getConfigValue('gemini.apiVersion', 'v1beta');
                const freeGeminiRequestStartedAt = Date.now();
                let routes;
                let freeGeminiDeadlineAt;
                try {
                    ({ routes, deadlineAt: freeGeminiDeadlineAt } = await resolveFreeGeminiRoutes(
                        modelId,
                        request.body.free_gemini_channel_id,
                        apiVersion,
                        freeGeminiRequestStartedAt,
                    ));
                } catch (error) {
                    const status = Number.isInteger(error?.status) ? error.status : 502;
                    return response.status(status).send({
                        error: {
                            code: error?.code || 'FREE_GEMINI_ROUTE_FAILED',
                            message: error?.code === 'FREE_GEMINI_CHANNEL_UNAVAILABLE'
                                ? error.message
                                : '免费 Gemini 渠道路由失败。',
                        },
                    });
                }
                if (routes.length === 0) {
                    return response.status(400).send({
                        error: { code: 'FREE_GEMINI_NO_ROUTE', message: '没有允许该模型的可用免费 Gemini 渠道。' },
                    });
                }
                request.body.model = modelId;

                // Model discovery and generation share one bounded request deadline. Give
                // each candidate a fair slice of the remaining time while reserving a useful
                // window for later candidates; retries and backoff consume the same slice.
                let lastFailure;
                for (let index = 0; index < routes.length; index++) {
                    const route = routes[index];
                    const remainingTotalMs = freeGeminiDeadlineAt - Date.now();
                    if (remainingTotalMs <= 0) {
                        break;
                    }
                    const remainingCandidates = routes.length - index;
                    const candidateBudgetMs = getFreeGeminiCandidateBudgetMs(
                        route.channel.timeoutMs,
                        remainingTotalMs,
                        remainingCandidates,
                    );
                    const candidateDeadlineAt = Math.min(
                        freeGeminiDeadlineAt,
                        Date.now() + candidateBudgetMs,
                    );
                    const result = await sendMakerSuiteRequest(request, response, {
                        freeGeminiChannel: route.channel,
                        freeGeminiModel: route.model,
                        deferFreeGeminiFailover: true,
                        freeGeminiDeadlineAt: candidateDeadlineAt,
                    });
                    if (!result?.freeGeminiFailover) {
                        return result;
                    }

                    lastFailure = result;
                    const hasNextRoute = index + 1 < routes.length;
                    if (!hasNextRoute || Date.now() >= freeGeminiDeadlineAt || response.destroyed || response.writableEnded) {
                        break;
                    }
                    console.warn(`Free Gemini channel failed transiently; trying candidate ${index + 2}/${routes.length}.`);
                }

                if (!response.headersSent && !response.destroyed && !response.writableEnded) {
                    if (lastFailure) {
                        return response.status(lastFailure.status).send(lastFailure.payload);
                    }
                    return response.status(504).send({
                        error: { code: 'FREE_GEMINI_TIMEOUT', message: '免费 Gemini 渠道请求超时。' },
                    });
                }
                return;
            }
            case CHAT_COMPLETION_SOURCES.VERTEXAI: return await sendMakerSuiteRequest(request, response);
            case CHAT_COMPLETION_SOURCES.MISTRALAI: return await sendMistralAIRequest(request, response);
            case CHAT_COMPLETION_SOURCES.COHERE: return await sendCohereRequest(request, response);
            case CHAT_COMPLETION_SOURCES.DEEPSEEK: return await sendDeepSeekRequest(request, response);
            case CHAT_COMPLETION_SOURCES.AIMLAPI: return await sendAimlapiRequest(request, response);
            case CHAT_COMPLETION_SOURCES.XAI: return await sendXaiRequest(request, response);
            case CHAT_COMPLETION_SOURCES.CHUTES: return await sendChutesRequest(request, response);
            case CHAT_COMPLETION_SOURCES.ELECTRONHUB: return await sendElectronHubRequest(request, response);
            case CHAT_COMPLETION_SOURCES.AZURE_OPENAI: return await sendAzureOpenAIRequest(request, response);
        }

        let apiUrl;
        let apiKey;
        let headers;
        let bodyParams;
        const isTextCompletion = Boolean(request.body.model && TEXT_COMPLETION_MODELS.includes(request.body.model)) || typeof request.body.messages === 'string';

        if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENAI) {
            apiUrl = new URL(request.body.reverse_proxy || API_OPENAI).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.OPENAI);
            headers = {};
            bodyParams = {
                logprobs: request.body.logprobs,
                top_logprobs: undefined,
            };

            // Adjust logprobs params for Chat Completions API, which expects { top_logprobs: number; logprobs: boolean; }
            if (!isTextCompletion && bodyParams.logprobs > 0) {
                bodyParams.top_logprobs = bodyParams.logprobs;
                bodyParams.logprobs = true;
            }

            if (getConfigValue('openai.randomizeUserId', false, 'boolean')) {
                bodyParams['user'] = uuidv4();
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENROUTER) {
            apiUrl = 'https://openrouter.ai/api/v1';
            apiKey = readSecret(request.user.directories, SECRET_KEYS.OPENROUTER);
            // OpenRouter needs to pass the Referer and X-Title: https://openrouter.ai/docs#requests
            headers = { ...OPENROUTER_HEADERS };
            bodyParams = {
                'transforms': getOpenRouterTransforms(request),
                'plugins': getOpenRouterPlugins(request),
                'include_reasoning': Boolean(request.body.include_reasoning),
            };

            if (request.body.min_p !== undefined) {
                bodyParams['min_p'] = request.body.min_p;
            }

            if (request.body.top_a !== undefined) {
                bodyParams['top_a'] = request.body.top_a;
            }

            if (request.body.repetition_penalty !== undefined) {
                bodyParams['repetition_penalty'] = request.body.repetition_penalty;
            }

            if (Array.isArray(request.body.provider) && request.body.provider.length > 0) {
                bodyParams['provider'] = {
                    allow_fallbacks: request.body.allow_fallbacks ?? true,
                    order: request.body.provider ?? [],
                };
            }

            if (request.body.use_fallback) {
                bodyParams['route'] = 'fallback';
            }

            if (request.body.reasoning_effort) {
                bodyParams['reasoning'] = { effort: request.body.reasoning_effort };
            }

            if (request.body.verbosity) {
                bodyParams['verbosity'] = request.body.verbosity;
            }

            if (request.body.json_schema) {
                bodyParams['response_format'] = {
                    type: 'json_schema',
                    json_schema: {
                        name: request.body.json_schema.name,
                        strict: request.body.json_schema.strict ?? true,
                        schema: request.body.json_schema.value,
                    },
                };
            }

            const isClaude = /^anthropic\/claude/.test(request.body.model);
            const isGemini = /google\/gemini/.test(request.body.model);
            const isCacheableGemini = isGemini && await isOpenRouterModelCacheable(request.body.model);
            const enableGeminiSystemPromptCache = getConfigValue('gemini.enableSystemPromptCache', false, 'boolean');

            if (Array.isArray(request.body.messages)) {
                embedOpenRouterMedia(request.body.messages);
                addOpenRouterSignatures(request.body.messages, request.body.model);

                if (isClaude) {
                    if (enableSystemPromptCache) {
                        cachingSystemPromptForOpenRouter(request.body.messages, cacheTTL);
                    }

                    if (cachingAtDepth !== -1) {
                        cachingAtDepthForOpenRouterClaude(request.body.messages, cachingAtDepth, cacheTTL);
                    }
                }

                if (isCacheableGemini && enableGeminiSystemPromptCache) {
                    cachingSystemPromptForOpenRouter(request.body.messages);
                }
            }

            if (isGemini) {
                bodyParams['safety_settings'] = GEMINI_SAFETY;
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            apiUrl = request.body.custom_url;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.CUSTOM);
            headers = {};
            bodyParams = {
                logprobs: request.body.logprobs,
                top_logprobs: undefined,
            };

            // Adjust logprobs params for Chat Completions API, which expects { top_logprobs: number; logprobs: boolean; }
            if (!isTextCompletion && bodyParams.logprobs > 0) {
                bodyParams.top_logprobs = bodyParams.logprobs;
                bodyParams.logprobs = true;
            }

            mergeObjectWithYaml(bodyParams, request.body.custom_include_body);
            mergeObjectWithYaml(headers, request.body.custom_include_headers);
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.PERPLEXITY) {
            apiUrl = API_PERPLEXITY;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.PERPLEXITY);
            headers = {};
            bodyParams = {
                reasoning_effort: request.body.reasoning_effort,
            };
            request.body.messages = postProcessPrompt(request.body.messages, PROMPT_PROCESSING_TYPE.STRICT, getPromptNames(request));
            if (request.body.json_schema) {
                bodyParams['response_format'] = {
                    type: 'json_schema',
                    json_schema: {
                        schema: request.body.json_schema.value,
                    },
                };
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.GROQ) {
            apiUrl = API_GROQ;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.GROQ);
            headers = {};
            bodyParams = {};
            if (request.body.json_schema) {
                bodyParams['response_format'] = {
                    type: 'json_schema',
                    json_schema: {
                        name: request.body.json_schema.name,
                        description: request.body.json_schema.description,
                        schema: request.body.json_schema.value,
                        strict: request.body.json_schema.strict ?? true,
                    },
                };
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.FIREWORKS) {
            apiUrl = API_FIREWORKS;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.FIREWORKS);
            headers = {};
            bodyParams = {};
            if (request.body.json_schema) {
                bodyParams['response_format'] = {
                    type: 'json_schema',
                    json_schema: {
                        name: request.body.json_schema.name,
                        description: request.body.json_schema.description,
                        schema: request.body.json_schema.value,
                        strict: request.body.json_schema.strict ?? true,
                    },
                };
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.NANOGPT) {
            apiUrl = API_NANOGPT;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.NANOGPT);
            headers = {};
            bodyParams = {};
            if (request.body.enable_web_search && !/:online$/.test(request.body.model)) {
                request.body.model = `${request.body.model}:online`;
            }
            if (request.body.min_p !== undefined) {
                bodyParams['min_p'] = request.body.min_p;
            }
            if (request.body.top_a !== undefined) {
                bodyParams['top_a'] = request.body.top_a;
            }
            if (request.body.repetition_penalty !== undefined) {
                bodyParams['repetition_penalty'] = request.body.repetition_penalty;
            }

            const isClaude = /^claude-/.test(request.body.model);
            if (enableSystemPromptCache && isClaude) {
                bodyParams['cache_control'] = {
                    'enabled': true,
                    'ttl': cacheTTL,
                };
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.POLLINATIONS) {
            apiUrl = API_POLLINATIONS;
            apiKey = 'NONE';
            headers = {
                'Authorization': '',
            };
            bodyParams = {
                reasoning_effort: request.body.reasoning_effort,
                private: true,
                referrer: 'sillytavern',
                seed: request.body.seed ?? Math.floor(Math.random() * 99999999),
            };
            if (request.body.json_schema) {
                setJsonObjectFormat(bodyParams, request.body.messages, request.body.json_schema);
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MOONSHOT) {
            apiUrl = API_MOONSHOT;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.MOONSHOT);
            headers = {};
            bodyParams = {};
            request.body.json_schema
                ? setJsonObjectFormat(bodyParams, request.body.messages, request.body.json_schema)
                : addAssistantPrefix(request.body.messages, [], 'partial');
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.COMETAPI) {
            apiUrl = API_COMETAPI;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.COMETAPI);
            headers = {};
            bodyParams = {
                reasoning_effort: request.body.reasoning_effort,
            };
            throw new Error('This provider is temporarily disabled.');
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.ZAI) {
            apiUrl = request.body.zai_endpoint === ZAI_ENDPOINT.CODING ? API_ZAI_CODING : API_ZAI_COMMON;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.ZAI);
            headers = {
                'Accept-Language': 'en-US,en',
            };
            bodyParams = {
                thinking: {
                    type: request.body.include_reasoning ? 'enabled' : 'disabled',
                },
            };
            if (request.body.json_schema) {
                setJsonObjectFormat(bodyParams, request.body.messages, request.body.json_schema);
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.SILICONFLOW) {
            apiUrl = API_SILICONFLOW;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.SILICONFLOW);
            headers = {};
            bodyParams = {};
            if (request.body.json_schema) {
                setJsonObjectFormat(bodyParams, request.body.messages, request.body.json_schema);
            }
        } else {
            console.warn('This chat completion source is not supported yet.');
            return response.status(400).send({ error: true });
        }

        // A few of OpenAIs reasoning models support reasoning effort
        if (request.body.reasoning_effort && [CHAT_COMPLETION_SOURCES.CUSTOM, CHAT_COMPLETION_SOURCES.OPENAI].includes(request.body.chat_completion_source)) {
            if (OPENAI_REASONING_EFFORT_MODELS.includes(request.body.model)) {
                bodyParams['reasoning_effort'] = OPENAI_REASONING_EFFORT_MAP[request.body.reasoning_effort] ?? request.body.reasoning_effort;
            }
        }

        if (request.body.verbosity && [CHAT_COMPLETION_SOURCES.CUSTOM, CHAT_COMPLETION_SOURCES.OPENAI].includes(request.body.chat_completion_source)) {
            if (OPENAI_VERBOSITY_MODELS.test(request.body.model)) {
                bodyParams['verbosity'] = request.body.verbosity;
            }
        }

        if (!apiKey && !request.body.reverse_proxy && request.body.chat_completion_source !== CHAT_COMPLETION_SOURCES.CUSTOM) {
            console.warn('OpenAI API key is missing.');
            return response.status(400).send({ error: true });
        }

        // Add custom stop sequences
        if (Array.isArray(request.body.stop) && request.body.stop.length > 0) {
            bodyParams['stop'] = request.body.stop;
        }

        const textPrompt = isTextCompletion ? convertTextCompletionPrompt(request.body.messages) : '';
        const endpointUrl = isTextCompletion && request.body.chat_completion_source !== CHAT_COMPLETION_SOURCES.OPENROUTER ?
            `${apiUrl}/completions` :
            `${apiUrl}/chat/completions`;

        const controller = new AbortController();
        response.once('close', function () {
            controller.abort();
        });

        if (!isTextCompletion && Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        if (request.body.json_schema && !bodyParams['response_format']) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    strict: request.body.json_schema.strict ?? true,
                    schema: request.body.json_schema.value,
                },
            };
        }

        const requestBody = {
            'messages': isTextCompletion === false ? request.body.messages : undefined,
            'prompt': isTextCompletion === true ? textPrompt : undefined,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'max_completion_tokens': request.body.max_completion_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'top_k': request.body.top_k,
            'stop': isTextCompletion === false ? request.body.stop : undefined,
            'logit_bias': request.body.logit_bias,
            'seed': request.body.seed,
            'n': request.body.n,
            ...bodyParams,
        };

        if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            excludeKeysByYaml(requestBody, request.body.custom_exclude_body);
        }

        /** @type {import('node-fetch').RequestInit} */
        const config = {
            method: 'post',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
                ...headers,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };

        console.debug('Chat Completion request:', requestBody);

        const fetchResponse = await fetch(endpointUrl, config);

        if (request.body.stream) {
            console.info('Streaming request in progress');
            return forwardFetchResponse(fetchResponse, response);
        }

        if (fetchResponse.ok) {
            /** @type {any} */
            const json = await fetchResponse.json();
            console.debug('Chat Completion response:', json);
            return response.send(json);
        } else {
            const responseText = await fetchResponse.text();
            const errorData = tryParse(responseText);

            const message = fetchResponse.statusText || 'Unknown error occurred';
            const quota_error = fetchResponse.status === 429 && errorData?.error?.type === 'insufficient_quota';
            console.error('Chat completion request error: ', message, responseText);

            if (!response.headersSent) {
                response.send({ error: { message }, quota_error: quota_error });
            } else if (!response.writableEnded) {
                response.write(responseText);
            } else {
                response.end();
            }
        }
    } catch (error) {
        console.error('Generation failed', error);
        const message = error.code === 'ECONNREFUSED'
            ? `Connection refused: ${error.message}`
            : error.message || 'Unknown error occurred';

        if (!response.headersSent) {
            response.status(502).send({ error: { message, ...error } });
        } else {
            response.end();
        }
    }
});

const multimodalModels = express.Router();

multimodalModels.post('/pollinations', async (_req, res) => {
    try {
        const response = await fetch('https://text.pollinations.ai/models');

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();

        if (!Array.isArray(data)) {
            return res.json([]);
        }

        const multimodalModels = data.filter(m => m?.vision).map(m => m.name);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/aimlapi', async (_req, res) => {
    try {
        const response = await fetch('https://api.aimlapi.com/v1/models');

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();

        if (!Array.isArray(data?.data)) {
            return res.json([]);
        }

        const multimodalModels = data.data.filter(m => m?.features?.includes('openai/chat-completion.vision')).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/nanogpt', async (_req, res) => {
    try {
        const response = await fetch('https://nano-gpt.com/api/v1/models?detailed=true');

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();

        if (!Array.isArray(data?.data)) {
            return res.json([]);
        }

        const multimodalModels = data.data.filter(m => m?.capabilities?.vision).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/electronhub', async (_req, res) => {
    try {
        const response = await fetch('https://api.electronhub.ai/v1/models');

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();
        const multimodalModels = data.data.filter(m => m.metadata?.vision).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/chutes', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.CHUTES);

        if (!key) {
            return res.json([]);
        }

        const response = await fetch('https://llm.chutes.ai/v1/models', {
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!response.ok) {
            return res.json([]);
        }

        const data = await response.json();

        const modelsData = /** @type {{object: string, data: Array<{id: string, input_modalities?: string[]}>}} */ (data);
        const multimodalModels = modelsData.data
            .filter(m => m.input_modalities?.includes('image'))
            .map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/mistral', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.MISTRALAI);

        if (!key) {
            return res.json([]);
        }

        const response = await fetch('https://api.mistral.ai/v1/models', {
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();
        const multimodalModels = data.data.filter(m => m.capabilities?.vision).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/xai', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.XAI);

        if (!key) {
            return res.json([]);
        }

        // xAI's /models endpoint doesn't return modality info, so we must use /language-models instead
        const response = await fetch('https://api.x.ai/v1/language-models', {
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();
        const multimodalModels = data.models.filter(m => m.input_modalities?.includes('image')).map(m => m.id);
        if (!multimodalModels.includes('grok-4-0709')) {
            // The endpoint says it doesn't support images, but it does
            multimodalModels.push('grok-4-0709');
        }
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

router.use('/multimodal-models', multimodalModels);

router.post('/process', async function (request, response) {
    try {
        if (!Array.isArray(request.body.messages)) {
            return response.status(400).send({ error: 'Invalid messages format' });
        }

        if (!Object.values(PROMPT_PROCESSING_TYPE).includes(request.body.type)) {
            return response.status(400).send({ error: 'Unknown processing type' });
        }

        const messages = postProcessPrompt(request.body.messages, request.body.type, getPromptNames(request));
        return response.send({ messages });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
