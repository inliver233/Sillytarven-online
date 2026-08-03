import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import fetch from 'node-fetch';
import ipaddr from 'ipaddr.js';
import writeFileAtomic from 'write-file-atomic';

import { KeyedMutex } from './keyed-mutex.js';
import { trimTrailingSlash, uuidv4 } from './util.js';

const STORAGE_DIRECTORY = '_global';
const LEGACY_STORAGE_DIRECTORY = '_storage';
const STORAGE_FILE = 'free-gemini-channels.json';
const STORAGE_VERSION = 2;
const MAX_NAME_LENGTH = 80;
const MAX_URL_LENGTH = 2048;
const MAX_KEY_LENGTH = 8192;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_MODELS = 1000;
const MAX_MODELS_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULTS = Object.freeze({
    priority: 0,
    modelPolicy: 'all',
    models: [],
    timeoutMs: 30000,
    maxRetries: 1,
    modelCacheTtlMs: 300000,
    maxOutputTokens: 0,
});
const MODEL_POLICIES = new Set(['all', 'allowlist', 'denylist']);
const storageMutex = new KeyedMutex();
const modelCache = new Map();

function isUnsafeUrlAllowedForTests() {
    return process.env.NODE_ENV === 'test';
}

function normalizeHostname(hostname) {
    return String(hostname ?? '').replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

function isPublicIpAddress(address) {
    if (!ipaddr.isValid(address)) {
        return false;
    }

    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
        parsed = parsed.toIPv4Address();
    }
    return parsed.range() === 'unicast';
}

function createUnsafeAddressError() {
    const error = new Error('免费 Gemini 渠道 URL 必须解析到公网地址');
    error.code = 'FREE_GEMINI_UNSAFE_ADDRESS';
    return error;
}

function safeFreeGeminiLookup(hostname, options, callback) {
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
        if (error) {
            callback(error);
            return;
        }
        if (!addresses.length || !addresses.every(item => isPublicIpAddress(item.address))) {
            callback(createUnsafeAddressError());
            return;
        }

        const requestedFamily = typeof options === 'number' ? options : Number(options?.family || 0);
        const matchingAddresses = addresses.filter(item => !requestedFamily || item.family === requestedFamily);
        if (!matchingAddresses.length) {
            const familyError = new Error('免费 Gemini 渠道域名没有可用的地址族');
            familyError.code = 'EAI_ADDRFAMILY';
            callback(familyError);
            return;
        }
        if (typeof options === 'object' && options?.all) {
            callback(null, matchingAddresses);
            return;
        }
        callback(null, matchingAddresses[0].address, matchingAddresses[0].family);
    });
}

const safeFreeGeminiHttpsAgent = new https.Agent({ lookup: safeFreeGeminiLookup });

export function getFreeGeminiFetchAgent(channel) {
    return isUnsafeUrlAllowedForTests() && String(channel?.url ?? '').startsWith('http:')
        ? undefined
        : safeFreeGeminiHttpsAgent;
}

function getStoragePath() {
    if (!globalThis.DATA_ROOT) {
        throw new Error('DATA_ROOT is not initialized.');
    }

    return path.join(globalThis.DATA_ROOT, STORAGE_DIRECTORY, STORAGE_FILE);
}

function getLegacyStoragePath() {
    if (!globalThis.DATA_ROOT) {
        throw new Error('DATA_ROOT is not initialized.');
    }

    return path.join(globalThis.DATA_ROOT, LEGACY_STORAGE_DIRECTORY, STORAGE_FILE);
}

/**
 * Moves files written by the initial implementation out of node-persist's private directory.
 * This must run before initUserStorage(), because node-persist tries to parse every file in _storage.
 */
export async function migrateLegacyFreeGeminiChannels() {
    const legacyPath = getLegacyStoragePath();
    const storagePath = getStoragePath();

    if (!fs.existsSync(legacyPath)) {
        return false;
    }

    await fs.promises.mkdir(path.dirname(storagePath), { recursive: true });
    if (!fs.existsSync(storagePath)) {
        await fs.promises.rename(legacyPath, storagePath);
    } else {
        await fs.promises.unlink(legacyPath);
    }

    console.info('Migrated free Gemini channel storage.');
    return true;
}

function createValidationError(message) {
    const error = new Error(message);
    error.code = 'FREE_GEMINI_VALIDATION';
    return error;
}

