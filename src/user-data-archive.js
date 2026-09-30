import fs from 'node:fs';
import path from 'node:path';

import { CHAT_STORAGE_LAYOUT, isChunkedChatFile, readChatForBackup } from './endpoints/chats.js';

export class ArchiveCancelledError extends Error {
    constructor() {
        super('User data archive was cancelled.');
        this.name = 'ArchiveCancelledError';
    }
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
 * @returns {Promise<void>}
 */
export async function appendUserDataToArchive(archive, { handle, rootPath, isCancelled = () => false }) {
    const root = path.resolve(rootPath);

    async function walk(directory, relativeDirectory) {
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
                await walk(absolutePath, name);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }

            if (isChatDirectory) {
                if (CHAT_STORAGE_LAYOUT.sidecarSuffixes.some(suffix => entry.name.endsWith(suffix))) {
                    continue;
                }
                if (entry.name.endsWith('.jsonl') && isChunkedChatFile(absolutePath)) {
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
                    continue;
                }
            }

            archive.file(absolutePath, { name });
        }
    }

    await walk(root, '');
}
