import path from 'node:path';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { Buffer } from 'node:buffer';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import yaml from 'yaml';
import _ from 'lodash';
import mime from 'mime-types';
import { Jimp, JimpMime } from '../jimp.js';
import storage from 'node-persist';

import { AVATAR_WIDTH, AVATAR_HEIGHT, DEFAULT_AVATAR_PATH } from '../constants.js';
import { default as validateAvatarUrlMiddleware, getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { deepMerge, humanizedISO8601DateTime, tryParse, MemoryLimitedMap, getConfigValue, mutateJsonString, clientRelativePath, getUniqueName, sanitizeSafeCharacterReplacements } from '../util.js';
import { TavernCardValidator } from '../validator/TavernCardValidator.js';
import { CharacterCardPngError, parse, read, write } from '../character-card-parser.js';
import { readWorldInfoFile } from './worldinfo.js';
import { invalidateThumbnail } from './thumbnails.js';
import { planRisuSprites } from './sprites.js';
import { getUserDirectoriesList } from '../users.js';
import { getChatInfo, runWithChatStorageLocks } from './chats.js';
import { ensureDurableChatRecovery } from '../chat-journal.js';
import { ensureChatBranchRecovery, getChatBranchUserLockPath, hasChatBranchFamilyCollision } from '../chat-branch.js';
import { createCharacterChatTransaction, ensureCharacterChatRecovery } from '../character-chat-transaction.js';
import { ByafParser } from '../byaf.js';
import { applyCharXAssetRewrites, CharXParser, planCharXAssets } from '../charx.js';
import cacheBuster from '../middleware/cacheBuster.js';
import { canConsumeStorage } from '../storage-quota.js';
import { beginEndpointPerformance } from '../performance-monitor.js';
import { detectImageFormat } from '../media-validation.js';
import { CharacterListCache, invalidateCharacterListCache, registerCharacterListCache } from '../character-list-cache.js';
import { ArchiveReadError } from '../bounded-zip.js';
import { FileTransaction, ensureFileTransactionRecovery } from '../file-transaction.js';
import { KeyedMutex } from '../keyed-mutex.js';

// With 100 MB limit it would take roughly 3000 characters to reach this limit
const memoryCacheCapacity = getConfigValue('performance.memoryCacheCapacity', '100mb');
const memoryCache = new MemoryLimitedMap(memoryCacheCapacity);
// Some Android devices require tighter memory management
const isAndroid = process.platform === 'android';
// Use shallow character data for the character list
const useShallowCharacters = !!getConfigValue('performance.lazyLoadCharacters', false, 'boolean');
const useDiskCache = !!getConfigValue('performance.useDiskCache', true, 'boolean');
const characterListCache = new CharacterListCache({
    enabled: getConfigValue('performance.characterListCache.enabled', true, 'boolean'),
    concurrency: getConfigValue('performance.characterListCache.concurrency', 6, 'number'),
    ttlMs: getConfigValue('performance.characterListCache.ttlMs', 30_000, 'number'),
    signatureTtlMs: getConfigValue('performance.characterListCache.signatureTtlMs', 5_000, 'number'),
    maxEntries: getConfigValue('performance.characterListCache.maxEntries', 100, 'number'),
    maxBytes: getConfigValue('performance.characterListCache.maxBytes', 100 * 1024 * 1024, 'number'),
});
registerCharacterListCache(characterListCache);
const chatDirStatsCache = new Map();
const characterImportMutex = new KeyedMutex();

class CharacterImportError extends Error {
    /**
     * @param {number} status HTTP status
     * @param {string} code Stable client-facing error code
     * @param {string} publicMessage Safe client-facing message
     * @param {string} internalMessage Detailed server log message
     * @param {unknown} [cause] Original error
     */
    constructor(status, code, publicMessage, internalMessage, cause) {
        super(internalMessage, cause ? { cause } : undefined);
        this.name = 'CharacterImportError';
        this.status = status;
        this.code = code;
        this.publicMessage = publicMessage;
    }

    /**
     * @param {string} internalMessage Detailed server log message
     * @param {unknown} [cause] Original parser error
     * @returns {CharacterImportError}
     */
    static invalid(internalMessage, cause) {
        return new CharacterImportError(
            400,
            'invalid_character_card',
            'The file does not contain a valid character card. Make sure it is a character PNG, JSON, YAML, CharX, or BYAF file rather than an ordinary image.',
            internalMessage,
            cause,
        );
    }

    /**
     * @param {string} format Requested import format
     * @returns {CharacterImportError}
     */
    static unsupported(format) {
        return new CharacterImportError(
            415,
            'unsupported_character_format',
            'This character card format is not supported.',
            `Unsupported character import format: ${format || '(empty)'}`,
        );
    }

    /**
     * @param {string} internalMessage Detailed server log message
     * @returns {CharacterImportError}
     */
    static writeFailed(internalMessage) {
        return new CharacterImportError(
            500,
            'character_write_failed',
            'The character card was parsed, but the server could not save it.',
            internalMessage,
        );
    }

    static storageLimit(result) {
        const error = new CharacterImportError(
            507,
            'storage_limit',
            'There is not enough storage space to import this character card.',
            'Character import exceeds the user storage quota.',
        );
        error.storage = result;
        return error;
    }
}

/**
 * Converts an unexpected import exception to a safe HTTP error.
 * @param {unknown} error Import exception
 * @returns {CharacterImportError}
 */
function normalizeCharacterImportError(error) {
    if (error instanceof CharacterImportError) {
        return error;
    }
    if (error instanceof ArchiveReadError) {
        return new CharacterImportError(
            error.status,
            error.code,
            error.status === 413
                ? 'The character archive exceeds the configured extraction limits.'
                : 'The uploaded character archive is invalid.',
            error.message,
            error,
        );
    }
    if (error instanceof CharacterCardPngError && ['metadata_limit_exceeded', 'metadata_chunk_limit_exceeded'].includes(error.code)) {
        return new CharacterImportError(
            413,
            'character_metadata_too_large',
            'The PNG character metadata exceeds the configured limit.',
            error.message,
            error,
        );
    }
    if (error instanceof CharacterCardPngError || error instanceof SyntaxError || error?.name === 'YAMLParseError') {
        return CharacterImportError.invalid('Failed to parse character card data.', error);
    }
    if (['ENOSPC', 'EDQUOT'].includes(error?.code)) {
        return new CharacterImportError(
            507,
            'storage_write_failed',
            'The server does not have enough storage space to save this character card.',
            'Character import failed because the filesystem has no available space.',
            error,
        );
    }

    return new CharacterImportError(
        500,
        'character_import_failed',
        'The server could not import the character card. Please try again or contact the administrator.',
        'Unexpected character import failure.',
        error,
    );
}

/**
 * Removes an uploaded temporary file without masking the original request result.
 * @param {string|null} uploadPath Temporary upload path
 * @returns {Promise<void>}
 */
async function cleanupUploadedFile(uploadPath) {
    if (!uploadPath) {
        return;
    }
    try {
        await fsPromises.rm(uploadPath, { force: true });
    } catch (error) {
        console.warn(`Failed to clean up uploaded character file: ${path.basename(uploadPath)}`, error);
    }
}

async function ensureCharacterStorageCapacity(request, response, additionalBytes) {
    const storageCheck = request.characterImportStorageCheck ?? canConsumeStorage;
    const result = await storageCheck(request.user.profile, request.user.directories, additionalBytes);
    if (!result.allowed) {
        return response.status(507).json({
            error: 'storage_limit',
            message: '存储空间不足，无法保存角色卡，请删除角色或使用激活码扩容。',
            usedBytes: result.usedBytes,
            limitBytes: result.limitBytes,
            remainingBytes: result.remainingBytes,
        });
    }

    return null;
}

async function getCharacterWriteDelta(outputImagePath, outputImage) {
    let previousBytes = 0;
    try {
        const stats = await fsPromises.stat(outputImagePath);
        if (!stats.isFile()) {
            throw new Error(`Character target is not a file: ${outputImagePath}`);
        }
        previousBytes = stats.size;
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    return Math.max(0, outputImage.length - previousBytes);
}

async function ensureCharacterStorageRecovery(request, root) {
    let changed = false;
    const record = (result) => {
        changed ||= result.restored > 0 || result.cleaned > 0;
    };

    try {
        record(await ensureFileTransactionRecovery(root, request.user.profile.handle));
        record(ensureDurableChatRecovery(root, request.user.profile.handle));
        record(ensureChatBranchRecovery(root, request.user.profile.handle, request.user.directories));
        record(ensureCharacterChatRecovery(root, request.user.profile.handle, request.user.directories));
    } catch (error) {
        invalidateCharacterListCache(request.user.profile.handle);
        throw error;
    }

    if (changed) {
        invalidateCharacterListCache(request.user.profile.handle);
    }
}

async function runWithCharacterRootLock(request, callback) {
    const root = path.resolve(request.user.directories.root);
    return await runWithChatStorageLocks(request, [getChatBranchUserLockPath(root)], async () => {
        await ensureCharacterStorageRecovery(request, root);
        return await callback(root);
    });
}

class DiskCache {
    /**
     * @type {string}
     * @readonly
     */
    static DIRECTORY = 'characters';

    /**
     * @type {number}
     * @readonly
     */
    static SYNC_INTERVAL = 5 * 60 * 1000;

    /** @type {import('node-persist').LocalStorage} */
    #instance;

    /** @type {NodeJS.Timeout} */
    #syncInterval;

    /**
     * Queue of user handles to sync.
     * @type {Set<string>}
     * @readonly
     */
    syncQueue = new Set();

    /**
     * Path to the cache directory.
     * @returns {string}
     */
    get cachePath() {
        return path.join(globalThis.DATA_ROOT, '_cache', DiskCache.DIRECTORY);
    }

    /**
     * Returns the list of hashed keys in the cache.
     * @returns {string[]}
     */
    get hashedKeys() {
        return fs.readdirSync(this.cachePath, { withFileTypes: true })
            .filter(entry => entry.isFile())
            .map(entry => entry.name);
    }

    /**
     * Processes the synchronization queue.
     * @returns {Promise<void>}
     */
    async #syncCacheEntries() {
        try {
            if (!useDiskCache || this.syncQueue.size === 0) {
                return;
            }

            // Cache files are shared by all users. Verifying only the users in
            // the queue would make every other user's valid cache look stale.
            this.syncQueue.clear();
            const directories = await getUserDirectoriesList();
            await this.verify(directories);
        } catch (error) {
            console.error('Error while synchronizing cache entries:', error);
        }
    }

    /**
     * Gets the disk cache instance.
     * @returns {Promise<import('node-persist').LocalStorage>}
     */
    async instance() {
        if (this.#instance) {
            return this.#instance;
        }

        this.#instance = storage.create({
            dir: this.cachePath,
            ttl: false,
            forgiveParseErrors: true,
            expiredInterval: 0,
            // @ts-ignore
            maxFileDescriptors: 100,
        });
        await this.#instance.init();
        this.#syncInterval = setInterval(this.#syncCacheEntries.bind(this), DiskCache.SYNC_INTERVAL);
        return this.#instance;
    }

    /**
     * Verifies disk cache size and prunes it if necessary.
     * @param {import('../users.js').UserDirectoryList[]} directoriesList List of user directories
     * @returns {Promise<void>}
     */
    async verify(directoriesList) {
        try {
            if (!useDiskCache) {
                return;
            }

            const cache = await this.instance();
            const validKeys = new Set();
            for (const dir of directoriesList) {
                const files = fs.readdirSync(dir.characters, { withFileTypes: true });
                for (const file of files.filter(f => f.isFile() && path.extname(f.name) === '.png')) {
                    const filePath = path.join(dir.characters, file.name);
                    const cacheKey = getCacheKey(filePath);
                    validKeys.add(path.parse(cache.getDatumPath(cacheKey)).base);
                }
            }
            const staleKeys = this.hashedKeys.filter(key => !validKeys.has(key));
            const batchSize = 64;
            let removed = 0;

            for (let index = 0; index < staleKeys.length; index += batchSize) {
                const batch = staleKeys.slice(index, index + batchSize);
                await Promise.all(batch.map(async key => {
                    // node-persist filenames are already SHA-256 hashes. Passing
                    // one to removeItem() hashes it a second time and leaves the
                    // original cache file behind, so remove the resolved file.
                    const cacheFile = path.join(this.cachePath, key);
                    try {
                        await fsPromises.unlink(cacheFile);
                        removed++;
                    } catch (error) {
                        if (error?.code !== 'ENOENT') {
                            throw error;
                        }
                    }
                }));
            }

            if (removed > 0) {
                console.info(`[Character cache] Pruned ${removed} stale disk cache entries.`);
            }
        } catch (error) {
            console.error('Error while verifying disk cache:', error);
        }
    }

    dispose() {
        if (this.#syncInterval) {
            clearInterval(this.#syncInterval);
        }
    }
}