function createModelsError(message, status = 502, code = 'FREE_GEMINI_MODELS_FAILED') {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function normalizeName(value, fallback = 'free-gemini') {
    const name = String(value ?? fallback).trim().replace(/\s+/g, ' ');
    if (!name) {
        throw createValidationError('渠道名称不能为空');
    }
    if (name.length > MAX_NAME_LENGTH) {
        throw createValidationError(`渠道名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
    }
    return name;
}

function normalizeUrl(value) {
    const rawUrl = String(value ?? '').trim();
    if (!rawUrl) {
        throw createValidationError('Gemini API URL 不能为空');
    }
    if (rawUrl.length > MAX_URL_LENGTH) {
        throw createValidationError(`Gemini API URL 不能超过 ${MAX_URL_LENGTH} 个字符`);
    }

    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw createValidationError('Gemini API URL 格式无效');
    }

    if (parsed.protocol !== 'https:' && !(isUnsafeUrlAllowedForTests() && parsed.protocol === 'http:')) {
        throw createValidationError('Gemini API URL 必须使用 https 协议');
    }
    const hostname = normalizeHostname(parsed.hostname);
    if (!hostname || (!isUnsafeUrlAllowedForTests() && (hostname === 'localhost' || hostname.endsWith('.localhost')
        || (ipaddr.isValid(hostname) && !isPublicIpAddress(hostname))))) {
        throw createValidationError('Gemini API URL 必须使用公网主机');
    }
    if (parsed.username || parsed.password) {
        throw createValidationError('Gemini API URL 不能包含用户名或密码');
    }
    if (parsed.search || parsed.hash) {
        throw createValidationError('Gemini API URL 不能包含查询参数或锚点');
    }

    return trimTrailingSlash(parsed.toString());
}

function normalizeKey(value, { required = false } = {}) {
    const key = String(value ?? '').trim();
    if (required && !key) {
        throw createValidationError('新增渠道时必须填写 API Key');
    }
    if (key.length > MAX_KEY_LENGTH) {
        throw createValidationError(`API Key 不能超过 ${MAX_KEY_LENGTH} 个字符`);
    }
    return key;
}

function normalizeInteger(value, fallback, min, max, label, { allowZero = false, stored = false } = {}) {
    const number = typeof value === 'number' ? value : Number(value);
    const valid = Number.isInteger(number) && ((allowZero && number === 0) || (number >= min && number <= max));
    if (valid) {
        return number;
    }
    if (stored || value === undefined) {
        return fallback;
    }
    throw createValidationError(`${label} 必须是 ${allowZero ? '0 或 ' : ''}${min}..${max} 的整数`);
}

function normalizeModelPolicy(value, { stored = false } = {}) {
    const policy = value === undefined ? DEFAULTS.modelPolicy : String(value).trim().toLowerCase();
    if (MODEL_POLICIES.has(policy)) {
        return policy;
    }
    if (stored) {
        return DEFAULTS.modelPolicy;
    }
    throw createValidationError('modelPolicy 必须是 all、allowlist 或 denylist');
}

function normalizeModelId(value) {
    const id = String(value ?? '').trim().replace(/^models\//, '');
    if (!id || id.length > MAX_MODEL_ID_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
        return null;
    }
    return id;
}

function normalizeModels(value, { stored = false } = {}) {
    if (value === undefined) {
        return [...DEFAULTS.models];
    }
    if (!Array.isArray(value)) {
        if (stored) {
            return [...DEFAULTS.models];
        }
        throw createValidationError('models 必须是模型 ID 数组');
    }
    if (value.length > MAX_MODELS) {
        if (stored) {
            return [...DEFAULTS.models];
        }
        throw createValidationError(`models 不能超过 ${MAX_MODELS} 项`);
    }

    const models = [];
    for (const valueItem of value) {
        if (typeof valueItem !== 'string') {
            if (stored) {
                continue;
            }
            throw createValidationError(`models 中的模型 ID 必须是非空且不超过 ${MAX_MODEL_ID_LENGTH} 个字符的字符串`);
        }
        const model = normalizeModelId(valueItem);
        if (!model) {
            if (stored) {
                continue;
            }
            throw createValidationError(`models 中的模型 ID 必须是非空且不超过 ${MAX_MODEL_ID_LENGTH} 个字符的字符串`);
        }
        if (!models.includes(model)) {
            models.push(model);
        }
    }
    return models;
}

function normalizeSettings(channel, { stored = false } = {}) {
    return {
        priority: normalizeInteger(channel?.priority, DEFAULTS.priority, 0, 1000, 'priority', { stored }),
        modelPolicy: normalizeModelPolicy(channel?.modelPolicy, { stored }),
        models: normalizeModels(channel?.models, { stored }),
        timeoutMs: normalizeInteger(channel?.timeoutMs, DEFAULTS.timeoutMs, 5000, 120000, 'timeoutMs', { stored }),
        maxRetries: normalizeInteger(channel?.maxRetries, DEFAULTS.maxRetries, 0, 3, 'maxRetries', { stored }),
        modelCacheTtlMs: normalizeInteger(channel?.modelCacheTtlMs, DEFAULTS.modelCacheTtlMs, 30000, 3600000, 'modelCacheTtlMs', { stored }),
        maxOutputTokens: normalizeInteger(channel?.maxOutputTokens, DEFAULTS.maxOutputTokens, 1, 65536, 'maxOutputTokens', { allowZero: true, stored }),
    };
}

function normalizeStoredChannel(channel) {
    if (!channel || typeof channel !== 'object' || typeof channel.id !== 'string') {
        return null;
    }

    try {
        return {
            id: channel.id,
            name: normalizeName(channel.name),
            url: normalizeUrl(channel.url),
            key: normalizeKey(channel.key),
            enabled: Boolean(channel.enabled),
            ...normalizeSettings(channel, { stored: true }),
            createdAt: String(channel.createdAt || new Date().toISOString()),
            updatedAt: String(channel.updatedAt || channel.createdAt || new Date().toISOString()),
        };
    } catch (error) {
        console.warn(`Ignoring invalid free Gemini channel ${channel.id}:`, error.message);
        return null;
    }
}

async function readStore() {
    const storagePath = getStoragePath();
    try {
        const content = await fs.promises.readFile(storagePath, 'utf8');
        const parsed = JSON.parse(content);
        const channels = Array.isArray(parsed) ? parsed : parsed?.channels;
        return {
            version: STORAGE_VERSION,
            channels: Array.isArray(channels) ? channels.map(normalizeStoredChannel).filter(Boolean) : [],
        };
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return { version: STORAGE_VERSION, channels: [] };
        }
        if (error instanceof SyntaxError) {
            throw new Error(`免费 Gemini 渠道配置文件损坏: ${error.message}`);
        }
        throw error;
    }
}

async function writeStore(store) {
    const storagePath = getStoragePath();
    await fs.promises.mkdir(path.dirname(storagePath), { recursive: true });
    await writeFileAtomic(storagePath, `${JSON.stringify(store, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
    });
}

function toPublicChannel(channel) {
    return {
        id: channel.id,
        name: channel.name,
    };
}

function maskKey(key) {
    if (!key) {
        return '';
    }
    if (key.length <= 10) {
        return '*'.repeat(10);
    }
    return `${'*'.repeat(Math.min(12, key.length - 3))}${key.slice(-3)}`;
}

function toAdminChannel(channel) {
    return {
        id: channel.id,
        name: channel.name,
        url: channel.url,
        enabled: channel.enabled,
        priority: channel.priority,
        modelPolicy: channel.modelPolicy,
        models: [...channel.models],
        timeoutMs: channel.timeoutMs,
        maxRetries: channel.maxRetries,
        modelCacheTtlMs: channel.modelCacheTtlMs,
        maxOutputTokens: channel.maxOutputTokens,
        hasKey: Boolean(channel.key),
        maskedKey: maskKey(channel.key),
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
    };
}

function sortChannels(channels) {
    return channels.sort((left, right) => right.priority - left.priority
        || String(left.createdAt).localeCompare(String(right.createdAt))
        || left.id.localeCompare(right.id));
}

function clearChannelModelCache(channelId) {
    const marker = `:${channelId}:`;
    for (const key of modelCache.keys()) {
        if (key.includes(marker)) {
            modelCache.delete(key);
        }
    }
}

function normalizeModelRecord(model) {
    if (!model || typeof model !== 'object') {
        return null;
    }
    if (model.supportedGenerationMethods != null
        && model.supportedGenerationMethods.includes?.('generateContent') !== true) {
        return null;
    }

    const id = normalizeModelId(model.name);
    if (!id) {
        return null;
    }

    const inputTokenLimit = Number(model.inputTokenLimit);
    const outputTokenLimit = Number(model.outputTokenLimit);
    return {
        id,
        ...(Number.isInteger(inputTokenLimit) && inputTokenLimit > 0 ? { inputTokenLimit } : {}),
        ...(Number.isInteger(outputTokenLimit) && outputTokenLimit > 0 ? { outputTokenLimit } : {}),
    };
}

function getModelsUrl(channel, apiVersion) {
    const baseUrl = trimTrailingSlash(channel.url);
    const versionBaseUrl = /\/v1(?:beta)?$/i.test(baseUrl) ? baseUrl : `${baseUrl}/${apiVersion}`;
    const modelsUrl = new URL(`${versionBaseUrl}/models`);
    modelsUrl.searchParams.set('key', channel.key);
    return modelsUrl;
}

async function fetchChannelModels(channel, apiVersion) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), channel.timeoutMs);
    try {
        const response = await fetch(getModelsUrl(channel, apiVersion), {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: controller.signal,
            agent: getFreeGeminiFetchAgent(channel),
            redirect: 'error',
            size: MAX_MODELS_RESPONSE_BYTES,
        });
        const text = await response.text();
        if (!response.ok) {
            const status = [400, 422, 429, 502, 503, 504].includes(response.status) ? response.status : 502;
            throw createModelsError('免费 Gemini 渠道模型列表请求失败。', status);
        }
        let data;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            throw createModelsError('免费 Gemini 渠道返回了无效的模型列表。', 502, 'FREE_GEMINI_MODELS_INVALID_RESPONSE');
        }
        if (!Array.isArray(data?.models)) {
            throw createModelsError('免费 Gemini 渠道返回了无效的模型列表。', 502, 'FREE_GEMINI_MODELS_INVALID_RESPONSE');
        }

        const seen = new Set();
        return data.models
            .slice(0, MAX_MODELS)
            .map(normalizeModelRecord)
            .filter(model => model && !seen.has(model.id) && seen.add(model.id));
    } catch (error) {
        if (error?.code?.startsWith?.('FREE_GEMINI_')) {
            throw error;
        }
        const aborted = error?.name === 'AbortError';
        const unsafeAddress = error?.code === 'FREE_GEMINI_UNSAFE_ADDRESS';
        throw createModelsError(
            aborted
                ? '免费 Gemini 渠道模型列表请求超时。'
                : unsafeAddress
                    ? '免费 Gemini 渠道 URL 解析到非公网地址。'
                    : '无法连接免费 Gemini 渠道。',
            unsafeAddress ? 400 : (aborted ? 504 : 502),
            unsafeAddress
                ? 'FREE_GEMINI_UNSAFE_ADDRESS'
                : aborted
                    ? 'FREE_GEMINI_MODELS_TIMEOUT'
                    : 'FREE_GEMINI_MODELS_NETWORK',
        );
    } finally {
        clearTimeout(timeout);
    }
}

