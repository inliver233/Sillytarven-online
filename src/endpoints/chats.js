import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import _ from 'lodash';

import validateAvatarUrlMiddleware from '../middleware/validateFileName.js';
import systemMonitor from '../system-monitor.js';

import {
    getConfigValue,
    humanizedISO8601DateTime,
    humanizedDateTime,
    tryParse,
    generateTimestamp,
    removeOldBackups,
    formatBytes,
    isPathUnderParent,
} from '../util.js';
import { canConsumeStorage } from '../storage-quota.js';
import { beginEndpointPerformance } from '../performance-monitor.js';
import { invalidateCharacterListCache } from '../character-list-cache.js';
import { RecentChatsCache, registerRecentChatsCache } from '../recent-chats-cache.js';

const isBackupEnabled = !!getConfigValue('backups.chat.enabled', true, 'boolean');
const maxTotalChatBackups = Number(getConfigValue('backups.chat.maxTotalBackups', -1, 'number'));
const throttleInterval = Number(getConfigValue('backups.chat.throttleInterval', 10_000, 'number'));
const checkIntegrity = !!getConfigValue('backups.chat.checkIntegrity', true, 'boolean');
const chatInfoCacheLimit = Number(getConfigValue('performance.chatInfoCacheLimit', 2000, 'number'));
const chatChunkingEnabled = !!getConfigValue('performance.chatChunkingEnabled', true, 'boolean');
const chatChunkSizeConfigured = Number(getConfigValue('performance.chatChunkSize', 300, 'number'));
const chatTailCompareLimit = Number(getConfigValue('performance.chatTailCompareLimit', 200, 'number'));
const recentChatsCache = new RecentChatsCache({
    enabled: getConfigValue('performance.recentChatsCache.enabled', true, 'boolean'),
    ttlMs: getConfigValue('performance.recentChatsCache.ttlMs', 15_000, 'number'),
    signatureTtlMs: getConfigValue('performance.recentChatsCache.signatureTtlMs', 2_000, 'number'),
    maxEntries: getConfigValue('performance.recentChatsCache.maxEntries', 300, 'number'),
    maxBytes: getConfigValue('performance.recentChatsCache.maxBytes', 50 * 1024 * 1024, 'number'),
});
registerRecentChatsCache(recentChatsCache);

export const CHAT_BACKUPS_PREFIX = 'chat_';
const chatInfoCache = new Map();
const lastLineChunkSize = 64 * 1024;
const tailChunkSize = 64 * 1024;
const CHAT_METADATA_SUFFIX = '.metadata.json';
const CHAT_CHUNK_DIR_SUFFIX = '.chunks';
const CHAT_INDEX_SUFFIX = '.index.json';

async function ensureChatStorageCapacity(request, response, additionalBytes) {
    const result = await canConsumeStorage(request.user.profile, request.user.directories, additionalBytes);
    if (!result.allowed) {
        return response.status(403).json({
            error: 'storage_limit',
            message: '存储空间不足，无法保存聊天记录，请删除聊天或使用激活码扩容。',
            usedBytes: result.usedBytes,
            limitBytes: result.limitBytes,
            remainingBytes: result.remainingBytes,
        });
    }

    return null;
}

/**
 * @typedef {Object} ChatIndexShard
 * @property {string} file
 * @property {number} count
 * @property {number} size
 * @property {number|null} last_mes
 * @property {string} last_message
 */

/**
 * @typedef {Object} ChatIndex
 * @property {number} version
 * @property {number} chunk_size
 * @property {number} message_count
 * @property {number|null} last_mes
 * @property {string} last_message
 * @property {number} total_bytes
 * @property {ChatIndexShard[]} shards
 */

/**
 * Saves a chat to the backups directory.
 * @param {string} directory The user's backups directory.
 * @param {string} name The name of the chat.
 * @param {string} chat The serialized chat to save.
 */
function backupChat(directory, name, chat) {
    try {
        if (!isBackupEnabled || !fs.existsSync(directory)) {
            return;
        }

        // replace non-alphanumeric characters with underscores
        name = sanitize(name).replace(/[^a-z0-9]/gi, '_').toLowerCase();

        const backupFile = path.join(directory, `${CHAT_BACKUPS_PREFIX}${name}_${generateTimestamp()}.jsonl`);
        writeFileAtomicSync(backupFile, chat, 'utf-8');

        removeOldBackups(directory, `${CHAT_BACKUPS_PREFIX}${name}_`);

        if (isNaN(maxTotalChatBackups) || maxTotalChatBackups < 0) {
            return;
        }

        removeOldBackups(directory, CHAT_BACKUPS_PREFIX, maxTotalChatBackups);
    } catch (err) {
        console.error(`Could not backup chat for ${name}`, err);
    }
}

/**
 * @type {Map<string, import('lodash').DebouncedFunc<function(string, string, string): void>>}
 */
const backupFunctions = new Map();

/**
 * Gets a backup function for a user.
 * @param {string} handle User handle
 * @returns {function(string, string, string): void} Backup function
 */
function getBackupFunction(handle) {
    if (!backupFunctions.has(handle)) {
        backupFunctions.set(handle, _.throttle(backupChat, throttleInterval, { leading: true, trailing: true }));
    }
    return backupFunctions.get(handle) || (() => { });
}

/**
 * Gets a preview message from a string.
 * @param {string} message Message text to preview
 * @returns {string} A truncated preview of the last message or empty string if no messages
 */
function getPreviewText(message) {
    const strlen = 400;
    if (!message) return '';
    return message.length > strlen
        ? '...' + message.substring(message.length - strlen)
        : message;
}

function getPreviewMessage(messages) {
    const lastMessage = messages[messages.length - 1]?.mes;
    return getPreviewText(lastMessage || '');
}

function getChatChunkSize() {
    const fallback = 300;
    const size = Number.isFinite(chatChunkSizeConfigured) ? chatChunkSizeConfigured : fallback;
    return Math.max(200, Math.min(size, 500));
}

/**
 * @param {string | number | null | undefined} value
 * @param {number | null | undefined} fallback
 * @returns {number | null}
 */
function parseSendDate(value, fallback = null) {
    if (value === null || value === undefined) return fallback;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    if (typeof value === 'string') {
        const normalized = value.trim();
        const parsed = Date.parse(normalized);
        if (!Number.isNaN(parsed)) return parsed;
        const humanizedMatch = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s*@(\d{1,2})h\s+(\d{1,2})m\s+(\d{1,2})s\s+(\d{1,3})ms$/);
        if (humanizedMatch) {
            const year = Number(humanizedMatch[1]);
            const month = Number(humanizedMatch[2]);
            const day = Number(humanizedMatch[3]);
            const hour = Number(humanizedMatch[4]);
            const minute = Number(humanizedMatch[5]);
            const second = Number(humanizedMatch[6]);
            const millisecond = Number(humanizedMatch[7]);
            const humanizedDate = new Date(year, month - 1, day, hour, minute, second, millisecond);
            const humanizedTime = humanizedDate.getTime();
            if (!Number.isNaN(humanizedTime)) return humanizedTime;
        }
    }
    return fallback;
}

function pruneChatInfoCache() {
    if (!Number.isFinite(chatInfoCacheLimit) || chatInfoCacheLimit <= 0) return;
    if (chatInfoCache.size <= chatInfoCacheLimit) return;
    let extra = chatInfoCache.size - chatInfoCacheLimit;
    for (const key of chatInfoCache.keys()) {
        chatInfoCache.delete(key);
        if (chatInfoCache.size <= chatInfoCacheLimit) break;
        if (--extra <= 0) break;
    }
}

function getCachedChatInfo(filePath, stats, withMetadata) {
    const cached = chatInfoCache.get(filePath);
    if (!cached) return null;
    if (cached.size !== stats.size || cached.mtimeMs !== stats.mtimeMs) return null;
    if (withMetadata && !cached.hasMetadata) return null;
    return cached.data;
}

function setCachedChatInfo(filePath, stats, data, hasMetadata) {
    chatInfoCache.set(filePath, {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        hasMetadata: Boolean(hasMetadata),
        data,
    });
    pruneChatInfoCache();
}

process.on('exit', () => {
    for (const func of backupFunctions.values()) {
        func.flush();
    }
});

/**
 * Imports a chat from Ooba's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
 * @returns {string} Chat data
 */
function importOobaChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        user_name: userName,
        character_name: characterName,
        create_date: humanizedISO8601DateTime(),
    }];

    for (const arr of jsonData.data_visible) {
        if (arr[0]) {
            const userMessage = {
                name: userName,
                is_user: true,
                send_date: humanizedISO8601DateTime(),
                mes: arr[0],
            };
            chat.push(userMessage);
        }
        if (arr[1]) {
            const charMessage = {
                name: characterName,
                is_user: false,
                send_date: humanizedISO8601DateTime(),
                mes: arr[1],
            };
            chat.push(charMessage);
        }
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Imports a chat from Agnai's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData Chat data
 * @returns {string} Chat data
 */
function importAgnaiChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        user_name: userName,
        character_name: characterName,
        create_date: humanizedISO8601DateTime(),
    }];

    for (const message of jsonData.messages) {
        const isUser = !!message.userId;
        chat.push({
            name: isUser ? userName : characterName,
            is_user: isUser,
            send_date: humanizedISO8601DateTime(),
            mes: message.msg,
        });
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Imports a chat from CAI Tools format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
 * @returns {string[]} Converted data
 */
function importCAIChat(userName, characterName, jsonData) {
    /**
     * Converts the chat data to suitable format.
     * @param {object} history Imported chat data
     * @returns {object[]} Converted chat data
     */
    function convert(history) {
        const starter = {
            user_name: userName,
            character_name: characterName,
            create_date: humanizedISO8601DateTime(),
        };

        const historyData = history.msgs.map((msg) => ({
            name: msg.src.is_human ? userName : characterName,
            is_user: msg.src.is_human,
            send_date: humanizedISO8601DateTime(),
            mes: msg.text,
        }));

        return [starter, ...historyData];
    }

    const newChats = (jsonData.histories.histories ?? []).map(history => newChats.push(convert(history).map(obj => JSON.stringify(obj)).join('\n')));
    return newChats;
}

/**
 * Imports a chat from Kobold Lite format.
 * @param {string} _userName User name
 * @param {string} _characterName Character name
 * @param {object} data JSON data
 * @returns {string} Chat data
 */
function importKoboldLiteChat(_userName, _characterName, data) {
    const inputToken = '{{[INPUT]}}';
    const outputToken = '{{[OUTPUT]}}';

    /** @type {function(string): object} */
    function processKoboldMessage(msg) {
        const isUser = msg.includes(inputToken);
        return {
            name: isUser ? header.user_name : header.character_name,
            is_user: isUser,
            mes: msg.replaceAll(inputToken, '').replaceAll(outputToken, '').trim(),
            send_date: Date.now(),
        };
    }

    // Create the header
    const header = {
        user_name: String(data.savedsettings.chatname),
        character_name: String(data.savedsettings.chatopponent).split('||$||')[0],
    };
    // Format messages
    const formattedMessages = data.actions.map(processKoboldMessage);
    // Add prompt if available
    if (data.prompt) {
        formattedMessages.unshift(processKoboldMessage(data.prompt));
    }
    // Combine header and messages
    const chatData = [header, ...formattedMessages];
    return chatData.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Flattens `msg` and `swipes` data from Chub Chat format.
 * Only changes enough to make it compatible with the standard chat serialization format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {string[]} lines serialised JSONL data
 * @returns {string} Converted data
 */
function flattenChubChat(userName, characterName, lines) {
    function flattenSwipe(swipe) {
        return swipe.message ? swipe.message : swipe;
    }

    function convert(line) {
        const lineData = tryParse(line);
        if (!lineData) return line;

        if (lineData.mes && lineData.mes.message) {
            lineData.mes = lineData?.mes.message;
        }

        if (lineData?.swipes && Array.isArray(lineData.swipes)) {
            lineData.swipes = lineData.swipes.map(swipe => flattenSwipe(swipe));
        }

        return JSON.stringify(lineData);
    }

    return (lines ?? []).map(convert).join('\n');
}

/**
 * Imports a chat from RisuAI format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData Imported chat data
 * @returns {string} Chat data
 */
function importRisuChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        user_name: userName,
        character_name: characterName,
        create_date: humanizedISO8601DateTime(),
    }];

    for (const message of jsonData.data.message) {
        const isUser = message.role === 'user';
        chat.push({
            name: message.name ?? (isUser ? userName : characterName),
            is_user: isUser,
            send_date: Number(message.time ?? Date.now()),
            mes: message.data ?? '',
        });
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Reads the first line of a file asynchronously.
 * @param {string} filePath Path to the file
 * @returns {Promise<string>} The first line of the file
 */
function readFirstLine(filePath) {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    return new Promise((resolve, reject) => {
        let resolved = false;
        rl.on('line', line => {
            resolved = true;
            rl.close();
            stream.close();
            resolve(line);
        });

        rl.on('error', error => {
            resolved = true;
            reject(error);
        });

        // Handle empty files
        stream.on('end', () => {
            if (!resolved) {
                resolved = true;
                resolve('');
            }
        });
    });
}

function getChatMetadataPath(filePath) {
    return `${filePath}${CHAT_METADATA_SUFFIX}`;
}

function getChatChunkDir(filePath) {
    return `${filePath}${CHAT_CHUNK_DIR_SUFFIX}`;
}

function getChatIndexPath(filePath) {
    return `${filePath}${CHAT_INDEX_SUFFIX}`;
}

function isChunkedChat(filePath) {
    return fs.existsSync(getChatIndexPath(filePath)) || fs.existsSync(getChatChunkDir(filePath));
}

function formatShardName(index) {
    return `${String(index).padStart(6, '0')}.jsonl`;
}

function readChatIndex(filePath) {
    try {
        const indexPath = getChatIndexPath(filePath);
        if (!fs.existsSync(indexPath)) return null;
        const raw = fs.readFileSync(indexPath, 'utf8');
        const parsed = tryParse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        console.warn('Failed to read chat index:', error);
        return null;
    }
}

function writeChatIndex(filePath, index) {
    try {
        if (!index || typeof index !== 'object') return;
        writeFileAtomicSync(getChatIndexPath(filePath), JSON.stringify(index), 'utf8');
    } catch (error) {
        console.warn('Failed to write chat index:', error);
    }
}

function getChatTotalBytes(filePath) {
    if (isChunkedChat(filePath)) {
        const index = readChatIndex(filePath);
        const totalBytes = Number(index?.total_bytes);
        if (Number.isFinite(totalBytes)) {
            return totalBytes;
        }
    }
    return fs.statSync(filePath).size;
}

function ensureChatChunkDir(filePath) {
    const dir = getChatChunkDir(filePath);
    if (!fs.existsSync(dir)) {
        // Ensure parent directory exists first
        const parentDir = path.dirname(filePath);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function listShardFiles(filePath) {
    const dir = getChatChunkDir(filePath);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(name => name.endsWith('.jsonl'))
        .sort();
}

async function readShardLines(shardPath) {
    const data = await fs.promises.readFile(shardPath, 'utf8');
    return data
        .split('\n')
        .map(line => line.replace(/\r$/, ''))
        .filter(line => line.length > 0);
}

async function rebuildChatIndex(filePath) {
    const shards = listShardFiles(filePath);
    /** @type {ChatIndex} */
    const index = {
        version: 1,
        chunk_size: getChatChunkSize(),
        message_count: 0,
        last_mes: null,
        last_message: '',
        total_bytes: 0,
        shards: [],
    };

    for (const shardName of shards) {
        const shardPath = path.join(getChatChunkDir(filePath), shardName);
        const stats = await fs.promises.stat(shardPath);
        const count = await countJsonlLines(shardPath);
        index.total_bytes += stats.size;
        index.message_count += count;

        let lastMesDate = index.last_mes;
        let lastMessage = index.last_message;
        if (count > 0) {
            const lastLine = await readLastLine(shardPath);
            const jsonData = tryParse(lastLine);
            if (jsonData) {
                lastMesDate = parseSendDate(jsonData.send_date, lastMesDate);
                lastMessage = typeof jsonData.mes === 'string' ? jsonData.mes : lastMessage;
            }
        }

        index.shards.push({
            file: shardName,
            count,
            size: stats.size,
            last_mes: lastMesDate,
            last_message: lastMessage,
        });
        index.last_mes = lastMesDate;
        index.last_message = lastMessage;
    }

    writeChatIndex(filePath, index);
    return index;
}

async function ensureChatIndex(filePath) {
    const existing = readChatIndex(filePath);
    if (existing) return existing;
    if (!isChunkedChat(filePath)) return null;
    return await rebuildChatIndex(filePath);
}

async function readChunkedChatLinesRange(filePath, startIndex, count) {
    const index = await ensureChatIndex(filePath);
    if (!index || !Array.isArray(index.shards)) return [];
    const totalMessages = Number(index.message_count) || 0;
    if (startIndex >= totalMessages || count <= 0) return [];
    const endIndex = Math.min(startIndex + count, totalMessages);
    const lines = [];

    let offset = 0;
    for (const shard of index.shards) {
        const shardCount = Number(shard?.count) || 0;
        if (shardCount <= 0) {
            continue;
        }
        const shardStart = offset;
        const shardEnd = offset + shardCount;
        offset = shardEnd;

        if (endIndex <= shardStart) {
            break;
        }
        if (startIndex >= shardEnd) {
            continue;
        }

        const localStart = Math.max(startIndex, shardStart) - shardStart;
        const localEnd = Math.min(endIndex, shardEnd) - shardStart;
        const shardPath = path.join(getChatChunkDir(filePath), shard.file);
        const shardLines = await readShardLines(shardPath);
        lines.push(...shardLines.slice(localStart, localEnd));
        if (lines.length >= count) {
            break;
        }
    }

    return lines;
}

async function readChunkedChatMessages(filePath) {
    const index = await ensureChatIndex(filePath);
    if (!index || !Array.isArray(index.shards)) return [];
    const messages = [];
    for (const shard of index.shards) {
        const shardPath = path.join(getChatChunkDir(filePath), shard.file);
        const shardLines = await readShardLines(shardPath);
        for (const line of shardLines) {
            const jsonData = tryParse(line);
            if (jsonData) {
                messages.push(jsonData);
            }
        }
    }
    return messages;
}

function updateChatHeaderMetadata(header, messageCount, lastMessage) {
    if (!header || typeof header !== 'object') return;
    const headerData = /** @type {any} */ (header);
    if (!headerData.chat_metadata || typeof headerData.chat_metadata !== 'object') {
        headerData.chat_metadata = {};
    }
    headerData.chat_metadata.message_count = Math.max(messageCount, 0);
    headerData.chat_metadata.last_mes = parseSendDate(lastMessage?.send_date, Date.now());
    headerData.chat_metadata.last_message = typeof lastMessage?.mes === 'string' ? lastMessage.mes : '';
}

function clearChunkDir(filePath) {
    const dir = getChatChunkDir(filePath);
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
        fs.unlinkSync(path.join(dir, entry));
    }
}

async function writeChunkedChat(filePath, header, messages) {
    const chunkSize = getChatChunkSize();
    ensureChatChunkDir(filePath);
    clearChunkDir(filePath);

    /** @type {ChatIndex} */
    const index = {
        version: 1,
        chunk_size: chunkSize,
        message_count: 0,
        last_mes: null,
        last_message: '',
        total_bytes: 0,
        shards: [],
    };

    let shardIndex = 0;
    for (let i = 0; i < messages.length; i += chunkSize) {
        const chunk = messages.slice(i, i + chunkSize);
        const shardName = formatShardName(shardIndex++);
        const shardPath = path.join(getChatChunkDir(filePath), shardName);
        const payload = chunk.map((item) => JSON.stringify(item)).join('\n');
        writeFileAtomicSync(shardPath, payload, 'utf8');
        const stats = await fs.promises.stat(shardPath);
        const lastMessage = chunk[chunk.length - 1];
        const lastMes = parseSendDate(lastMessage?.send_date, index.last_mes);

        index.message_count += chunk.length;
        index.total_bytes += stats.size;
        index.last_mes = lastMes;
        index.last_message = typeof lastMessage?.mes === 'string' ? lastMessage.mes : index.last_message;
        index.shards.push({
            file: shardName,
            count: chunk.length,
            size: stats.size,
            last_mes: lastMes,
            last_message: index.last_message,
        });
    }

    updateChatHeaderMetadata(header, index.message_count, messages[messages.length - 1]);
    writeFileAtomicSync(filePath, header ? JSON.stringify(header) : '', 'utf8');
    if (header) {
        writeChatHeader(filePath, header);
    }
    writeChatIndex(filePath, index);
    return index;
}

async function convertLegacyChatToChunks(filePath) {
    if (!fs.existsSync(filePath)) return { header: null, index: null };
    const chunkSize = getChatChunkSize();
    ensureChatChunkDir(filePath);
    clearChunkDir(filePath);

    /** @type {ChatIndex} */
    const index = {
        version: 1,
        chunk_size: chunkSize,
        message_count: 0,
        last_mes: null,
        last_message: '',
        total_bytes: 0,
        shards: [],
    };

    let header = null;
    let buffer = [];
    let shardIndex = 0;
    let sawHeader = false;
    let lastMessageObj = null;

    const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });

    const flushBuffer = async () => {
        if (buffer.length === 0) return;
        const shardName = formatShardName(shardIndex++);
        const shardPath = path.join(getChatChunkDir(filePath), shardName);
        writeFileAtomicSync(shardPath, buffer.join('\n'), 'utf8');
        const stats = await fs.promises.stat(shardPath);
        const lastLine = buffer[buffer.length - 1] || '';
        const lastMessage = tryParse(lastLine);
        if (lastMessage) {
            lastMessageObj = lastMessage;
        }
        const lastMes = parseSendDate(lastMessage?.send_date, index.last_mes);
        const lastMessageText = typeof lastMessage?.mes === 'string' ? lastMessage.mes : index.last_message;

        index.message_count += buffer.length;
        index.total_bytes += stats.size;
        index.last_mes = lastMes;
        index.last_message = lastMessageText;
        index.shards.push({
            file: shardName,
            count: buffer.length,
            size: stats.size,
            last_mes: lastMes,
            last_message: lastMessageText,
        });
        buffer = [];
    };

    for await (const line of rl) {
        if (!sawHeader) {
            sawHeader = true;
            header = tryParse(line) || null;
            continue;
        }
        if (!line) continue;
        buffer.push(line);
        if (buffer.length >= chunkSize) {
            await flushBuffer();
        }
    }
    await flushBuffer();

    updateChatHeaderMetadata(header, index.message_count, lastMessageObj);
    writeFileAtomicSync(filePath, header ? JSON.stringify(header) : '', 'utf8');
    if (header) {
        writeChatHeader(filePath, header);
    }
    writeChatIndex(filePath, index);
    return { header, index };
}