export const diskCache = new DiskCache();

/**
 * Gets the cache key for the specified image file.
 * @param {string} inputFile - Path to the image file
 * @returns {string} - Cache key
 */
function getCacheKey(inputFile) {
    if (fs.existsSync(inputFile)) {
        const stat = fs.statSync(inputFile);
        return `${inputFile}-${stat.mtimeMs}`;
    }

    return inputFile;
}

/**
 * Reads the character card from the specified image file.
 * @param {string} inputFile - Path to the image file
 * @param {string} inputFormat - 'png'
 * @param {((state: string) => void)|null} cacheObserver Cache state observer
 * @returns {Promise<string | undefined>} - Character card data
 */
async function readCharacterData(inputFile, inputFormat = 'png', cacheObserver = null) {
    const cacheKey = getCacheKey(inputFile);
    if (memoryCache.has(cacheKey)) {
        cacheObserver?.('memory-hit');
        return memoryCache.get(cacheKey);
    }
    if (useDiskCache) {
        try {
            const cache = await diskCache.instance();
            const cachedData = await cache.getItem(cacheKey);
            if (cachedData) {
                cacheObserver?.('disk-hit');
                return cachedData;
            }
        } catch (error) {
            console.warn('Error while reading from disk cache:', error);
        }
    }

    cacheObserver?.('miss');
    const result = await parse(inputFile, inputFormat);
    !isAndroid && memoryCache.set(cacheKey, result);
    if (useDiskCache) {
        try {
            const cache = await diskCache.instance();
            await cache.setItem(cacheKey, result);
        } catch (error) {
            console.warn('Error while writing to disk cache:', error);
        }
    }
    return result;
}

/**
 * Writes the character card to the specified image file.
 * @param {string|Buffer} inputFile - Path to the image file or image buffer
 * @param {string} data - Character card data
 * @param {string} outputFile - Target image file name
 * @param {import('express').Request} request - Express request obejct
 * @param {Crop|undefined} crop - Crop parameters
 * @returns {Promise<boolean>} - True if the operation was successful
 */
async function buildCharacterPng(inputFile, data, crop = undefined) {
    let inputImage;
    try {
        inputImage = Buffer.isBuffer(inputFile)
            ? await parseImageBuffer(inputFile, crop)
            : await tryReadImage(inputFile, crop);
    } catch (error) {
        const message = Buffer.isBuffer(inputFile) ? 'Failed to read image buffer.' : `Failed to read image: ${inputFile}.`;
        console.warn(message, 'Using a fallback image.', error);
        inputImage = await fs.promises.readFile(DEFAULT_AVATAR_PATH);
    }
    return write(inputImage, data);
}

function invalidateCharacterDataCache(inputFile, request) {
    for (const key of memoryCache.keys()) {
        if (Buffer.isBuffer(inputFile)) {
            break;
        }
        if (key.startsWith(inputFile)) {
            memoryCache.delete(key);
            break;
        }
    }
    if (useDiskCache && !Buffer.isBuffer(inputFile)) {
        diskCache.syncQueue.add(request.user.profile.handle);
    }
}

async function writeCharacterData(inputFile, data, outputFile, request, crop = undefined, preparedOutputImage = undefined) {
    try {
        invalidateCharacterDataCache(inputFile, request);
        const outputImage = preparedOutputImage ?? await buildCharacterPng(inputFile, data, crop);
        const outputImagePath = path.join(request.user.directories.characters, `${outputFile}.png`);
        const writeCharacterFile = request.characterImportWriteFileAtomicSync ?? writeFileAtomicSync;

        writeCharacterFile(outputImagePath, outputImage);
        invalidateCharacterListCache(request.user.profile.handle);
        return true;
    } catch (err) {
        console.error(err);
        return false;
    }
}

async function prepareCharacterWrite(inputFile, data, outputFile, request, crop = undefined) {
    const outputImage = await buildCharacterPng(inputFile, data, crop);
    const outputImagePath = path.join(request.user.directories.characters, `${outputFile}.png`);
    const additionalBytes = await getCharacterWriteDelta(outputImagePath, outputImage);
    return { inputFile, data, outputFile, crop, outputImage, outputImagePath, additionalBytes, request };
}

async function commitPreparedCharacterWrite(prepared) {
    return await writeCharacterData(
        prepared.inputFile,
        prepared.data,
        prepared.outputFile,
        prepared.request,
        prepared.crop,
        prepared.outputImage,
    );
}

/**
 * @typedef {Object} Crop
 * @property {number} x X-coordinate
 * @property {number} y Y-coordinate
 * @property {number} width Width
 * @property {number} height Height
 * @property {boolean} want_resize Resize the image to the standard avatar size
 */

/**
 * Applies avatar crop and resize operations to an image.
 * I couldn't fix the type issue, so the first argument has {any} type.
 * @param {object} jimp Jimp image instance
 * @param {Crop|undefined} [crop] Crop parameters
 * @returns {Promise<Buffer>} Processed image buffer
 */
export async function applyAvatarCropResize(jimp, crop) {
    if (!(jimp instanceof Jimp)) {
        throw new TypeError('Expected a Jimp instance');
    }

    const image = /** @type {InstanceType<typeof Jimp>} */ (jimp);
    let finalWidth = image.bitmap.width, finalHeight = image.bitmap.height;

    // Apply crop if defined
    if (typeof crop == 'object' && [crop.x, crop.y, crop.width, crop.height].every(x => typeof x === 'number')) {
        image.crop({ x: crop.x, y: crop.y, w: crop.width, h: crop.height });
        // Apply standard resize if requested
        if (crop.want_resize) {
            finalWidth = AVATAR_WIDTH;
            finalHeight = AVATAR_HEIGHT;
        } else {
            finalWidth = crop.width;
            finalHeight = crop.height;
        }
    }

    image.cover({ w: finalWidth, h: finalHeight });
    return await image.getBuffer(JimpMime.png);
}

