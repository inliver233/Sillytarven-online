import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import mime from 'mime-types';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { ensureDurableChatRecovery } from '../chat-journal.js';
import { ensureChatBranchRecovery, getChatBranchUserLockPath } from '../chat-branch.js';
import { ensureCharacterChatRecovery } from '../character-chat-transaction.js';
import { FileTransaction, ensureFileTransactionRecovery } from '../file-transaction.js';
import { canConsumeStorage } from '../storage-quota.js';
import { getImageBuffers } from '../util.js';
import { runWithChatStorageLocks } from './chats.js';

class SpriteRequestError extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}

function normalized(filePath) {
    const resolved = path.normalize(path.resolve(filePath));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function fileSystemName(value) {
    return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isOutside(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function assertExactRealDirectory(directoryPath, parent = null) {
    const absolute = path.resolve(directoryPath);
    if (parent && isOutside(path.resolve(parent), absolute)) {
        throw new SpriteRequestError(400, 'unsafe_sprite_path');
    }
    const stats = fs.lstatSync(absolute);
    if (!stats.isDirectory() || stats.isSymbolicLink()
        || normalized(fs.realpathSync.native(absolute)) !== normalized(absolute)) {
        throw new SpriteRequestError(400, 'unsafe_sprite_path');
    }
    return absolute;
}

function assertSafeDirectoryChain(root, directoryPath) {
    const absoluteRoot = assertExactRealDirectory(root);
    const absoluteDirectory = path.resolve(directoryPath);
    if (isOutside(absoluteRoot, absoluteDirectory)) {
        throw new SpriteRequestError(400, 'unsafe_sprite_path');
    }

    let current = absoluteRoot;
    for (const part of path.relative(absoluteRoot, absoluteDirectory).split(path.sep)) {
        current = path.join(current, part);
        try {
            assertExactRealDirectory(current, absoluteRoot);
        } catch (error) {
            if (error?.code === 'ENOENT') break;
            throw error;
        }
    }
    return absoluteDirectory;
}

function isSafePathPart(value) {
    return typeof value === 'string'
        && value.length > 0
        && value !== '.'
        && value !== '..'
        && path.basename(value) === value
        && sanitize(value) === value;
}

function resolveRequestSpritesPath(request, rawName) {
    if (typeof rawName !== 'string' || rawName.includes('\\')) {
        throw new SpriteRequestError(400, 'unsafe_sprite_path');
    }
    const parts = rawName.split('/');
    if (parts.length < 1 || parts.length > 2 || parts.some(part => !isSafePathPart(part))) {
        throw new SpriteRequestError(400, 'unsafe_sprite_path');
    }

    const root = path.resolve(request.user.directories.root);
    const charactersRoot = path.resolve(request.user.directories.characters);
    assertSafeDirectoryChain(root, charactersRoot);
    const spritesPath = path.resolve(charactersRoot, ...parts);
    if (isOutside(charactersRoot, spritesPath)) {
        throw new SpriteRequestError(400, 'unsafe_sprite_path');
    }
    assertSafeDirectoryChain(root, spritesPath);
    return spritesPath;
}

function listSafeSpriteFiles(spritesPath) {
    try {
        assertExactRealDirectory(spritesPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }

    const files = [];
    for (const entry of fs.readdirSync(spritesPath, { withFileTypes: true })) {
        const entryPath = path.join(spritesPath, entry.name);
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()) || sanitize(entry.name) !== entry.name) {
            throw new SpriteRequestError(400, 'unsafe_sprite_file');
        }
        if (entry.isDirectory()) {
            assertExactRealDirectory(entryPath, spritesPath);
            continue;
        }
        const stats = fs.lstatSync(entryPath);
        if (!stats.isFile() || stats.isSymbolicLink()
            || normalized(fs.realpathSync.native(entryPath)) !== normalized(entryPath)) {
            throw new SpriteRequestError(400, 'unsafe_sprite_file');
        }
        files.push({ name: entry.name, path: entryPath, stats });
    }
    return files;
}

function resolveUploadedFile(file) {
    if (!file || typeof file.destination !== 'string' || typeof file.filename !== 'string'
        || !isSafePathPart(file.filename)) {
        return null;
    }
    const directory = path.resolve(file.destination);
    const filePath = path.resolve(directory, file.filename);
    return path.dirname(filePath) === directory ? filePath : null;
}

function assertSafeUploadedFile(filePath) {
    if (!filePath) throw new SpriteRequestError(400, 'invalid_sprite_upload');
    let stats;
    try {
        stats = fs.lstatSync(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') throw new SpriteRequestError(400, 'invalid_sprite_upload');
        throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()
        || normalized(fs.realpathSync.native(filePath)) !== normalized(filePath)) {
        throw new SpriteRequestError(400, 'invalid_sprite_upload');
    }
}

async function cleanupUploadedFile(filePath) {
    if (!filePath) return;
    try {
        await fs.promises.rm(filePath, { force: true });
    } catch (error) {
        console.warn(`Failed to clean up uploaded sprite file: ${path.basename(filePath)}`, error);
    }
}

async function runWithSpriteStorage(request, callback) {
    const root = path.resolve(request.user.directories.root);
    return await runWithChatStorageLocks(request, [getChatBranchUserLockPath(root)], async () => {
        await ensureFileTransactionRecovery(root, request.user.profile.handle);
        ensureDurableChatRecovery(root, request.user.profile.handle);
        ensureChatBranchRecovery(root, request.user.profile.handle, request.user.directories);
        ensureCharacterChatRecovery(root, request.user.profile.handle, request.user.directories);
        return await callback(root);
    });
}

async function commitSpriteTransaction(request, stage) {
    const transaction = new FileTransaction(request.user.directories.root, {
        ...request.spriteTransactionOptions,
        handle: request.user.profile.handle,
    });
    try {
        await stage(transaction);
        const additionalBytes = await transaction.getAdditionalBytes();
        if (additionalBytes > 0) {
            const storageCheck = request.spriteStorageCheck ?? canConsumeStorage;
            const quota = await storageCheck(request.user.profile, request.user.directories, additionalBytes);
            if (!quota.allowed) return { quota, additionalBytes };
        }
        await transaction.commit();
        return { quota: null, additionalBytes };
    } finally {
        await transaction.dispose();
    }
}

function sendSpriteError(response, error) {
    if (error instanceof SpriteRequestError) {
        return response.status(error.status).send({ error: error.code });
    }
    console.error(error);
    return response.status(500).send({ error: 'sprite_operation_failed' });
}

function sendStorageError(response, quota) {
    return response.status(507).send({
        error: 'storage_limit',
        usedBytes: quota.usedBytes,
        limitBytes: quota.limitBytes,
        remainingBytes: quota.remainingBytes,
    });
}

function safeSpriteFileName(value) {
    const fileName = String(value ?? '');
    if (!isSafePathPart(fileName)) {
        throw new SpriteRequestError(400, 'unsafe_sprite_file');
    }
    return fileName;
}

async function stageSpriteReplacement(transaction, spritesPath, existingFiles, fileName, buffer) {
    const targetPath = path.join(spritesPath, fileName);
    const targetKey = normalized(targetPath);
    const label = fileSystemName(path.parse(fileName).name);
    for (const existing of existingFiles) {
        if (fileSystemName(path.parse(existing.name).name) === label && normalized(existing.path) !== targetKey) {
            transaction.removeFile(existing.path);
        }
    }
    await transaction.stageFile(targetPath, buffer);
}

/**
 * @typedef {Object} RisuSpritePlan
 * @property {{filePath: string, buffer: Buffer}[]} writes Sprite files to stage
 * @property {() => void} stripEmbeddedData Removes staged sprite payloads from card metadata
 */

/**
 * Gets the path to the sprites folder for the provided character name
 * @param {import('../users.js').UserDirectoryList} directories - User directories
 * @param {string} name - The name of the character
 * @param {boolean} isSubfolder - Whether the name contains a subfolder
 * @returns {string | null} The path to the sprites folder. Null if the name is invalid.
 */
function getSpritesPath(directories, name, isSubfolder) {
    if (isSubfolder) {
        const nameParts = name.split('/');
        const characterName = sanitize(nameParts[0]);
        const subfolderName = sanitize(nameParts[1]);

        if (!characterName || !subfolderName) {
            return null;
        }

        return path.join(directories.characters, characterName, subfolderName);
    }

    name = sanitize(name);

    if (!name) {
        return null;
    }

    return path.join(directories.characters, name);
}

/**
 * Plans base64 encoded RisuAI sprites without writing to disk.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {object} data RisuAI character data
 * @returns {RisuSpritePlan} Sprite writes and the deferred metadata cleanup
 */
export function planRisuSprites(directories, data) {
    const name = data?.data?.name;
    const risuData = data?.data?.extensions?.risuai;
    const emptyPlan = { writes: [], stripEmbeddedData: () => {} };

    if (!risuData || !name) {
        return emptyPlan;
    }

    const images = [
        ...(Array.isArray(risuData.additionalAssets) ? risuData.additionalAssets : []),
        ...(Array.isArray(risuData.emotions) ? risuData.emotions : []),
    ];
    if (images.length === 0) {
        return emptyPlan;
    }

    const spritesPath = getSpritesPath(directories, name, false);
    if (!spritesPath) {
        return emptyPlan;
    }
    if (fs.existsSync(spritesPath) && !fs.statSync(spritesPath).isDirectory()) {
        return emptyPlan;
    }

    const occupiedLabels = new Set(
        fs.existsSync(spritesPath)
            ? fs.readdirSync(spritesPath).map(file => path.parse(file).name)
            : [],
    );
    const writes = [];
    for (const image of images) {
        if (!Array.isArray(image) || image.length < 2) continue;
        const [label, fileBase64] = image;
        const filename = sanitize(`${String(label)}.png`);
        if (!filename) continue;
        const safeLabel = path.parse(filename).name;
        if (occupiedLabels.has(safeLabel)) {
            console.warn(`RisuAI: The sprite ${safeLabel} for ${name} already exists. Skipping.`);
            continue;
        }
        occupiedLabels.add(safeLabel);
        writes.push({
            filePath: path.join(spritesPath, filename),
            buffer: Buffer.from(String(fileBase64), 'base64'),
        });
    }

    return {
        writes,
        stripEmbeddedData: () => {
            delete risuData.additionalAssets;
            delete risuData.emotions;
        },
    };
}

/**
 * Imports base64 encoded sprites from RisuAI character data.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {object} data RisuAI character data
 */
export function importRisuSprites(directories, data) {
    try {
        const plan = planRisuSprites(directories, data);
        if (plan.writes.length > 0) {
            console.info(`RisuAI: Found ${plan.writes.length} new sprites. Writing to disk.`);
        }
        for (const sprite of plan.writes) {
            fs.mkdirSync(path.dirname(sprite.filePath), { recursive: true });
            writeFileAtomicSync(sprite.filePath, sprite.buffer);
        }
        plan.stripEmbeddedData();
    } catch (error) {
        console.error(error);
    }
}

export const router = express.Router();

router.get('/get', async function (request, response) {
    try {
        return await runWithSpriteStorage(request, async () => {
            const name = request.query.name;
            const spritesPath = resolveRequestSpritesPath(request, name);
            const files = listSafeSpriteFiles(spritesPath);
            if (!files) return response.send([]);

            const sprites = files
                .filter(file => mime.lookup(file.name)?.startsWith('image/'))
                .map((file) => {
                    const mtime = file.stats.mtime?.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
                    const fileName = path.parse(file.name).name.toLowerCase();
                    // joy.png, joy-1.png, and joy.expressive.png share the label "joy".
                    const label = fileName.match(/^(.+?)(?:[-\\.].*?)?$/)?.[1] ?? fileName;
                    return {
                        label,
                        path: `/characters/${name}/${file.name}` + (mtime ? `?t=${mtime}` : ''),
                    };
                });
            return response.send(sprites);
        });
    } catch (error) {
        return sendSpriteError(response, error);
    }
});

router.post('/delete', async (request, response) => {
    const name = request.body?.name;
    const spriteName = request.body?.spriteName || request.body?.label;
    if (typeof name !== 'string' || !spriteName) {
        return response.sendStatus(400);
    }

    try {
        return await runWithSpriteStorage(request, async () => {
            const safeSpriteName = safeSpriteFileName(spriteName);
            const spritesPath = resolveRequestSpritesPath(request, name);
            const files = listSafeSpriteFiles(spritesPath);
            if (!files) return response.sendStatus(404);

            await commitSpriteTransaction(request, async transaction => {
                for (const file of files) {
                    if (fileSystemName(path.parse(file.name).name) === fileSystemName(safeSpriteName)) {
                        transaction.removeFile(file.path);
                    }
                }
            });
            return response.sendStatus(200);
        });
    } catch (error) {
        return sendSpriteError(response, error);
    }
});

router.post('/upload-zip', async (request, response) => {
    const file = request.file;
    const uploadPath = resolveUploadedFile(file);
    try {
        if (!file || typeof request.body?.name !== 'string') {
            return response.sendStatus(400);
        }
        assertSafeUploadedFile(uploadPath);

        return await runWithSpriteStorage(request, async () => {
            const spritesPath = resolveRequestSpritesPath(request, request.body.name);
            const existingFiles = listSafeSpriteFiles(spritesPath) ?? [];
            const readArchive = request.spriteArchiveReader ?? getImageBuffers;
            const sprites = await readArchive(uploadPath);
            if (!Array.isArray(sprites)) {
                throw new SpriteRequestError(400, 'invalid_sprite_archive');
            }

            const planned = [];
            const labels = new Set();
            for (const entry of sprites) {
                if (!Array.isArray(entry) || entry.length < 2 || !Buffer.isBuffer(entry[1])) {
                    throw new SpriteRequestError(400, 'invalid_sprite_archive');
                }
                const fileName = safeSpriteFileName(entry[0]);
                const label = fileSystemName(path.parse(fileName).name);
                if (labels.has(label)) {
                    throw new SpriteRequestError(400, 'duplicate_sprite_label');
                }
                labels.add(label);
                planned.push({ fileName, buffer: entry[1] });
            }

            const result = await commitSpriteTransaction(request, async transaction => {
                for (const sprite of planned) {
                    await stageSpriteReplacement(
                        transaction,
                        spritesPath,
                        existingFiles,
                        sprite.fileName,
                        sprite.buffer,
                    );
                }
            });
            if (result.quota) return sendStorageError(response, result.quota);
            return response.send({ ok: true, count: planned.length });
        });
    } catch (error) {
        return sendSpriteError(response, error);
    } finally {
        await cleanupUploadedFile(uploadPath);
    }
});

router.post('/upload', async (request, response) => {
    const file = request.file;
    const uploadPath = resolveUploadedFile(file);
    try {
        const label = request.body?.label;
        const name = request.body?.name;
        const spriteName = request.body?.spriteName || label;
        if (!file || !label || typeof name !== 'string' || !spriteName) {
            return response.sendStatus(400);
        }
        assertSafeUploadedFile(uploadPath);

        return await runWithSpriteStorage(request, async () => {
            const safeSpriteName = safeSpriteFileName(spriteName);
            const originalName = safeSpriteFileName(file.originalname);
            const fileName = safeSpriteFileName(`${safeSpriteName}${path.extname(originalName)}`);
            const spritesPath = resolveRequestSpritesPath(request, name);
            const existingFiles = listSafeSpriteFiles(spritesPath) ?? [];
            const buffer = await fs.promises.readFile(uploadPath);
            const result = await commitSpriteTransaction(request, transaction => stageSpriteReplacement(
                transaction,
                spritesPath,
                existingFiles,
                fileName,
                buffer,
            ));
            if (result.quota) return sendStorageError(response, result.quota);
            return response.send({ ok: true });
        });
    } catch (error) {
        return sendSpriteError(response, error);
    } finally {
        await cleanupUploadedFile(uploadPath);
    }
});