async function truncateChunkedChat(filePath, index, beforeIndex) {
    if (!index || !Array.isArray(index.shards)) {
        return await rebuildChatIndex(filePath);
    }

    const chunkDir = getChatChunkDir(filePath);
    let offset = 0;
    /** @type {ChatIndexShard[]} */
    const keptShards = [];

    for (const shard of index.shards) {
        const shardCount = Number(shard?.count) || 0;
        const shardStart = offset;
        const shardEnd = offset + shardCount;
        offset = shardEnd;

        if (beforeIndex >= shardEnd) {
            keptShards.push(shard);
            continue;
        }

        if (beforeIndex <= shardStart) {
            const shardsToDelete = index.shards.slice(index.shards.indexOf(shard));
            for (const target of shardsToDelete) {
                const shardPath = path.join(chunkDir, target.file);
                if (fs.existsSync(shardPath)) {
                    fs.unlinkSync(shardPath);
                }
            }
            break;
        }

        const localCount = beforeIndex - shardStart;
        const shardPath = path.join(chunkDir, shard.file);
        const shardLines = await readShardLines(shardPath);
        const keptLines = shardLines.slice(0, localCount);
        if (keptLines.length) {
            writeFileAtomicSync(shardPath, keptLines.join('\n'), 'utf8');
            const stats = await fs.promises.stat(shardPath);
            const lastLine = keptLines[keptLines.length - 1] || '';
            const lastMessage = tryParse(lastLine);
            const lastMes = parseSendDate(lastMessage?.send_date, null);
            keptShards.push({
                file: shard.file,
                count: keptLines.length,
                size: stats.size,
                last_mes: lastMes,
                last_message: typeof lastMessage?.mes === 'string' ? lastMessage.mes : '',
            });
        } else if (fs.existsSync(shardPath)) {
            fs.unlinkSync(shardPath);
        }

        const shardsToDelete = index.shards.slice(index.shards.indexOf(shard) + 1);
        for (const target of shardsToDelete) {
            const targetPath = path.join(chunkDir, target.file);
            if (fs.existsSync(targetPath)) {
                fs.unlinkSync(targetPath);
            }
        }
        break;
    }

    /** @type {ChatIndex} */
    const newIndex = {
        version: 1,
        chunk_size: getChatChunkSize(),
        message_count: 0,
        last_mes: null,
        last_message: '',
        total_bytes: 0,
        shards: [],
    };

    for (const shard of keptShards) {
        newIndex.message_count += shard.count;
        newIndex.total_bytes += shard.size || 0;
        newIndex.last_mes = shard.last_mes ?? newIndex.last_mes;
        newIndex.last_message = shard.last_message || newIndex.last_message;
        newIndex.shards.push(shard);
    }

    writeChatIndex(filePath, newIndex);
    return newIndex;
}

async function appendChunkedMessages(filePath, index, messages) {
    if (!messages || messages.length === 0) return index;
    const chunkSize = getChatChunkSize();
    const chunkDir = ensureChatChunkDir(filePath);
    /** @type {ChatIndex} */
    const nextIndex = index ? { ...index, shards: [...(index.shards || [])] } : {
        version: 1,
        chunk_size: chunkSize,
        message_count: 0,
        last_mes: null,
        last_message: '',
        total_bytes: 0,
        shards: [],
    };
    nextIndex.chunk_size = chunkSize;

    let shardEntry = nextIndex.shards[nextIndex.shards.length - 1] || null;
    let shardPath = shardEntry ? path.join(chunkDir, shardEntry.file) : '';

    let cursor = 0;
    while (cursor < messages.length) {
        if (!shardEntry || shardEntry.count >= chunkSize) {
            const shardName = formatShardName(nextIndex.shards.length);
            shardPath = path.join(chunkDir, shardName);
            const chunk = messages.slice(cursor, cursor + chunkSize);
            const payload = chunk.map((item) => JSON.stringify(item)).join('\n');
            writeFileAtomicSync(shardPath, payload, 'utf8');
            const stats = await fs.promises.stat(shardPath);
            const lastMessage = chunk[chunk.length - 1];
            const lastMes = parseSendDate(lastMessage?.send_date, nextIndex.last_mes);
            shardEntry = {
                file: shardName,
                count: chunk.length,
                size: stats.size,
                last_mes: lastMes,
                last_message: typeof lastMessage?.mes === 'string' ? lastMessage.mes : '',
            };
            nextIndex.shards.push(shardEntry);
            nextIndex.total_bytes += stats.size;
            nextIndex.message_count += chunk.length;
            nextIndex.last_mes = lastMes;
            nextIndex.last_message = shardEntry.last_message;
            cursor += chunk.length;
            continue;
        }

        const available = Math.max(0, chunkSize - shardEntry.count);
        const chunk = messages.slice(cursor, cursor + available);
        let payloadToAppend = chunk.map((item) => JSON.stringify(item)).join('\n');
        if (payloadToAppend.length > 0) {
            if (!shardEntry) {
                cursor += chunk.length;
                continue;
            }
            if (!shardPath) {
                shardPath = path.join(chunkDir, shardEntry.file);
            }
            if (needsLeadingNewline(shardPath)) {
                payloadToAppend = `\n${payloadToAppend}`;
            }
            const previousSize = shardEntry.size || 0;
            fs.appendFileSync(shardPath, payloadToAppend, 'utf8');
            const stats = await fs.promises.stat(shardPath);
            const lastMessage = chunk[chunk.length - 1];
            shardEntry.count += chunk.length;
            shardEntry.size = stats.size;
            shardEntry.last_mes = parseSendDate(lastMessage?.send_date, shardEntry.last_mes);
            shardEntry.last_message = typeof lastMessage?.mes === 'string' ? lastMessage.mes : shardEntry.last_message;
            nextIndex.total_bytes = nextIndex.total_bytes - previousSize + stats.size;
            nextIndex.message_count += chunk.length;
            nextIndex.last_mes = shardEntry.last_mes;
            nextIndex.last_message = shardEntry.last_message;
        }
        cursor += chunk.length;
    }

    writeChatIndex(filePath, nextIndex);
    return nextIndex;
}

/**
 * @param {string} filePath
 * @returns {Promise<any>}
 */
async function readChatHeader(filePath) {
    try {
        const metadataPath = getChatMetadataPath(filePath);
        if (fs.existsSync(metadataPath)) {
            const metadata = await fs.promises.readFile(metadataPath, 'utf8');
            const parsed = tryParse(metadata);
            if (parsed && _.isObject(parsed)) {
                return parsed;
            }
        }
    } catch (error) {
        console.warn('Failed to read chat metadata sidecar:', error);
    }

    const firstLine = await readFirstLine(filePath);
    const jsonData = tryParse(firstLine);
    return jsonData && _.isObject(jsonData) ? jsonData : null;
}

function writeChatHeader(filePath, header) {
    try {
        if (!header || typeof header !== 'object') return;
        const metadataPath = getChatMetadataPath(filePath);
        writeFileAtomicSync(metadataPath, JSON.stringify(header), 'utf8');
    } catch (error) {
        console.warn('Failed to write chat metadata sidecar:', error);
    }
}

async function getHeaderEndOffset(filePath) {
    const [firstLine, stats] = await Promise.all([
        readFirstLine(filePath),
        fs.promises.stat(filePath),
    ]);
    if (!firstLine) return 0;
    const headerLength = Buffer.byteLength(firstLine, 'utf8');
    return Math.min(headerLength + 1, stats.size);
}

/**
 * Reads the last line of a file asynchronously.
 * @param {string} filePath Path to the file
 * @returns {Promise<string>} The last line of the file
 */
async function readLastLine(filePath) {
    const stats = await fs.promises.stat(filePath);
    if (stats.size === 0) return '';
    const handle = await fs.promises.open(filePath, 'r');
    try {
        let position = stats.size;
        let buffer = '';

        while (position > 0) {
            const readSize = Math.min(lastLineChunkSize, position);
            position -= readSize;
            const chunk = Buffer.alloc(readSize);
            await handle.read(chunk, 0, readSize, position);
            buffer = chunk.toString('utf8') + buffer;

            const idx = buffer.lastIndexOf('\n');
            if (idx !== -1) {
                return buffer.slice(idx + 1).trimEnd();
            }
        }

        return buffer.trimEnd();
    } finally {
        await handle.close();
    }
}

async function readJsonlTail(filePath, limit, beforeOffset = null) {
    if (isChunkedChat(filePath)) {
        return await readJsonlTailChunked(filePath, limit, beforeOffset);
    }

    const stats = await fs.promises.stat(filePath);
    let end = typeof beforeOffset === 'number' ? Math.max(0, Math.min(beforeOffset, stats.size)) : stats.size;
    if (end === 0) {
        return { lines: [], cursor: 0, readBytes: 0, chunksRead: 0 };
    }

    const handle = await fs.promises.open(filePath, 'r');
    try {
        let position = end;
        let buffer = Buffer.alloc(0);
        const lines = [];
        let cursor = 0;
        let readBytes = 0;
        let chunksRead = 0;

        while (position > 0 && lines.length < limit) {
            const readSize = Math.min(tailChunkSize, position);
            position -= readSize;
            const chunk = Buffer.alloc(readSize);
            await handle.read(chunk, 0, readSize, position);
            readBytes += readSize;
            chunksRead++;
            buffer = Buffer.concat([chunk, buffer]);

            let idx;
            while ((idx = buffer.lastIndexOf(0x0A)) !== -1) {
                const lineBuf = buffer.slice(idx + 1);
                buffer = buffer.slice(0, idx);
                if (lineBuf.length === 0) {
                    continue;
                }
                const line = lineBuf.toString('utf8').replace(/\r$/, '');
                if (line.length === 0) {
                    continue;
                }
                lines.push(line);
                if (lines.length === limit) {
                    cursor = position + idx + 1;
                    break;
                }
            }
        }

        if (lines.length < limit && buffer.length > 0) {
            const line = buffer.toString('utf8').replace(/\r$/, '');
            if (line.length > 0) {
                lines.push(line);
            }
            cursor = 0;
        }

        lines.reverse();
        return { lines, cursor, readBytes, chunksRead };
    } finally {
        await handle.close();
    }
}

async function readJsonlTailChunked(filePath, limit, beforeOffset = null) {
    const index = await ensureChatIndex(filePath);
    if (!index || !Array.isArray(index.shards)) {
        return { lines: [], cursor: 0, readBytes: 0, chunksRead: 0 };
    }
    const totalMessages = Number(index.message_count) || 0;
    const endIndex = typeof beforeOffset === 'number'
        ? Math.max(0, Math.min(beforeOffset, totalMessages))
        : totalMessages;
    if (endIndex === 0) {
        return { lines: [], cursor: 0, readBytes: 0, chunksRead: 0 };
    }

    const startIndex = Math.max(0, endIndex - limit);
    const lines = [];
    let remainingEnd = endIndex;
    let readBytes = 0;
    let chunksRead = 0;

    for (let i = index.shards.length - 1; i >= 0 && lines.length < limit; i--) {
        const shard = index.shards[i];
        const shardCount = Number(shard?.count) || 0;
        if (shardCount <= 0) {
            continue;
        }
        const shardStart = Math.max(0, remainingEnd - shardCount);
        const shardEnd = remainingEnd;

        if (shardEnd <= startIndex) {
            remainingEnd = shardStart;
            continue;
        }

        const readStart = Math.max(shardStart, startIndex);
        const readEnd = shardEnd;
        const localStart = readStart - shardStart;
        const localEnd = readEnd - shardStart;

        const shardPath = path.join(getChatChunkDir(filePath), shard.file);
        const shardLines = await readShardLines(shardPath);
        readBytes += Number(shard.size) || Buffer.byteLength(shardLines.join('\n'), 'utf8');
        chunksRead++;
        const slice = shardLines.slice(localStart, localEnd);
        lines.unshift(...slice);

        remainingEnd = shardStart;
    }

    const cursor = startIndex;
    return { lines, cursor, readBytes, chunksRead };
}

function parseChatLines(lines) {
    const messages = [];
    for (const line of lines) {
        const jsonData = tryParse(line);
        if (!jsonData) continue;
        const isHeader = jsonData?.user_name && jsonData?.character_name && !jsonData?.name;
        if (isHeader) continue;
        messages.push(jsonData);
    }
    return messages;
}

