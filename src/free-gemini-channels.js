import fs from 'node:fs';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';

import { KeyedMutex } from './keyed-mutex.js';
import { trimTrailingSlash, uuidv4 } from './util.js';

const STORAGE_FILE = 'free-gemini-channels.json';
const STORAGE_VERSION = 1;
const MAX_NAME_LENGTH = 80;
const MAX_URL_LENGTH = 2048;
const MAX_KEY_LENGTH = 8192;
const storageMutex = new KeyedMutex();

function getStoragePath() {
    if (!globalThis.DATA_ROOT) {
        throw new Error('DATA_ROOT is not initialized.');
    }

    return path.join(globalThis.DATA_ROOT, '_storage', STORAGE_FILE);
}

function createValidationError(message) {
    const error = new Error(message);
    error.code = 'FREE_GEMINI_VALIDATION';
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

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw createValidationError('Gemini API URL 仅支持 http 或 https 协议');
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
        hasKey: Boolean(channel.key),
        maskedKey: maskKey(channel.key),
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
    };
}

export async function listPublicFreeGeminiChannels() {
    const store = await readStore();
    return store.channels
        .filter(channel => channel.enabled && channel.key)
        .map(toPublicChannel);
}

export async function listAdminFreeGeminiChannels() {
    const store = await readStore();
    return store.channels.map(toAdminChannel);
}

export async function getEnabledFreeGeminiChannel(id) {
    const channelId = String(id ?? '').trim();
    if (!channelId) {
        return null;
    }

    const store = await readStore();
    return store.channels.find(channel => channel.id === channelId && channel.enabled && channel.key) ?? null;
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
        if (channel.enabled && !channel.key) {
            throw createValidationError('启用渠道前必须配置 API Key');
        }

        channel.updatedAt = new Date().toISOString();
        await writeStore(store);
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

        store.channels.splice(index, 1);
        await writeStore(store);
        return true;
    });
}