export function isFreeGeminiModelAllowed(channel, model) {
    const modelId = normalizeModelId(model);
    if (!modelId) {
        return false;
    }
    if (channel.modelPolicy === 'allowlist') {
        return channel.models.includes(modelId);
    }
    if (channel.modelPolicy === 'denylist') {
        return !channel.models.includes(modelId);
    }
    return true;
}

export async function listPublicFreeGeminiChannels() {
    const store = await readStore();
    return sortChannels(store.channels.filter(channel => channel.enabled && channel.key)).map(toPublicChannel);
}

export async function listAdminFreeGeminiChannels() {
    const store = await readStore();
    return sortChannels(store.channels).map(toAdminChannel);
}

export async function listEnabledFreeGeminiChannels() {
    const store = await readStore();
    return sortChannels(store.channels.filter(channel => channel.enabled && channel.key));
}

export async function getFreeGeminiChannel(id) {
    const channelId = String(id ?? '').trim();
    if (!channelId) {
        return null;
    }
    const store = await readStore();
    return store.channels.find(channel => channel.id === channelId) ?? null;
}

export async function getEnabledFreeGeminiChannel(id) {
    const channel = await getFreeGeminiChannel(id);
    return channel?.enabled && channel.key ? channel : null;
}

export async function getFreeGeminiChannelModels(channelOrId, { refresh = false, apiVersion = 'v1beta', allowDisabled = false } = {}) {
    const channel = typeof channelOrId === 'string' ? await getFreeGeminiChannel(channelOrId) : channelOrId;
    if (!channel || (!allowDisabled && (!channel.enabled || !channel.key)) || !channel.key) {
        throw createModelsError('免费 Gemini 渠道不存在、已停用或未配置密钥。', 404, 'FREE_GEMINI_CHANNEL_UNAVAILABLE');
    }

    const normalizedVersion = /^v1(?:beta)?$/i.test(String(apiVersion)) ? String(apiVersion).toLowerCase() : 'v1beta';
    const cacheKey = `${getStoragePath()}:${channel.id}:${normalizedVersion}`;
    const cached = modelCache.get(cacheKey);
    const useStaleOnError = promise => refresh || !cached?.models
        ? promise
        : promise.catch(error => {
            console.warn(`Using stale free Gemini model cache (${error?.code || 'refresh_failed'}).`);
            return cached.models.map(model => ({ ...model }));
        });

    if (cached?.promise) {
        return useStaleOnError(cached.promise);
    }
    if (!refresh && cached?.models && cached.expiresAt > Date.now()) {
        return cached.models.map(model => ({ ...model }));
    }

    const promise = fetchChannelModels(channel, normalizedVersion)
        .then(models => {
            modelCache.set(cacheKey, {
                models,
                expiresAt: Date.now() + channel.modelCacheTtlMs,
                promise: null,
            });
            return models.map(model => ({ ...model }));
        })
        .catch(error => {
            if (cached?.models) {
                modelCache.set(cacheKey, {
                    models: cached.models,
                    expiresAt: cached.expiresAt,
                    promise: null,
                });
            } else {
                modelCache.delete(cacheKey);
            }
            throw error;
        });

    modelCache.set(cacheKey, {
        models: cached?.models,
        expiresAt: cached?.expiresAt || 0,
        promise,
    });
    return useStaleOnError(promise);
}