function needsLeadingNewline(filePath) {
    const size = fs.statSync(filePath).size;
    if (size === 0) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(1);
        fs.readSync(fd, buffer, 0, 1, size - 1);
        return buffer[0] !== 0x0A;
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Counts JSONL lines without parsing JSON.
 * @param {string} filePath Path to the file
 * @returns {Promise<number>} Line count
 */
function countJsonlLines(filePath) {
    return new Promise((resolve, reject) => {
        let count = 0;
        let lastChunkEndedWithNewline = false;
        const stream = fs.createReadStream(filePath);

        stream.on('data', (chunk) => {
            const text = chunk.toString('utf8');
            for (let i = 0; i < text.length; i++) {
                if (text[i] === '\n') count++;
            }
            lastChunkEndedWithNewline = text.endsWith('\n');
        });

        stream.on('end', () => {
            if (!lastChunkEndedWithNewline) count++;
            resolve(count);
        });

        stream.on('error', (error) => reject(error));
    });
}

function getChatSummaryFromMetadata(chatMetadata) {
    if (!chatMetadata || typeof chatMetadata !== 'object') return {};
    const messageCount = Number(chatMetadata.message_count);
    const lastMes = parseSendDate(chatMetadata.last_mes, null);
    const lastMessage = typeof chatMetadata.last_message === 'string' ? chatMetadata.last_message : '';
    return {
        messageCount: Number.isFinite(messageCount) ? messageCount : null,
        lastMes: Number.isFinite(lastMes) ? lastMes : null,
        lastMessage,
    };
}

/**
 * Checks if the chat being saved has the same integrity as the one being loaded.
 * @param {string} filePath Path to the chat file
 * @param {string} integritySlug Integrity slug
 * @returns {Promise<boolean>} Whether the chat is intact
 */
async function checkChatIntegrity(filePath, integritySlug) {
    // If the chat file doesn't exist, assume it's intact
    if (!fs.existsSync(filePath)) {
        return true;
    }

    const header = await readChatHeader(filePath);
    const chatIntegrity = header?.chat_metadata?.integrity;

    // If the chat has no integrity metadata, assume it's intact
    if (!chatIntegrity) {
        return true;
    }

    // Check if the integrity matches
    return chatIntegrity === integritySlug;
}

/**
 * @typedef {Object} ChatInfo
 * @property {string} [file_id] - The name of the chat file (without extension)
 * @property {string} [file_name] - The name of the chat file (with extension)
 * @property {string} [file_size] - The size of the chat file
 * @property {number} [chat_items] - The number of chat items in the file
 * @property {string} [mes] - The last message in the chat
 * @property {number} [last_mes] - The timestamp of the last message
 * @property {object} [chat_metadata] - Additional chat metadata
 */

/**
 * Reads the information from a chat file.
 * @param {string} pathToFile - Path to the chat file
 * @param {object} additionalData - Additional data to include in the result
 * @param {boolean} isGroup - Whether the chat is a group chat
 * @param {boolean} withMetadata - Whether to read chat metadata
 * @param {((state: string) => void)|null} cacheObserver Optional cache state observer
 * @returns {Promise<ChatInfo>}
 */
export async function getChatInfo(pathToFile, additionalData = {}, isGroup = false, withMetadata = false, cacheObserver = null) {
    return new Promise(async (res) => {
        const parsedPath = path.parse(pathToFile);
        let stats = await fs.promises.stat(pathToFile);
        const chunked = isChunkedChat(pathToFile);
        if (chunked) {
            const indexPath = getChatIndexPath(pathToFile);
            if (fs.existsSync(indexPath)) {
                try {
                    stats = await fs.promises.stat(indexPath);
                } catch (error) {
                    console.warn('Failed to read chat index stats for cache:', error);
                }
            }
        }
        const cached = getCachedChatInfo(pathToFile, stats, withMetadata);
        if (cached) {
            cacheObserver?.('hit');
            res({ ...cached, ...additionalData });
            return;
        }
        cacheObserver?.('miss');
        let fileSizeInKB = `${(stats.size / 1024).toFixed(2)}kb`;

        const chatData = {
            file_id: parsedPath.name,
            file_name: parsedPath.base,
            file_size: fileSizeInKB,
            chat_items: 0,
            mes: '[The chat is empty]',
            last_mes: stats.mtimeMs,
            ...additionalData,
        };

        if (stats.size === 0 && !isGroup && !chunked) {
            console.warn(`Found an empty chat file: ${pathToFile}`);
            res({});
            return;
        }

        if (stats.size === 0 && isGroup && !chunked) {
            res(chatData);
            return;
        }

        let chatMetadata = null;
        const header = /** @type {any} */ (await readChatHeader(pathToFile));
        if (header && _.isObject(header.chat_metadata)) {
            chatMetadata = header.chat_metadata;
            if (withMetadata) {
                chatData.chat_metadata = header.chat_metadata;
            }
        }

        const summary = getChatSummaryFromMetadata(chatMetadata);
        let messageCount = summary.messageCount;
        let lastMessage = summary.lastMessage;
        let lastMesDate = summary.lastMes;
        let chunkedIndex = null;

        if (chunked) {
            chunkedIndex = await ensureChatIndex(pathToFile);
            if (chunkedIndex) {
                const totalBytes = Number(chunkedIndex.total_bytes);
                if (Number.isFinite(totalBytes)) {
                    fileSizeInKB = `${(totalBytes / 1024).toFixed(2)}kb`;
                }
                const indexCount = Number(chunkedIndex.message_count);
                if (Number.isFinite(indexCount)) {
                    messageCount = indexCount;
                }
                if (chunkedIndex.last_message) {
                    lastMessage = chunkedIndex.last_message;
                }
                lastMesDate = parseSendDate(chunkedIndex.last_mes, lastMesDate);
            }
        }

        if (messageCount === null) {
            const lineCount = await countJsonlLines(pathToFile);
            messageCount = isGroup ? lineCount : Math.max(lineCount - 1, 0);
        }

        if (!lastMessage || lastMesDate === null) {
            const lastLine = await readLastLine(pathToFile);
            const jsonData = tryParse(lastLine);
            if (jsonData && (jsonData.name || jsonData.character_name || jsonData.chat_metadata)) {
                lastMessage = jsonData['mes'] || '[The message is empty]';
                lastMesDate = parseSendDate(jsonData['send_date'], stats.mtimeMs);
            } else {
                console.warn('Found an invalid or corrupted chat file:', pathToFile);
                res({});
                return;
            }
        }

        chatData.chat_items = messageCount;
        chatData.mes = lastMessage || '[The message is empty]';
        chatData.last_mes = Number.isFinite(lastMesDate) ? lastMesDate : stats.mtimeMs;

        setCachedChatInfo(pathToFile, stats, chatData, withMetadata && Boolean(chatMetadata));
        res(chatData);
    });
}

export const router = express.Router();

const CHARACTER_LIST_INVALIDATION_PATHS = new Set(['/save', '/save-tail', '/rename', '/delete', '/import']);
router.use((request, response, next) => {
    if (request.method === 'POST' && CHARACTER_LIST_INVALIDATION_PATHS.has(request.path)) {
        response.once('finish', () => {
            const handle = request.user?.profile?.handle;
            if (response.statusCode < 400 && handle) {
                invalidateCharacterListCache(handle);
            }
        });
    }
    next();
});

router.post('/save', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const directoryName = String(request.body.avatar_url).replace('.png', '');
        const chatData = request.body.chat;
        let header = Array.isArray(chatData) && chatData.length ? /** @type {any} */ (chatData[0]) : null;
        const messages = Array.isArray(chatData) ? chatData.slice(1) : [];
        if (header && typeof header === 'object') {
            updateChatHeaderMetadata(header, messages.length, messages[messages.length - 1]);
        }
        const fileName = `${String(request.body.file_name)}.jsonl`;
        const filePath = path.join(request.user.directories.chats, directoryName, sanitize(fileName));
        if (!isPathUnderParent(request.user.directories.chats, filePath)) {
            return response.sendStatus(400);
        }
        let jsonlData = null;
        let additionalBytes = 0;
        if (chatChunkingEnabled) {
            const messagesPayload = messages.map((item) => JSON.stringify(item)).join('\n');
            const newSize = Buffer.byteLength(messagesPayload, 'utf8');
            const oldSize = fs.existsSync(filePath) ? getChatTotalBytes(filePath) : 0;
            additionalBytes = Math.max(0, newSize - oldSize);
        } else {
            jsonlData = chatData.map((item) => JSON.stringify(item)).join('\n');
            const newSize = Buffer.byteLength(jsonlData, 'utf8');
            const oldSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
            additionalBytes = Math.max(0, newSize - oldSize);
        }
        const storageError = await ensureChatStorageCapacity(request, response, additionalBytes);
        if (storageError) {
            return storageError;
        }
        if (checkIntegrity && !request.body.force) {
            const integritySlug = header?.chat_metadata?.integrity;
            const isIntact = await checkChatIntegrity(filePath, integritySlug);
            if (!isIntact) {
                console.error(`Chat integrity check failed for ${filePath}`);
                return response.status(400).send({ error: 'integrity' });
            }
        }
        if (chatChunkingEnabled) {
            await writeChunkedChat(filePath, header, messages);
        } else {
            writeFileAtomicSync(filePath, jsonlData, 'utf8');
            writeChatHeader(filePath, header);
        }
        try {
            const stats = await fs.promises.stat(filePath);
            const index = chatChunkingEnabled ? readChatIndex(filePath) : null;
            const totalBytes = Number(index?.total_bytes);
            const fileSizeInKB = Number.isFinite(totalBytes)
                ? `${(totalBytes / 1024).toFixed(2)}kb`
                : `${(stats.size / 1024).toFixed(2)}kb`;
            const lastMessage = messages[messages.length - 1] || {};
            setCachedChatInfo(filePath, stats, {
                file_id: path.parse(filePath).name,
                file_name: path.parse(filePath).base,
                file_size: fileSizeInKB,
                chat_items: Math.max(messages?.length || 0, 0),
                mes: typeof lastMessage.mes === 'string' ? lastMessage.mes : '[The message is empty]',
                last_mes: parseSendDate(lastMessage.send_date, stats.mtimeMs),
                chat_metadata: header?.chat_metadata,
            }, true);
        } catch (error) {
            console.warn('Failed to update chat info cache after save:', error);
        }
        if (Array.isArray(chatData) && chatData.length) {
            const jsonlData = chatData.map((item) => JSON.stringify(item)).join('\n');
            getBackupFunction(request.user.profile.handle)(request.user.directories.backups, directoryName, jsonlData);
        }
        // 记录聊天活动到系统监控器
        if (messages && messages.length > 0) {
            const lastMessage = messages[messages.length - 1];
            if (lastMessage) {
                const messageType = lastMessage.is_user ? 'user' : 'character';
                systemMonitor.recordUserChatActivity(
                    request.user.profile.handle,
                    messageType,
                    {
                        userName: request.user.profile.name,
                        characterName: directoryName,
                    },
                );
            }
        }
        return response.send({ result: 'ok' });
    } catch (error) {
        console.error(error);
        return response.send(error);
    }
});