/**
 * Parses an image buffer and applies crop if defined.
 * @param {Buffer} buffer Buffer of the image
 * @param {Crop|undefined} [crop] Crop parameters
 * @returns {Promise<Buffer>} Image buffer
 */
async function parseImageBuffer(buffer, crop) {
    if (crop == null && detectImageFormat(buffer)?.extension === 'png') {
        return buffer;
    }
    const image = await Jimp.fromBuffer(buffer);
    return await applyAvatarCropResize(image, crop);
}

function getCharacterArchiveLimits() {
    return {
        maxEntries: getConfigValue('imports.archive.maxEntries', 1024, 'number'),
        maxEntryBytes: getConfigValue('imports.archive.maxEntryBytes', 128 * 1024 * 1024, 'number'),
        maxTotalBytes: getConfigValue('imports.archive.maxTotalBytes', 256 * 1024 * 1024, 'number'),
        maxCompressionRatio: getConfigValue('imports.archive.maxCompressionRatio', 200, 'number'),
    };
}

async function commitCharacterImportTransaction(transaction, request) {
    const additionalBytes = await transaction.getAdditionalBytes();
    const storageCheck = request.characterImportStorageCheck ?? canConsumeStorage;
    const quota = await storageCheck(request.user.profile, request.user.directories, additionalBytes);
    if (!quota.allowed) {
        throw CharacterImportError.storageLimit(quota);
    }
    await transaction.commit();
    invalidateCharacterListCache(request.user.profile.handle);
}

async function saveCharacterImport(inputFile, data, fileName, request, crop = undefined, risuPlan = null) {
    const transaction = new FileTransaction(request.user.directories.root, {
        ...request.characterImportTransactionOptions,
        handle: request.user.profile.handle,
    });
    const savedCardPath = path.join(request.user.directories.characters, `${fileName}.png`);
    try {
        for (const sprite of risuPlan?.writes ?? []) {
            await transaction.stageFile(sprite.filePath, sprite.buffer);
        }
        const characterPng = await buildCharacterPng(inputFile, data, crop);
        await transaction.stageFile(savedCardPath, characterPng);
        await commitCharacterImportTransaction(transaction, request);
    } finally {
        await transaction.dispose();
    }
    invalidateCharacterDataCache(savedCardPath, request);
}

/**
 * Reads an image file and applies crop if defined.
 * @param {string} imgPath Path to the image file
 * @param {Crop|undefined} crop Crop parameters
 * @returns {Promise<Buffer>} Image buffer
 */
async function tryReadImage(imgPath, crop) {
    const imageBuffer = fs.readFileSync(imgPath);
    if (crop == null && detectImageFormat(imageBuffer)?.extension === 'png') {
        return imageBuffer;
    }

    try {
        const rawImg = await Jimp.read(imgPath);
        return await applyAvatarCropResize(rawImg, crop);
    }
    // If it's an unsupported type of image (APNG) - just read the file as buffer
    catch (error) {
        console.error(`Failed to read image: ${imgPath}`, error);
        return imageBuffer;
    }
}

/**
 * calculateChatSize - Calculates the total chat size for a given character.
 *
 * @param  {string} charDir The directory where the chats are stored.
 * @return { {chatSize: number, dateLastChat: number} }         The total chat size.
 */
const calculateChatSize = (charDir) => {
    let chatSize = 0;
    let dateLastChat = 0;

    if (!fs.existsSync(charDir)) {
        return { chatSize, dateLastChat };
    }

    try {
        const dirStat = fs.statSync(charDir);
        const cached = chatDirStatsCache.get(charDir);
        if (cached && cached.dirMtimeMs === dirStat.mtimeMs) {
            return { chatSize: cached.chatSize, dateLastChat: cached.dateLastChat };
        }

        const chats = fs.readdirSync(charDir, { withFileTypes: true });
        if (Array.isArray(chats) && chats.length) {
            for (const entry of chats) {
                const entryPath = path.join(charDir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name.endsWith('.jsonl.chunks')) {
                        const shardFiles = fs.readdirSync(entryPath);
                        for (const shard of shardFiles) {
                            const shardStat = fs.statSync(path.join(entryPath, shard));
                            chatSize += shardStat.size;
                            dateLastChat = Math.max(dateLastChat, shardStat.mtimeMs);
                        }
                    }
                    continue;
                }

                const chatStat = fs.statSync(entryPath);
                chatSize += chatStat.size;
                dateLastChat = Math.max(dateLastChat, chatStat.mtimeMs);
            }
        }

        chatDirStatsCache.set(charDir, {
            dirMtimeMs: dirStat.mtimeMs,
            chatSize,
            dateLastChat,
        });
    } catch (error) {
        console.warn('Failed to read chat stats for', charDir, error);
    }

    return { chatSize, dateLastChat };
};

// Calculate the total string length of the data object
const calculateDataSize = (data) => {
    return typeof data === 'object' ? Object.values(data).reduce((acc, val) => acc + String(val).length, 0) : 0;
};

/**
 * Only get fields that are used to display the character list.
 * @param {object} character Character object
 * @returns {{shallow: true, [key: string]: any}} Shallow character
 */
const toShallow = (character) => {
    return {
        shallow: true,
        name: character.name,
        avatar: character.avatar,
        chat: character.chat,
        fav: character.fav,
        date_added: character.date_added,
        create_date: character.create_date,
        date_last_chat: character.date_last_chat,
        chat_size: character.chat_size,
        data_size: character.data_size,
        tags: character.tags,
        data: {
            name: _.get(character, 'data.name', ''),
            character_version: _.get(character, 'data.character_version', ''),
            creator: _.get(character, 'data.creator', ''),
            creator_notes: _.get(character, 'data.creator_notes', ''),
            tags: _.get(character, 'data.tags', []),
            extensions: {
                fav: _.get(character, 'data.extensions.fav', false),
            },
        },
    };
};

/**
 * processCharacter - Process a given character, read its data and calculate its statistics.
 *
 * @param  {string} item The name of the character.
 * @param  {import('../users.js').UserDirectoryList} directories User directories
 * @param  {object} options Options for the character processing
 * @param  {boolean} options.shallow If true, only return the core character's metadata
 * @param  {((state: string) => void)|null} [options.cacheObserver] Cache state observer
 * @return {Promise<object>}     A Promise that resolves when the character processing is done.
 */
const processCharacter = async (item, directories, { shallow, cacheObserver = null }) => {
    try {
        const imgFile = path.join(directories.characters, item);
        const imgData = await readCharacterData(imgFile, 'png', cacheObserver);
        if (imgData === undefined) throw new Error('Failed to read character file');

        let jsonObject = getCharaCardV2(JSON.parse(imgData), directories, false);
        jsonObject.avatar = item;
        const character = jsonObject;
        character['json_data'] = imgData;
        const charStat = fs.statSync(path.join(directories.characters, item));
        character['date_added'] = charStat.ctimeMs;
        character['create_date'] = jsonObject['create_date'] || humanizedISO8601DateTime(charStat.ctimeMs);
        const chatsDirectory = path.join(directories.chats, item.replace('.png', ''));

        const { chatSize, dateLastChat } = calculateChatSize(chatsDirectory);
        character['chat_size'] = chatSize;
        character['date_last_chat'] = dateLastChat;
        character['data_size'] = calculateDataSize(jsonObject?.data);
        return shallow ? toShallow(character) : character;
    }
    catch (err) {
        console.error(`Could not process character: ${item}`);

        if (err instanceof SyntaxError) {
            console.error(`${item} does not contain a valid JSON object.`);
        } else {
            console.error('An unexpected error occurred: ', err);
        }

        return {
            date_added: 0,
            date_last_chat: 0,
            chat_size: 0,
        };
    }
};

/**
 * Convert a character object to Spec V2 format.
 * @param {object} jsonObject Character object
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {boolean} hoistDate Will set the chat and create_date fields to the current date if they are missing
 * @returns {object} Character object in Spec V2 format
 */
function getCharaCardV2(jsonObject, directories, hoistDate = true) {
    if (jsonObject.spec === undefined) {
        jsonObject = convertToV2(jsonObject, directories);

        if (hoistDate && !jsonObject.create_date) {
            jsonObject.create_date = humanizedISO8601DateTime();
        }
    } else {
        jsonObject = readFromV2(jsonObject);
    }
    return jsonObject;
}

/**
 * Convert a character object to Spec V2 format.
 * @param {object} char Character object
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {object} Character object in Spec V2 format
 */
function convertToV2(char, directories) {
    // Simulate incoming data from frontend form
    const result = charaFormatData({
        json_data: JSON.stringify(char),
        ch_name: char.name,
        description: char.description,
        personality: char.personality,
        scenario: char.scenario,
        first_mes: char.first_mes,
        mes_example: char.mes_example,
        creator_notes: char.creatorcomment,
        talkativeness: char.talkativeness,
        fav: char.fav,
        creator: char.creator,
        tags: char.tags,
        depth_prompt_prompt: char.depth_prompt_prompt,
        depth_prompt_depth: char.depth_prompt_depth,
        depth_prompt_role: char.depth_prompt_role,
    }, directories);

    result.chat = char.chat ?? humanizedISO8601DateTime();
    result.create_date = char.create_date;

    return result;
}

/**
 * Removes fields that are not meant to be shared.
 */
function unsetPrivateFields(char) {
    _.set(char, 'fav', false);
    _.set(char, 'data.extensions.fav', false);
    _.unset(char, 'chat');
}