export async function createFreeGeminiChannel(input) {
    return storageMutex.runExclusive('free-gemini-channels', async () => {
        const store = await readStore();
        const now = new Date().toISOString();
        const channel = {
            id: uuidv4(),
            name: normalizeName(input?.name),
            url: normalizeUrl(input?.url),
            key: normalizeKey(input?.key, { required: true }),
            enabled: input?.enabled === undefined ? true : Boolean(input.enabled),
            ...normalizeSettings(input),
            createdAt: now,
            updatedAt: now,
        };
        store.channels.push(channel);
        await writeStore(store);
        return toAdminChannel(channel);
    });
}

export async function updateFreeGeminiChannel(id, input) {
    return storageMutex.runExclusive('free-gemini-channels', async () => {
        const store = await readStore();
        const channel = store.channels.find(item => item.id === String(id ?? ''));
        if (!channel) {
            return null;
        }

        if (Object.hasOwn(input ?? {}, 'name')) {
            channel.name = normalizeName(input.name);
        }
        if (Object.hasOwn(input ?? {}, 'url')) {
            channel.url = normalizeUrl(input.url);
        }
        if (input?.clearKey === true) {
            channel.key = '';
        } else if (Object.hasOwn(input ?? {}, 'key') && String(input.key ?? '').trim()) {
            channel.key = normalizeKey(input.key);
        }
        if (Object.hasOwn(input ?? {}, 'enabled')) {
            channel.enabled = Boolean(input.enabled);
        }
        for (const property of ['priority', 'modelPolicy', 'models', 'timeoutMs', 'maxRetries', 'modelCacheTtlMs', 'maxOutputTokens']) {
            if (Object.hasOwn(input ?? {}, property)) {
                Object.assign(channel, normalizeSettings({ ...channel, [property]: input[property] }));
            }
        }
        if (channel.enabled && !channel.key) {
            throw createValidationError('启用渠道前必须配置 API Key');
        }

        channel.updatedAt = new Date().toISOString();
        await writeStore(store);
        clearChannelModelCache(channel.id);
        return toAdminChannel(channel);
    });
}

export async function deleteFreeGeminiChannel(id) {
    return storageMutex.runExclusive('free-gemini-channels', async () => {
        const store = await readStore();
        const index = store.channels.findIndex(channel => channel.id === String(id ?? ''));
        if (index === -1) {
            return false;
        }

        const [deleted] = store.channels.splice(index, 1);
        await writeStore(store);
        clearChannelModelCache(deleted.id);
        return true;
    });
}