router.post('/save-tail', validateAvatarUrlMiddleware, async function (request, response) {
    const performanceTimer = beginEndpointPerformance(request, 'chat-save-tail');
    performanceTimer.setCacheState('bypass');
    const stopWriteTimer = performanceTimer.startPhase('write');
    const prepareResponse = () => {
        stopWriteTimer();
        performanceTimer.startPhase('serialize');
    };
    try {
        const directoryName = String(request.body.avatar_url).replace('.png', '');
        const fileName = `${String(request.body.file_name)}.jsonl`;
        const filePath = path.join(request.user.directories.chats, directoryName, sanitize(fileName));
        if (!isPathUnderParent(request.user.directories.chats, filePath)) {
            prepareResponse();
            return response.sendStatus(400);
        }
        const header = request.body.header && typeof request.body.header === 'object'
            ? /** @type {any} */ (request.body.header)
            : null;
        const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
        let beforeOffset = Number.isFinite(request.body.before) ? request.body.before : Number(request.body.before ?? 0);
        if (!Number.isFinite(beforeOffset)) {
            beforeOffset = 0;
        }
        performanceTimer.setCounter('messages', messages.length);
        performanceTimer.setCounter('cursor', beforeOffset);
        performanceTimer.setCounter('chunked', Number(chatChunkingEnabled));
        performanceTimer.setCounter('chunks', chatChunkingEnabled && messages.length ? Math.ceil(messages.length / getChatChunkSize()) : Number(messages.length > 0));
        let additionalBytes = 0;
        let payloadBytes = 0;
        if (chatChunkingEnabled) {
            const messagesPayload = messages.map((item) => JSON.stringify(item)).join('\n');
            const newSize = Buffer.byteLength(messagesPayload, 'utf8');
            payloadBytes = newSize;
            const oldSize = fs.existsSync(filePath) ? getChatTotalBytes(filePath) : 0;
            if (!fs.existsSync(filePath) || beforeOffset <= 0) {
                additionalBytes = Math.max(0, newSize - oldSize);
            } else {
                additionalBytes = Math.max(0, newSize);
            }
        } else if (!fs.existsSync(filePath) || beforeOffset <= 0) {
            const headerToWrite = header ?? {
                user_name: request.user.profile?.name ?? 'User',
                character_name: String(request.body.ch_name ?? directoryName),
                create_date: humanizedISO8601DateTime(),
                chat_metadata: {},
            };
            updateChatHeaderMetadata(headerToWrite, messages.length, messages[messages.length - 1]);
            const jsonlData = [JSON.stringify(headerToWrite), ...messages.map((item) => JSON.stringify(item))].join('\n');
            const newSize = Buffer.byteLength(jsonlData, 'utf8');
            payloadBytes = newSize;
            const oldSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
            additionalBytes = Math.max(0, newSize - oldSize);
        } else {
            const oldSize = fs.statSync(filePath).size;
            let payload = messages.map((item) => JSON.stringify(item)).join('\n');
            let appendedBytes = Buffer.byteLength(payload, 'utf8');
            if (payload && needsLeadingNewline(filePath)) {
                appendedBytes += 1;
            }
            const newSize = Math.max(0, beforeOffset) + appendedBytes;
            payloadBytes = appendedBytes;
            additionalBytes = Math.max(0, newSize - oldSize);
        }
        performanceTimer.setCounter('payload-bytes', payloadBytes);
        performanceTimer.setCounter('storage-growth-bytes', additionalBytes);

        const storageError = await ensureChatStorageCapacity(request, response, additionalBytes);
        if (storageError) {
            return storageError;
        }

        if (checkIntegrity && !request.body.force) {
            const integritySlug = header?.chat_metadata?.integrity;
            if (integritySlug) {
                const isIntact = await checkChatIntegrity(filePath, integritySlug);
                if (!isIntact) {
                    console.error(`Chat integrity check failed for ${filePath}`);
                    prepareResponse();
                    return response.status(400).send({ error: 'integrity' });
                }
            }
        }

        if (!fs.existsSync(path.dirname(filePath))) {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
        }

        if (chatChunkingEnabled) {
            if (!fs.existsSync(filePath) || beforeOffset <= 0) {
                const headerToWrite = header ?? {
                    user_name: request.user.profile?.name ?? 'User',
                    character_name: String(request.body.ch_name ?? directoryName),
                    create_date: humanizedISO8601DateTime(),
                    chat_metadata: {},
                };
                updateChatHeaderMetadata(headerToWrite, messages.length, messages[messages.length - 1]);
                await writeChunkedChat(filePath, headerToWrite, messages);
                const jsonlData = [JSON.stringify(headerToWrite), ...messages.map((item) => JSON.stringify(item))].join('\n');
                getBackupFunction(request.user.profile.handle)(request.user.directories.backups, directoryName, jsonlData);
                prepareResponse();
                return response.send({ result: 'ok' });
            }

            if (!isChunkedChat(filePath)) {
                await convertLegacyChatToChunks(filePath);
            }

            const index = await ensureChatIndex(filePath);
            const totalMessages = Number(index?.message_count) || 0;
            const beforeIndex = Math.max(0, Math.min(beforeOffset, totalMessages));
            const existingTailCount = Math.max(0, totalMessages - beforeIndex);
            const compareLimit = Math.max(1, Number.isFinite(chatTailCompareLimit) ? chatTailCompareLimit : getChatChunkSize());
            let appendOnly = false;

            if (existingTailCount <= compareLimit && existingTailCount <= messages.length) {
                const existingLines = await readChunkedChatLinesRange(filePath, beforeIndex, existingTailCount);
                appendOnly = existingLines.length === existingTailCount && existingLines.every((line, idx) => {
                    const incoming = messages[idx];
                    if (!incoming) return false;
                    if (line === JSON.stringify(incoming)) return true;
                    const existingObj = tryParse(line);
                    return existingObj ? _.isEqual(existingObj, incoming) : false;
                });
            }

            let updatedIndex = index;
            if (!appendOnly) {
                updatedIndex = await truncateChunkedChat(filePath, index, beforeIndex);
                updatedIndex = await appendChunkedMessages(filePath, updatedIndex, messages);
            } else {
                const newMessages = messages.slice(existingTailCount);
                updatedIndex = await appendChunkedMessages(filePath, updatedIndex, newMessages);
            }

            if (header) {
                updateChatHeaderMetadata(header, updatedIndex?.message_count ?? messages.length, messages[messages.length - 1]);
                writeFileAtomicSync(filePath, JSON.stringify(header), 'utf8');
                writeChatHeader(filePath, header);
            } else if (fs.existsSync(filePath)) {
                const now = new Date();
                fs.utimesSync(filePath, now, now);
            }
        } else {
            if (!fs.existsSync(filePath) || beforeOffset <= 0) {
                const headerToWrite = header ?? {
                    user_name: request.user.profile?.name ?? 'User',
                    character_name: String(request.body.ch_name ?? directoryName),
                    create_date: humanizedISO8601DateTime(),
                    chat_metadata: {},
                };
                updateChatHeaderMetadata(headerToWrite, messages.length, messages[messages.length - 1]);
                const jsonlData = [JSON.stringify(headerToWrite), ...messages.map((item) => JSON.stringify(item))].join('\n');
                writeFileAtomicSync(filePath, jsonlData, 'utf8');
                writeChatHeader(filePath, headerToWrite);
                getBackupFunction(request.user.profile.handle)(request.user.directories.backups, directoryName, jsonlData);
                prepareResponse();
                return response.send({ result: 'ok' });
            }

            fs.truncateSync(filePath, beforeOffset);

            if (messages.length) {
                let payload = messages.map((item) => JSON.stringify(item)).join('\n');
                if (needsLeadingNewline(filePath)) {
                    payload = `\n${payload}`;
                }
                fs.appendFileSync(filePath, payload, 'utf8');
            }

            if (header) {
                writeChatHeader(filePath, header);
            }
        }

        try {
            const stats = await fs.promises.stat(filePath);
            const index = chatChunkingEnabled ? readChatIndex(filePath) : null;
            const totalBytes = Number(index?.total_bytes);
            const fileSizeInKB = Number.isFinite(totalBytes)
                ? `${(totalBytes / 1024).toFixed(2)}kb`
                : `${(stats.size / 1024).toFixed(2)}kb`;
            const lastMessage = messages?.[messages.length - 1] || {};
            const chatItems = Number.isFinite(index?.message_count) ? Number(index.message_count) : Math.max(messages?.length || 0, 0);
            setCachedChatInfo(filePath, stats, {
                file_id: path.parse(filePath).name,
                file_name: path.parse(filePath).base,
                file_size: fileSizeInKB,
                chat_items: chatItems,
                mes: typeof lastMessage.mes === 'string' ? lastMessage.mes : '[The message is empty]',
                last_mes: parseSendDate(lastMessage.send_date, stats.mtimeMs),
                chat_metadata: header?.chat_metadata,
            }, Boolean(header?.chat_metadata));
        } catch (error) {
            console.warn('Failed to update chat info cache after tail save:', error);
        }

        if (messages && messages.length > 0) {
            const lastMessage = messages[messages.length - 1];
            if (lastMessage) {
                const messageType = lastMessage.is_user ? 'user' : 'character';
                systemMonitor.recordUserChatActivity(
                    request.user.profile.handle,
                    messageType,
                    {
                        userName: request.user.profile.name,
                        characterName: directoryName,
                    },
                );
            }
        }

        prepareResponse();
        return response.send({ result: 'ok' });
    } catch (error) {
        console.error(error);
        prepareResponse();
        return response.status(500).send(error);
    }
});

router.post('/get', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const dirName = String(request.body.avatar_url).replace('.png', '');
        const directoryPath = path.join(request.user.directories.chats, dirName);
        if (!isPathUnderParent(request.user.directories.chats, directoryPath)) {
            return response.sendStatus(400);
        }
        const chatDirExists = fs.existsSync(directoryPath);

        //if no chat dir for the character is found, make one with the character name
        if (!chatDirExists) {
            fs.mkdirSync(directoryPath);
            return response.send({});
        }

        if (!request.body.file_name) {
            return response.send({});
        }

        const fileName = `${String(request.body.file_name)}.jsonl`;
        const filePath = path.join(directoryPath, sanitize(fileName));
        const chatFileExists = fs.existsSync(filePath);

        if (!chatFileExists) {
            return response.send({});
        }

        if (chatChunkingEnabled && !isChunkedChat(filePath)) {
            await convertLegacyChatToChunks(filePath);
        }

        if (chatChunkingEnabled && isChunkedChat(filePath)) {
            const header = await readChatHeader(filePath);
            const messages = await readChunkedChatMessages(filePath);
            return response.send([header, ...messages].filter(x => x));
        }

        const data = fs.readFileSync(filePath, 'utf8');
        const lines = data.split('\n');

        // Iterate through the array of strings and parse each line as JSON
        const jsonData = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return; } }).filter(x => x);
        return response.send(jsonData);
    } catch (error) {
        console.error(error);
        return response.send({});
    }
});

router.post('/get-range', validateAvatarUrlMiddleware, async function (request, response) {
    const performanceTimer = beginEndpointPerformance(request, 'chat-get-range');
    performanceTimer.setCacheState('bypass');
    try {
        const dirName = String(request.body.avatar_url).replace('.png', '');
        const directoryPath = path.join(request.user.directories.chats, dirName);
        if (!isPathUnderParent(request.user.directories.chats, directoryPath)) {
            return response.sendStatus(400);
        }

        if (!request.body.file_name) {
            performanceTimer.startPhase('serialize');
            return response.send({ header: null, messages: [], cursor: 0, hasMore: false });
        }

        const fileName = `${String(request.body.file_name)}.jsonl`;
        const filePath = path.join(directoryPath, sanitize(fileName));
        const chatFileExists = fs.existsSync(filePath);

        if (!chatFileExists) {
            performanceTimer.startPhase('serialize');
            return response.send({ header: null, messages: [], cursor: 0, hasMore: false });
        }

        const limit = Math.max(1, Math.min(Number(request.body.limit ?? 20), 200));
        const before = request.body.before;
        const beforeOffset = Number.isFinite(before) ? before : Number.isFinite(Number(before)) ? Number(before) : null;
        performanceTimer.setCounter('requested', limit);
        performanceTimer.setCounter('cursor', beforeOffset ?? 0);

        if (chatChunkingEnabled && !isChunkedChat(filePath)) {
            await convertLegacyChatToChunks(filePath);
        }

        const { header, tail } = await performanceTimer.measureAsync('read', async () => ({
            header: await readChatHeader(filePath),
            tail: await readJsonlTail(filePath, limit, beforeOffset),
        }));
        const messages = parseChatLines(tail.lines);
        const chunked = isChunkedChat(filePath);
        const headerEndOffset = chunked ? 0 : await getHeaderEndOffset(filePath);
        let cursor = tail.cursor;
        if (!messages.length) {
            cursor = chunked ? 0 : headerEndOffset;
        }

        const hasMore = chunked ? cursor > 0 : cursor > headerEndOffset;
        performanceTimer.setCounter('messages', messages.length);
        performanceTimer.setCounter('read-bytes', tail.readBytes);
        performanceTimer.setCounter('chunks', tail.chunksRead);
        performanceTimer.setCounter('next-cursor', cursor);
        performanceTimer.startPhase('serialize');
        return response.send({ header, messages, cursor, hasMore });
    } catch (error) {
        console.error(error);
        performanceTimer.startPhase('serialize');
        return response.status(500).send({ header: null, messages: [], cursor: 0, hasMore: false });
    }
});