function readFromV2(char) {
    if (_.isUndefined(char.data)) {
        console.warn(`Char ${char['name']} has Spec v2 data missing`);
        return char;
    }

    // If 'json_data' was already saved, don't let it propagate
    _.unset(char, 'json_data');

    const fieldMappings = {
        name: 'name',
        description: 'description',
        personality: 'personality',
        scenario: 'scenario',
        first_mes: 'first_mes',
        mes_example: 'mes_example',
        talkativeness: 'extensions.talkativeness',
        fav: 'extensions.fav',
        tags: 'tags',
    };

    _.forEach(fieldMappings, (v2Path, charField) => {
        //console.info(`Migrating field: ${charField} from ${v2Path}`);
        const v2Value = _.get(char.data, v2Path);
        if (_.isUndefined(v2Value)) {
            let defaultValue = undefined;

            // Backfill default values for missing ST extension fields
            if (v2Path === 'extensions.talkativeness') {
                defaultValue = 0.5;
            }

            if (v2Path === 'extensions.fav') {
                defaultValue = false;
            }

            if (!_.isUndefined(defaultValue)) {
                //console.warn(`Spec v2 extension data missing for field: ${charField}, using default value: ${defaultValue}`);
                char[charField] = defaultValue;
            } else {
                console.warn(`Char ${char['name']} has Spec v2 data missing for unknown field: ${charField}`);
                return;
            }
        }
        if (!_.isUndefined(char[charField]) && !_.isUndefined(v2Value) && String(char[charField]) !== String(v2Value)) {
            console.warn(`Char ${char['name']} has Spec v2 data mismatch with Spec v1 for field: ${charField}`, char[charField], v2Value);
        }
        char[charField] = v2Value;
    });

    char['chat'] = char['chat'] ?? humanizedISO8601DateTime();

    return char;
}

/**
 * Format character data to Spec V2 format.
 * @param {object} data Character data
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns
 */
function charaFormatData(data, directories) {
    // This is supposed to save all the foreign keys that ST doesn't care about
    const char = tryParse(data.json_data) || {};

    // Prevent erroneous 'json_data' recursive saving
    _.unset(char, 'json_data');

    // Checks if data.alternate_greetings is an array, a string, or neither, and acts accordingly. (expected to be an array of strings)
    const getAlternateGreetings = data => {
        if (Array.isArray(data.alternate_greetings)) return data.alternate_greetings;
        if (typeof data.alternate_greetings === 'string') return [data.alternate_greetings];
        return [];
    };

    // Spec V1 fields
    _.set(char, 'name', data.ch_name);
    _.set(char, 'description', data.description || '');
    _.set(char, 'personality', data.personality || '');
    _.set(char, 'scenario', data.scenario || '');
    _.set(char, 'first_mes', data.first_mes || '');
    _.set(char, 'mes_example', data.mes_example || '');

    // Old ST extension fields (for backward compatibility, will be deprecated)
    _.set(char, 'creatorcomment', data.creator_notes || '');
    _.set(char, 'avatar', 'none');
    _.set(char, 'chat', data.ch_name + ' - ' + humanizedISO8601DateTime());
    _.set(char, 'talkativeness', data.talkativeness || 0.5);
    _.set(char, 'fav', data.fav == 'true');
    _.set(char, 'tags', typeof data.tags == 'string' ? (data.tags.split(',').map(x => x.trim()).filter(x => x)) : data.tags || []);

    // Spec V2 fields
    _.set(char, 'spec', 'chara_card_v2');
    _.set(char, 'spec_version', '2.0');
    _.set(char, 'data.name', data.ch_name);
    _.set(char, 'data.description', data.description || '');
    _.set(char, 'data.personality', data.personality || '');
    _.set(char, 'data.scenario', data.scenario || '');
    _.set(char, 'data.first_mes', data.first_mes || '');
    _.set(char, 'data.mes_example', data.mes_example || '');

    // New V2 fields
    _.set(char, 'data.creator_notes', data.creator_notes || '');
    _.set(char, 'data.system_prompt', data.system_prompt || '');
    _.set(char, 'data.post_history_instructions', data.post_history_instructions || '');
    _.set(char, 'data.tags', typeof data.tags == 'string' ? (data.tags.split(',').map(x => x.trim()).filter(x => x)) : data.tags || []);
    _.set(char, 'data.creator', data.creator || '');
    _.set(char, 'data.character_version', data.character_version || '');
    _.set(char, 'data.alternate_greetings', getAlternateGreetings(data));

    // ST extension fields to V2 object
    _.set(char, 'data.extensions.talkativeness', data.talkativeness || 0.5);
    _.set(char, 'data.extensions.fav', data.fav == 'true');
    _.set(char, 'data.extensions.world', data.world || '');

    // Spec extension: depth prompt
    const depth_default = 4;
    const role_default = 'system';
    const depth_value = !isNaN(Number(data.depth_prompt_depth)) ? Number(data.depth_prompt_depth) : depth_default;
    const role_value = data.depth_prompt_role ?? role_default;
    _.set(char, 'data.extensions.depth_prompt.prompt', data.depth_prompt_prompt ?? '');
    _.set(char, 'data.extensions.depth_prompt.depth', depth_value);
    _.set(char, 'data.extensions.depth_prompt.role', role_value);
    //_.set(char, 'data.extensions.create_date', humanizedISO8601DateTime());
    //_.set(char, 'data.extensions.avatar', 'none');
    //_.set(char, 'data.extensions.chat', data.ch_name + ' - ' + humanizedISO8601DateTime());

    // V3 fields
    _.set(char, 'data.group_only_greetings', data.group_only_greetings ?? []);

    if (data.world) {
        try {
            const file = readWorldInfoFile(directories, data.world, false);

            // File was imported - save it to the character book
            if (file && file.originalData) {
                _.set(char, 'data.character_book', file.originalData);
            }

            // File was not imported - convert the world info to the character book
            if (file && file.entries) {
                _.set(char, 'data.character_book', convertWorldInfoToCharacterBook(data.world, file.entries));
            }

        } catch {
            console.warn(`Failed to read world info file: ${data.world}. Character book will not be available.`);
        }
    }

    if (data.extensions) {
        try {
            const extensions = JSON.parse(data.extensions);
            // Deep merge the extensions object
            _.set(char, 'data.extensions', deepMerge(char.data.extensions, extensions));
        } catch {
            console.warn(`Failed to parse extensions JSON: ${data.extensions}`);
        }
    }

    return char;
}

/**
 * @param {string} name Name of World Info file
 * @param {object} entries Entries object
 */
function convertWorldInfoToCharacterBook(name, entries) {
    /** @type {{ entries: object[]; name: string }} */
    const result = { entries: [], name };

    for (const index in entries) {
        const entry = entries[index];

        const originalEntry = {
            id: entry.uid,
            keys: entry.key,
            secondary_keys: entry.keysecondary,
            comment: entry.comment,
            content: entry.content,
            constant: entry.constant,
            selective: entry.selective,
            insertion_order: entry.order,
            enabled: !entry.disable,
            position: entry.position == 0 ? 'before_char' : 'after_char',
            use_regex: true, // ST keys are always regex
            extensions: {
                ...entry.extensions,
                position: entry.position,
                exclude_recursion: entry.excludeRecursion,
                display_index: entry.displayIndex,
                probability: entry.probability ?? null,
                useProbability: entry.useProbability ?? false,
                depth: entry.depth ?? 4,
                selectiveLogic: entry.selectiveLogic ?? 0,
                outlet_name: entry.outletName ?? '',
                group: entry.group ?? '',
                group_override: entry.groupOverride ?? false,
                group_weight: entry.groupWeight ?? null,
                prevent_recursion: entry.preventRecursion ?? false,
                delay_until_recursion: entry.delayUntilRecursion ?? false,
                scan_depth: entry.scanDepth ?? null,
                match_whole_words: entry.matchWholeWords ?? null,
                use_group_scoring: entry.useGroupScoring ?? false,
                case_sensitive: entry.caseSensitive ?? null,
                automation_id: entry.automationId ?? '',
                role: entry.role ?? 0,
                vectorized: entry.vectorized ?? false,
                sticky: entry.sticky ?? null,
                cooldown: entry.cooldown ?? null,
                delay: entry.delay ?? null,
                match_persona_description: entry.matchPersonaDescription ?? false,
                match_character_description: entry.matchCharacterDescription ?? false,
                match_character_personality: entry.matchCharacterPersonality ?? false,
                match_character_depth_prompt: entry.matchCharacterDepthPrompt ?? false,
                match_scenario: entry.matchScenario ?? false,
                match_creator_notes: entry.matchCreatorNotes ?? false,
                triggers: entry.triggers ?? [],
                ignore_budget: entry.ignoreBudget ?? false,
            },
        };

        result.entries.push(originalEntry);
    }

    return result;
}

