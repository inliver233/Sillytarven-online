import fs from 'node:fs';
import path from 'node:path';

import { CHAT_STORAGE_LAYOUT, getChatSamplePaths, getChatStoredBytes, isChunkedChatFile, readChatForBackup } from './endpoints/chats.js';
import { estimateZipBytes } from './zip-size-estimate.js';

export class ArchiveCancelledError extends Error {
    constructor() {
        super('User data archive was cancelled.');
        this.name = 'ArchiveCancelledError';
    }
}

// API keys stay out of backups unless the owner opts in, like upstream
// SillyTavern (which excludes them unless allowKeysExposure is set).
const SECRETS_FILE = 'secrets.json';
const SECRETS_MIGRATION_PATTERN = /^backups\/secrets_migration_[^/]*\.json$/;

/**
 * @param {string} name Entry path relative to the user root
 * @returns {boolean}
 */
function isSecretsEntry(name) {
    return name === SECRETS_FILE || SECRETS_MIGRATION_PATTERN.test(name);
}

/**
 * Whether a directory (relative to the user root, "/"-separated) holds chat files.
 * @param {string} relativeDirectory Directory relative to the user root
 * @returns {{isChatDirectory: boolean, isGroup: boolean}}
 */
function describeDirectory(relativeDirectory) {
    const segments = relativeDirectory ? relativeDirectory.split('/') : [];
    if (segments.length === 1 && segments[0] === 'group chats') {
        return { isChatDirectory: true, isGroup: true };
    }
    if (segments.length === 2 && segments[0] === 'chats') {
        return { isChatDirectory: true, isGroup: false };
    }
    return { isChatDirectory: false, isGroup: false };
}

/**
 * Appends one in-memory entry and waits until archiver has consumed it, so
 * assembling many large chats never buffers them all at once.
 * @param {import('archiver').Archiver} archive Archive
 * @param {string} content Entry content
 * @param {import('archiver').EntryData} data Entry data
 * @returns {Promise<void>}
 */
function appendAndWait(archive, content, data) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            archive.off('entry', onEntry);
            archive.off('error', onError);
        };
        const onEntry = (entry) => {
            if (entry?.name === data.name) {
                cleanup();
                resolve();
            }
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        archive.on('entry', onEntry);
        archive.once('error', onError);
        archive.append(content, data);
    });
}

/**
 * Walks a user's data directory exactly as it goes into a backup: chunk
 * directories and storage sidecars are skipped (chunked chats are reported
 * once, to be reassembled), and API keys are left out unless requested.
 * @param {object} options Options
 * @param {string} options.rootPath User data root
 * @param {() => boolean} [options.isCancelled] Stops the walk when it returns true
 * @param {boolean} [options.includeSecrets] Include the user's API keys (secrets.json)
 * @returns {AsyncGenerator<{name: string, absolutePath: string, chunked: boolean, isGroup: boolean}>}
 */
export async function* walkUserData({ rootPath, isCancelled = () => false, includeSecrets = false }) {
    async function* walk(directory, relativeDirectory) {
        const { isChatDirectory, isGroup } = describeDirectory(relativeDirectory);
        let entries;
        try {
            entries = await fs.promises.readdir(directory, { withFileTypes: true });
        } catch (error) {
            if (error?.code === 'ENOENT') {
                return;
            }
            throw error;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            if (isCancelled()) {
                throw new ArchiveCancelledError();
            }
            const absolutePath = path.join(directory, entry.name);
            const name = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;

            if (entry.isSymbolicLink()) {
                continue;
            }
            if (entry.isDirectory()) {
                if (isChatDirectory && entry.name.endsWith(CHAT_STORAGE_LAYOUT.chunkDirectorySuffix)) {
                    continue;
                }
                yield* walk(absolutePath, name);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            if (!includeSecrets && isSecretsEntry(name)) {
                continue;
            }
            if (isChatDirectory && CHAT_STORAGE_LAYOUT.sidecarSuffixes.some(suffix => entry.name.endsWith(suffix))) {
                continue;
            }
            const chunked = isChatDirectory && entry.name.endsWith('.jsonl') && isChunkedChatFile(absolutePath);
            yield { name, absolutePath, chunked, isGroup };
        }
    }

    yield* walk(path.resolve(rootPath), '');
}

/**
 * Adds a user's data directory to a ZIP archive in the upstream SillyTavern
 * layout: every chat is one complete .jsonl file. Chats stored in this fork's
 * chunked layout are reassembled, and the chunk directories and storage
 * sidecars are left out, so the archive can be extracted into an upstream
 * SillyTavern data directory as-is. Everything else is copied unchanged.
 * @param {import('archiver').Archiver} archive Archive to append to
 * @param {object} options Options
 * @param {string} options.handle User handle (used for chat storage locks)
 * @param {string} options.rootPath User data root
 * @param {() => boolean} [options.isCancelled] Stops the walk when it returns true
 * @param {boolean} [options.includeSecrets] Include the user's API keys (secrets.json)
 * @returns {Promise<void>}
 */
export async function appendUserDataToArchive(archive, { handle, rootPath, isCancelled = () => false, includeSecrets = false }) {
    for await (const { name, absolutePath, chunked, isGroup } of walkUserData({ rootPath, isCancelled, includeSecrets })) {
        if (!chunked) {
            archive.file(absolutePath, { name });
            continue;
        }
        let stats = null;
        try {
            stats = await fs.promises.stat(absolutePath);
        } catch (error) {
            if (error?.code === 'ENOENT') {
                continue;
            }
            throw error;
        }
        const content = await readChatForBackup(handle, absolutePath, isGroup);
        await appendAndWait(archive, content, { name, date: stats.mtime });
    }
}

/**
 * Estimated download size of the user's full backup (same files, same
 * compression level as the backup job).
 * @param {object} options Options
 * @param {string} options.rootPath User data root
 * @param {boolean} [options.includeSecrets] Include the user's API keys
 * @returns {Promise<{files: number, rawBytes: number, estimatedBytes: number}>}
 */
export async function estimateUserDataArchive({ rootPath, includeSecrets = false }) {
    const entries = [];
    for await (const { name, absolutePath, chunked } of walkUserData({ rootPath, includeSecrets })) {
        try {
            const size = chunked ? getChatStoredBytes(absolutePath) : (await fs.promises.stat(absolutePath)).size;
            entries.push({ name, size, samplePath: chunked ? getChatSamplePaths(absolutePath) : absolutePath });
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
        }
    }
    return estimateZipBytes(entries, 1);
}