router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body || !request.body.original_file || !request.body.renamed_file) {
            return response.sendStatus(400);
        }

        const pathToFolder = request.body.is_group
            ? request.user.directories.groupChats
            : path.join(request.user.directories.chats, String(request.body.avatar_url).replace('.png', ''));
        if (!request.body.is_group && !isPathUnderParent(request.user.directories.chats, pathToFolder)) {
            return response.sendStatus(400);
        }
        const pathToOriginalFile = path.join(pathToFolder, sanitize(request.body.original_file));
        const pathToRenamedFile = path.join(pathToFolder, sanitize(request.body.renamed_file));
        const sanitizedFileName = path.parse(pathToRenamedFile).name;
        console.debug('Old chat name', pathToOriginalFile);
        console.debug('New chat name', pathToRenamedFile);

        if (!fs.existsSync(pathToOriginalFile) || fs.existsSync(pathToRenamedFile)) {
            console.error('Either Source or Destination files are not available');
            return response.status(400).send({ error: true });
        }

        fs.copyFileSync(pathToOriginalFile, pathToRenamedFile);
        fs.unlinkSync(pathToOriginalFile);
        const metadataOriginal = getChatMetadataPath(pathToOriginalFile);
        const metadataRenamed = getChatMetadataPath(pathToRenamedFile);
        if (fs.existsSync(metadataOriginal)) {
            fs.copyFileSync(metadataOriginal, metadataRenamed);
            fs.unlinkSync(metadataOriginal);
        }
        const indexOriginal = getChatIndexPath(pathToOriginalFile);
        const indexRenamed = getChatIndexPath(pathToRenamedFile);
        if (fs.existsSync(indexOriginal)) {
            fs.copyFileSync(indexOriginal, indexRenamed);
            fs.unlinkSync(indexOriginal);
        }
        const chunkDirOriginal = getChatChunkDir(pathToOriginalFile);
        const chunkDirRenamed = getChatChunkDir(pathToRenamedFile);
        if (fs.existsSync(chunkDirOriginal)) {
            fs.renameSync(chunkDirOriginal, chunkDirRenamed);
        }
        console.info('Successfully renamed chat file.');
        return response.send({ ok: true, sanitizedFileName });
    } catch (error) {
        console.error('Error renaming chat file:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/delete', validateAvatarUrlMiddleware, function (request, response) {
    try {
        if (!path.extname(request.body.chatfile)) {
            request.body.chatfile += '.jsonl';
        }

        const dirName = String(request.body.avatar_url).replace('.png', '');
        const fileName = String(request.body.chatfile);
        const filePath = path.join(request.user.directories.chats, dirName, sanitize(fileName));
        if (!isPathUnderParent(request.user.directories.chats, filePath)) {
            return response.sendStatus(400);
        }
        const chatFileExists = fs.existsSync(filePath);

        if (!chatFileExists) {
            console.error(`Chat file not found '${filePath}'`);
            return response.sendStatus(400);
        }

        fs.unlinkSync(filePath);
        const metadataPath = getChatMetadataPath(filePath);
        if (fs.existsSync(metadataPath)) {
            fs.unlinkSync(metadataPath);
        }
        const indexPath = getChatIndexPath(filePath);
        if (fs.existsSync(indexPath)) {
            fs.unlinkSync(indexPath);
        }
        const chunkDir = getChatChunkDir(filePath);
        if (fs.existsSync(chunkDir)) {
            const entries = fs.readdirSync(chunkDir);
            for (const entry of entries) {
                fs.unlinkSync(path.join(chunkDir, entry));
            }
            fs.rmdirSync(chunkDir);
        }
        console.info(`Deleted chat file: ${filePath}`);
        return response.send({ ok: true });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/export', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body.file || (!request.body.avatar_url && request.body.is_group === false)) {
        return response.sendStatus(400);
    }
    const pathToFolder = request.body.is_group
        ? request.user.directories.groupChats
        : path.join(request.user.directories.chats, String(request.body.avatar_url).replace('.png', ''));
    const filename = path.join(pathToFolder, sanitize(request.body.file));
    if (!request.body.is_group && !isPathUnderParent(request.user.directories.chats, filename)) {
        return response.sendStatus(400);
    }
    let exportfilename = request.body.exportfilename;
    if (!fs.existsSync(filename)) {
        const errorMessage = {
            message: `Could not find JSONL file to export. Source chat file: ${filename}.`,
        };
        console.error(errorMessage.message);
        return response.status(404).json(errorMessage);
    }
    try {
        // Short path for JSONL files
        if (request.body.format === 'jsonl') {
            try {
                let rawFile;
                if (chatChunkingEnabled && isChunkedChat(filename)) {
                    const header = await readChatHeader(filename);
                    const index = await ensureChatIndex(filename);
                    const lines = [];
                    if (header) {
                        lines.push(JSON.stringify(header));
                    }
                    if (index?.shards?.length) {
                        for (const shard of index.shards) {
                            const shardPath = path.join(getChatChunkDir(filename), shard.file);
                            const shardLines = await readShardLines(shardPath);
                            lines.push(...shardLines);
                        }
                    }
                    rawFile = lines.join('\n');
                } else {
                    rawFile = fs.readFileSync(filename, 'utf8');
                }
                const successMessage = {
                    message: `Chat saved to ${exportfilename}`,
                    result: rawFile,
                };

                console.info(`Chat exported as ${exportfilename}`);
                return response.status(200).json(successMessage);
            } catch (err) {
                console.error(err);
                const errorMessage = {
                    message: `Could not read JSONL file to export. Source chat file: ${filename}.`,
                };
                console.error(errorMessage.message);
                return response.status(500).json(errorMessage);
            }
        }

        let buffer = '';
        const handleLine = (line) => {
            const data = JSON.parse(line);
            // Skip non-printable/prompt-hidden messages
            if (data.is_system) {
                return;
            }
            if (data.mes) {
                const name = data.name;
                const message = (data?.extra?.display_text || data?.mes || '').replace(/\r?\n/g, '\n');
                buffer += (`${name}: ${message}\n\n`);
            }
        };

        if (chatChunkingEnabled && isChunkedChat(filename)) {
            const index = await ensureChatIndex(filename);
            if (index?.shards?.length) {
                for (const shard of index.shards) {
                    const shardPath = path.join(getChatChunkDir(filename), shard.file);
                    const shardLines = await readShardLines(shardPath);
                    for (const line of shardLines) {
                        handleLine(line);
                    }
                }
            }
            const successMessage = {
                message: `Chat saved to ${exportfilename}`,
                result: buffer,
            };
            console.info(`Chat exported as ${exportfilename}`);
            return response.status(200).json(successMessage);
        }

        const readStream = fs.createReadStream(filename);
        const rl = readline.createInterface({
            input: readStream,
        });
        rl.on('line', (line) => {
            handleLine(line);
        });
        rl.on('close', () => {
            const successMessage = {
                message: `Chat saved to ${exportfilename}`,
                result: buffer,
            };
            console.info(`Chat exported as ${exportfilename}`);
            return response.status(200).json(successMessage);
        });
    } catch (err) {
        console.error('chat export failed.', err);
        return response.sendStatus(400);
    }
});

router.post('/group/import', async function (request, response) {
    try {
        const filedata = request.file;

        if (!filedata) {
            return response.sendStatus(400);
        }

        const chatname = humanizedDateTime();
        const pathToUpload = path.join(filedata.destination, filedata.filename);
        const uploadSize = fs.statSync(pathToUpload).size;
        const storageError = await ensureChatStorageCapacity(request, response, uploadSize);
        if (storageError) {
            fs.unlinkSync(pathToUpload);
            return storageError;
        }
        const pathToNewFile = path.join(request.user.directories.groupChats, `${chatname}.jsonl`);
        fs.copyFileSync(pathToUpload, pathToNewFile);
        fs.unlinkSync(pathToUpload);
        if (chatChunkingEnabled) {
            convertLegacyChatToChunks(pathToNewFile).catch((error) => {
                console.warn('Failed to chunk imported group chat:', error);
            });
        }
        return response.send({ res: chatname });
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/import', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body) return response.sendStatus(400);

    const format = request.body.file_type;
    const avatarUrl = String(request.body.avatar_url).replace('.png', '');
    const characterName = String(request.body.character_name ?? 'Character');
    const safeCharacterName = sanitize(characterName) || 'Character';
    const userName = request.body.user_name || 'User';
    const fileNames = [];

    if (!request.file) {
        return response.sendStatus(400);
    }

    const directoryPath = path.join(request.user.directories.chats, avatarUrl);
    if (!isPathUnderParent(request.user.directories.chats, directoryPath)) {
        return response.sendStatus(400);
    }

    try {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        const uploadSize = fs.statSync(pathToUpload).size;
        const storageError = await ensureChatStorageCapacity(request, response, uploadSize);
        if (storageError) {
            fs.unlinkSync(pathToUpload);
            return storageError;
        }
        if (!fs.existsSync(directoryPath)) {
            fs.mkdirSync(directoryPath, { recursive: true });
        }
        const data = fs.readFileSync(pathToUpload, 'utf8');

        if (format === 'json') {
            fs.unlinkSync(pathToUpload);
            const jsonData = JSON.parse(data);

            /** @type {function(string, string, object): string|string[]} */
            let importFunc;

            if (jsonData.savedsettings !== undefined) { // Kobold Lite format
                importFunc = importKoboldLiteChat;
            } else if (jsonData.histories !== undefined) { // CAI Tools format
                importFunc = importCAIChat;
            } else if (Array.isArray(jsonData.data_visible)) { // oobabooga's format
                importFunc = importOobaChat;
            } else if (Array.isArray(jsonData.messages)) { // Agnai's format
                importFunc = importAgnaiChat;
            } else if (jsonData.type === 'risuChat') { // RisuAI format
                importFunc = importRisuChat;
            } else { // Unknown format
                console.error('Incorrect chat format .json');
                return response.send({ error: true });
            }

            const handleChat = async (chat) => {
                const fileName = `${safeCharacterName} - ${humanizedDateTime()} imported.jsonl`;
                const filePath = path.join(directoryPath, fileName);
                fileNames.push(fileName);
                if (chatChunkingEnabled) {
                    const lines = String(chat).split('\n').filter(line => line.length > 0);
                    const header = tryParse(lines.shift() ?? '') || null;
                    const messages = lines.map(line => tryParse(line)).filter(x => x);
                    await writeChunkedChat(filePath, header, messages);
                } else {
                    writeFileAtomicSync(filePath, chat, 'utf8');
                    const header = tryParse(String(chat).split('\n')[0] ?? '');
                    if (header && _.isObject(header)) {
                        writeChatHeader(filePath, header);
                    }
                }
            };

            const chat = importFunc(userName, characterName, jsonData);

            if (Array.isArray(chat)) {
                for (const item of chat) {
                    await handleChat(item);
                }
            } else {
                await handleChat(chat);
            }

            return response.send({ res: true, fileNames });
        }

        if (format === 'jsonl') {
            let lines = data.split('\n');
            const header = lines[0];

            const jsonData = JSON.parse(header);

            if (!(jsonData.user_name !== undefined || jsonData.name !== undefined || jsonData.chat_metadata !== undefined)) {
                console.error('Incorrect chat format .jsonl');
                return response.send({ error: true });
            }

            // Do a tiny bit of work to import Chub Chat data
            // Processing the entire file is so fast that it's not worth checking if it's a Chub chat first
            let flattenedChat = data;
            try {
                // flattening is unlikely to break, but it's not worth failing to
                // import normal chats in an attempt to import a Chub chat
                flattenedChat = flattenChubChat(userName, characterName, lines);
            } catch (error) {
                console.warn('Failed to flatten Chub Chat data: ', error);
            }

            const fileName = `${safeCharacterName} - ${humanizedDateTime()} imported.jsonl`;
            const filePath = path.join(directoryPath, fileName);
            fileNames.push(fileName);
            if (chatChunkingEnabled) {
                const lines = String(flattenedChat ?? '').split('\n').filter(line => line.length > 0);
                const header = tryParse(lines.shift() ?? '') || null;
                const messages = lines.map(line => tryParse(line)).filter(x => x);
                await writeChunkedChat(filePath, header, messages);
            } else {
                if (flattenedChat !== data) {
                    writeFileAtomicSync(filePath, flattenedChat, 'utf8');
                } else {
                    fs.copyFileSync(pathToUpload, filePath);
                }
                const header = tryParse(String(flattenedChat ?? '').split('\n')[0] ?? '');
                if (header && _.isObject(header)) {
                    writeChatHeader(filePath, header);
                }
            }
            fs.unlinkSync(pathToUpload);
            response.send({ res: true, fileNames });
        }
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/group/get', async (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    const id = request.body.id;
    const pathToFile = path.join(request.user.directories.groupChats, `${id}.jsonl`);

    if (fs.existsSync(pathToFile)) {
        if (chatChunkingEnabled && !isChunkedChat(pathToFile)) {
            await convertLegacyChatToChunks(pathToFile);
        }
        if (chatChunkingEnabled && isChunkedChat(pathToFile)) {
            const messages = await readChunkedChatMessages(pathToFile);
            return response.send(messages);
        }

        const data = fs.readFileSync(pathToFile, 'utf8');
        const lines = data.split('\n');

        // Iterate through the array of strings and parse each line as JSON
        const jsonData = lines.map(line => tryParse(line)).filter(x => x);
        return response.send(jsonData);
    } else {
        return response.send([]);
    }
});

router.post('/group/get-range', async (request, response) => {
    const performanceTimer = beginEndpointPerformance(request, 'group-chat-get-range');
    performanceTimer.setCacheState('bypass');
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = request.body.id;
        const filePath = path.join(request.user.directories.groupChats, `${id}.jsonl`);

        if (!fs.existsSync(filePath)) {
            performanceTimer.startPhase('serialize');
            return response.send({ messages: [], cursor: 0, hasMore: false });
        }

        const limit = Math.max(1, Math.min(Number(request.body.limit ?? 20), 200));
        const before = request.body.before;
        const beforeOffset = Number.isFinite(before) ? before : Number.isFinite(Number(before)) ? Number(before) : null;
        performanceTimer.setCounter('requested', limit);
        performanceTimer.setCounter('cursor', beforeOffset ?? 0);
        if (chatChunkingEnabled && !isChunkedChat(filePath)) {
            await convertLegacyChatToChunks(filePath);
        }
        const tail = await performanceTimer.measureAsync('read', () => readJsonlTail(filePath, limit, beforeOffset));
        const messages = parseChatLines(tail.lines);
        const cursor = tail.cursor;
        const hasMore = isChunkedChat(filePath) ? cursor > 0 : cursor > 0;
        performanceTimer.setCounter('messages', messages.length);
        performanceTimer.setCounter('read-bytes', tail.readBytes);
        performanceTimer.setCounter('chunks', tail.chunksRead);
        performanceTimer.setCounter('next-cursor', cursor);
        performanceTimer.startPhase('serialize');
        return response.send({ messages, cursor, hasMore });
    } catch (error) {
        console.error(error);
        performanceTimer.startPhase('serialize');
        return response.status(500).send({ messages: [], cursor: 0, hasMore: false });
    }
});

router.post('/group/delete', (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    const id = request.body.id;
    const pathToFile = path.join(request.user.directories.groupChats, `${id}.jsonl`);

    if (fs.existsSync(pathToFile)) {
        fs.unlinkSync(pathToFile);
        const indexPath = getChatIndexPath(pathToFile);
        if (fs.existsSync(indexPath)) {
            fs.unlinkSync(indexPath);
        }
        const chunkDir = getChatChunkDir(pathToFile);
        if (fs.existsSync(chunkDir)) {
            const entries = fs.readdirSync(chunkDir);
            for (const entry of entries) {
                fs.unlinkSync(path.join(chunkDir, entry));
            }
            fs.rmdirSync(chunkDir);
        }
        return response.send({ ok: true });
    }

    return response.send({ error: true });
});

router.post('/group/save', async (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    const id = request.body.id;
    const pathToFile = path.join(request.user.directories.groupChats, `${id}.jsonl`);

    if (!fs.existsSync(request.user.directories.groupChats)) {
        fs.mkdirSync(request.user.directories.groupChats);
    }

    let chat_data = request.body.chat;
    let jsonlData = chat_data.map((item) => JSON.stringify(item)).join('\n');
    let additionalBytes = 0;
    if (chatChunkingEnabled) {
        const newSize = Buffer.byteLength(jsonlData, 'utf8');
        const oldSize = fs.existsSync(pathToFile) ? getChatTotalBytes(pathToFile) : 0;
        additionalBytes = Math.max(0, newSize - oldSize);
    } else {
        const newSize = Buffer.byteLength(jsonlData, 'utf8');
        const oldSize = fs.existsSync(pathToFile) ? fs.statSync(pathToFile).size : 0;
        additionalBytes = Math.max(0, newSize - oldSize);
    }
    const storageError = await ensureChatStorageCapacity(request, response, additionalBytes);
    if (storageError) {
        return storageError;
    }
    if (chatChunkingEnabled) {
        await writeChunkedChat(pathToFile, null, chat_data);
    } else {
        writeFileAtomicSync(pathToFile, jsonlData, 'utf8');
    }
    try {
        const stats = fs.statSync(pathToFile);
        const index = chatChunkingEnabled ? readChatIndex(pathToFile) : null;
        const totalBytes = Number(index?.total_bytes);
        const fileSizeInKB = Number.isFinite(totalBytes)
            ? `${(totalBytes / 1024).toFixed(2)}kb`
            : `${(stats.size / 1024).toFixed(2)}kb`;
        const lastMessage = chat_data?.[chat_data.length - 1] || {};
        setCachedChatInfo(pathToFile, stats, {
            file_id: path.parse(pathToFile).name,
            file_name: path.parse(pathToFile).base,
            file_size: fileSizeInKB,
            chat_items: Math.max(chat_data?.length || 0, 0),
            mes: typeof lastMessage.mes === 'string' ? lastMessage.mes : '[The message is empty]',
            last_mes: parseSendDate(lastMessage.send_date, stats.mtimeMs),
        }, false);
    } catch (error) {
        console.warn('Failed to update group chat cache after save:', error);
    }
    getBackupFunction(request.user.profile.handle)(request.user.directories.backups, String(id), jsonlData);
    return response.send({ ok: true });
});

router.post('/group/save-tail', async (request, response) => {
    const performanceTimer = beginEndpointPerformance(request, 'group-chat-save-tail');
    performanceTimer.setCacheState('bypass');
    const stopWriteTimer = performanceTimer.startPhase('write');
    const prepareResponse = () => {
        stopWriteTimer();
        performanceTimer.startPhase('serialize');
    };
    if (!request.body || !request.body.id) {
        prepareResponse();
        return response.sendStatus(400);
    }

    const id = request.body.id;
    const filePath = path.join(request.user.directories.groupChats, `${id}.jsonl`);
    const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
    let beforeOffset = Number.isFinite(request.body.before) ? request.body.before : Number(request.body.before ?? 0);
    if (!Number.isFinite(beforeOffset)) {
        beforeOffset = 0;
    }
    performanceTimer.setCounter('messages', messages.length);
    performanceTimer.setCounter('cursor', beforeOffset);
    performanceTimer.setCounter('chunked', Number(chatChunkingEnabled));
    performanceTimer.setCounter('chunks', chatChunkingEnabled && messages.length ? Math.ceil(messages.length / getChatChunkSize()) : Number(messages.length > 0));
    let additionalBytes = 0;
    let payloadBytes = 0;
    if (chatChunkingEnabled) {
        const payload = messages.map((item) => JSON.stringify(item)).join('\n');
        const newSize = Buffer.byteLength(payload, 'utf8');
        payloadBytes = newSize;
        const oldSize = fs.existsSync(filePath) ? getChatTotalBytes(filePath) : 0;
        if (!fs.existsSync(filePath) || beforeOffset <= 0) {
            additionalBytes = Math.max(0, newSize - oldSize);
        } else {
            additionalBytes = Math.max(0, newSize);
        }
    } else if (!fs.existsSync(filePath) || beforeOffset <= 0) {
        const jsonlData = messages.map((item) => JSON.stringify(item)).join('\n');
        const newSize = Buffer.byteLength(jsonlData, 'utf8');
        payloadBytes = newSize;
        const oldSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        additionalBytes = Math.max(0, newSize - oldSize);
    } else {
        const oldSize = fs.statSync(filePath).size;
        let payload = messages.map((item) => JSON.stringify(item)).join('\n');
        let appendedBytes = Buffer.byteLength(payload, 'utf8');
        if (payload && needsLeadingNewline(filePath)) {
            appendedBytes += 1;
        }
        const newSize = Math.max(0, beforeOffset) + appendedBytes;
        payloadBytes = appendedBytes;
        additionalBytes = Math.max(0, newSize - oldSize);
    }
    performanceTimer.setCounter('payload-bytes', payloadBytes);
    performanceTimer.setCounter('storage-growth-bytes', additionalBytes);

    const storageError = await ensureChatStorageCapacity(request, response, additionalBytes);
    if (storageError) {
        return storageError;
    }

    if (!fs.existsSync(request.user.directories.groupChats)) {
        fs.mkdirSync(request.user.directories.groupChats);
    }

    if (chatChunkingEnabled) {
        if (!fs.existsSync(filePath) || beforeOffset <= 0) {
            await writeChunkedChat(filePath, null, messages);
            prepareResponse();
            return response.send({ ok: true });
        }

        if (!isChunkedChat(filePath)) {
            await convertLegacyChatToChunks(filePath);
        }

        const index = await ensureChatIndex(filePath);
        const totalMessages = Number(index?.message_count) || 0;
        const beforeIndex = Math.max(0, Math.min(beforeOffset, totalMessages));
        const existingTailCount = Math.max(0, totalMessages - beforeIndex);
        const compareLimit = Math.max(1, Number.isFinite(chatTailCompareLimit) ? chatTailCompareLimit : getChatChunkSize());
        let appendOnly = false;

        if (existingTailCount <= compareLimit && existingTailCount <= messages.length) {
            const existingLines = await readChunkedChatLinesRange(filePath, beforeIndex, existingTailCount);
            appendOnly = existingLines.length === existingTailCount && existingLines.every((line, idx) => {
                const incoming = messages[idx];
                if (!incoming) return false;
                if (line === JSON.stringify(incoming)) return true;
                const existingObj = tryParse(line);
                return existingObj ? _.isEqual(existingObj, incoming) : false;
            });
        }

        let updatedIndex = index;
        if (!appendOnly) {
            updatedIndex = await truncateChunkedChat(filePath, index, beforeIndex);
            updatedIndex = await appendChunkedMessages(filePath, updatedIndex, messages);
        } else {
            const newMessages = messages.slice(existingTailCount);
            updatedIndex = await appendChunkedMessages(filePath, updatedIndex, newMessages);
        }
        if (fs.existsSync(filePath)) {
            const now = new Date();
            fs.utimesSync(filePath, now, now);
        }
    } else {
        if (!fs.existsSync(filePath) || beforeOffset <= 0) {
            const jsonlData = messages.map((item) => JSON.stringify(item)).join('\n');
            writeFileAtomicSync(filePath, jsonlData, 'utf8');
            prepareResponse();
            return response.send({ ok: true });
        }

        fs.truncateSync(filePath, beforeOffset);

        if (messages.length) {
            let payload = messages.map((item) => JSON.stringify(item)).join('\n');
            if (needsLeadingNewline(filePath)) {
                payload = `\n${payload}`;
            }
            fs.appendFileSync(filePath, payload, 'utf8');
        }
    }

    try {
        const stats = fs.statSync(filePath);
        const index = chatChunkingEnabled ? readChatIndex(filePath) : null;
        const totalBytes = Number(index?.total_bytes);
        const fileSizeInKB = Number.isFinite(totalBytes)
            ? `${(totalBytes / 1024).toFixed(2)}kb`
            : `${(stats.size / 1024).toFixed(2)}kb`;
        const lastMessage = messages?.[messages.length - 1] || {};
        const chatItems = Number.isFinite(index?.message_count) ? Number(index.message_count) : Math.max(messages?.length || 0, 0);
        setCachedChatInfo(filePath, stats, {
            file_id: path.parse(filePath).name,
            file_name: path.parse(filePath).base,
            file_size: fileSizeInKB,
            chat_items: chatItems,
            mes: typeof lastMessage.mes === 'string' ? lastMessage.mes : '[The message is empty]',
            last_mes: parseSendDate(lastMessage.send_date, stats.mtimeMs),
        }, false);
    } catch (error) {
        console.warn('Failed to update group chat cache after tail save:', error);
    }

    prepareResponse();
    return response.send({ ok: true });
});

async function scanChatFileForQuery(filePath, fragments) {
    if (isChunkedChat(filePath)) {
        return await scanChunkedChatForQuery(filePath, fragments);
    }

    let messageCount = 0;
    let lastMessage = '';
    let lastMesDate = null;
    const matches = new Set();

    const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });

    for await (const line of rl) {
        const jsonData = tryParse(line);
        if (!jsonData || typeof jsonData.mes !== 'string') continue;
        messageCount++;
        lastMessage = jsonData.mes;
        lastMesDate = parseSendDate(jsonData.send_date, lastMesDate);

        const text = jsonData.mes.toLowerCase();
        for (const fragment of fragments) {
            if (!matches.has(fragment) && text.includes(fragment)) {
                matches.add(fragment);
            }
        }
    }

    return {
        messageCount,
        lastMessage,
        lastMesDate,
        matches,
    };
}