/**
 * Import a character from a YAML file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response }} context Express request and response objects
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromYaml(uploadPath, context, preservedFileName) {
    const fileText = fs.readFileSync(uploadPath, 'utf8');
    let yamlData;
    try {
        yamlData = yaml.parse(fileText);
    } catch (error) {
        throw CharacterImportError.invalid('Failed to parse YAML character card.', error);
    }
    if (!yamlData || typeof yamlData !== 'object' || typeof yamlData.name !== 'string') {
        throw CharacterImportError.invalid('YAML character card is missing a valid name.');
    }
    console.info('Importing from YAML');
    yamlData.name = sanitize(yamlData.name);
    if (!yamlData.name) {
        throw CharacterImportError.invalid('YAML character card name is empty after sanitization.');
    }
    const fileName = preservedFileName || getPngName(yamlData.name, context.request.user.directories);
    let char = convertToV2({
        'name': yamlData.name,
        'description': yamlData.context ?? '',
        'first_mes': yamlData.greeting ?? '',
        'create_date': humanizedISO8601DateTime(),
        'chat': `${yamlData.name} - ${humanizedISO8601DateTime()}`,
        'personality': '',
        'creatorcomment': '',
        'avatar': 'none',
        'mes_example': '',
        'scenario': '',
        'talkativeness': 0.5,
        'creator': '',
        'tags': '',
    }, context.request.user.directories);
    await saveCharacterImport(DEFAULT_AVATAR_PATH, JSON.stringify(char), fileName, context.request);
    return fileName;
}

/**
 * Imports a character card from CharX (ZIP) file.
 * @param {string} uploadPath
 * @param {object} params
 * @param {import('express').Request} params.request
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromCharX(uploadPath, { request }, preservedFileName) {
    const fileBuffer = fs.readFileSync(uploadPath);
    // Create a properly-sized ArrayBuffer (Node's buffer pool can cause oversized .buffer)
    const data = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);

    const parser = new CharXParser(data, getCharacterArchiveLimits());
    let parsed;
    try {
        parsed = await parser.parse();
    } catch (error) {
        if (error instanceof ArchiveReadError) {
            throw error;
        }
        throw CharacterImportError.invalid('Failed to parse CharX character card.', error);
    }
    const { card, avatar, auxiliaryAssets, extractedBuffers } = parsed;

    // Apply standard character transformations
    let processedCard = readFromV2(card);
    unsetPrivateFields(processedCard);
    processedCard['create_date'] = humanizedISO8601DateTime();
    processedCard.name = sanitize(String(processedCard.name || ''));
    if (!processedCard.name) {
        throw CharacterImportError.invalid('CharX character card is missing a valid name.');
    }

    const fileName = preservedFileName || getPngName(processedCard.name, request.user.directories);
    const characterFolder = processedCard.name;
    const hasSprites = auxiliaryAssets.some(asset => asset.storageCategory === 'sprite');
    if (hasSprites) {
        // New CharX imports use the unique internal card name for sprites. The
        // client reads this marker while legacy cards keep their display-name folder.
        _.set(processedCard, 'data.extensions.sillytavern.charx_sprite_folder', fileName);
    }

    const assetPlan = planCharXAssets(auxiliaryAssets, extractedBuffers, request.user.directories, {
        characterFolder,
        assetFolder: fileName,
        spriteFolder: fileName,
    });
    applyCharXAssetRewrites(processedCard, assetPlan.summary.rewrites);

    const transaction = new FileTransaction(request.user.directories.root, {
        ...request.characterImportTransactionOptions,
        handle: request.user.profile.handle,
    });
    const savedCardPath = path.join(request.user.directories.characters, `${fileName}.png`);
    try {
        for (const writePlan of assetPlan.writes) {
            await transaction.stageFile(writePlan.filePath, writePlan.buffer);
        }
        for (const removal of assetPlan.removals) {
            transaction.removeFile(removal);
        }
        const characterPng = await buildCharacterPng(avatar, JSON.stringify(processedCard));
        await transaction.stageFile(savedCardPath, characterPng);
        await commitCharacterImportTransaction(transaction, request);
    } finally {
        await transaction.dispose();
    }

    request.characterImportBackgrounds = assetPlan.summary.backgrounds;
    invalidateCharacterDataCache(savedCardPath, request);
    if (assetPlan.summary.sprites || assetPlan.summary.backgrounds || assetPlan.summary.misc) {
        console.log(`CharX: Imported ${assetPlan.summary.sprites} sprite(s), ${assetPlan.summary.backgrounds} background(s), ${assetPlan.summary.misc} misc asset(s) for ${characterFolder}`);
    }

    return fileName;
}

async function importFromByaf(uploadPath, { request }, preservedFileName) {
    const fileBuffer = await fsPromises.readFile(uploadPath);
    const data = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
    console.info('Importing from BYAF');

    let byafData;
    try {
        byafData = await new ByafParser(data, getCharacterArchiveLimits()).parse();
    } catch (error) {
        if (error instanceof ArchiveReadError) {
            throw error;
        }
        throw CharacterImportError.invalid('Failed to parse BYAF character card.', error);
    }
    const card = readFromV2(byafData.card);
    const fileName = preservedFileName || getPngName(sanitize(byafData.character.displayName || card.name, { replacement: sanitizeSafeCharacterReplacements }), request.user.directories);
    const transaction = new FileTransaction(request.user.directories.root, {
        ...request.characterImportTransactionOptions,
        handle: request.user.profile.handle,
    });
    const savedCardPath = path.join(request.user.directories.characters, `${fileName}.png`);

    try {
        // Don't import chats and images if the character is being replaced or updated.
        if (!preservedFileName) {
            const reservedPaths = new Set();
            const reserveUniquePath = (directory, baseName, extension) => {
                const uniqueName = getUniqueName(baseName, name => {
                    const candidate = path.join(directory, `${name}${extension}`);
                    const hasDiskCollision = extension === '.jsonl'
                        ? hasChatBranchFamilyCollision(candidate)
                        : fs.existsSync(candidate);
                    return hasDiskCollision || reservedPaths.has(path.resolve(candidate));
                });
                const candidate = path.join(directory, `${uniqueName}${extension}`);
                reservedPaths.add(path.resolve(candidate));
                return candidate;
            };

            for (const bg of byafData.chatBackgrounds) {
                if (!Buffer.isBuffer(bg.data)) {
                    continue;
                }
                const format = detectImageFormat(bg.data);
                if (!format) {
                    throw CharacterImportError.invalid('BYAF archive contains an invalid background image.');
                }
                const directory = path.join(request.user.directories.userImages, fileName);
                const targetPath = reserveUniquePath(directory, `${path.basename(fileName)}_bg`, `.${format.extension}`);
                await transaction.stageFile(targetPath, bg.data);
                bg.name = clientRelativePath(request.user.directories.root, targetPath);
            }

            const chats = [];
            if (Array.isArray(byafData.scenarios)) {
                for (const scenario of byafData.scenarios) {
                    const rawBaseName = sanitize(`${scenario.title || card.name} - ${humanizedISO8601DateTime()} imported`, { replacement: sanitizeSafeCharacterReplacements }) || 'Imported chat';
                    const chatPath = reserveUniquePath(path.join(request.user.directories.chats, path.basename(fileName)), rawBaseName, '.jsonl');
                    await transaction.stageFile(
                        chatPath,
                        ByafParser.getChatFromScenario(scenario, request.body.user_name, card.name, byafData.chatBackgrounds),
                    );
                    chats.push(path.basename(chatPath));
                }
            }
            if (chats.length > 0) {
                card.chat = path.basename(chats[0], path.extname(chats[0]));
            }

            const altImagesFolder = path.join(request.user.directories.characters, sanitize(card.name));
            for (const icon of byafData.images.slice(1)) {
                if (!Buffer.isBuffer(icon.image)) {
                    continue;
                }
                const format = detectImageFormat(icon.image);
                if (!format) {
                    throw CharacterImportError.invalid('BYAF archive contains an invalid alternate character image.');
                }
                const baseName = sanitize(icon.label, { replacement: sanitizeSafeCharacterReplacements }) || 'alt';
                const targetPath = reserveUniquePath(altImagesFolder, baseName, `.${format.extension}`);
                await transaction.stageFile(targetPath, icon.image);
            }
        }

        const characterPng = await buildCharacterPng(byafData.images[0].image, JSON.stringify(card));
        await transaction.stageFile(savedCardPath, characterPng);
        await commitCharacterImportTransaction(transaction, request);
    } finally {
        await transaction.dispose();
    }

    invalidateCharacterDataCache(savedCardPath, request);
    return fileName;
}

/**
 * Import a character from a JSON file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response }} context Express request and response objects
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromJson(uploadPath, { request }, preservedFileName) {
    const data = fs.readFileSync(uploadPath, 'utf8');
    let jsonData = JSON.parse(data);
    if (!jsonData || typeof jsonData !== 'object' || Array.isArray(jsonData)) {
        throw CharacterImportError.invalid('JSON character card root must be an object.');
    }

    if (jsonData.spec !== undefined) {
        const characterName = jsonData.data?.name || jsonData.name;
        if (typeof characterName !== 'string' || !characterName.trim()) {
            throw CharacterImportError.invalid('JSON character card is missing a valid name.');
        }
        console.info(`Importing from ${jsonData.spec} json`);
        const risuPlan = planRisuSprites(request.user.directories, jsonData);
        risuPlan.stripEmbeddedData();
        unsetPrivateFields(jsonData);
        jsonData = readFromV2(jsonData);
        jsonData['create_date'] = humanizedISO8601DateTime();
        const pngName = preservedFileName || getPngName(characterName, request.user.directories);
        const char = JSON.stringify(jsonData);
        await saveCharacterImport(DEFAULT_AVATAR_PATH, char, pngName, request, undefined, risuPlan);
        return pngName;
    } else if (jsonData.name !== undefined) {
        if (typeof jsonData.name !== 'string' || !jsonData.name.trim()) {
            throw CharacterImportError.invalid('JSON character card is missing a valid name.');
        }
        console.info('Importing from v1 json');
        jsonData.name = sanitize(jsonData.name);
        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }
        const pngName = preservedFileName || getPngName(jsonData.name, request.user.directories);
        let char = {
            'name': jsonData.name,
            'description': jsonData.description ?? '',
            'creatorcomment': jsonData.creatorcomment ?? jsonData.creator_notes ?? '',
            'personality': jsonData.personality ?? '',
            'first_mes': jsonData.first_mes ?? '',
            'avatar': 'none',
            'chat': jsonData.name + ' - ' + humanizedISO8601DateTime(),
            'mes_example': jsonData.mes_example ?? '',
            'scenario': jsonData.scenario ?? '',
            'create_date': humanizedISO8601DateTime(),
            'talkativeness': jsonData.talkativeness ?? 0.5,
            'creator': jsonData.creator ?? '',
            'tags': jsonData.tags ?? '',
        };
        char = convertToV2(char, request.user.directories);
        let charJSON = JSON.stringify(char);
        await saveCharacterImport(DEFAULT_AVATAR_PATH, charJSON, pngName, request);
        return pngName;
    } else if (jsonData.char_name !== undefined) {//json Pygmalion notepad
        if (typeof jsonData.char_name !== 'string' || !jsonData.char_name.trim()) {
            throw CharacterImportError.invalid('JSON character card is missing a valid name.');
        }
        console.info('Importing from gradio json');
        jsonData.char_name = sanitize(jsonData.char_name);
        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }
        const pngName = preservedFileName || getPngName(jsonData.char_name, request.user.directories);
        let char = {
            'name': jsonData.char_name,
            'description': jsonData.char_persona ?? '',
            'creatorcomment': jsonData.creatorcomment ?? jsonData.creator_notes ?? '',
            'personality': '',
            'first_mes': jsonData.char_greeting ?? '',
            'avatar': 'none',
            'chat': jsonData.name + ' - ' + humanizedISO8601DateTime(),
            'mes_example': jsonData.example_dialogue ?? '',
            'scenario': jsonData.world_scenario ?? '',
            'create_date': humanizedISO8601DateTime(),
            'talkativeness': jsonData.talkativeness ?? 0.5,
            'creator': jsonData.creator ?? '',
            'tags': jsonData.tags ?? '',
        };
        char = convertToV2(char, request.user.directories);
        const charJSON = JSON.stringify(char);
        await saveCharacterImport(DEFAULT_AVATAR_PATH, charJSON, pngName, request);
        return pngName;
    }

    throw CharacterImportError.invalid('JSON file does not match a supported character card schema.');
}

/**
 * Import a character from a PNG file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response }} context Express request and response objects
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromPng(uploadPath, { request }, preservedFileName) {
    const imgData = await readCharacterData(uploadPath);
    if (imgData === undefined) throw CharacterImportError.invalid('PNG character metadata is empty.');

    let jsonData = JSON.parse(imgData);
    if (!jsonData || typeof jsonData !== 'object' || Array.isArray(jsonData)) {
        throw CharacterImportError.invalid('PNG character metadata root must be an object.');
    }

    jsonData.name = sanitize(String(jsonData.data?.name || jsonData.name || ''));
    if (!jsonData.name) {
        throw CharacterImportError.invalid('PNG character metadata is missing a valid name.');
    }
    const pngName = preservedFileName || getPngName(jsonData.name, request.user.directories);

    if (jsonData.spec !== undefined) {
        console.info(`Found a ${jsonData.spec} character file.`);
        const risuPlan = planRisuSprites(request.user.directories, jsonData);
        risuPlan.stripEmbeddedData();
        unsetPrivateFields(jsonData);
        jsonData = readFromV2(jsonData);
        jsonData['create_date'] = humanizedISO8601DateTime();
        const char = JSON.stringify(jsonData);
        await saveCharacterImport(uploadPath, char, pngName, request, undefined, risuPlan);
        return pngName;
    } else if (jsonData.name !== undefined) {
        console.info('Found a v1 character file.');

        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }

        let char = {
            'name': jsonData.name,
            'description': jsonData.description ?? '',
            'creatorcomment': jsonData.creatorcomment ?? jsonData.creator_notes ?? '',
            'personality': jsonData.personality ?? '',
            'first_mes': jsonData.first_mes ?? '',
            'avatar': 'none',
            'chat': jsonData.name + ' - ' + humanizedISO8601DateTime(),
            'mes_example': jsonData.mes_example ?? '',
            'scenario': jsonData.scenario ?? '',
            'create_date': humanizedISO8601DateTime(),
            'talkativeness': jsonData.talkativeness ?? 0.5,
            'creator': jsonData.creator ?? '',
            'tags': jsonData.tags ?? '',
        };
        char = convertToV2(char, request.user.directories);
        const charJSON = JSON.stringify(char);
        await saveCharacterImport(uploadPath, charJSON, pngName, request);
        return pngName;
    }

    throw CharacterImportError.invalid('PNG metadata does not match a supported character card schema.');
}

export const router = express.Router();

router.post('/create', getFileNameValidationFunction('file_name'), async function (request, response) {
    const uploadPath = request.file ? path.join(request.file.destination, request.file.filename) : null;
    try {
        if (!request.body) return response.sendStatus(400);

        request.body.ch_name = sanitize(request.body.ch_name);
        const char = JSON.stringify(charaFormatData(request.body, request.user.directories));

        return await runWithCharacterRootLock(request, async () => {
            const internalName = request.body.file_name || getPngName(request.body.ch_name, request.user.directories);
            const avatarName = `${internalName}.png`;
            const avatarPath = path.join(request.user.directories.characters, avatarName);
            const chatsPath = path.join(request.user.directories.chats, internalName);
            const cardOccupied = fs.existsSync(avatarPath) && fs.statSync(avatarPath).isFile();
            if (request.body.file_name && (cardOccupied || fs.existsSync(chatsPath))) {
                return response.status(409).json({
                    error: 'character_exists',
                    message: 'A character card or chat already occupies that file name.',
                });
            }

            const inputFile = uploadPath || DEFAULT_AVATAR_PATH;
            const crop = uploadPath ? tryParse(request.query.crop) : undefined;
            const prepared = await prepareCharacterWrite(inputFile, char, internalName, request, crop);
            const storageError = await ensureCharacterStorageCapacity(request, response, prepared.additionalBytes);
            if (storageError) {
                return storageError;
            }

            const saved = await commitPreparedCharacterWrite(prepared);
            if (!saved) {
                return response.sendStatus(500);
            }

            return response.send(avatarName);
        });
    } catch (err) {
        console.error(err);
        return response.sendStatus(500);
    } finally {
        await cleanupUploadedFile(uploadPath);
    }
});

async function runCharacterChatMutation(options, callback) {
    const transaction = createCharacterChatTransaction(options);
    try {
        await transaction.markMutating();
        const result = await callback();
        await transaction.commit();
        return result;
    } catch (error) {
        try {
            await transaction.rollback();
        } catch (rollbackError) {
            const transactionError = new Error('Character/chat mutation and rollback failed.', { cause: rollbackError });
            transactionError.mutationError = error;
            throw transactionError;
        }
        throw error;
    }
}

router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body.avatar_url || !request.body.new_name) {
        return response.sendStatus(400);
    }

    const oldAvatarName = request.body.avatar_url;
    const newName = sanitize(request.body.new_name);
    const oldInternalName = path.parse(request.body.avatar_url).name;
    const root = path.resolve(request.user.directories.root);

    try {
        return await runWithChatStorageLocks(request, [getChatBranchUserLockPath(root)], async () => {
            await ensureFileTransactionRecovery(root, request.user.profile.handle);
            ensureDurableChatRecovery(root, request.user.profile.handle);
            ensureChatBranchRecovery(root, request.user.profile.handle, request.user.directories);
            ensureCharacterChatRecovery(root, request.user.profile.handle, request.user.directories);

            const newInternalName = getPngName(newName, request.user.directories);
            const newAvatarName = `${newInternalName}.png`;
            const oldAvatarPath = path.join(request.user.directories.characters, oldAvatarName);
            const newAvatarPath = path.join(request.user.directories.characters, newAvatarName);
            const oldChatsPath = path.join(request.user.directories.chats, oldInternalName);
            const newChatsPath = path.join(request.user.directories.chats, newInternalName);

            // Read old file, replace name int it
            const rawOldData = await readCharacterData(oldAvatarPath);
            if (rawOldData === undefined) throw new Error('Failed to read character file');

            const oldData = getCharaCardV2(JSON.parse(rawOldData), request.user.directories);
            _.set(oldData, 'data.name', newName);
            _.set(oldData, 'name', newName);
            const newData = JSON.stringify(oldData);

            await runCharacterChatMutation({
                root,
                handle: request.user.profile.handle,
                directories: request.user.directories,
                operation: 'rename',
                oldCardPath: oldAvatarPath,
                newCardPath: newAvatarPath,
                oldChatsPath,
                newChatsPath,
            }, async () => {
                // Write data to new location
                const saved = await writeCharacterData(oldAvatarPath, newData, newInternalName, request);
                if (!saved) throw new Error('Failed to write renamed character file');

                // Rename chats folder
                if (fs.existsSync(oldChatsPath) && !fs.existsSync(newChatsPath)) {
                    fs.cpSync(oldChatsPath, newChatsPath, { recursive: true });
                    fs.rmSync(oldChatsPath, { recursive: true, force: true });
                }

                // Remove the old character file
                fs.unlinkSync(oldAvatarPath);
            });
            invalidateCharacterListCache(request.user.profile.handle);

            // Return new avatar name to ST
            return response.send({ avatar: newAvatarName });
        });
    }
    catch (err) {
        console.error(err);
        return response.sendStatus(500);
    }
});

router.post('/edit', validateAvatarUrlMiddleware, async function (request, response) {
    const uploadPath = request.file ? path.join(request.file.destination, request.file.filename) : null;
    if (!request.body) {
        console.warn('Error: no response body detected');
        return response.status(400).send('Error: no response body detected');
    }

    if (request.body.ch_name === '' || request.body.ch_name === undefined || request.body.ch_name === '.') {
        console.warn('Error: invalid name.');
        return response.status(400).send('Error: invalid name.');
    }

    try {
        return await runWithCharacterRootLock(request, async () => {
            const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
            if (!fs.existsSync(avatarPath)) {
                return response.status(400).send('Error: character file does not exist');
            }

            let char = charaFormatData(request.body, request.user.directories);
            char.chat = request.body.chat;
            char.create_date = request.body.create_date;
            const characterData = JSON.stringify(char);
            const targetFile = path.parse(request.body.avatar_url).name;
            const crop = uploadPath ? tryParse(request.query.crop) : undefined;
            const prepared = await prepareCharacterWrite(uploadPath || avatarPath, characterData, targetFile, request, crop);
            const storageError = await ensureCharacterStorageCapacity(request, response, prepared.additionalBytes);
            if (storageError) return storageError;

            const saved = await commitPreparedCharacterWrite(prepared);
            if (!saved) return response.sendStatus(500);

            if (uploadPath) {
                invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);
                cacheBuster.bust(request, response);
            }
            return response.sendStatus(200);
        });
    } catch (err) {
        console.error('An error occurred, character edit invalidated.', err);
        return response.sendStatus(500);
    } finally {
        await cleanupUploadedFile(uploadPath);
    }
});

router.post('/edit-avatar', validateAvatarUrlMiddleware, async function (request, response) {
    const uploadPath = request.file ? path.join(request.file.destination, request.file.filename) : null;
    try {
        if (!uploadPath) {
            return response.status(400).send('Error: no file uploaded');
        }
        if (!request.body || !request.body.avatar_url) {
            return response.status(400).send('Error: no avatar_url in request body');
        }
        if (!fs.existsSync(uploadPath)) {
            return response.status(400).send('Error: uploaded file does not exist');
        }

        return await runWithCharacterRootLock(request, async () => {
            const characterPath = path.join(request.user.directories.characters, request.body.avatar_url);
            if (!fs.existsSync(characterPath)) {
                return response.status(400).send('Error: character file does not exist');
            }
            const data = await readCharacterData(characterPath);
            if (!data) {
                return response.status(400).send('Error: failed to read character data');
            }

            const crop = tryParse(request.query.crop);
            const fileName = path.parse(request.body.avatar_url).name;
            const prepared = await prepareCharacterWrite(uploadPath, data, fileName, request, crop);
            const storageError = await ensureCharacterStorageCapacity(request, response, prepared.additionalBytes);
            if (storageError) return storageError;

            const saved = await commitPreparedCharacterWrite(prepared);
            if (!saved) return response.sendStatus(500);

            cacheBuster.bust(request, response);
            invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);
            return response.sendStatus(200);
        });
    } catch (err) {
        console.error('An error occurred while editing avatar', err);
        return response.sendStatus(500);
    } finally {
        await cleanupUploadedFile(uploadPath);
    }
});

/**
 * Handle a POST request to edit a character attribute.
 *
 * This function reads the character data from a file, updates the specified attribute,
 * and writes the updated data back to the file.
 *
 * @param {Object} request - The HTTP request object.
 * @param {Object} response - The HTTP response object.
 * @returns {void}
 */
