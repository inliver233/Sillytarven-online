import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import process from 'node:process';

import archiver from 'archiver';
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
import { KeyedMutex } from '../keyed-mutex.js';
import { FileTransaction } from '../file-transaction.js';
import { ArchiveReadError, openZipFileReader } from '../bounded-zip.js';
import { read as readCharacterCard } from '../character-card-parser.js';
import { BackupQuotaError, consumeBackupQuota } from '../backup-limits.js';
import { chatLinesToText, estimateZipBytes } from '../zip-size-estimate.js';
import { RestoreUploadError, RestoreUploadManager } from '../chat-restore-uploads.js';
import { getUploadLimits } from '../upload-middleware.js';
import { holdStcontrolWrite } from '../stcontrol.js';
import { recordBackupActivity, registerBackupLiveSource } from '../backup-activity.js';
import { invalidateRecentChatsCache, RecentChatsCache, registerRecentChatsCache } from '../recent-chats-cache.js';

const isBackupEnabled = !!getConfigValue('backups.chat.enabled', true, 'boolean');
const maxTotalChatBackups = Number(getConfigValue('backups.chat.maxTotalBackups', -1, 'number'));
const throttleInterval = Number(getConfigValue('backups.chat.throttleInterval', 900_000, 'number'));
const checkIntegrity = !!getConfigValue('backups.chat.checkIntegrity', true, 'boolean');
const chatInfoCacheLimit = Number(getConfigValue('performance.chatInfoCacheLimit', 2000, 'number'));
const chatChunkingEnabled = !!getConfigValue('performance.chatChunkingEnabled', true, 'boolean');
const chatPagingProtocolEnabled = !!getConfigValue('performance.chatPaging.enabled', true, 'boolean');
const chatChunkSizeConfigured = Number(getConfigValue('performance.chatChunkSize', 300, 'number'));
const chatTailCompareLimit = Number(getConfigValue('performance.chatTailCompareLimit', 200, 'number'));
const CHAT_RANGE_LIMIT_MAX = 1000;
const recentChatsCache = new RecentChatsCache({
    enabled: getConfigValue('performance.recentChatsCache.enabled', true, 'boolean'),
    ttlMs: getConfigValue('performance.recentChatsCache.ttlMs', 15_000, 'number'),
    signatureTtlMs: getConfigValue('performance.recentChatsCache.signatureTtlMs', 2_000, 'number'),
    maxEntries: getConfigValue('performance.recentChatsCache.maxEntries', 300, 'number'),
    maxVariantsPerUser: getConfigValue('performance.recentChatsCache.maxVariantsPerUser', 8, 'number'),
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
const CHAT_REVISION_SUFFIX = '.revision.json';
const chatStorageMutex = new KeyedMutex();

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
function backupChatStrict(directory, name, chat) {
    if (!isBackupEnabled || !fs.existsSync(directory)) {
        return;
    }

    const safeName = sanitize(name).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const backupFile = path.join(directory, `${CHAT_BACKUPS_PREFIX}${safeName}_${generateTimestamp()}.jsonl`);
    writeFileAtomicSync(backupFile, chat, 'utf-8');
    removeOldBackups(directory, `${CHAT_BACKUPS_PREFIX}${safeName}_`);

    if (!isNaN(maxTotalChatBackups) && maxTotalChatBackups >= 0) {
        removeOldBackups(directory, CHAT_BACKUPS_PREFIX, maxTotalChatBackups);
    }
}

const lastTailBackupAt = new Map();

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

function backupTailChat(handle, directory, name, chat) {
    if (!isBackupEnabled) {
        return;
    }
    const key = `${handle}\0${directory}\0${name}`;
    const now = Date.now();
    const lastBackup = lastTailBackupAt.get(key) ?? 0;
    if (throttleInterval > 0 && now - lastBackup < throttleInterval) {
        return;
    }
    backupChatStrict(directory, name, chat);
    lastTailBackupAt.set(key, now);
    while (lastTailBackupAt.size > 2000) {
        lastTailBackupAt.delete(lastTailBackupAt.keys().next().value);
    }
}

function getChatRevisionPath(filePath) {
    return `${filePath}${CHAT_REVISION_SUFFIX}`;
}

function getChatStorageLockKey(request, filePath) {
    const handle = String(request.user?.profile?.handle ?? 'anonymous');
    let canonicalPath = path.normalize(path.resolve(filePath));
    if (process.platform === 'win32') {
        canonicalPath = canonicalPath.toLowerCase();
    }
    return `${handle}\0${canonicalPath}`;
}

function listChatArtifactPaths(filePath) {
    const paths = [
        filePath,
        getChatMetadataPath(filePath),
        getChatIndexPath(filePath),
        getChatRevisionPath(filePath),
    ].filter(candidate => fs.existsSync(candidate));
    const chunkDirectory = getChatChunkDir(filePath);
    if (fs.existsSync(chunkDirectory)) {
        paths.push(...fs.readdirSync(chunkDirectory).sort().map(name => path.join(chunkDirectory, name)));
    }
    return paths;
}

function computeLegacyChatRevision(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    const hash = crypto.createHash('sha256');
    for (const artifactPath of listChatArtifactPaths(filePath).filter(candidate => candidate !== getChatRevisionPath(filePath))) {
        hash.update(path.relative(path.dirname(filePath), artifactPath));
        hash.update('\0');
        hash.update(fs.readFileSync(artifactPath));
        hash.update('\0');
    }
    return `legacy-${hash.digest('hex')}`;
}

function readChatRevision(filePath) {
    const revisionPath = getChatRevisionPath(filePath);
    if (fs.existsSync(revisionPath)) {
        const parsed = tryParse(fs.readFileSync(revisionPath, 'utf8'));
        if (parsed?.version === 1 && typeof parsed.revision === 'string' && parsed.revision.length > 0) {
            return parsed.revision;
        }
        throw new Error(`Invalid chat revision sidecar: ${revisionPath}`);
    }
    return computeLegacyChatRevision(filePath);
}

function writeChatRevision(filePath, revision) {
    if (typeof revision !== 'string' || revision.length === 0) {
        throw new TypeError('Chat revision must be a non-empty string.');
    }
    writeFileAtomicSync(getChatRevisionPath(filePath), JSON.stringify({ version: 1, revision }), 'utf8');
}

function removeChatArtifacts(filePath) {
    for (const artifactPath of [
        filePath,
        getChatMetadataPath(filePath),
        getChatIndexPath(filePath),
        getChatRevisionPath(filePath),
    ]) {
        if (fs.existsSync(artifactPath)) {
            fs.unlinkSync(artifactPath);
        }
    }
    const chunkDirectory = getChatChunkDir(filePath);
    if (fs.existsSync(chunkDirectory)) {
        fs.rmSync(chunkDirectory, { recursive: true, force: true });
    }
}

function linkOrCopyFile(source, destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try {
        fs.linkSync(source, destination);
    } catch {
        fs.copyFileSync(source, destination);
    }
}

function createChatWriteSnapshot(filePath, temporaryRoot) {
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const snapshotDirectory = fs.mkdtempSync(path.join(temporaryRoot, '.chat-write-'));
    const entries = [];
    try {
        for (const [index, artifactPath] of listChatArtifactPaths(filePath).entries()) {
            const snapshotPath = path.join(snapshotDirectory, String(index));
            linkOrCopyFile(artifactPath, snapshotPath);
            entries.push({ artifactPath, snapshotPath });
        }
    } catch (error) {
        fs.rmSync(snapshotDirectory, { recursive: true, force: true });
        throw error;
    }

    let settled = false;
    const cleanup = () => {
        fs.rmSync(snapshotDirectory, { recursive: true, force: true });
    };
    return {
        commit() {
            if (settled) return;
            settled = true;
            cleanup();
        },
        rollback() {
            if (settled) return;
            settled = true;
            removeChatArtifacts(filePath);
            for (const entry of entries) {
                linkOrCopyFile(entry.snapshotPath, entry.artifactPath);
            }
            cleanup();
        },
    };
}

function validateExpectedChatRevision(request, response, filePath) {
    if (!Object.hasOwn(request.body ?? {}, 'expectedRevision')) {
        response.status(428).send({ error: 'revision_required' });
        return null;
    }
    const currentRevision = readChatRevision(filePath);
    const expectedRevision = request.body.expectedRevision;
    if (expectedRevision !== currentRevision) {
        response.status(409).send({
            error: 'revision_conflict',
            currentRevision,
        });
        return null;
    }
    return { currentRevision };
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
    if (!index || typeof index !== 'object') {
        throw new TypeError('Chat index must be an object.');
    }
    writeFileAtomicSync(getChatIndexPath(filePath), JSON.stringify(index), 'utf8');
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

/**
 * Files holding a chat's oldest and newest messages, for sampling its content.
 * @param {string} filePath Chat file
 * @returns {string[]} Paths to read
 */
export function getChatSamplePaths(filePath) {
    if (!isChunkedChat(filePath)) {
        return [filePath];
    }
    const shards = listShardFiles(filePath);
    if (!shards.length) {
        return [filePath];
    }
    const picked = shards.length === 1 ? shards : [shards[0], shards[shards.length - 1]];
    return picked.map(shard => path.join(getChatChunkDir(filePath), shard));
}

/**
 * Size of a chat as one .jsonl file (header + every message), without reading it.
 * @param {string} filePath Chat file
 * @returns {number} Bytes
 */
export function getChatStoredBytes(filePath) {
    const headerBytes = fs.statSync(filePath).size;
    if (!isChunkedChat(filePath)) {
        return headerBytes;
    }
    return headerBytes + getChatTotalBytes(filePath);
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

function buildNonChunkedTailPayload(filePath, header, messages, beforeOffset, fallbackHeader) {
    const existingBuffer = fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.alloc(0);
    const safeOffset = Math.max(0, Math.min(Math.trunc(beforeOffset), existingBuffer.length));
    const prefixLines = existingBuffer.subarray(0, safeOffset).toString('utf8')
        .split('\n')
        .map(line => line.replace(/\r$/, ''));
    const storedHeader = tryParse(prefixLines.shift() || '');
    const prefixMessageLines = prefixLines.filter(Boolean);
    const headerToWrite = header ?? (storedHeader && typeof storedHeader === 'object' ? storedHeader : fallbackHeader);
    const lastMessage = messages[messages.length - 1] ?? tryParse(prefixMessageLines[prefixMessageLines.length - 1] || '');
    updateChatHeaderMetadata(headerToWrite, prefixMessageLines.length + messages.length, lastMessage);
    return {
        header: headerToWrite,
        jsonlData: [
            JSON.stringify(headerToWrite),
            ...prefixMessageLines,
            ...messages.map(item => JSON.stringify(item)),
        ].join('\n'),
    };
}

async function serializeChunkedChatForBackup(filePath, header, isGroup) {
    let messages = await readChunkedChatMessages(filePath);
    if (isGroup) {
        const split = splitGroupChatData(messages);
        messages = split.messages;
    }
    return [header, ...messages].filter(Boolean).map(item => JSON.stringify(item)).join('\n');
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
            const existingPayload = fs.existsSync(shardPath) ? fs.readFileSync(shardPath, 'utf8') : '';
            writeFileAtomicSync(shardPath, `${existingPayload}${payloadToAppend}`, 'utf8');
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
    if (!header || typeof header !== 'object') {
        throw new TypeError('Chat header must be an object.');
    }
    const metadataPath = getChatMetadataPath(filePath);
    writeFileAtomicSync(metadataPath, JSON.stringify(header), 'utf8');
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
    let readBytes = 0;
    let chunksRead = 0;
    const shardRanges = [];
    let offset = 0;
    for (const shard of index.shards) {
        const count = Math.max(0, Number(shard?.count) || 0);
        shardRanges.push({ shard, start: offset, end: offset + count });
        offset += count;
    }

    for (let i = shardRanges.length - 1; i >= 0 && lines.length < limit; i--) {
        const range = shardRanges[i];
        if (range.end <= startIndex) {
            break;
        }
        if (range.start >= endIndex || range.end <= range.start) {
            continue;
        }

        const localStart = Math.max(startIndex, range.start) - range.start;
        const localEnd = Math.min(endIndex, range.end) - range.start;
        const shardPath = path.join(getChatChunkDir(filePath), range.shard.file);
        const shardLines = await readShardLines(shardPath);
        readBytes += Number(range.shard.size) || Buffer.byteLength(shardLines.join('\n'), 'utf8');
        chunksRead++;
        const slice = shardLines.slice(localStart, localEnd);
        lines.unshift(...slice);
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

function isGroupChatHeader(value) {
    return Boolean(
        value
        && typeof value === 'object'
        && !Array.isArray(value)
        && !Object.hasOwn(value, 'name')
        && (Object.hasOwn(value, 'chat_metadata') || (value.user_name && value.character_name)),
    );
}

function splitGroupChatData(chatData) {
    const items = Array.isArray(chatData) ? chatData : [];
    const header = isGroupChatHeader(items[0]) ? items[0] : null;
    return { header, messages: header ? items.slice(1) : items.slice() };
}

async function readGroupChatHeaderInfo(filePath) {
    const storedHeader = await readChatHeader(filePath);
    if (!isChunkedChat(filePath)) {
        return { header: isGroupChatHeader(storedHeader) ? storedHeader : null, embeddedHeaderCount: 0 };
    }

    const firstLines = await readChunkedChatLinesRange(filePath, 0, 1);
    const embeddedHeader = firstLines.length ? tryParse(firstLines[0]) : null;
    const embeddedHeaderCount = isGroupChatHeader(embeddedHeader) ? 1 : 0;
    return {
        header: isGroupChatHeader(storedHeader) ? storedHeader : embeddedHeaderCount ? embeddedHeader : null,
        embeddedHeaderCount,
    };
}

async function checkGroupChatIntegrity(filePath, integritySlug) {
    if (!fs.existsSync(filePath)) return true;
    const { header } = await readGroupChatHeaderInfo(filePath);
    const storedSlug = header?.chat_metadata?.integrity;
    return !storedSlug || storedSlug === integritySlug;
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
        const groupHeaderInfo = isGroup && chunked ? await readGroupChatHeaderInfo(pathToFile) : null;
        const header = /** @type {any} */ (groupHeaderInfo?.header ?? await readChatHeader(pathToFile));
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
                    messageCount = Math.max(0, indexCount - Number(groupHeaderInfo?.embeddedHeaderCount || 0));
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

function getTailStorageMetrics(filePath, header, messages, beforeOffset, defaultHeader) {
    let additionalBytes = 0;
    let payloadBytes = 0;
    if (chatChunkingEnabled) {
        const payload = messages.map(item => JSON.stringify(item)).join('\n');
        payloadBytes = Buffer.byteLength(payload, 'utf8');
        const oldSize = fs.existsSync(filePath) ? getChatTotalBytes(filePath) : 0;
        additionalBytes = !fs.existsSync(filePath) || beforeOffset <= 0
            ? Math.max(0, payloadBytes - oldSize)
            : Math.max(0, payloadBytes);
    } else if (!fs.existsSync(filePath) || beforeOffset <= 0) {
        const headerToWrite = header ?? defaultHeader;
        updateChatHeaderMetadata(headerToWrite, messages.length, messages[messages.length - 1]);
        const jsonlData = [JSON.stringify(headerToWrite), ...messages.map(item => JSON.stringify(item))].join('\n');
        payloadBytes = Buffer.byteLength(jsonlData, 'utf8');
        const oldSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        additionalBytes = Math.max(0, payloadBytes - oldSize);
    } else {
        const oldSize = fs.statSync(filePath).size;
        const payload = buildNonChunkedTailPayload(filePath, structuredClone(header), messages, beforeOffset, structuredClone(defaultHeader));
        payloadBytes = Buffer.byteLength(payload.jsonlData, 'utf8');
        additionalBytes = Math.max(0, payloadBytes - oldSize);
    }
    return { additionalBytes, payloadBytes };
}

async function persistChatTail({
    request,
    response,
    filePath,
    header,
    messages,
    beforeOffset,
    defaultHeader,
    isGroup,
    backupName,
    performanceTimer,
}) {
    const revisionCheck = validateExpectedChatRevision(request, response, filePath);
    if (!revisionCheck) {
        return null;
    }

    const { additionalBytes, payloadBytes } = getTailStorageMetrics(
        filePath,
        structuredClone(header),
        messages,
        beforeOffset,
        structuredClone(defaultHeader),
    );
    performanceTimer.setCounter('payload-bytes', payloadBytes);
    performanceTimer.setCounter('storage-growth-bytes', additionalBytes);
    const storageError = await ensureChatStorageCapacity(request, response, additionalBytes);
    if (storageError) {
        return null;
    }

    if (checkIntegrity && !request.body.force) {
        const integritySlug = header?.chat_metadata?.integrity;
        const isIntact = isGroup
            ? !integritySlug || await checkGroupChatIntegrity(filePath, integritySlug)
            : !integritySlug || await checkChatIntegrity(filePath, integritySlug);
        if (!isIntact) {
            console.error(`Chat integrity check failed for ${filePath}`);
            response.status(400).send({ error: 'integrity' });
            return null;
        }
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const snapshot = createChatWriteSnapshot(filePath, request.user.directories.root);
    try {
        let embeddedHeaderCount = 0;
        let persistedHeader = header ?? structuredClone(defaultHeader);
        let backupPayload = '';
        let messageCount = messages.length;
        let totalBytes = 0;
        let lastMessage = messages[messages.length - 1] ?? null;

        if (chatChunkingEnabled) {
            let updatedIndex;
            if (!fs.existsSync(filePath) || beforeOffset <= 0) {
                updateChatHeaderMetadata(persistedHeader, messages.length, lastMessage);
                updatedIndex = await writeChunkedChat(filePath, persistedHeader, messages);
            } else {
                if (!isChunkedChat(filePath)) {
                    await convertLegacyChatToChunks(filePath);
                }

                const headerInfo = isGroup ? await readGroupChatHeaderInfo(filePath) : null;
                embeddedHeaderCount = Number(headerInfo?.embeddedHeaderCount || 0);
                persistedHeader = header ?? headerInfo?.header ?? await readChatHeader(filePath) ?? structuredClone(defaultHeader);
                const index = await ensureChatIndex(filePath);
                const totalMessages = Number(index?.message_count) || 0;
                const beforeIndex = Math.max(0, Math.min(beforeOffset, totalMessages));
                const existingTailCount = Math.max(0, totalMessages - beforeIndex);
                const compareLimit = Math.max(1, Number.isFinite(chatTailCompareLimit) ? chatTailCompareLimit : getChatChunkSize());
                let appendOnly = false;

                if (existingTailCount <= compareLimit && existingTailCount <= messages.length) {
                    const existingLines = await readChunkedChatLinesRange(filePath, beforeIndex, existingTailCount);
                    appendOnly = existingLines.length === existingTailCount && existingLines.every((line, index) => {
                        const incoming = messages[index];
                        if (!incoming) return false;
                        if (line === JSON.stringify(incoming)) return true;
                        const existingObject = tryParse(line);
                        return existingObject ? _.isEqual(existingObject, incoming) : false;
                    });
                }

                updatedIndex = index;
                if (!appendOnly) {
                    updatedIndex = await truncateChunkedChat(filePath, index, beforeIndex);
                    updatedIndex = await appendChunkedMessages(filePath, updatedIndex, messages);
                } else {
                    updatedIndex = await appendChunkedMessages(filePath, updatedIndex, messages.slice(existingTailCount));
                }
            }

            messageCount = Math.max(0, Number(updatedIndex?.message_count || 0) - embeddedHeaderCount);
            totalBytes = Number(updatedIndex?.total_bytes || 0);
            lastMessage ??= {
                send_date: updatedIndex?.last_mes,
                mes: updatedIndex?.last_message,
            };
            updateChatHeaderMetadata(persistedHeader, messageCount, lastMessage);
            writeFileAtomicSync(filePath, JSON.stringify(persistedHeader), 'utf8');
            writeChatHeader(filePath, persistedHeader);
            backupPayload = await serializeChunkedChatForBackup(filePath, persistedHeader, isGroup);
        } else {
            let payload;
            if (!fs.existsSync(filePath) || beforeOffset <= 0) {
                updateChatHeaderMetadata(persistedHeader, messages.length, lastMessage);
                payload = {
                    header: persistedHeader,
                    jsonlData: [JSON.stringify(persistedHeader), ...messages.map(item => JSON.stringify(item))].join('\n'),
                };
            } else {
                payload = buildNonChunkedTailPayload(filePath, persistedHeader, messages, beforeOffset, structuredClone(defaultHeader));
                persistedHeader = payload.header;
            }
            writeFileAtomicSync(filePath, payload.jsonlData, 'utf8');
            writeChatHeader(filePath, persistedHeader);
            backupPayload = payload.jsonlData;
            totalBytes = Buffer.byteLength(payload.jsonlData, 'utf8');
            messageCount = Number(persistedHeader.chat_metadata?.message_count) || 0;
            lastMessage = messages[messages.length - 1] ?? null;
        }

        const revision = crypto.randomUUID();
        writeChatRevision(filePath, revision);
        backupTailChat(request.user.profile.handle, request.user.directories.backups, backupName, backupPayload);

        const stats = fs.statSync(filePath);
        setCachedChatInfo(filePath, stats, {
            file_id: path.parse(filePath).name,
            file_name: path.parse(filePath).base,
            file_size: `${(totalBytes / 1024).toFixed(2)}kb`,
            chat_items: messageCount,
            mes: typeof lastMessage?.mes === 'string' ? lastMessage.mes : '[The message is empty]',
            last_mes: parseSendDate(lastMessage?.send_date, stats.mtimeMs),
            chat_metadata: persistedHeader.chat_metadata,
        }, true);
        invalidateCharacterListCache(request.user.profile.handle);
        invalidateRecentChatsCache(request.user.profile.handle);

        if (!isGroup && lastMessage) {
            systemMonitor.recordUserChatActivity(
                request.user.profile.handle,
                lastMessage.is_user ? 'user' : 'character',
                {
                    userName: request.user.profile.name,
                    characterName: backupName,
                },
            );
        }

        snapshot.commit();
        return { revision };
    } catch (error) {
        try {
            snapshot.rollback();
        } catch (rollbackError) {
            const combinedError = new Error('Chat tail save and rollback both failed.', { cause: error });
            combinedError.rollbackError = rollbackError;
            throw combinedError;
        }
        throw error;
    }
}

async function persistFullChat({ request, response, filePath, header, messages, isGroup, backupName }) {
    updateChatHeaderMetadata(header, messages.length, messages[messages.length - 1]);
    const jsonlData = [header, ...messages].map(item => JSON.stringify(item)).join('\n');
    const newSize = chatChunkingEnabled
        ? Buffer.byteLength(messages.map(item => JSON.stringify(item)).join('\n'), 'utf8')
        : Buffer.byteLength(jsonlData, 'utf8');
    const oldSize = fs.existsSync(filePath)
        ? (chatChunkingEnabled ? getChatTotalBytes(filePath) : fs.statSync(filePath).size)
        : 0;
    const storageError = await ensureChatStorageCapacity(request, response, Math.max(0, newSize - oldSize));
    if (storageError) {
        return null;
    }

    if (checkIntegrity && !request.body.force) {
        const integritySlug = header?.chat_metadata?.integrity;
        const isIntact = isGroup
            ? !integritySlug || await checkGroupChatIntegrity(filePath, integritySlug)
            : await checkChatIntegrity(filePath, integritySlug);
        if (!isIntact) {
            console.error(`Chat integrity check failed for ${filePath}`);
            response.status(400).send({ error: 'integrity' });
            return null;
        }
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const snapshot = createChatWriteSnapshot(filePath, request.user.directories.root);
    try {
        if (chatChunkingEnabled) {
            await writeChunkedChat(filePath, header, messages);
        } else {
            writeFileAtomicSync(filePath, jsonlData, 'utf8');
            writeChatHeader(filePath, header);
        }
        const revision = crypto.randomUUID();
        writeChatRevision(filePath, revision);
        backupTailChat(request.user.profile.handle, request.user.directories.backups, backupName, jsonlData);

        const stats = fs.statSync(filePath);
        const index = chatChunkingEnabled ? readChatIndex(filePath) : null;
        const totalBytes = Number(index?.total_bytes);
        const lastMessage = messages[messages.length - 1] || {};
        setCachedChatInfo(filePath, stats, {
            file_id: path.parse(filePath).name,
            file_name: path.parse(filePath).base,
            file_size: Number.isFinite(totalBytes)
                ? `${(totalBytes / 1024).toFixed(2)}kb`
                : `${(stats.size / 1024).toFixed(2)}kb`,
            chat_items: messages.length,
            mes: typeof lastMessage.mes === 'string' ? lastMessage.mes : '[The message is empty]',
            last_mes: parseSendDate(lastMessage.send_date, stats.mtimeMs),
            chat_metadata: header.chat_metadata,
        }, true);
        invalidateCharacterListCache(request.user.profile.handle);
        invalidateRecentChatsCache(request.user.profile.handle);
        if (!isGroup && lastMessage) {
            systemMonitor.recordUserChatActivity(
                request.user.profile.handle,
                lastMessage.is_user ? 'user' : 'character',
                {
                    userName: request.user.profile.name,
                    characterName: backupName,
                },
            );
        }
        snapshot.commit();
        return { revision };
    } catch (error) {
        try {
            snapshot.rollback();
        } catch (rollbackError) {
            const combinedError = new Error('Chat save and rollback both failed.', { cause: error });
            combinedError.rollbackError = rollbackError;
            throw combinedError;
        }
        throw error;
    }
}

router.post('/save', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body?.file_name || !Array.isArray(request.body.chat) || !request.body.chat.length) {
            return response.sendStatus(400);
        }
        const directoryName = String(request.body.avatar_url).replace('.png', '');
        const chatData = request.body.chat;
        const header = chatData[0] && typeof chatData[0] === 'object' ? /** @type {any} */ (chatData[0]) : null;
        if (!header) {
            return response.sendStatus(400);
        }
        const messages = chatData.slice(1);
        const fileName = `${String(request.body.file_name)}.jsonl`;
        const filePath = path.join(request.user.directories.chats, directoryName, sanitize(fileName));
        if (!isPathUnderParent(request.user.directories.chats, filePath)) {
            return response.sendStatus(400);
        }
        return await chatStorageMutex.runExclusive(getChatStorageLockKey(request, filePath), async () => {
            const result = await persistFullChat({
                request,
                response,
                filePath,
                header,
                messages,
                isGroup: false,
                backupName: directoryName,
            });
            return result ? response.send({ result: 'ok', revision: result.revision }) : response;
        });
    } catch (error) {
        console.error(error);
        return response.status(500).send({ error: 'chat_save_failed' });
    }
});

router.post('/save-tail', validateAvatarUrlMiddleware, async function (request, response) {
    const performanceTimer = beginEndpointPerformance(request, 'chat-save-tail');
    performanceTimer.setCacheState('bypass');
    const stopWriteTimer = performanceTimer.startPhase('write');
    let responsePrepared = false;
    const prepareResponse = () => {
        if (responsePrepared) return;
        responsePrepared = true;
        stopWriteTimer();
        performanceTimer.startPhase('serialize');
    };
    try {
        if (!chatPagingProtocolEnabled) {
            prepareResponse();
            return response.status(404).send({ error: 'chat_paging_disabled' });
        }
        if (!request.body || !request.body.file_name || !Array.isArray(request.body.messages)) {
            prepareResponse();
            return response.sendStatus(400);
        }
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
        const messages = request.body.messages;
        let beforeOffset = Number.isFinite(request.body.before) ? request.body.before : Number(request.body.before ?? 0);
        if (!Number.isFinite(beforeOffset)) {
            beforeOffset = 0;
        }
        performanceTimer.setCounter('messages', messages.length);
        performanceTimer.setCounter('cursor', beforeOffset);
        performanceTimer.setCounter('chunked', Number(chatChunkingEnabled));
        performanceTimer.setCounter('chunks', chatChunkingEnabled && messages.length ? Math.ceil(messages.length / getChatChunkSize()) : Number(messages.length > 0));
        const defaultHeader = {
            user_name: request.user.profile?.name ?? 'User',
            character_name: String(request.body.ch_name ?? directoryName),
            create_date: humanizedISO8601DateTime(),
            chat_metadata: {},
        };
        return await chatStorageMutex.runExclusive(getChatStorageLockKey(request, filePath), async () => {
            const result = await persistChatTail({
                request,
                response,
                filePath,
                header,
                messages,
                beforeOffset,
                defaultHeader,
                isGroup: false,
                backupName: directoryName,
                performanceTimer,
            });
            prepareResponse();
            return result ? response.send({ result: 'ok', revision: result.revision }) : response;
        });
    } catch (error) {
        console.error(error);
        prepareResponse();
        return response.status(500).send({ error: 'chat_tail_save_failed' });
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
        if (!chatPagingProtocolEnabled) {
            performanceTimer.startPhase('serialize');
            return response.status(404).send({ error: 'chat_paging_disabled' });
        }
        const dirName = String(request.body.avatar_url).replace('.png', '');
        const directoryPath = path.join(request.user.directories.chats, dirName);
        if (!isPathUnderParent(request.user.directories.chats, directoryPath)) {
            return response.sendStatus(400);
        }

        if (!request.body.file_name) {
            performanceTimer.startPhase('serialize');
            return response.send({ header: null, messages: [], cursor: 0, hasMore: false, revision: null });
        }

        const fileName = `${String(request.body.file_name)}.jsonl`;
        const filePath = path.join(directoryPath, sanitize(fileName));
        const chatFileExists = fs.existsSync(filePath);

        if (!chatFileExists) {
            performanceTimer.startPhase('serialize');
            return response.send({ header: null, messages: [], cursor: 0, hasMore: false, revision: null });
        }

        return await chatStorageMutex.runExclusive(getChatStorageLockKey(request, filePath), async () => {
            const limit = Math.max(1, Math.min(Number(request.body.limit ?? 20), CHAT_RANGE_LIMIT_MAX));
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
            const revision = readChatRevision(filePath);
            performanceTimer.setCounter('messages', messages.length);
            performanceTimer.setCounter('read-bytes', tail.readBytes);
            performanceTimer.setCounter('chunks', tail.chunksRead);
            performanceTimer.setCounter('next-cursor', cursor);
            performanceTimer.startPhase('serialize');
            return response.send({ header, messages, cursor, hasMore, revision });
        });
    } catch (error) {
        console.error(error);
        performanceTimer.startPhase('serialize');
        return response.status(500).send({ header: null, messages: [], cursor: 0, hasMore: false, revision: null });
    }
});

// ---------------------------------------------------------------------------
// Chat hydration: lets the client hold the whole chat (every message, correct
// indices) without downloading the bulky fields of old messages. Old messages
// arrive as a "light" copy plus a list of omitted fields (path + content hash);
// omitted fields are fetched on demand, and saves send only what changed.
// Requires chunked storage; without it the client keeps the paged behaviour.
// ---------------------------------------------------------------------------

/** Values up to this many JSON characters are always sent with the light copy. */
const HYDRATION_LIGHT_CHARS = 2048;
/** Light characters per hydration page, and a raw-read cap so huge chats stay bounded. */
const HYDRATION_PAGE_LIGHT_CHARS = 3 * 1024 * 1024;
const HYDRATION_PAGE_RAW_CHARS = 48 * 1024 * 1024;
const HYDRATION_PAGE_MAX_MESSAGES = 2000;
const HYDRATION_FIELDS_MAX_ITEMS = 1000;
/** Media keys stay inline: the client migrates them as soon as a message is loaded. */
const HYDRATION_INLINE_EXTRA_KEYS = new Set(['media', 'files', 'file', 'image', 'video', 'image_swipes', 'media_display', 'media_index', 'type']);
const HYDRATION_FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class HydrationUnsupportedError extends Error {}

function hashHydrationValue(json) {
    return crypto.createHash('sha1').update(json).digest('base64url').slice(0, 22);
}

function isHeaderLikeLine(value) {
    return Boolean(value?.user_name && value?.character_name && !value?.name) || isGroupChatHeader(value);
}

/**
 * Splits a stored message into the copy sent eagerly and the specs of omitted fields.
 * @param {object} message Parsed message
 * @returns {{item: any[], lightChars: number}}
 */
function splitMessageForHydration(message) {
    const light = {};
    const lazy = [];
    let lightChars = 2;
    for (const [key, value] of Object.entries(message)) {
        const json = JSON.stringify(value);
        if (json === undefined) {
            continue;
        }
        if (key === 'mes' || json.length <= HYDRATION_LIGHT_CHARS) {
            light[key] = value;
            lightChars += key.length + json.length + 4;
            continue;
        }
        if (key === 'extra' && isPlainObject(value)) {
            const lightExtra = {};
            for (const [subKey, subValue] of Object.entries(value)) {
                const subJson = JSON.stringify(subValue);
                if (subJson === undefined) {
                    continue;
                }
                if (HYDRATION_INLINE_EXTRA_KEYS.has(subKey) || subJson.length <= HYDRATION_LIGHT_CHARS) {
                    lightExtra[subKey] = subValue;
                    lightChars += subKey.length + subJson.length + 4;
                } else {
                    lazy.push([['extra', subKey], hashHydrationValue(subJson), subJson.length]);
                }
            }
            light.extra = lightExtra;
            lightChars += 12;
            continue;
        }
        lazy.push([[key], hashHydrationValue(json), json.length]);
    }
    if (!lazy.length) {
        return { item: [light], lightChars };
    }
    // Original key order, so omitted fields keep their place on the client.
    const order = [Object.keys(message)];
    if (isPlainObject(message.extra) && lazy.some(spec => spec[0].length === 2)) {
        order.push(Object.keys(message.extra));
    }
    return { item: [light, lazy, order], lightChars };
}

function getChatShardRanges(index) {
    const ranges = [];
    let offset = 0;
    for (const shard of index?.shards ?? []) {
        const count = Math.max(0, Number(shard?.count) || 0);
        ranges.push({ shard, start: offset, end: offset + count });
        offset += count;
    }
    return ranges;
}

/**
 * Number of leading header lines inside the chunk files (0 or 1).
 * @param {string} filePath Chat file
 * @param {boolean} isGroup Group chat
 * @returns {Promise<number>}
 */
async function getHydrationBaseLine(filePath, isGroup) {
    if (isGroup) {
        return Number((await readGroupChatHeaderInfo(filePath)).embeddedHeaderCount) || 0;
    }
    const firstLines = await readChunkedChatLinesRange(filePath, 0, 1);
    return firstLines.length && isHeaderLikeLine(tryParse(firstLines[0])) ? 1 : 0;
}

/**
 * Reads specific chunk lines, touching only the shards that hold them.
 * @param {string} filePath Chat file
 * @param {object} index Chunk index
 * @param {Iterable<number>} lineNumbers Line numbers to read
 * @returns {Promise<Map<number, string>>}
 */
async function readChunkLinesByNumber(filePath, index, lineNumbers) {
    const wanted = [...new Set(lineNumbers)].sort((a, b) => a - b);
    const result = new Map();
    if (!wanted.length) {
        return result;
    }
    let cursor = 0;
    for (const range of getChatShardRanges(index)) {
        if (cursor >= wanted.length) {
            break;
        }
        if (wanted[cursor] >= range.end) {
            continue;
        }
        const lines = await readShardLines(path.join(getChatChunkDir(filePath), range.shard.file));
        while (cursor < wanted.length && wanted[cursor] < range.end) {
            const line = lines[wanted[cursor] - range.start];
            if (line !== undefined) {
                result.set(wanted[cursor], line);
            }
            cursor++;
        }
    }
    return result;
}

/**
 * Prepares a chunked chat for hydration requests.
 * @returns {Promise<{index: object, baseLine: number, total: number}>}
 */
async function openHydrationChat(filePath, isGroup) {
    if (!chatChunkingEnabled) {
        throw new HydrationUnsupportedError('chunking_disabled');
    }
    if (!isChunkedChat(filePath)) {
        await convertLegacyChatToChunks(filePath);
    }
    const index = await ensureChatIndex(filePath);
    if (!index || !Array.isArray(index.shards)) {
        throw new HydrationUnsupportedError('no_index');
    }
    const baseLine = await getHydrationBaseLine(filePath, isGroup);
    const total = Math.max(0, (Number(index.message_count) || 0) - baseLine);
    return { index, baseLine, total };
}

function resolveHydrationChatPath(request, isGroup) {
    if (isGroup) {
        const id = String(request.body?.id ?? '');
        if (!id) return null;
        const filePath = path.join(request.user.directories.groupChats, `${id}.jsonl`);
        return isPathUnderParent(request.user.directories.groupChats, filePath) ? filePath : null;
    }
    if (!request.body?.file_name) return null;
    const directoryName = String(request.body.avatar_url).replace('.png', '');
    const filePath = path.join(request.user.directories.chats, directoryName, sanitize(`${String(request.body.file_name)}.jsonl`));
    return isPathUnderParent(request.user.directories.chats, filePath) ? filePath : null;
}

function isValidHydrationPath(value) {
    return Array.isArray(value)
        && value.length >= 1
        && value.length <= 4
        && value.every(part => typeof part === 'string' && part.length > 0 && !HYDRATION_FORBIDDEN_KEYS.has(part));
}

function getValueAtPath(object, valuePath) {
    let current = object;
    for (const part of valuePath) {
        if (!isPlainObject(current) || !Object.hasOwn(current, part)) {
            return undefined;
        }
        current = current[part];
    }
    return current;
}

function applyHydrationOp(message, op) {
    const valuePath = op?.p;
    if (!isValidHydrationPath(valuePath)) {
        throw new HydrationUnsupportedError('invalid_op');
    }
    let parent = message;
    for (const part of valuePath.slice(0, -1)) {
        if (!isPlainObject(parent[part])) {
            if (op.d) return;
            parent[part] = {};
        }
        parent = parent[part];
    }
    const key = valuePath[valuePath.length - 1];
    if (op.d) {
        delete parent[key];
    } else if (Object.hasOwn(op, 'v')) {
        parent[key] = op.v;
    } else {
        throw new HydrationUnsupportedError('invalid_op');
    }
}

function sendHydrationError(response, error, fallbackCode) {
    if (error instanceof HydrationUnsupportedError) {
        return response.status(422).send({ error: 'hydration_unsupported', reason: error.message });
    }
    console.error(fallbackCode, error);
    return response.status(500).send({ error: fallbackCode });
}

async function handleHydratePage(request, response, isGroup) {
    const filePath = resolveHydrationChatPath(request, isGroup);
    if (!filePath) return response.sendStatus(400);
    if (!fs.existsSync(filePath)) {
        return response.send({ revision: null, total: 0, start: 0, items: [] });
    }
    try {
        return await chatStorageMutex.runExclusive(getChatStorageLockKey(request, filePath), async () => {
            const { index, baseLine, total } = await openHydrationChat(filePath, isGroup);
            // The first page is addressed by the chunk line where the loaded page starts.
            const requestedBefore = Number.isInteger(request.body?.beforeLine)
                ? request.body.beforeLine - baseLine
                : Number(request.body?.before);
            const before = Number.isInteger(requestedBefore) ? Math.max(0, Math.min(requestedBefore, total)) : total;
            const endLine = baseLine + before;
            const collected = [];
            let lightChars = 0;
            let rawChars = 0;
            const ranges = getChatShardRanges(index);
            outer: for (let shardIndex = ranges.length - 1; shardIndex >= 0; shardIndex--) {
                const range = ranges[shardIndex];
                if (range.start >= endLine) continue;
                if (range.end <= baseLine) break;
                const lines = await readShardLines(path.join(getChatChunkDir(filePath), range.shard.file));
                for (let line = Math.min(range.end, endLine) - 1; line >= Math.max(range.start, baseLine); line--) {
                    const text = lines[line - range.start];
                    const message = text === undefined ? null : tryParse(text);
                    if (!isPlainObject(message) || isHeaderLikeLine(message)) {
                        throw new HydrationUnsupportedError('unexpected_line');
                    }
                    const split = splitMessageForHydration(message);
                    collected.push(split.item);
                    lightChars += split.lightChars;
                    rawChars += text.length;
                    if (collected.length >= HYDRATION_PAGE_MAX_MESSAGES
                        || lightChars >= HYDRATION_PAGE_LIGHT_CHARS
                        || rawChars >= HYDRATION_PAGE_RAW_CHARS) {
                        break outer;
                    }
                }
            }
            collected.reverse();
            return response.send({
                revision: readChatRevision(filePath),
                total,
                start: before - collected.length,
                items: collected,
            });
        });
    } catch (error) {
        return sendHydrationError(response, error, 'chat_hydrate_page_failed');
    }
}

async function handleHydrateFields(request, response, isGroup) {
    const filePath = resolveHydrationChatPath(request, isGroup);
    const items = request.body?.items;
    if (!filePath || !Array.isArray(items) || items.length === 0 || items.length > HYDRATION_FIELDS_MAX_ITEMS) {
        return response.sendStatus(400);
    }
    if (!fs.existsSync(filePath)) {
        return response.send({ values: items.map(() => null) });
    }
    try {
        return await chatStorageMutex.runExclusive(getChatStorageLockKey(request, filePath), async () => {
            const { index, baseLine, total } = await openHydrationChat(filePath, isGroup);
            const candidatesFor = (item) => [item?.[0], item?.[3]]
                .filter(candidate => Number.isInteger(candidate) && candidate >= 0 && candidate < total);
            const lineNumbers = items.flatMap(item => candidatesFor(item).map(candidate => baseLine + candidate));
            const lines = await readChunkLinesByNumber(filePath, index, lineNumbers);
            const parsed = new Map();
            const values = items.map((item) => {
                const valuePath = item?.[1];
                const hash = item?.[2];
                if (!isValidHydrationPath(valuePath) || typeof hash !== 'string') {
                    return null;
                }
                for (const candidate of candidatesFor(item)) {
                    const lineNumber = baseLine + candidate;
                    if (!parsed.has(lineNumber)) {
                        parsed.set(lineNumber, tryParse(lines.get(lineNumber) ?? ''));
                    }
                    const value = getValueAtPath(parsed.get(lineNumber), valuePath);
                    if (value === undefined) continue;
                    const json = JSON.stringify(value);
                    if (json !== undefined && hashHydrationValue(json) === hash) {
                        return json;
                    }
                }
                return null;
            });
            return response.send({ values });
        });
    } catch (error) {
        return sendHydrationError(response, error, 'chat_hydrate_fields_failed');
    }
}

/**
 * Patch items: {r: [a, b]} keeps stored messages a..b, {p: a, o: ops} keeps
 * message a with field changes, {m: message} writes a message as sent.
 */
function collectPatchReferences(items, total) {
    const references = [];
    for (const item of items) {
        if (!isPlainObject(item)) throw new HydrationUnsupportedError('invalid_item');
        if (Array.isArray(item.r)) {
            const [first, last] = item.r;
            if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last >= total) {
                throw new HydrationUnsupportedError('invalid_reference');
            }
            for (let i = first; i <= last; i++) references.push(i);
        } else if (Object.hasOwn(item, 'p')) {
            if (!Number.isInteger(item.p) || item.p < 0 || item.p >= total || !Array.isArray(item.o)) {
                throw new HydrationUnsupportedError('invalid_reference');
            }
            references.push(item.p);
        } else if (!isPlainObject(item.m)) {
            throw new HydrationUnsupportedError('invalid_item');
        }
    }
    return references;
}

async function handleSavePatch(request, response, isGroup, performanceTimer) {
    const filePath = resolveHydrationChatPath(request, isGroup);
    const from = request.body?.from;
    const items = request.body?.items;
    if (!filePath || !Number.isInteger(from) || from < 0 || !Array.isArray(items)) {
        return response.sendStatus(400);
    }
    if (!fs.existsSync(filePath)) {
        return response.status(409).send({ error: 'revision_conflict', currentRevision: null });
    }
    const header = isPlainObject(request.body.header) ? request.body.header : null;
    const backupName = isGroup ? String(request.body.id) : String(request.body.avatar_url).replace('.png', '');
    const defaultHeader = isGroup
        ? { chat_metadata: {}, user_name: 'unused', character_name: 'unused' }
        : {
            user_name: request.user.profile?.name ?? 'User',
            character_name: String(request.body.ch_name ?? backupName),
            create_date: humanizedISO8601DateTime(),
            chat_metadata: {},
        };
    try {
        return await chatStorageMutex.runExclusive(getChatStorageLockKey(request, filePath), async () => {
            if (!validateExpectedChatRevision(request, response, filePath)) {
                return response;
            }
            const { index, baseLine, total } = await openHydrationChat(filePath, isGroup);
            if (from > total) {
                throw new HydrationUnsupportedError('invalid_from');
            }
            const references = collectPatchReferences(items, total);
            const lines = await readChunkLinesByNumber(filePath, index, references.map(i => baseLine + i));
            const readStored = (messageIndex) => {
                const message = tryParse(lines.get(baseLine + messageIndex) ?? '');
                if (!isPlainObject(message)) {
                    throw new HydrationUnsupportedError('missing_reference');
                }
                return message;
            };
            const messages = [];
            for (const item of items) {
                if (Array.isArray(item.r)) {
                    for (let i = item.r[0]; i <= item.r[1]; i++) messages.push(readStored(i));
                } else if (Object.hasOwn(item, 'p')) {
                    const message = readStored(item.p);
                    for (const op of item.o) applyHydrationOp(message, op);
                    messages.push(message);
                } else {
                    messages.push(item.m);
                }
            }
            performanceTimer.setCounter('messages', messages.length);
            performanceTimer.setCounter('cursor', from);
            const result = await persistChatTail({
                request,
                response,
                filePath,
                header,
                messages,
                beforeOffset: baseLine + from,
                defaultHeader,
                isGroup,
                backupName,
                performanceTimer,
            });
            return result ? response.send({ result: 'ok', revision: result.revision }) : response;
        });
    } catch (error) {
        return sendHydrationError(response, error, 'chat_save_patch_failed');
    }
}

/**
 * Copies the first `count` messages of a chat into a new chat file, on the
 * server, so branches of huge chats never pass through the browser.
 */
async function handleCopyPrefix(request, response, isGroup) {
    const sourcePath = resolveHydrationChatPath(request, isGroup);
    const count = request.body?.count;
    const header = isPlainObject(request.body?.header) ? request.body.header : null;
    if (!sourcePath || !Number.isInteger(count) || count < 0 || !header) {
        return response.sendStatus(400);
    }
    const targetName = String(request.body?.target ?? '');
    const targetPath = isGroup
        ? path.join(request.user.directories.groupChats, `${targetName}.jsonl`)
        : path.join(path.dirname(sourcePath), sanitize(`${targetName}.jsonl`));
    const targetParent = isGroup ? request.user.directories.groupChats : request.user.directories.chats;
    if (!targetName || !isPathUnderParent(targetParent, targetPath) || toPathKey(targetPath) === toPathKey(sourcePath)) {
        return response.sendStatus(400);
    }
    if (!fs.existsSync(sourcePath)) {
        return response.sendStatus(404);
    }
    if (fs.existsSync(targetPath)) {
        return response.status(409).send({ error: 'target_exists' });
    }
    try {
        const messages = await chatStorageMutex.runExclusive(getChatStorageLockKey(request, sourcePath), async () => {
            const { baseLine, total } = await openHydrationChat(sourcePath, isGroup);
            const lines = await readChunkedChatLinesRange(sourcePath, baseLine, Math.min(count, total));
            return lines.map(line => tryParse(line)).filter(message => isPlainObject(message) && !isHeaderLikeLine(message));
        });
        const backupName = isGroup ? targetName : String(request.body.avatar_url).replace('.png', '');
        return await chatStorageMutex.runExclusive(getChatStorageLockKey(request, targetPath), async () => {
            if (fs.existsSync(targetPath)) {
                return response.status(409).send({ error: 'target_exists' });
            }
            const result = await persistFullChat({ request, response, filePath: targetPath, header, messages, isGroup, backupName });
            return result ? response.send({ result: 'ok', revision: result.revision, count: messages.length }) : response;
        });
    } catch (error) {
        return sendHydrationError(response, error, 'chat_copy_prefix_failed');
    }
}

function createSavePatchRoute(isGroup) {
    return async function (request, response) {
        const performanceTimer = beginEndpointPerformance(request, isGroup ? 'group-chat-save-patch' : 'chat-save-patch');
        performanceTimer.setCacheState('bypass');
        const stopWriteTimer = performanceTimer.startPhase('write');
        try {
            return await handleSavePatch(request, response, isGroup, performanceTimer);
        } finally {
            stopWriteTimer();
        }
    };
}

router.post('/hydrate-page', validateAvatarUrlMiddleware, (request, response) => handleHydratePage(request, response, false));
router.post('/hydrate-fields', validateAvatarUrlMiddleware, (request, response) => handleHydrateFields(request, response, false));
router.post('/save-patch', validateAvatarUrlMiddleware, createSavePatchRoute(false));
router.post('/copy-prefix', validateAvatarUrlMiddleware, (request, response) => handleCopyPrefix(request, response, false));
router.post('/group/hydrate-page', (request, response) => handleHydratePage(request, response, true));
router.post('/group/hydrate-fields', (request, response) => handleHydrateFields(request, response, true));
router.post('/group/save-patch', createSavePatchRoute(true));
router.post('/group/copy-prefix', (request, response) => handleCopyPrefix(request, response, true));

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
        const revisionOriginal = getChatRevisionPath(pathToOriginalFile);
        const revisionRenamed = getChatRevisionPath(pathToRenamedFile);
        if (fs.existsSync(revisionOriginal)) {
            fs.copyFileSync(revisionOriginal, revisionRenamed);
            fs.unlinkSync(revisionOriginal);
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
        const revisionPath = getChatRevisionPath(filePath);
        if (fs.existsSync(revisionPath)) {
            fs.unlinkSync(revisionPath);
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

//************************** CHAT TRANSFER (bulk export / archive restore) **************************//

const CHAT_TRANSFER_LIMITS = Object.freeze({
    maxExportTargets: 5000,
    maxChatPartBytes: 256 * 1024 * 1024,
    maxChatBytes: 512 * 1024 * 1024,
    maxSidecarBytes: 16 * 1024 * 1024,
    maxGroupBytes: 4 * 1024 * 1024,
    maxCardBytes: 64 * 1024 * 1024,
    maxTotalReadBytes: 4 * 1024 * 1024 * 1024,
    maxCompressionRatio: 200,
    maxRenameAttempts: 100,
    maxReportedMissingCharacters: 50,
});

const ARCHIVE_ROOT_MARKERS = Object.freeze(['chats', 'group chats', 'groups', 'characters']);
const CHAT_ARCHIVE_PATTERNS = Object.freeze([
    ['characterChat', /^chats\/([^/]+)\/([^/]+\.jsonl)$/],
    ['characterSidecar', /^chats\/([^/]+)\/([^/]+\.jsonl)\.metadata\.json$/],
    ['characterShard', /^chats\/([^/]+)\/([^/]+\.jsonl)\.chunks\/([^/]+\.jsonl)$/],
    ['groupChat', /^group chats\/()([^/]+\.jsonl)$/],
    ['groupSidecar', /^group chats\/()([^/]+\.jsonl)\.metadata\.json$/],
    ['groupShard', /^group chats\/()([^/]+\.jsonl)\.chunks\/([^/]+\.jsonl)$/],
    ['group', /^groups\/([^/]+\.json)$/],
    ['character', /^characters\/([^/]+\.png)$/],
]);

const ARCHIVE_ERROR_MESSAGES = Object.freeze({
    invalid_archive: '文件不是有效的 ZIP 压缩包，或压缩包已损坏',
    archive_entry_limit_exceeded: '压缩包内文件数量过多',
    archive_entry_too_large: '压缩包中有单个文件过大',
    archive_size_limit_exceeded: '压缩包解压后的数据过大',
    archive_compression_ratio_exceeded: '压缩包中存在异常的高压缩比文件',
});

class ChatTransferError extends Error {
    /**
     * @param {number} status HTTP status
     * @param {string} code Stable error code
     * @param {string} message User-facing message
     */
    constructor(status, code, message) {
        super(message);
        this.name = 'ChatTransferError';
        this.status = status;
        this.code = code;
    }
}

function sendChatTransferError(response, error, fallbackCode) {
    if (error instanceof ChatTransferError) {
        return response.status(error.status).json({ error: error.code, message: error.message });
    }
    if (error instanceof ArchiveReadError) {
        return response.status(error.status).json({
            error: error.code,
            message: ARCHIVE_ERROR_MESSAGES[error.code] ?? '无法读取压缩包',
        });
    }
    console.error(`${fallbackCode}:`, error);
    return response.status(500).json({ error: fallbackCode, message: '服务器处理失败，请稍后重试' });
}

function toPathKey(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a file or folder name can be used verbatim inside a user directory.
 * @param {unknown} name Candidate name
 * @returns {boolean}
 */
function isSafeEntryName(name) {
    return typeof name === 'string'
        && name.length > 0
        && name.length <= 255
        && !name.startsWith('.')
        && sanitize(name) === name;
}

function splitJsonlLines(text) {
    return String(text)
        .replace(/^\uFEFF/, '')
        .split('\n')
        .map(line => line.replace(/\r$/, ''))
        .filter(line => line.trim().length > 0);
}

/**
 * Chat headers carry metadata but never message text.
 * @param {unknown} value Parsed JSONL line
 * @returns {boolean}
 */
function isChatHeaderObject(value) {
    return isPlainObject(value)
        && !Object.hasOwn(value, 'mes')
        && (Object.hasOwn(value, 'chat_metadata') || Boolean(value.user_name && value.character_name));
}

/**
 * Reads a chat (legacy or chunked) as a complete JSONL document.
 * @param {string} filePath Chat file path
 * @param {boolean} isGroup Whether this is a group chat
 * @returns {Promise<string>}
 */
async function readChatJsonl(filePath, isGroup = false) {
    if (!isChunkedChat(filePath)) {
        return await fs.promises.readFile(filePath, 'utf8');
    }

    const index = await ensureChatIndex(filePath);
    let header;
    let embeddedHeaderCount = 0;
    if (isGroup) {
        const headerInfo = await readGroupChatHeaderInfo(filePath);
        header = headerInfo.header;
        embeddedHeaderCount = headerInfo.embeddedHeaderCount;
    } else {
        header = await readChatHeader(filePath);
    }

    const lines = [];
    for (const shard of index?.shards ?? []) {
        lines.push(...await readShardLines(path.join(getChatChunkDir(filePath), shard.file)));
    }
    const messageLines = lines.slice(embeddedHeaderCount);
    return (header ? [JSON.stringify(header), ...messageLines] : messageLines).join('\n');
}

/**
 * Directory suffix and sidecar file suffixes that only exist in this fork's
 * chunked chat layout. Upstream SillyTavern stores each chat as one JSONL file.
 */
export const CHAT_STORAGE_LAYOUT = Object.freeze({
    chunkDirectorySuffix: `.jsonl${CHAT_CHUNK_DIR_SUFFIX}`,
    sidecarSuffixes: Object.freeze([CHAT_METADATA_SUFFIX, CHAT_INDEX_SUFFIX, CHAT_REVISION_SUFFIX].map(suffix => `.jsonl${suffix}`)),
});

/**
 * @param {string} filePath Chat .jsonl path
 * @returns {boolean} Whether the chat's messages live in chunk shards
 */
export function isChunkedChatFile(filePath) {
    return isChunkedChat(filePath);
}

/**
 * Streams a chat as one upstream-compatible JSONL document for backups, one
 * chunk at a time, so huge chats never sit in memory whole. The chat lock is
 * held until `consume` has finished with the stream.
 * @param {string} handle Owner of the chat
 * @param {string} filePath Chat .jsonl path
 * @param {boolean} isGroup Whether this is a group chat
 * @param {(stream: import('node:stream').Readable) => Promise<void>} consume Reads the stream to the end
 * @returns {Promise<void>}
 */
export async function streamChatForBackup(handle, filePath, isGroup, consume) {
    const lockOwner = { user: { profile: { handle } } };
    await chatStorageMutex.runExclusive(getChatStorageLockKey(lockOwner, filePath), async () => {
        if (!isChunkedChat(filePath)) {
            await consume(fs.createReadStream(filePath));
            return;
        }
        const index = await ensureChatIndex(filePath);
        let header;
        let skipLines = 0;
        if (isGroup) {
            const headerInfo = await readGroupChatHeaderInfo(filePath);
            header = headerInfo.header;
            skipLines = headerInfo.embeddedHeaderCount;
        } else {
            header = await readChatHeader(filePath);
        }
        const chunkDirectory = getChatChunkDir(filePath);
        // Line by line: a single chunk of a huge chat can be tens of megabytes.
        async function* pieces() {
            let started = false;
            if (header) {
                yield JSON.stringify(header);
                started = true;
            }
            for (const shard of index?.shards ?? []) {
                const lines = readline.createInterface({
                    input: fs.createReadStream(path.join(chunkDirectory, shard.file), { encoding: 'utf8' }),
                    crlfDelay: Infinity,
                });
                for await (const line of lines) {
                    if (!line) {
                        continue;
                    }
                    if (skipLines > 0) {
                        skipLines--;
                        continue;
                    }
                    yield started ? `\n${line}` : line;
                    started = true;
                }
            }
        }
        await consume(Readable.from(pieces()));
    });
}

/**
 * Converts a chat JSONL document into a readable transcript.
 * @param {string} jsonl Chat JSONL
 * @returns {string}
 */
function chatJsonlToText(jsonl) {
    let buffer = '';
    for (const line of splitJsonlLines(jsonl)) {
        const data = tryParse(line);
        // Skip headers, invalid lines and non-printable/prompt-hidden messages
        if (!isPlainObject(data) || data.is_system || !data.mes) {
            continue;
        }
        const message = String(data?.extra?.display_text || data.mes).replace(/\r?\n/g, '\n');
        buffer += `${data.name}: ${message}\n\n`;
    }
    return buffer;
}

/**
 * Lets other requests run between slices of a long pass over a large chat
 * (restoring a 100 MB chat would otherwise hold the server for about a second).
 * @returns {(bytes: number) => Promise<void>} Call with the bytes just processed
 */
function createEventLoopYielder() {
    let pending = 0;
    return async bytes => {
        pending += bytes;
        if (pending >= 2 * 1024 * 1024) {
            pending = 0;
            await new Promise(resolve => setImmediate(resolve));
        }
    };
}

/**
 * Stable signature of a chat's messages (headers are ignored because their
 * bookkeeping fields change without the conversation changing).
 * @param {string[]} lines JSONL lines
 * @returns {Promise<string>}
 */
async function getChatMessagesSignature(lines) {
    const hash = crypto.createHash('sha256');
    const yieldEventLoop = createEventLoopYielder();
    for (const line of lines) {
        await yieldEventLoop(line.length);
        const data = tryParse(line);
        if (!isPlainObject(data) || isChatHeaderObject(data)) {
            continue;
        }
        hash.update(JSON.stringify(data));
        hash.update('\n');
    }
    return hash.digest('hex');
}

/**
 * Finds a chat file path that does not exist yet.
 * @param {string} directory Target directory
 * @param {string} baseName File name without extension
 * @param {Set<string>} [reserved] Path keys already claimed in this operation
 * @returns {string}
 */
function getAvailableChatPath(directory, baseName, reserved = undefined) {
    for (let attempt = 1; attempt <= 1000; attempt++) {
        const suffix = attempt === 1 ? '' : ` (${attempt})`;
        const candidate = path.join(directory, `${baseName}${suffix}.jsonl`);
        if (!fs.existsSync(candidate) && !reserved?.has(toPathKey(candidate))) {
            return candidate;
        }
    }
    throw new Error(`Could not allocate a unique chat file name for ${baseName}`);
}

function listJsonlFiles(directory) {
    try {
        return fs.readdirSync(directory, { withFileTypes: true })
            .filter(entry => entry.isFile() && path.extname(entry.name) === '.jsonl')
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b));
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

/**
 * Reads all group definitions of a user.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {Map<string, {id: string, filePath: string, data: any, chats: string[], members: string[]}>}
 */
function readUserGroups(directories) {
    const groups = new Map();
    let files = [];
    try {
        files = fs.readdirSync(directories.groups).filter(name => path.extname(name) === '.json');
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }

    for (const file of files) {
        const filePath = path.join(directories.groups, file);
        try {
            const data = tryParse(fs.readFileSync(filePath, 'utf8'));
            if (!isPlainObject(data)) {
                continue;
            }
            const id = path.parse(file).name;
            groups.set(id, {
                id,
                filePath,
                data,
                chats: Array.isArray(data.chats) ? data.chats.map(String) : [],
                members: Array.isArray(data.members) ? data.members.map(String) : [],
            });
        } catch (error) {
            console.warn(`Could not read group file ${file}:`, error);
        }
    }
    return groups;
}

function normalizeChatFileName(value) {
    let name = String(value ?? '');
    if (!name.endsWith('.jsonl')) {
        name += '.jsonl';
    }
    return isSafeEntryName(name) ? name : null;
}

/**
 * Resolves which chats a bulk export should contain.
 * @param {import('express').Request} request Request
 * @param {{scope: 'all'|'selection', targets: any[], includeCards: boolean}} options Export options
 */
function collectChatExportPlan(request, { scope, targets, includeCards }) {
    const directories = request.user.directories;
    const userGroups = readUserGroups(directories);
    const chats = [];
    const seenChats = new Set();
    const groups = new Map();
    const cards = new Set();

    const addCharacterChats = (dirName, files) => {
        if (!isSafeEntryName(dirName)) {
            throw new ChatTransferError(400, 'invalid_target', '无效的角色');
        }
        const folder = path.join(directories.chats, dirName);
        const available = listJsonlFiles(folder);
        const availableSet = new Set(available);
        const selected = files === null ? available : files.map(normalizeChatFileName);
        for (const file of selected) {
            const filePath = path.join(folder, String(file));
            if (!file || !availableSet.has(file) || seenChats.has(toPathKey(filePath))) {
                continue;
            }
            seenChats.add(toPathKey(filePath));
            chats.push({ kind: 'character', owner: dirName, ownerName: dirName, file, filePath });
            if (includeCards) {
                cards.add(`${dirName}.png`);
            }
        }
    };

    const addGroupChats = (group, chatIds) => {
        const selected = chatIds === null
            ? group.chats
            : chatIds.map(id => String(id).replace(/\.jsonl$/, '')).filter(id => group.chats.includes(id));
        for (const id of selected) {
            const file = normalizeChatFileName(id);
            if (!file) {
                continue;
            }
            const filePath = path.join(directories.groupChats, file);
            if (!fs.existsSync(filePath) || seenChats.has(toPathKey(filePath))) {
                continue;
            }
            seenChats.add(toPathKey(filePath));
            chats.push({ kind: 'group', owner: group.id, ownerName: String(group.data.name || group.id), file, filePath });
        }
        groups.set(group.id, group);
        if (includeCards) {
            group.members.forEach(member => cards.add(member));
        }
    };

    if (scope === 'all') {
        let entries = [];
        try {
            entries = fs.readdirSync(directories.chats, { withFileTypes: true });
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
        }
        for (const entry of entries) {
            if (entry.isDirectory() && isSafeEntryName(entry.name)) {
                addCharacterChats(entry.name, null);
            }
        }
        for (const group of userGroups.values()) {
            addGroupChats(group, null);
        }
    } else {
        if (!Array.isArray(targets) || targets.length === 0) {
            throw new ChatTransferError(400, 'invalid_target', '请选择要导出的对话');
        }
        if (targets.length > CHAT_TRANSFER_LIMITS.maxExportTargets) {
            throw new ChatTransferError(400, 'too_many_targets', '一次选择的导出目标过多');
        }
        for (const target of targets) {
            const files = Array.isArray(target?.files) ? target.files : null;
            if (target?.type === 'group') {
                const group = userGroups.get(String(target.id ?? ''));
                if (!group) {
                    throw new ChatTransferError(404, 'group_not_found', '找不到要导出的群聊');
                }
                addGroupChats(group, files);
            } else {
                addCharacterChats(String(target?.avatar ?? '').replace(/\.png$/i, ''), files);
            }
        }
    }

    const cardFiles = [...cards].filter(file => isSafeEntryName(file) && path.extname(file) === '.png'
        && fs.existsSync(path.join(directories.characters, file)));
    return { chats, groups: [...groups.values()], cardFiles };
}

/**
 * Builds unique, human readable folder names for plain-text exports.
 * @param {{kind: string, owner: string, ownerName: string}[]} chats Planned chats
 * @returns {Map<string, string>} Owner key -> folder name
 */
function getTextExportFolders(chats) {
    const folders = new Map();
    const used = new Set();
    for (const chat of chats) {
        const key = `${chat.kind}\0${chat.owner}`;
        if (folders.has(key)) {
            continue;
        }
        const baseName = sanitize(chat.kind === 'group' ? `群聊 - ${chat.ownerName}` : chat.ownerName) || chat.owner;
        let name = baseName;
        for (let attempt = 2; used.has(name.toLowerCase()); attempt++) {
            name = `${baseName} (${attempt})`;
        }
        used.add(name.toLowerCase());
        folders.set(key, name);
    }
    return folders;
}

/**
 * Detects an optional single top-level folder that wraps the user data layout.
 * @param {{path: string}[]} entries Archive entries
 * @returns {string|null} Root prefix ('' or 'folder/') or null when no data is present
 */
function detectArchiveRoot(entries) {
    const votes = new Map();
    for (const { path: entryPath } of entries) {
        const segments = entryPath.split('/');
        if (segments.length > 1 && ARCHIVE_ROOT_MARKERS.includes(segments[0])) {
            votes.set('', (votes.get('') ?? 0) + 1);
        } else if (segments.length > 2 && ARCHIVE_ROOT_MARKERS.includes(segments[1])) {
            const prefix = `${segments[0]}/`;
            votes.set(prefix, (votes.get(prefix) ?? 0) + 1);
        }
    }
    let best = null;
    let bestVotes = 0;
    for (const [prefix, count] of votes) {
        if (count > bestVotes) {
            best = prefix;
            bestVotes = count;
        }
    }
    return best;
}

/**
 * Groups archive entries into restorable chats, groups and character cards.
 * @param {{path: string, entry: any}[]} entries Archive entries
 */
function classifyChatArchive(entries) {
    const layout = {
        characterChats: new Map(),
        groupChats: new Map(),
        groups: new Map(),
        characters: new Map(),
    };
    const root = detectArchiveRoot(entries);
    if (root === null) {
        return layout;
    }

    const getChatRecord = (map, dir, file) => {
        const key = `${dir}/${file}`;
        if (!map.has(key)) {
            map.set(key, { dir, file, main: null, sidecar: null, shards: [] });
        }
        return map.get(key);
    };

    for (const item of entries) {
        if (!item.path.startsWith(root)) {
            continue;
        }
        const relativePath = item.path.slice(root.length);
        for (const [kind, pattern] of CHAT_ARCHIVE_PATTERNS) {
            const match = pattern.exec(relativePath);
            if (!match) {
                continue;
            }
            const names = match.slice(1).filter(Boolean);
            if (!names.every(isSafeEntryName)) {
                break;
            }
            const [, dir, file, shard] = match;
            switch (kind) {
                case 'characterChat':
                case 'groupChat':
                    getChatRecord(kind === 'groupChat' ? layout.groupChats : layout.characterChats, dir, file).main = item;
                    break;
                case 'characterSidecar':
                case 'groupSidecar':
                    getChatRecord(kind === 'groupSidecar' ? layout.groupChats : layout.characterChats, dir, file).sidecar = item;
                    break;
                case 'characterShard':
                case 'groupShard':
                    getChatRecord(kind === 'groupShard' ? layout.groupChats : layout.characterChats, dir, file).shards.push({ name: shard, item });
                    break;
                case 'group':
                    layout.groups.set(path.parse(match[1]).name, item);
                    break;
                case 'character':
                    layout.characters.set(match[1], item);
                    break;
            }
            break;
        }
    }

    for (const map of [layout.characterChats, layout.groupChats]) {
        for (const [key, record] of map) {
            record.shards.sort((a, b) => a.name.localeCompare(b.name));
            // Metadata sidecars alone are not conversations.
            if (!record.main && record.shards.length === 0) {
                map.delete(key);
            }
        }
    }
    return layout;
}

/**
 * Rebuilds one archived chat (legacy file or chunked layout) into a legacy JSONL document.
 * @param {{dir: string, file: string, main: any, sidecar: any, shards: {item: any}[]}} record Archived chat parts
 * @param {boolean} isGroup Whether this is a group chat
 * @param {(item: any, maxBytes: number) => Promise<Buffer>} readEntry Bounded entry reader
 * @param {{invalidLines: number}} summary Restore summary
 * @returns {Promise<{content: string, signature: string}>}
 */
async function assembleArchivedChat(record, isGroup, readEntry, summary) {
    const readLines = async (item, maxBytes) => splitJsonlLines((await readEntry(item, maxBytes)).toString('utf8'));
    const mainLines = record.main ? await readLines(record.main, CHAT_TRANSFER_LIMITS.maxChatPartBytes) : [];
    const sidecar = record.sidecar
        ? tryParse((await readEntry(record.sidecar, CHAT_TRANSFER_LIMITS.maxSidecarBytes)).toString('utf8'))
        : null;

    let header = isChatHeaderObject(sidecar) ? sidecar : null;
    let messageLines = mainLines;
    if (record.shards.length > 0) {
        // Chunked layout: the main file only holds the header.
        const fileHeader = tryParse(mainLines[0] ?? '');
        header ??= isChatHeaderObject(fileHeader) ? fileHeader : null;
        messageLines = [];
        let assembledBytes = 0;
        for (const shard of record.shards) {
            const lines = await readLines(shard.item, CHAT_TRANSFER_LIMITS.maxChatPartBytes);
            assembledBytes += lines.reduce((total, line) => total + line.length + 1, 0);
            if (assembledBytes > CHAT_TRANSFER_LIMITS.maxChatBytes) {
                throw new ChatTransferError(413, 'chat_too_large', `对话过大，无法恢复：${record.file}`);
            }
            messageLines.push(...lines);
        }
    }

    const messages = [];
    const yieldEventLoop = createEventLoopYielder();
    for (const [index, line] of messageLines.entries()) {
        await yieldEventLoop(line.length);
        const data = tryParse(line);
        if (!isPlainObject(data)) {
            summary.invalidLines++;
            continue;
        }
        if (index === 0 && isChatHeaderObject(data)) {
            header ??= data;
            continue;
        }
        messages.push(JSON.stringify(data));
    }

    header ??= isGroup
        ? { chat_metadata: {}, user_name: 'unused', character_name: 'unused' }
        : { user_name: 'User', character_name: record.dir, create_date: humanizedISO8601DateTime(), chat_metadata: {} };
    const lines = [JSON.stringify(header), ...messages];
    return { content: lines.join('\n'), signature: await getChatMessagesSignature(lines) };
}

/**
 * Picks where a restored chat goes: skip identical copies, otherwise keep the
 * original name or add a " (restored N)" suffix. Existing files are never overwritten.
 * @returns {Promise<{action: 'create'|'rename'|'skip', filePath: string}>}
 */
async function resolveChatRestoreTarget(request, { directory, baseName, signature, isGroup, reserved }) {
    for (let attempt = 0; attempt < CHAT_TRANSFER_LIMITS.maxRenameAttempts; attempt++) {
        const suffix = attempt === 0 ? '' : attempt === 1 ? ' (restored)' : ` (restored ${attempt})`;
        const candidate = path.join(directory, `${baseName}${suffix}.jsonl`);
        if (reserved.has(toPathKey(candidate))) {
            continue;
        }
        if (!fs.existsSync(candidate)) {
            return { action: attempt === 0 ? 'create' : 'rename', filePath: candidate };
        }
        const existing = await chatStorageMutex.runExclusive(getChatStorageLockKey(request, candidate),
            () => readChatJsonl(candidate, isGroup));
        if (await getChatMessagesSignature(splitJsonlLines(existing)) === signature) {
            return { action: 'skip', filePath: candidate };
        }
    }
    throw new ChatTransferError(409, 'restore_name_conflict', `同名对话过多，无法恢复：${baseName}`);
}

/**
 * Restores chats, groups and (optionally) missing character cards from an
 * exported chat bundle or a full user backup. The restore is additive and
 * atomic: nothing existing is overwritten except group chat lists that gain
 * restored entries, and either every file is written or none is.
 * @param {import('express').Request} request Request
 * @param {string} zipPath Uploaded archive path
 * @param {{includeCharacters: boolean}} options Restore options
 */
async function restoreChatArchive(request, zipPath, { includeCharacters }) {
    const directories = request.user.directories;
    const summary = {
        chats: { imported: 0, renamed: 0, skipped: 0 },
        groupChats: { imported: 0, renamed: 0, skipped: 0, orphaned: 0 },
        groups: { created: 0, updated: 0 },
        characters: { imported: 0, skipped: 0, invalid: 0, notSelected: 0 },
        invalidLines: 0,
        missingCharacters: [],
    };

    const reader = await openZipFileReader(zipPath);
    const transaction = new FileTransaction(directories.root);
    try {
        const layout = classifyChatArchive(reader.entries);
        if (layout.characterChats.size === 0 && layout.groupChats.size === 0 && layout.groups.size === 0 && layout.characters.size === 0) {
            throw new ChatTransferError(400, 'no_chat_data', '压缩包中没有找到可恢复的对话数据，请选择「导出全部对话」或「下载备份」得到的 ZIP 文件');
        }

        const quota = await canConsumeStorage(request.user.profile, directories, 0);
        const remainingBytes = quota.config.enabled ? quota.remainingBytes : Number.POSITIVE_INFINITY;
        const reserved = new Set();
        let readBytes = 0;
        let stagedBytes = 0;

        const readEntry = async (item, maxBytes) => {
            const buffer = await reader.read(item, { maxBytes, maxCompressionRatio: CHAT_TRANSFER_LIMITS.maxCompressionRatio });
            readBytes += buffer.length;
            if (readBytes > CHAT_TRANSFER_LIMITS.maxTotalReadBytes) {
                throw new ChatTransferError(413, 'archive_size_limit_exceeded', ARCHIVE_ERROR_MESSAGES.archive_size_limit_exceeded);
            }
            return buffer;
        };
        const stage = async (targetPath, data) => {
            const previousSize = fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0;
            stagedBytes += Math.max(0, Buffer.byteLength(data) - previousSize);
            if (stagedBytes > remainingBytes) {
                throw new ChatTransferError(403, 'storage_limit', '存储空间不足，无法恢复全部对话。请清理空间或扩容后重试');
            }
            await transaction.stageFile(targetPath, data);
            reserved.add(toPathKey(targetPath));
        };

        // Character cards first, so restored chats can be matched to them.
        for (const [file, item] of layout.characters) {
            const targetPath = path.join(directories.characters, file);
            if (fs.existsSync(targetPath)) {
                summary.characters.skipped++;
                continue;
            }
            if (!includeCharacters) {
                summary.characters.notSelected++;
                continue;
            }
            const buffer = await readEntry(item, CHAT_TRANSFER_LIMITS.maxCardBytes);
            try {
                if (!isPlainObject(JSON.parse(readCharacterCard(buffer)))) {
                    throw new TypeError('Character card is not an object.');
                }
            } catch {
                summary.characters.invalid++;
                continue;
            }
            await stage(targetPath, buffer);
            summary.characters.imported++;
        }

        const missingCharacters = new Set();
        for (const record of layout.characterChats.values()) {
            const assembled = await assembleArchivedChat(record, false, readEntry, summary);
            const target = await resolveChatRestoreTarget(request, {
                directory: path.join(directories.chats, record.dir),
                baseName: path.parse(record.file).name,
                signature: assembled.signature,
                isGroup: false,
                reserved,
            });
            if (target.action === 'skip') {
                summary.chats.skipped++;
                continue;
            }
            await stage(target.filePath, assembled.content);
            summary.chats[target.action === 'rename' ? 'renamed' : 'imported']++;

            const cardPath = path.join(directories.characters, `${record.dir}.png`);
            if (!fs.existsSync(cardPath) && !reserved.has(toPathKey(cardPath))) {
                missingCharacters.add(record.dir);
            }
        }
        summary.missingCharacters = [...missingCharacters].slice(0, CHAT_TRANSFER_LIMITS.maxReportedMissingCharacters);

        // Group chats are only visible through a group definition.
        const localGroups = readUserGroups(directories);
        const archivedGroups = new Map();
        for (const [id, item] of layout.groups) {
            const data = tryParse((await readEntry(item, CHAT_TRANSFER_LIMITS.maxGroupBytes)).toString('utf8'));
            if (isPlainObject(data)) {
                archivedGroups.set(id, data);
            }
        }
        const chatOwners = new Map();
        for (const [id, group] of localGroups) {
            group.chats.forEach(chatId => chatOwners.set(chatId, id));
        }
        for (const [id, data] of archivedGroups) {
            (Array.isArray(data.chats) ? data.chats : []).forEach(chatId => chatOwners.set(String(chatId), id));
        }

        const finalChatIds = new Map();
        const restoredChatsByGroup = new Map();
        for (const record of layout.groupChats.values()) {
            const originalId = path.parse(record.file).name;
            const groupId = chatOwners.get(originalId);
            if (!groupId) {
                summary.groupChats.orphaned++;
                continue;
            }
            const assembled = await assembleArchivedChat(record, true, readEntry, summary);
            const target = await resolveChatRestoreTarget(request, {
                directory: directories.groupChats,
                baseName: originalId,
                signature: assembled.signature,
                isGroup: true,
                reserved,
            });
            const finalId = path.parse(target.filePath).name;
            finalChatIds.set(originalId, finalId);
            if (!restoredChatsByGroup.has(groupId)) {
                restoredChatsByGroup.set(groupId, []);
            }
            restoredChatsByGroup.get(groupId).push(finalId);
            if (target.action === 'skip') {
                summary.groupChats.skipped++;
                continue;
            }
            await stage(target.filePath, assembled.content);
            summary.groupChats[target.action === 'rename' ? 'renamed' : 'imported']++;
        }

        const groupIds = new Set([...archivedGroups.keys(), ...restoredChatsByGroup.keys()]);
        for (const groupId of groupIds) {
            const restoredIds = restoredChatsByGroup.get(groupId) ?? [];
            const localGroup = localGroups.get(groupId);
            if (localGroup) {
                const chats = [...localGroup.chats];
                for (const chatId of restoredIds) {
                    if (!chats.includes(chatId)) {
                        chats.push(chatId);
                    }
                }
                if (chats.length !== localGroup.chats.length) {
                    await stage(localGroup.filePath, JSON.stringify({ ...localGroup.data, chats }, null, 4));
                    summary.groups.updated++;
                }
                continue;
            }

            const archived = archivedGroups.get(groupId);
            if (!archived || !isSafeEntryName(`${groupId}.json`)) {
                continue;
            }
            const chats = (Array.isArray(archived.chats) ? archived.chats : [])
                .map(chatId => finalChatIds.get(String(chatId)))
                .filter(Boolean);
            const chatId = finalChatIds.get(String(archived.chat_id)) ?? chats[chats.length - 1] ?? groupId;
            if (!chats.includes(chatId)) {
                chats.push(chatId);
            }
            const groupData = { ...archived, id: groupId, chats, chat_id: chatId };
            delete groupData.past_metadata;
            await stage(path.join(directories.groups, `${groupId}.json`), JSON.stringify(groupData, null, 4));
            summary.groups.created++;
        }

        // Re-check against the live directory size right before committing.
        const additionalBytes = await transaction.getAdditionalBytes();
        const capacity = await canConsumeStorage(request.user.profile, directories, additionalBytes);
        if (!capacity.allowed) {
            throw new ChatTransferError(403, 'storage_limit', '存储空间不足，无法恢复全部对话。请清理空间或扩容后重试');
        }
        await transaction.commit();
        return summary;
    } finally {
        reader.close();
        await transaction.dispose();
    }
}

/**
 * Adds one entry and waits until archiver has consumed it, so large exports
 * stream one chat at a time instead of buffering everything in memory.
 * @param {import('archiver').Archiver} archive Archive
 * @param {import('express').Response} response Response the archive is piped to
 * @param {() => void} addEntry Callback that appends exactly one entry
 * @returns {Promise<void>}
 */
function appendArchiveEntry(archive, response, addEntry) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            archive.off('entry', onEntry);
            archive.off('error', onError);
            response.off('close', onClose);
        };
        const onEntry = () => {
            cleanup();
            resolve();
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const onClose = () => {
            cleanup();
            reject(Object.assign(new Error('Client closed the export stream.'), { code: 'CLIENT_CLOSED' }));
        };
        archive.on('entry', onEntry);
        archive.once('error', onError);
        response.once('close', onClose);
        addEntry();
    });
}

router.post('/export-estimate', async function (request, response) {
    const format = request.body?.format === 'txt' ? 'txt' : 'jsonl';
    const scope = request.body?.scope === 'all' ? 'all' : 'selection';
    const includeCards = format === 'jsonl' && request.body?.include_cards === true;
    try {
        const plan = collectChatExportPlan(request, { scope, targets: request.body?.targets, includeCards });
        const entries = [];
        const sizeOf = (filePath) => { try { return fs.statSync(filePath).size; } catch { return 0; } };
        for (const chat of plan.chats) {
            let size = 0;
            try { size = getChatStoredBytes(chat.filePath); } catch { size = 0; }
            const samplePath = getChatSamplePaths(chat.filePath);
            entries.push(format === 'txt'
                ? { name: chat.file, size, samplePath, transform: chatLinesToText }
                : { name: chat.file, size, samplePath });
        }
        if (includeCards) {
            for (const group of plan.groups) {
                entries.push({ name: group.filePath, size: sizeOf(group.filePath) });
            }
            for (const file of plan.cardFiles) {
                entries.push({ name: file, size: sizeOf(path.join(request.user.directories.characters, file)) });
            }
        }
        return response.json({ chats: plan.chats.length, ...await estimateZipBytes(entries, 6) });
    } catch (error) {
        return sendChatTransferError(response, error, 'chat_export_estimate_failed');
    }
});

router.post('/export-bundle', async function (request, response) {
    const format = request.body?.format === 'txt' ? 'txt' : 'jsonl';
    const scope = request.body?.scope === 'all' ? 'all' : 'selection';
    const includeCards = format === 'jsonl' && request.body?.include_cards === true;

    let plan;
    try {
        plan = collectChatExportPlan(request, { scope, targets: request.body?.targets, includeCards });
    } catch (error) {
        return sendChatTransferError(response, error, 'chat_export_failed');
    }
    if (plan.chats.length === 0) {
        return response.status(404).json({ error: 'no_chats', message: '没有找到可导出的对话' });
    }

    const exportStartedAt = Date.now();
    const activity = { u: request.user.profile.handle, a: Boolean(request.user.profile.admin), k: 'partial' };
    let quota;
    try {
        quota = await consumeBackupQuota(request.user.profile, 'partial');
    } catch (error) {
        if (error instanceof BackupQuotaError) {
            recordBackupActivity({ ...activity, s: 'rejected', r: error.message });
            const status = error.code === 'backup_disabled' ? 403 : 429;
            return response.status(status).json({ error: error.code, message: error.message, quota: error.quota });
        }
        return sendChatTransferError(response, error, 'chat_export_failed');
    }

    const archive = archiver('zip', { zlib: { level: 6 } });
    let completed = false;
    response.once('finish', () => {
        completed = true;
        recordBackupActivity({ ...activity, s: 'ok', b: archive.pointer(), ms: Date.now() - exportStartedAt });
    });
    response.once('close', () => {
        if (!completed) {
            archive.abort();
        }
    });
    archive.on('warning', warning => console.warn('Chat export warning:', warning));
    archive.on('error', error => {
        console.error('Chat export archive failed:', error);
        response.destroy(error);
    });

    // No Content-Disposition: the client names and saves the file itself.
    // Download managers (IDM, Thunder, ...) hijack "attachment" responses and
    // hand the page an empty 204 instead of the archive.
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    archive.pipe(response);

    let exported = 0;
    try {
        const textFolders = format === 'txt' ? getTextExportFolders(plan.chats) : null;
        const failed = [];
        for (const chat of plan.chats) {
            let content;
            try {
                content = await chatStorageMutex.runExclusive(getChatStorageLockKey(request, chat.filePath),
                    () => readChatJsonl(chat.filePath, chat.kind === 'group'));
            } catch (error) {
                console.warn(`Could not export chat ${chat.filePath}:`, error);
                failed.push(`${chat.ownerName}/${chat.file}`);
                continue;
            }

            let name;
            if (format === 'txt') {
                content = chatJsonlToText(content);
                name = `${textFolders.get(`${chat.kind}\0${chat.owner}`)}/${path.parse(chat.file).name}.txt`;
            } else {
                name = chat.kind === 'group' ? `group chats/${chat.file}` : `chats/${chat.owner}/${chat.file}`;
            }
            await appendArchiveEntry(archive, response, () => archive.append(content, { name }));
            exported++;
        }

        if (format === 'jsonl') {
            for (const group of plan.groups) {
                await appendArchiveEntry(archive, response,
                    () => archive.file(group.filePath, { name: `groups/${path.basename(group.filePath)}` }));
            }
            for (const file of plan.cardFiles) {
                await appendArchiveEntry(archive, response,
                    () => archive.file(path.join(request.user.directories.characters, file), { name: `characters/${file}` }));
            }
            const manifest = JSON.stringify({
                format: 'sillytavern-chat-bundle',
                version: 1,
                exportedAt: new Date().toISOString(),
                chats: exported,
                groups: plan.groups.length,
                characters: plan.cardFiles.length,
                failed,
            }, null, 4);
            await appendArchiveEntry(archive, response, () => archive.append(manifest, { name: 'manifest.json' }));
        } else if (failed.length > 0) {
            const report = `以下对话读取失败，未包含在导出中：\n${failed.join('\n')}\n`;
            await appendArchiveEntry(archive, response, () => archive.append(report, { name: '导出失败的对话.txt' }));
        }

        await archive.finalize();
    } catch (error) {
        if (!completed) {
            if (error?.code === 'CLIENT_CLOSED') {
                console.warn('Chat bundle export cancelled by the client.');
                recordBackupActivity({ ...activity, s: 'cancelled', ms: Date.now() - exportStartedAt, r: '用户中途取消下载' });
            } else {
                console.error('Chat bundle export failed:', error);
                recordBackupActivity({ ...activity, s: 'failed', ms: Date.now() - exportStartedAt, r: String(error?.message ?? error).slice(0, 200) });
            }
            archive.abort();
            response.destroy();
            if (exported === 0) {
                // Nothing was delivered, so the attempt does not count.
                await quota.release();
            }
        }
    }
});

router.post('/import-archive', async function (request, response) {
    if (!request.file) {
        return response.status(400).json({ error: 'missing_file', message: '请选择要恢复的 ZIP 文件' });
    }

    const uploadPath = path.join(request.file.destination, request.file.filename);
    const handle = request.user.profile.handle;
    const activity = { u: handle, a: Boolean(request.user.profile.admin), k: 'restore', b: request.file.size };
    const startedAt = Date.now();
    try {
        const summary = await chatStorageMutex.runExclusive(`chat-restore\0${handle}`, () => restoreChatArchive(request, uploadPath, {
            includeCharacters: String(request.body?.include_characters ?? 'true') !== 'false',
        }));
        invalidateCharacterListCache(handle);
        invalidateRecentChatsCache(handle);
        recordBackupActivity({ ...activity, s: 'ok', ms: Date.now() - startedAt });
        return response.send({ ok: true, summary });
    } catch (error) {
        recordBackupActivity({ ...activity, s: 'failed', ms: Date.now() - startedAt, r: describeRestoreFailure(error) });
        return sendChatTransferError(response, error, 'chat_restore_failed');
    } finally {
        await fs.promises.rm(uploadPath, { force: true }).catch(() => undefined);
    }
});

/** @type {RestoreUploadManager|null} */
let restoreUploads = null;

/** Chunked backup uploads, created on first use (it owns and clears its directory). */
function getRestoreUploads() {
    restoreUploads ??= new RestoreUploadManager({
        directory: path.join(globalThis.DATA_ROOT, '_restore-uploads'),
        maxFileBytes: getUploadLimits().fileSize,
    });
    return restoreUploads;
}

registerBackupLiveSource(() => restoreUploads?.describeUploads() ?? []);

/**
 * Short reason for the admin panel's restore log.
 * @param {unknown} error Error
 * @returns {string}
 */
function describeRestoreFailure(error) {
    if (error instanceof ChatTransferError) return error.message;
    if (error instanceof ArchiveReadError) return ARCHIVE_ERROR_MESSAGES[error.code] ?? '无法读取压缩包';
    return '服务器处理失败';
}

function sendRestoreUploadError(response, error) {
    if (error instanceof RestoreUploadError) {
        return response.status(error.status).json({ error: error.code, message: error.message, ...error.details });
    }
    return sendChatTransferError(response, error, 'chat_restore_failed');
}

/**
 * User-facing form of a restore failure, kept for the page to poll.
 * @param {unknown} error Error
 * @returns {unknown}
 */
function toRestoreUploadError(error) {
    if (error instanceof ChatTransferError) {
        return new RestoreUploadError(error.status, error.code, error.message);
    }
    if (error instanceof ArchiveReadError) {
        return new RestoreUploadError(error.status, error.code, ARCHIVE_ERROR_MESSAGES[error.code] ?? '无法读取压缩包');
    }
    return error;
}

router.post('/restore-upload/start', async function (request, response) {
    try {
        const upload = await getRestoreUploads().start(request.user.profile.handle, Number(request.body?.size));
        return response.json(upload);
    } catch (error) {
        return sendRestoreUploadError(response, error);
    }
});

router.put('/restore-upload/:id', async function (request, response) {
    try {
        const result = await getRestoreUploads().writeChunk(
            request.user.profile.handle,
            request.params.id,
            Number(request.query.offset),
            Number(request.headers['content-length']),
            request,
        );
        return response.json(result);
    } catch (error) {
        return sendRestoreUploadError(response, error);
    }
});

router.post('/restore-upload/:id/finish', async function (request, response) {
    try {
        const handle = request.user.profile.handle;
        const manager = getRestoreUploads();
        if (manager.get(handle, request.params.id).state !== 'uploading') {
            return response.json(manager.status(handle, request.params.id));
        }
        const includeCharacters = request.body?.include_characters !== false;
        const activity = { u: handle, a: Boolean(request.user.profile.admin), k: 'restore', b: manager.get(handle, request.params.id).size };
        // The restore outlives this request; the controller must still see it as a running write.
        const releaseWrite = await holdStcontrolWrite(request);
        let status;
        try {
            status = manager.finish(handle, request.params.id, async filePath => {
                const startedAt = Date.now();
                try {
                    const summary = await chatStorageMutex.runExclusive(`chat-restore\0${handle}`, () => restoreChatArchive(request, filePath, { includeCharacters }));
                    recordBackupActivity({ ...activity, s: 'ok', ms: Date.now() - startedAt });
                    return summary;
                } catch (error) {
                    recordBackupActivity({ ...activity, s: 'failed', ms: Date.now() - startedAt, r: describeRestoreFailure(error) });
                    throw toRestoreUploadError(error);
                } finally {
                    invalidateCharacterListCache(handle);
                    invalidateRecentChatsCache(handle);
                }
            }, releaseWrite);
        } catch (error) {
            releaseWrite();
            throw error;
        }
        return response.status(202).json(status);
    } catch (error) {
        return sendRestoreUploadError(response, error);
    }
});

router.get('/restore-upload/:id', function (request, response) {
    try {
        return response.json(getRestoreUploads().status(request.user.profile.handle, request.params.id));
    } catch (error) {
        return sendRestoreUploadError(response, error);
    }
});

router.delete('/restore-upload/:id', async function (request, response) {
    try {
        await getRestoreUploads().cancel(request.user.profile.handle, request.params.id);
        return response.json({ ok: true });
    } catch (error) {
        return sendRestoreUploadError(response, error);
    }
});

router.post('/export', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body.file || (!request.body.avatar_url && request.body.is_group === false)) {
        return response.sendStatus(400);
    }
    const isGroup = Boolean(request.body.is_group);
    const pathToFolder = isGroup
        ? request.user.directories.groupChats
        : path.join(request.user.directories.chats, String(request.body.avatar_url).replace('.png', ''));
    const filename = path.join(pathToFolder, sanitize(request.body.file));
    if (!isGroup && !isPathUnderParent(request.user.directories.chats, filename)) {
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
        const rawFile = await chatStorageMutex.runExclusive(getChatStorageLockKey(request, filename),
            () => readChatJsonl(filename, isGroup));
        const successMessage = {
            message: `Chat saved to ${exportfilename}`,
            result: request.body.format === 'jsonl' ? rawFile : chatJsonlToText(rawFile),
        };
        console.info(`Chat exported as ${exportfilename}`);
        return response.status(200).json(successMessage);
    } catch (err) {
        console.error('chat export failed.', err);
        const errorMessage = {
            message: `Could not read JSONL file to export. Source chat file: ${filename}.`,
        };
        return response.status(500).json(errorMessage);
    }
});

router.post('/group/import', async function (request, response) {
    try {
        const filedata = request.file;

        if (!filedata) {
            return response.sendStatus(400);
        }

        const pathToUpload = path.join(filedata.destination, filedata.filename);
        const uploadSize = fs.statSync(pathToUpload).size;
        const storageError = await ensureChatStorageCapacity(request, response, uploadSize);
        if (storageError) {
            fs.unlinkSync(pathToUpload);
            return storageError;
        }
        const firstLine = await readFirstLine(pathToUpload);
        if (!isPlainObject(tryParse(firstLine))) {
            fs.unlinkSync(pathToUpload);
            console.error('Incorrect group chat format .jsonl');
            return response.send({ error: true });
        }
        const pathToNewFile = getAvailableChatPath(request.user.directories.groupChats, humanizedDateTime());
        const chatname = path.parse(pathToNewFile).name;
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
                const filePath = getAvailableChatPath(directoryPath, `${safeCharacterName} - ${humanizedDateTime()} imported`);
                const fileName = path.basename(filePath);
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

            const filePath = getAvailableChatPath(directoryPath, `${safeCharacterName} - ${humanizedDateTime()} imported`);
            const fileName = path.basename(filePath);
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
            const [headerInfo, storedMessages] = await Promise.all([
                readGroupChatHeaderInfo(pathToFile),
                readChunkedChatMessages(pathToFile),
            ]);
            const messages = headerInfo.embeddedHeaderCount ? storedMessages.slice(1) : storedMessages;
            return response.send(headerInfo.header ? [headerInfo.header, ...messages] : messages);
        }

        const data = fs.readFileSync(pathToFile, 'utf8');
        const lines = data.split('\n');

        // Iterate through the array of strings and parse each line as JSON
        const jsonData = lines.map(line => tryParse(line)).filter(x => x);
        const split = splitGroupChatData(jsonData);
        const storedHeader = await readChatHeader(pathToFile);
        const header = isGroupChatHeader(storedHeader) ? storedHeader : split.header;
        return response.send(header ? [header, ...split.messages] : split.messages);
    } else {
        return response.send([]);
    }
});

router.post('/group/get-range', async (request, response) => {
    const performanceTimer = beginEndpointPerformance(request, 'group-chat-get-range');
    performanceTimer.setCacheState('bypass');
    try {
        if (!chatPagingProtocolEnabled) {
            performanceTimer.startPhase('serialize');
            return response.status(404).send({ error: 'chat_paging_disabled' });
        }
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = request.body.id;
        const filePath = path.join(request.user.directories.groupChats, `${id}.jsonl`);

        if (!fs.existsSync(filePath)) {
            performanceTimer.startPhase('serialize');
            return response.send({ header: null, messages: [], cursor: 0, messageOffset: 0, total: 0, hasMore: false, revision: null });
        }

        return await chatStorageMutex.runExclusive(getChatStorageLockKey(request, filePath), async () => {
            const limit = Math.max(1, Math.min(Number(request.body.limit ?? 20), CHAT_RANGE_LIMIT_MAX));
            const before = request.body.before;
            const beforeOffset = Number.isFinite(before) ? before : Number.isFinite(Number(before)) ? Number(before) : null;
            performanceTimer.setCounter('requested', limit);
            performanceTimer.setCounter('cursor', beforeOffset ?? 0);
            if (chatChunkingEnabled && !isChunkedChat(filePath)) {
                await convertLegacyChatToChunks(filePath);
            }
            const chunked = isChunkedChat(filePath);
            const { headerInfo, tail, headerEndOffset, index } = await performanceTimer.measureAsync('read', async () => {
                const [headerInfo, tail, headerEndOffset, index] = await Promise.all([
                    readGroupChatHeaderInfo(filePath),
                    readJsonlTail(filePath, limit, beforeOffset),
                    chunked ? Promise.resolve(0) : getHeaderEndOffset(filePath),
                    chunked ? ensureChatIndex(filePath) : Promise.resolve(null),
                ]);
                return { headerInfo, tail, headerEndOffset, index };
            });
            const messages = parseChatLines(tail.lines);
            const headerBoundary = chunked ? headerInfo.embeddedHeaderCount : headerEndOffset;
            let cursor = tail.cursor;
            if (!messages.length) {
                cursor = headerBoundary;
            }
            const hasMore = cursor > headerBoundary;
            const indexedTotal = Number(index?.message_count);
            const total = Number.isFinite(indexedTotal)
                ? Math.max(0, indexedTotal - headerInfo.embeddedHeaderCount)
                : Number.isFinite(Number(headerInfo.header?.chat_metadata?.message_count))
                    ? Math.max(0, Number(headerInfo.header.chat_metadata.message_count))
                    : null;
            const messageOffset = chunked
                ? Math.max(0, cursor - headerInfo.embeddedHeaderCount)
                : (beforeOffset === null && Number.isFinite(total) ? Math.max(0, total - messages.length) : null);
            const revision = readChatRevision(filePath);
            performanceTimer.setCounter('messages', messages.length);
            performanceTimer.setCounter('read-bytes', tail.readBytes);
            performanceTimer.setCounter('chunks', tail.chunksRead);
            performanceTimer.setCounter('next-cursor', cursor);
            performanceTimer.startPhase('serialize');
            return response.send({ header: headerInfo.header, messages, cursor, messageOffset, total, hasMore, revision });
        });
    } catch (error) {
        console.error(error);
        performanceTimer.startPhase('serialize');
        return response.status(500).send({ header: null, messages: [], cursor: 0, messageOffset: 0, total: 0, hasMore: false, revision: null });
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
        const metadataPath = getChatMetadataPath(pathToFile);
        if (fs.existsSync(metadataPath)) {
            fs.unlinkSync(metadataPath);
        }
        const indexPath = getChatIndexPath(pathToFile);
        if (fs.existsSync(indexPath)) {
            fs.unlinkSync(indexPath);
        }
        const revisionPath = getChatRevisionPath(pathToFile);
        if (fs.existsSync(revisionPath)) {
            fs.unlinkSync(revisionPath);
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
    try {
        if (!request.body || !request.body.id || !Array.isArray(request.body.chat)) {
            return response.sendStatus(400);
        }

        const id = request.body.id;
        const pathToFile = path.join(request.user.directories.groupChats, `${id}.jsonl`);
        const split = splitGroupChatData(request.body.chat);
        const header = split.header ?? {
            chat_metadata: {},
            user_name: 'unused',
            character_name: 'unused',
        };
        const messages = split.messages;
        return await chatStorageMutex.runExclusive(getChatStorageLockKey(request, pathToFile), async () => {
            const result = await persistFullChat({
                request,
                response,
                filePath: pathToFile,
                header,
                messages,
                isGroup: true,
                backupName: String(id),
            });
            return result ? response.send({ ok: true, revision: result.revision }) : response;
        });
    } catch (error) {
        console.error(error);
        return response.status(500).send({ error: 'group_chat_save_failed' });
    }
});

router.post('/group/save-tail', async (request, response) => {
    const performanceTimer = beginEndpointPerformance(request, 'group-chat-save-tail');
    performanceTimer.setCacheState('bypass');
    const stopWriteTimer = performanceTimer.startPhase('write');
    let responsePrepared = false;
    const prepareResponse = () => {
        if (responsePrepared) return;
        responsePrepared = true;
        stopWriteTimer();
        performanceTimer.startPhase('serialize');
    };
    if (!chatPagingProtocolEnabled) {
        prepareResponse();
        return response.status(404).send({ error: 'chat_paging_disabled' });
    }
    if (!request.body || !request.body.id || !Array.isArray(request.body.messages)) {
        prepareResponse();
        return response.sendStatus(400);
    }

    const id = request.body.id;
    const filePath = path.join(request.user.directories.groupChats, `${id}.jsonl`);
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
    try {
        return await chatStorageMutex.runExclusive(getChatStorageLockKey(request, filePath), async () => {
            const result = await persistChatTail({
                request,
                response,
                filePath,
                header,
                messages,
                beforeOffset,
                defaultHeader: {
                    chat_metadata: {},
                    user_name: 'unused',
                    character_name: 'unused',
                },
                isGroup: true,
                backupName: String(id),
                performanceTimer,
            });
            prepareResponse();
            return result ? response.send({ ok: true, revision: result.revision }) : response;
        });
    } catch (error) {
        console.error(error);
        prepareResponse();
        return response.status(500).send({ error: 'group_chat_tail_save_failed' });
    }
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