async function scanChunkedChatForQuery(filePath, fragments) {
    let messageCount = 0;
    let lastMessage = '';
    let lastMesDate = null;
    const matches = new Set();
    const index = await ensureChatIndex(filePath);

    if (!index?.shards?.length) {
        return { messageCount, lastMessage, lastMesDate, matches };
    }

    for (const shard of index.shards) {
        const shardPath = path.join(getChatChunkDir(filePath), shard.file);
        const shardLines = await readShardLines(shardPath);
        for (const line of shardLines) {
            const jsonData = tryParse(line);
            if (!jsonData || typeof jsonData.mes !== 'string') continue;
            messageCount++;
            lastMessage = jsonData.mes;
            lastMesDate = parseSendDate(jsonData.send_date, lastMesDate);

            const text = jsonData.mes.toLowerCase();
            for (const fragment of fragments) {
                if (!matches.has(fragment) && text.includes(fragment)) {
                    matches.add(fragment);
                }
            }
        }
    }

    return {
        messageCount,
        lastMessage,
        lastMesDate,
        matches,
    };
}

router.post('/search', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { query, avatar_url, group_id } = request.body;
        let chatFiles = [];

        if (group_id) {
            // Find group's chat IDs first
            const groupDir = path.join(request.user.directories.groups);
            const groupFiles = fs.readdirSync(groupDir)
                .filter(file => file.endsWith('.json'));

            let targetGroup;
            for (const groupFile of groupFiles) {
                try {
                    const groupData = JSON.parse(fs.readFileSync(path.join(groupDir, groupFile), 'utf8'));
                    if (groupData.id === group_id) {
                        targetGroup = groupData;
                        break;
                    }
                } catch (error) {
                    console.warn(groupFile, 'group file is corrupted:', error);
                }
            }

            if (!targetGroup?.chats) {
                return response.send([]);
            }

            // Find group chat files for given group ID
            const groupChatsDir = path.join(request.user.directories.groupChats);
            chatFiles = targetGroup.chats
                .map(chatId => {
                    const filePath = path.join(groupChatsDir, `${chatId}.jsonl`);
                    if (!fs.existsSync(filePath)) return null;
                    const totalBytes = getChatTotalBytes(filePath);
                    return {
                        file_name: chatId,
                        file_size: formatBytes(totalBytes),
                        path: filePath,
                    };
                })
                .filter(x => x);
        } else {
            // Regular character chat directory
            const character_name = avatar_url.replace('.png', '');
            const directoryPath = path.join(request.user.directories.chats, character_name);

            if (!fs.existsSync(directoryPath)) {
                return response.send([]);
            }

            chatFiles = fs.readdirSync(directoryPath)
                .filter(file => file.endsWith('.jsonl'))
                .map(fileName => {
                    const filePath = path.join(directoryPath, fileName);
                    const totalBytes = getChatTotalBytes(filePath);
                    return {
                        file_name: fileName,
                        file_size: formatBytes(totalBytes),
                        path: filePath,
                    };
                });
        }

        const results = [];

        if (!query) {
            for (const chatFile of chatFiles) {
                const info = await getChatInfo(chatFile.path, {}, Boolean(group_id), false);
                if (!info?.file_name) continue;
                results.push({
                    file_name: chatFile.file_name,
                    file_size: chatFile.file_size,
                    message_count: info.chat_items ?? 0,
                    last_mes: info.last_mes,
                    preview_message: getPreviewText(info.mes || ''),
                });
            }
        } else {
            const fragments = query.trim().toLowerCase().split(/\s+/).filter(x => x);
            for (const chatFile of chatFiles) {
                const stats = fs.statSync(chatFile.path);
                const fileNameText = path.parse(chatFile.path).name.toLowerCase();
                const matched = new Set(fragments.filter(fragment => fileNameText.includes(fragment)));
                const scan = await scanChatFileForQuery(chatFile.path, fragments);
                for (const fragment of matched) {
                    scan.matches.add(fragment);
                }

                if (fragments.length && scan.matches.size < fragments.length) {
                    continue;
                }

                results.push({
                    file_name: chatFile.file_name,
                    file_size: chatFile.file_size,
                    message_count: scan.messageCount,
                    last_mes: parseSendDate(scan.lastMesDate, stats.mtimeMs),
                    preview_message: getPreviewText(scan.lastMessage || ''),
                });
            }
        }

        // Sort by last message date descending
        results.sort((a, b) => new Date(b.last_mes ?? 0).getTime() - new Date(a.last_mes ?? 0).getTime());
        return response.send(results);

    } catch (error) {
        console.error('Chat search error:', error);
        return response.status(500).json({ error: 'Search failed' });
    }
});