router.post('/edit-attribute', validateAvatarUrlMiddleware, async function (request, response) {
    console.debug(request.body);
    if (!request.body) {
        console.warn('Error: no response body detected');
        return response.status(400).send('Error: no response body detected');
    }

    if (request.body.ch_name === '' || request.body.ch_name === undefined || request.body.ch_name === '.') {
        console.warn('Error: invalid name.');
        return response.status(400).send('Error: invalid name.');
    }

    if (request.body.field === 'json_data') {
        console.warn('Error: cannot edit json_data field.');
        return response.status(400).send('Error: cannot edit json_data field.');
    }

    try {
        return await runWithCharacterRootLock(request, async () => {
            const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
            if (!fs.existsSync(avatarPath)) {
                return response.status(400).send('Error: character file does not exist');
            }
            const charJSON = await readCharacterData(avatarPath);
            if (typeof charJSON !== 'string') throw new Error('Failed to read character file');

            const char = JSON.parse(charJSON);
            //check if the field exists
            if (char[request.body.field] === undefined && char.data[request.body.field] === undefined) {
                console.warn('Error: invalid field.');
                return response.status(400).send('Error: invalid field.');
            }
            char[request.body.field] = request.body.value;
            char.data[request.body.field] = request.body.value;
            const newCharJSON = JSON.stringify(char);
            const targetFile = path.parse(request.body.avatar_url).name;
            const prepared = await prepareCharacterWrite(avatarPath, newCharJSON, targetFile, request);
            const storageError = await ensureCharacterStorageCapacity(request, response, prepared.additionalBytes);
            if (storageError) return storageError;

            const saved = await commitPreparedCharacterWrite(prepared);
            if (!saved) return response.sendStatus(500);
            return response.sendStatus(200);
        });
    } catch (err) {
        console.error('An error occurred, character edit invalidated.', err);
        return response.sendStatus(500);
    }
});

/**
 * Handle a POST request to edit character properties.
 *
 * Merges the request body with the selected character and
 * validates the result against TavernCard V2 specification.
 *
 * @param {Object} request - The HTTP request object.
 * @param {Object} response - The HTTP response object.
 *
 * @returns {void}
 * */
router.post('/merge-attributes', getFileNameValidationFunction('avatar'), async function (request, response) {
    try {
        return await runWithCharacterRootLock(request, async () => {
            const update = _.cloneDeep(request.body);
            const avatarPath = path.join(request.user.directories.characters, update.avatar);
            if (!fs.existsSync(avatarPath)) {
                return response.status(400).send('Error: invalid character file.');
            }

            const pngStringData = await readCharacterData(avatarPath);
            if (!pngStringData) {
                console.error('Error: invalid character file.');
                return response.status(400).send('Error: invalid character file.');
            }

            let character = JSON.parse(pngStringData);
            _.unset(update, 'json_data');
            _.unset(character, 'json_data');
            character = deepMerge(character, update);

            const validator = new TavernCardValidator(character);
            if (!validator.validate()) {
                console.warn(validator.lastValidationError);
                return response.status(400).send({ message: `Validation failed for ${character.name}`, error: validator.lastValidationError });
            }

            const targetImg = path.parse(update.avatar).name;
            const prepared = await prepareCharacterWrite(avatarPath, JSON.stringify(character), targetImg, request);
            const storageError = await ensureCharacterStorageCapacity(request, response, prepared.additionalBytes);
            if (storageError) return storageError;

            const saved = await commitPreparedCharacterWrite(prepared);
            if (!saved) {
                return response.status(500).send({ message: 'Unexpected error while saving character.' });
            }
            return response.sendStatus(200);
        });
    } catch (exception) {
        return response.status(500).send({ message: 'Unexpected error while saving character.', error: exception.toString() });
    }
});

router.post('/delete', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body || !request.body.avatar_url) {
        return response.sendStatus(400);
    }

    if (request.body.avatar_url !== sanitize(request.body.avatar_url)) {
        console.error('Malicious filename prevented');
        return response.sendStatus(403);
    }

    const dir_name = request.body.avatar_url.replace('.png', '');
    if (!dir_name.length) {
        console.error('Malicious dirname prevented');
        return response.sendStatus(403);
    }

    const root = path.resolve(request.user.directories.root);
    try {
        return await runWithChatStorageLocks(request, [getChatBranchUserLockPath(root)], async () => {
            await ensureFileTransactionRecovery(root, request.user.profile.handle);
            ensureDurableChatRecovery(root, request.user.profile.handle);
            ensureChatBranchRecovery(root, request.user.profile.handle, request.user.directories);
            ensureCharacterChatRecovery(root, request.user.profile.handle, request.user.directories);

            const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
            if (!fs.existsSync(avatarPath)) {
                return response.sendStatus(400);
            }

            const chatsPath = request.body.delete_chats == true
                ? path.join(request.user.directories.chats, sanitize(dir_name))
                : null;
            await runCharacterChatMutation({
                root,
                handle: request.user.profile.handle,
                directories: request.user.directories,
                operation: 'delete',
                oldCardPath: avatarPath,
                newCardPath: null,
                oldChatsPath: chatsPath,
                newChatsPath: null,
            }, async () => {
                fs.unlinkSync(avatarPath);
                if (chatsPath) {
                    await fs.promises.rm(chatsPath, { recursive: true, force: true });
                }
            });
            invalidateCharacterListCache(request.user.profile.handle);
            invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);

            return response.sendStatus(200);
        });
    } catch (err) {
        console.error(err);
        return response.sendStatus(500);
    }
});