router.post('/recent', async function (request, response) {
    const performanceTimer = beginEndpointPerformance(request, 'chats-recent');
    try {
        const max = parseInt(request.body.max ?? Number.MAX_SAFE_INTEGER);
        const withMetadata = Boolean(request.body.metadata);
        const result = await performanceTimer.measureAsync('recent-cache', () => recentChatsCache.get({
            userKey: request.user.profile.handle,
            directories: request.user.directories,
            max,
            metadata: withMetadata,
            load: async () => {
                /** @type {{pngFile?: string, groupId?: string, filePath: string, mtime: number}[]} */
                const allChatFiles = [];

                const getCharacterChatFiles = async () => {
                    const pngDirents = await fs.promises.readdir(request.user.directories.characters, { withFileTypes: true });
                    const pngFiles = pngDirents.filter(e => e.isFile() && path.extname(e.name) === '.png').map(e => e.name);

                    for (const pngFile of pngFiles) {
                        const chatsDirectory = pngFile.replace('.png', '');
                        const pathToChats = path.join(request.user.directories.chats, chatsDirectory);
                        if (!fs.existsSync(pathToChats)) {
                            continue;
                        }
                        const pathStats = await fs.promises.stat(pathToChats);
                        performanceTimer.increment('stat-calls');
                        if (pathStats.isDirectory()) {
                            const chatFiles = await fs.promises.readdir(pathToChats);
                            const jsonlFiles = chatFiles.filter(file => path.extname(file) === '.jsonl');

                            for (const file of jsonlFiles) {
                                const filePath = path.join(pathToChats, file);
                                const stats = await fs.promises.stat(filePath);
                                performanceTimer.increment('stat-calls');
                                allChatFiles.push({ pngFile, filePath, mtime: stats.mtimeMs });
                            }
                        }
                    }
                };

                const getGroupChatFiles = async () => {
                    const groupDirents = await fs.promises.readdir(request.user.directories.groups, { withFileTypes: true });
                    const groups = groupDirents.filter(e => e.isFile() && path.extname(e.name) === '.json').map(e => e.name);

                    for (const group of groups) {
                        try {
                            const groupPath = path.join(request.user.directories.groups, group);
                            const groupContents = await fs.promises.readFile(groupPath, 'utf8');
                            const groupData = JSON.parse(groupContents);

                            if (Array.isArray(groupData.chats)) {
                                for (const chat of groupData.chats) {
                                    const filePath = path.join(request.user.directories.groupChats, `${chat}.jsonl`);
                                    if (!fs.existsSync(filePath)) {
                                        continue;
                                    }
                                    const stats = await fs.promises.stat(filePath);
                                    performanceTimer.increment('stat-calls');
                                    allChatFiles.push({ groupId: groupData.id, filePath, mtime: stats.mtimeMs });
                                }
                            }
                        } catch (error) {
                            // Skip group files that can't be read or parsed
                            continue;
                        }
                    }
                };

                const getRootChatFiles = async () => {
                    const dirents = await fs.promises.readdir(request.user.directories.chats, { withFileTypes: true });
                    const chatFiles = dirents.filter(e => e.isFile() && path.extname(e.name) === '.jsonl').map(e => e.name);

                    for (const file of chatFiles) {
                        const filePath = path.join(request.user.directories.chats, file);
                        const stats = await fs.promises.stat(filePath);
                        performanceTimer.increment('stat-calls');
                        allChatFiles.push({ filePath, mtime: stats.mtimeMs });
                    }
                };

                await performanceTimer.measureAsync('scan', () => Promise.allSettled([getCharacterChatFiles(), getGroupChatFiles(), getRootChatFiles()]));

                const recentChats = allChatFiles.sort((a, b) => b.mtime - a.mtime).slice(0, max);
                performanceTimer.setCounter('candidates', allChatFiles.length);
                performanceTimer.setCounter('top', recentChats.length);
                const jsonFilesPromise = recentChats.map((file) => {
                    const observeCache = state => performanceTimer.increment(`chat-info-${state}`);
                    return file.groupId
                        ? getChatInfo(file.filePath, { group: file.groupId }, true, withMetadata, observeCache)
                        : getChatInfo(file.filePath, { avatar: file.pngFile }, false, withMetadata, observeCache);
                });

                const chatData = (await performanceTimer.measureAsync('chat-info', () => Promise.allSettled(jsonFilesPromise)))
                    .filter(x => x.status === 'fulfilled')
                    .map(x => x.value);
                return chatData.filter(i => i.file_name);
            },
        }));
        performanceTimer.increment(`recent-cache-${result.state}`);
        performanceTimer.setCounter('returned', result.value.length);
        performanceTimer.setCacheState(result.state === 'miss' ? 'miss' : 'hit');

        performanceTimer.startPhase('serialize');
        return response.send(result.value);
    } catch (error) {
        console.error(error);
        performanceTimer.startPhase('serialize');
        return response.sendStatus(500);
    }
});