/**
 * HTTP POST endpoint for the "/api/characters/all" route.
 *
 * This endpoint is responsible for reading character files from the `charactersPath` directory,
 * parsing character data, calculating stats for each character and responding with the data.
 * Stats are calculated only on the first run, on subsequent runs the stats are fetched from
 * the `charStats` variable.
 * The stats are calculated by the `calculateStats` function.
 * The characters are processed by the `processCharacter` function.
 *
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/all', async function (request, response) {
    const performanceTimer = beginEndpointPerformance(request, 'characters-all');
    try {
        await runWithCharacterRootLock(request, async () => {});
        const result = await performanceTimer.measureAsync('list', () => characterListCache.get({
            userKey: request.user.profile.handle,
            directory: request.user.directories.characters,
            shallow: useShallowCharacters,
            loadCharacter: file => processCharacter(file, request.user.directories, {
                shallow: useShallowCharacters,
                cacheObserver: state => performanceTimer.increment(`cache-${state}`),
            }),
        }));
        performanceTimer.setCounter('files', result.fileCount);
        performanceTimer.setCounter('concurrency', result.concurrency);
        performanceTimer.increment(`list-cache-${result.state}`);
        if (result.state === 'miss') {
            performanceTimer.setCounter('failures', result.failures);
            performanceTimer.setCounter('max-character-ms', result.maxCharacterMs);
        }
        performanceTimer.setCounter('returned', result.characters.length);
        performanceTimer.setCacheState(result.state === 'miss' ? 'miss' : 'hit');
        performanceTimer.startPhase('serialize');
        return response.send(result.characters);
    } catch (err) {
        console.error(err);
        const isRangeError = err instanceof RangeError;
        performanceTimer.startPhase('serialize');
        response.status(500).send({ overflow: isRangeError, error: true });
    }
});

router.post('/get', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);
        await runWithCharacterRootLock(request, async () => {});
        const item = request.body.avatar_url;
        const filePath = path.join(request.user.directories.characters, item);

        if (!fs.existsSync(filePath)) {
            return response.sendStatus(404);
        }

        const data = await processCharacter(item, request.user.directories, { shallow: false });

        return response.send(data);
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});

router.post('/chats', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);

        const characterDirectory = (request.body.avatar_url).replace('.png', '');
        const chatsDirectory = path.join(request.user.directories.chats, characterDirectory);

        if (!fs.existsSync(chatsDirectory)) {
            return response.send({ error: true });
        }

        const files = fs.readdirSync(chatsDirectory, { withFileTypes: true });
        const jsonFiles = files.filter(file => file.isFile() && path.extname(file.name) === '.jsonl').map(file => file.name);

        if (jsonFiles.length === 0) {
            return response.send([]);
        }

        if (request.body.simple) {
            return response.send(jsonFiles.map(file => ({ file_name: file, file_id: path.parse(file).name })));
        }

        const jsonFilesPromise = jsonFiles.map((file) => {
            const withMetadata = !!request.body.metadata;
            const pathToFile = path.join(request.user.directories.chats, characterDirectory, file);
            return getChatInfo(pathToFile, {}, false, withMetadata);
        });

        const chatData = (await Promise.allSettled(jsonFilesPromise)).filter(x => x.status === 'fulfilled').map(x => x.value);
        const validFiles = chatData.filter(i => i.file_name);

        return response.send(validFiles);
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

/**
 * Gets the name for the uploaded PNG file.
 * @param {string} file File name
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {string} - The name for the uploaded PNG file
 */
function getPngName(file, directories) {
    file = sanitize(String(file || ''), { replacement: sanitizeSafeCharacterReplacements }) || 'Character';
    let i = 1;
    const baseName = file;
    while (fs.existsSync(path.join(directories.characters, `${file}.png`))
        || fs.existsSync(path.join(directories.chats, file))) {
        file = baseName + i;
        i++;
    }
    return file;
}

/**
 * Gets the preserved name for the uploaded file if the request is valid.
 * @param {import("express").Request} request - Express request object
 * @returns {string | undefined} - The preserved name if the request is valid, otherwise undefined
 */
function getPreservedName(request) {
    if (typeof request.body?.preserved_name !== 'string' || request.body.preserved_name.length === 0) {
        return undefined;
    }
    const baseName = path.parse(path.basename(request.body.preserved_name)).name;
    return sanitize(baseName, { replacement: sanitizeSafeCharacterReplacements }) || undefined;
}

router.post('/import', async function (request, response) {
    const uploadPath = request.file ? path.join(request.file.destination, request.file.filename) : null;
    let format = '';

    try {
        if (!request.body || !request.file || !uploadPath) {
            throw new CharacterImportError(
                400,
                'missing_character_file',
                'No character card file was uploaded.',
                'Character import request did not contain a file.',
            );
        }

        format = String(request.body.file_type || path.extname(request.file.originalname).slice(1)).toLowerCase();
        const formatImportFunctions = {
            'yaml': importFromYaml,
            'yml': importFromYaml,
            'json': importFromJson,
            'png': importFromPng,
            'charx': importFromCharX,
            'byaf': importFromByaf,
        };
        const importFunction = formatImportFunctions[format];
        if (!importFunction) {
            throw CharacterImportError.unsupported(format);
        }

        return await runWithCharacterRootLock(request, async () => {
            return await characterImportMutex.runExclusive(request.user.profile.handle, async () => {
                const preservedFileName = getPreservedName(request);
                const fileName = await importFunction(uploadPath, { request, response }, preservedFileName);

                if (!fileName) {
                    throw CharacterImportError.invalid('Character importer did not return a file name.');
                }

                if (preservedFileName) {
                    invalidateThumbnail(request.user.directories, 'avatar', `${preservedFileName}.png`);
                }

                return response.send({
                    file_name: fileName,
                    backgrounds_imported: Number(request.characterImportBackgrounds || 0),
                });
            });
        });
    } catch (err) {
        const importError = normalizeCharacterImportError(err);
        console.error('Character import failed', {
            code: importError.code,
            format,
            file: request.file?.originalname ? path.basename(request.file.originalname) : undefined,
            message: importError.message,
        }, err);
        return response.status(importError.status).json({
            error: importError.code,
            message: importError.publicMessage,
            ...(importError.storage ? {
                usedBytes: importError.storage.usedBytes,
                limitBytes: importError.storage.limitBytes,
                remainingBytes: importError.storage.remainingBytes,
            } : {}),
        });
    } finally {
        await cleanupUploadedFile(uploadPath);
    }
});

router.post('/duplicate', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body.avatar_url) {
            console.warn('avatar URL not found in request body');
            console.debug(request.body);
            return response.sendStatus(400);
        }

        return await runWithCharacterRootLock(request, async () => {
            const filename = path.join(request.user.directories.characters, sanitize(request.body.avatar_url));
            if (!fs.existsSync(filename)) {
                console.error('file for dupe not found', filename);
                return response.sendStatus(404);
            }

            const sourceCard = await fsPromises.readFile(filename);
            const extension = path.extname(filename);
            const nameParts = path.basename(filename, extension).split('_');
            const lastPart = nameParts[nameParts.length - 1];
            let suffix = !isNaN(Number(lastPart)) && nameParts.length > 1
                ? parseInt(lastPart) + 1
                : 1;
            const baseName = !isNaN(Number(lastPart)) && nameParts.length > 1
                ? nameParts.slice(0, -1).join('_')
                : nameParts.join('_');

            let newFilename;
            while (true) {
                const candidateBase = `${baseName}_${suffix}`;
                const candidate = path.join(request.user.directories.characters, `${candidateBase}${extension}`);
                const candidateChat = path.join(request.user.directories.chats, candidateBase);
                if (fs.existsSync(candidate) || fs.existsSync(candidateChat)) {
                    suffix++;
                    continue;
                }
                newFilename = candidate;
                break;
            }

            const transaction = new FileTransaction(request.user.directories.root, {
                ...request.characterImportTransactionOptions,
                handle: request.user.profile.handle,
            });
            try {
                await transaction.stageFile(newFilename, sourceCard);
                const storageError = await ensureCharacterStorageCapacity(
                    request,
                    response,
                    await transaction.getAdditionalBytes(),
                );
                if (storageError) {
                    return storageError;
                }
                await transaction.commit();
            } finally {
                await transaction.dispose();
            }

            invalidateCharacterListCache(request.user.profile.handle);
            console.info(`${filename} was copied to ${newFilename}`);
            return response.send({ path: path.parse(newFilename).base });
        });
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/export', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body.format || !request.body.avatar_url) {
            return response.sendStatus(400);
        }

        let filename = path.join(request.user.directories.characters, sanitize(request.body.avatar_url));

        if (!fs.existsSync(filename)) {
            return response.sendStatus(404);
        }

        switch (request.body.format) {
            case 'png': {
                const rawBuffer = await fsPromises.readFile(filename);
                const rawData = read(rawBuffer);
                const mutatedData = mutateJsonString(rawData, unsetPrivateFields);
                const mutatedBuffer = write(rawBuffer, mutatedData);
                const contentType = mime.lookup(filename) || 'image/png';
                response.setHeader('Content-Type', contentType);
                response.setHeader('Content-Disposition', `attachment; filename="${encodeURI(path.basename(filename))}"`);
                return response.send(mutatedBuffer);
            }
            case 'json': {
                try {
                    const json = await readCharacterData(filename);
                    if (json === undefined) return response.sendStatus(400);
                    const jsonObject = getCharaCardV2(JSON.parse(json), request.user.directories);
                    unsetPrivateFields(jsonObject);
                    return response.type('json').send(JSON.stringify(jsonObject, null, 4));
                }
                catch {
                    return response.sendStatus(400);
                }
            }
        }

        return response.sendStatus(400);
    } catch (err) {
        console.error('Character export failed', err);
        response.sendStatus(500);
    }
});
