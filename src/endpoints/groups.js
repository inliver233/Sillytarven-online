import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync, default as writeFileAtomic } from 'write-file-atomic';

import { color, tryParse } from '../util.js';
import {
    assertChatBranchFamilySafe,
    createDurableGroupDeleteTransaction,
    getChatBranchUserLockPath,
    removeChatBranchFamily,
    runChatBranchFaultPoint,
} from '../chat-branch.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { ensureChatStorageRecovery, resolveGroupChatPath, runWithChatStorageLocks } from './chats.js';

export const router = express.Router();

const GROUP_METADATA_MIGRATION_MARKER = '.group-metadata-migrated';
const DEPRECATED_GROUP_METADATA_KEYS = ['chat_metadata', 'past_metadata'];

/**
 * Checks whether group data contains deprecated metadata keys.
 * @param {object} groupData Group data object
 * @returns {boolean} Whether deprecated metadata is present
 */
function hasDeprecatedGroupMetadata(groupData) {
    if (typeof groupData !== 'object' || groupData === null) {
        return false;
    }

    return DEPRECATED_GROUP_METADATA_KEYS.some(key => Object.hasOwn(groupData, key));
}

function resolveReferencedGroupChatPaths(request, groupData) {
    if (!Array.isArray(groupData?.chats)) throw new TypeError('Group chats must be an array.');
    const chatIds = [...groupData.chats];
    if (groupData.chat_id !== undefined && groupData.chat_id !== null && !chatIds.includes(groupData.chat_id)) {
        chatIds.push(groupData.chat_id);
    }
    return [...new Set(chatIds.map(chatId => resolveGroupChatPath(request, chatId)))];
}

function hasCompleteGroupChatArtifactFamily(root, chatPath) {
    assertChatBranchFamilySafe(root, chatPath);
    if (!fs.existsSync(chatPath)) return false;

    const indexPath = `${chatPath}.index.json`;
    const chunkDirectory = `${chatPath}.chunks`;
    const hasIndex = fs.existsSync(indexPath);
    const hasChunkDirectory = fs.existsSync(chunkDirectory);
    if (!hasIndex && !hasChunkDirectory) return true;
    if (!hasIndex || !hasChunkDirectory) return false;

    const index = tryParse(fs.readFileSync(indexPath, 'utf8'));
    return Array.isArray(index?.shards) && index.shards.every(shard => {
        if (typeof shard?.file !== 'string' || !/^\d{6}\.jsonl$/.test(shard.file)) return false;
        return fs.existsSync(path.join(chunkDirectory, shard.file));
    });
}

function reconcileGroupChatReferences(request, root, body, latestGroup) {
    const bodyChatIds = [...body.chats];
    const latestChatIds = Array.isArray(latestGroup?.chats) ? latestGroup.chats : [];
    const latestKeys = new Set(latestChatIds.map(chatId => String(chatId)));
    const seenKeys = new Set();
    const reconciled = [];
    const add = (chatId) => {
        const key = String(chatId);
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        reconciled.push(chatId);
    };
    const hasArtifact = (chatId) => {
        const chatPath = resolveGroupChatPath(request, chatId);
        return hasCompleteGroupChatArtifactFamily(root, chatPath);
    };

    for (const chatId of bodyChatIds) {
        if (latestKeys.has(String(chatId)) || hasArtifact(chatId)) add(chatId);
    }
    for (const chatId of latestChatIds) {
        if (!seenKeys.has(String(chatId)) && hasArtifact(chatId)) add(chatId);
    }
    body.chats = reconciled;

    const requestedCurrent = body.chats.find(chatId => String(chatId) === String(body.chat_id));
    if (requestedCurrent !== undefined) {
        body.chat_id = requestedCurrent;
        return;
    }
    const validChatIds = new Map(body.chats.map(chatId => [String(chatId), chatId]));
    body.chat_id = [latestGroup?.chat_id, ...bodyChatIds, ...latestChatIds]
        .map(chatId => validChatIds.get(String(chatId)))
        .find(chatId => chatId !== undefined) ?? null;
}

/**
 * Migrates metadata for a single group file.
 * @param {import('../users.js').UserDirectoryList} userDirs User directories
 * @param {string} groupFileName Group file name
 * @param {import('node:fs').Dirent[]} [groupChatFiles] Group chat directory entries
 * @returns {Promise<{complete: boolean, migrated: boolean}>} Migration result
 */
async function migrateGroupMetadataFile(userDirs, groupFileName, groupChatFiles) {
    const groupFilePath = path.join(userDirs.groups, groupFileName);
    const groupDataRaw = await fsPromises.readFile(groupFilePath, 'utf8');
    const groupData = tryParse(groupDataRaw) || {};
    if (!hasDeprecatedGroupMetadata(groupData)) {
        return { complete: true, migrated: false };
    }

    const backupPath = path.join(userDirs.backups, '_group_metadata_update');
    if (!fs.existsSync(backupPath)) {
        await fsPromises.mkdir(backupPath, { recursive: true });
    }
    await fsPromises.copyFile(groupFilePath, path.join(backupPath, groupFileName));

    if (!Array.isArray(groupData.chats)) {
        console.warn(color.yellow(`Group ${groupFileName} has no chats array, skipping migration.`));
        return { complete: false, migrated: false };
    }

    const chatFiles = groupChatFiles ?? await fsPromises.readdir(userDirs.groupChats, { withFileTypes: true });
    const allMetadata = {
        ...(groupData.past_metadata || {}),
        [groupData.chat_id]: (groupData.chat_metadata || {}),
    };
    let migrationFailed = false;
    let anyDataMigrated = false;

    for (const chatId of groupData.chats) {
        try {
            const chatFileName = sanitize(`${chatId}.jsonl`);
            const chatFileDirent = chatFiles.find(f => f.isFile() && f.name === chatFileName);
            if (!chatFileDirent) {
                console.warn(color.yellow(`Group chat file ${chatId} not found, skipping migration.`));
                migrationFailed = true;
                continue;
            }
            const chatFilePath = path.join(userDirs.groupChats, chatFileName);
            const chatMetadata = allMetadata[chatId] || {};
            const chatDataRaw = await fsPromises.readFile(chatFilePath, 'utf8');
            const chatData = chatDataRaw.split('\n').filter(line => line.trim()).map(line => tryParse(line)).filter(Boolean);
            const alreadyHasMetadata = chatData.length > 0 && Object.hasOwn(chatData[0], 'chat_metadata');
            if (alreadyHasMetadata) {
                console.log(color.yellow(`Group chat ${chatId} already has chat metadata, skipping update.`));
                continue;
            }
            await fsPromises.copyFile(chatFilePath, path.join(backupPath, chatFileName));
            const chatHeader = { chat_metadata: chatMetadata, user_name: 'unused', character_name: 'unused' };
            const newChatData = [chatHeader, ...chatData];
            const newChatDataRaw = newChatData.map(entry => JSON.stringify(entry)).join('\n');
            await writeFileAtomic(chatFilePath, newChatDataRaw, 'utf8');
            console.log(`Updated group chat data format for ${chatId}`);
            anyDataMigrated = true;
        } catch (chatError) {
            console.error(color.red(`Could not update existing chat data for ${chatId}`), chatError);
            migrationFailed = true;
        }
    }

    if (migrationFailed) {
        return { complete: false, migrated: anyDataMigrated };
    }

    delete groupData.chat_metadata;
    delete groupData.past_metadata;
    await writeFileAtomic(groupFilePath, JSON.stringify(groupData, null, 4), 'utf8');
    console.log(`Migrated group chats metadata for group: ${groupData.id}`);
    return { complete: true, migrated: true };
}

/**
 * Migrates metadata introduced through a group write endpoint even if the startup marker exists.
 * @param {import('../users.js').UserDirectoryList} userDirs User directories
 * @param {string} groupFileName Group file name
 */
async function migrateImportedGroupMetadata(userDirs, groupFileName) {
    const markerPath = path.join(userDirs.groups, GROUP_METADATA_MIGRATION_MARKER);
    const hadMarker = fs.existsSync(markerPath);

    try {
        const result = await migrateGroupMetadataFile(userDirs, groupFileName);
        if (hadMarker && !result.complete) {
            await fsPromises.rm(markerPath, { force: true });
        }
    } catch (error) {
        if (hadMarker) {
            await fsPromises.rm(markerPath, { force: true });
        }
        throw error;
    }
}

/**
 * Migrates group metadata to include chat metadata for each group chat instead of the group itself.
 * @param {import('../users.js').UserDirectoryList[]} userDirectories Listing of all users' directories
 */
export async function migrateGroupChatsMetadataFormat(userDirectories) {
    for (const userDirs of userDirectories) {
        try {
            const markerPath = path.join(userDirs.groups, GROUP_METADATA_MIGRATION_MARKER);
            if (fs.existsSync(markerPath)) {
                continue;
            }

            let anyDataMigrated = false;
            let migrationComplete = true;
            const backupPath = path.join(userDirs.backups, '_group_metadata_update');
            const groupFiles = await fsPromises.readdir(userDirs.groups, { withFileTypes: true });
            const groupChatFiles = await fsPromises.readdir(userDirs.groupChats, { withFileTypes: true });
            for (const groupFile of groupFiles) {
                try {
                    const isJsonFile = groupFile.isFile() && path.extname(groupFile.name) === '.json';
                    if (!isJsonFile) {
                        continue;
                    }
                    const result = await migrateGroupMetadataFile(userDirs, groupFile.name, groupChatFiles);
                    anyDataMigrated ||= result.migrated;
                    migrationComplete &&= result.complete;
                } catch (groupError) {
                    console.error(color.red(`Could not process group file ${groupFile.name}`), groupError);
                    migrationComplete = false;
                }
            }
            if (anyDataMigrated) {
                console.log(color.green(`Completed migration of group chats metadata for user at ${userDirs.root}`));
                console.log(color.cyan(`Backups of modified files are located at ${backupPath}`));
            }
            if (migrationComplete) {
                await writeFileAtomic(markerPath, '', 'utf8');
            }
        } catch (directoryError) {
            console.error(color.red(`Error migrating group chats metadata for user at ${userDirs.root}`), directoryError);
        }
    }
}

router.use(async (request, response, next) => {
    const root = path.resolve(request.user.directories.root);
    try {
        await runWithChatStorageLocks(request, [getChatBranchUserLockPath(root)], async () => {
            await ensureChatStorageRecovery(request);
        });
        next();
    } catch (error) {
        console.error('Failed to recover durable group transaction:', error);
        response.status(500).send({ error: 'chat_recovery_failed' });
    }
});

router.post('/all', (request, response) => {
    const groups = [];

    if (!fs.existsSync(request.user.directories.groups)) {
        fs.mkdirSync(request.user.directories.groups);
    }

    const files = fs.readdirSync(request.user.directories.groups).filter(x => path.extname(x) === '.json');
    const chats = fs.readdirSync(request.user.directories.groupChats).filter(x => path.extname(x) === '.jsonl');

    files.forEach(function (file) {
        try {
            const filePath = path.join(request.user.directories.groups, file);
            const fileContents = fs.readFileSync(filePath, 'utf8');
            const group = JSON.parse(fileContents);
            const groupStat = fs.statSync(filePath);
            group['date_added'] = groupStat.birthtimeMs;
            group['create_date'] = new Date(groupStat.birthtimeMs).toISOString();

            let chat_size = 0;
            let date_last_chat = 0;

            if (Array.isArray(group.chats) && Array.isArray(chats)) {
                for (const chat of chats) {
                    if (group.chats.includes(path.parse(chat).name)) {
                        const chatStat = fs.statSync(path.join(request.user.directories.groupChats, chat));
                        chat_size += chatStat.size;
                        date_last_chat = Math.max(date_last_chat, chatStat.mtimeMs);
                    }
                }
            }

            group['date_last_chat'] = date_last_chat;
            group['chat_size'] = chat_size;
            groups.push(group);
        }
        catch (error) {
            console.error(error);
        }
    });

    return response.send(groups);
});

router.post('/create', async (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    const root = path.resolve(request.user.directories.root);
    try {
        return await runWithChatStorageLocks(request, [getChatBranchUserLockPath(root)], async () => {
            if (!fs.existsSync(request.user.directories.groups)) {
                fs.mkdirSync(request.user.directories.groups);
            }
            let numericId = Date.now();
            while (fs.existsSync(path.join(request.user.directories.groups, `${numericId}.json`))) numericId++;
            const id = String(numericId);
            const groupMetadata = {
                id,
                name: request.body.name ?? 'New Group',
                members: request.body.members ?? [],
                avatar_url: request.body.avatar_url,
                allow_self_responses: !!request.body.allow_self_responses,
                activation_strategy: request.body.activation_strategy ?? 0,
                generation_mode: request.body.generation_mode ?? 0,
                disabled_members: request.body.disabled_members ?? [],
                fav: request.body.fav,
                chat_id: request.body.chat_id ?? id,
                chats: request.body.chats ?? [id],
                auto_mode_delay: request.body.auto_mode_delay ?? 5,
                generation_mode_join_prefix: request.body.generation_mode_join_prefix ?? '',
                generation_mode_join_suffix: request.body.generation_mode_join_suffix ?? '',
            };
            for (const key of DEPRECATED_GROUP_METADATA_KEYS) {
                if (Object.hasOwn(request.body, key)) groupMetadata[key] = request.body[key];
            }

            let chatPaths;
            try {
                chatPaths = resolveReferencedGroupChatPaths(request, groupMetadata);
            } catch {
                return response.sendStatus(400);
            }
            const pathToFile = path.join(request.user.directories.groups, `${id}.json`);
            return await runWithChatStorageLocks(request, [pathToFile, ...chatPaths], async () => {
                writeFileAtomicSync(pathToFile, JSON.stringify(groupMetadata, null, 4));
                if (hasDeprecatedGroupMetadata(groupMetadata)) {
                    await migrateImportedGroupMetadata(request.user.directories, path.basename(pathToFile));
                    DEPRECATED_GROUP_METADATA_KEYS.forEach(key => delete groupMetadata[key]);
                }
                return response.send(groupMetadata);
            });
        });
    } catch (error) {
        console.error('Could not create group.', error);
        return response.status(500).send({ error: 'group_create_failed' });
    }
});

router.post('/edit', getFileNameValidationFunction('id'), async (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }
    const id = request.body.id;
    const root = path.resolve(request.user.directories.root);
    const pathToFile = path.join(request.user.directories.groups, sanitize(`${id}.json`));
    let bodyChatPaths;
    try {
        bodyChatPaths = resolveReferencedGroupChatPaths(request, request.body);
    } catch {
        return response.sendStatus(400);
    }

    try {
        return await runWithChatStorageLocks(request, [getChatBranchUserLockPath(root)], async () => {
            const body = structuredClone(request.body);
            const latestGroup = fs.existsSync(pathToFile)
                ? tryParse(fs.readFileSync(pathToFile, 'utf8'))
                : null;
            let latestChatPaths = [];
            if (latestGroup && Array.isArray(latestGroup.chats)) {
                try {
                    latestChatPaths = resolveReferencedGroupChatPaths(request, latestGroup);
                } catch {
                    return response.sendStatus(400);
                }
            }

            return await runWithChatStorageLocks(request, [pathToFile, ...bodyChatPaths, ...latestChatPaths], async () => {
                reconcileGroupChatReferences(request, root, body, latestGroup);

                writeFileAtomicSync(pathToFile, JSON.stringify(body, null, 4));
                if (hasDeprecatedGroupMetadata(body)) {
                    await migrateImportedGroupMetadata(request.user.directories, path.basename(pathToFile));
                }
                return response.send({ ok: true });
            });
        });
    } catch (error) {
        console.error('Could not edit group.', error);
        return response.status(500).send({ error: 'group_edit_failed' });
    }
});

router.post('/delete', getFileNameValidationFunction('id'), async (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    const id = request.body.id;
    const root = path.resolve(request.user.directories.root);
    const pathToGroup = path.join(request.user.directories.groups, sanitize(`${id}.json`));
    const userLockPath = getChatBranchUserLockPath(root);

    try {
        return await runWithChatStorageLocks(request, [userLockPath], async () => {
            await ensureChatStorageRecovery(request);
            return await runWithChatStorageLocks(request, [pathToGroup], async () => {
                if (!fs.existsSync(pathToGroup)) return response.send({ ok: true });
                const groupStats = fs.lstatSync(pathToGroup);
                if (!groupStats.isFile() || groupStats.isSymbolicLink()) throw new Error('Unsafe group metadata path.');
                const group = JSON.parse(fs.readFileSync(pathToGroup, 'utf8'));
                const chatPaths = Array.isArray(group?.chats)
                    ? group.chats.map(chatId => resolveGroupChatPath(request, chatId))
                    : [];

                return await runWithChatStorageLocks(request, chatPaths, async () => {
                    for (const chatPath of chatPaths) assertChatBranchFamilySafe(root, chatPath);
                    const transaction = createDurableGroupDeleteTransaction({
                        root,
                        handle: request.user.profile.handle,
                        directories: request.user.directories,
                        groupId: String(id),
                        groupPath: pathToGroup,
                        chatPaths,
                    });
                    const faultContext = { groupId: String(id), groupPath: pathToGroup, chatPaths };
                    try {
                        transaction.markMutating();
                        await runChatBranchFaultPoint('after-group-delete-journal-mutating', faultContext);
                        for (const chatPath of chatPaths) {
                            console.info('Deleting group chat', path.basename(chatPath, '.jsonl'));
                            removeChatBranchFamily(root, chatPath);
                            await runChatBranchFaultPoint('after-group-delete-chat-removal', { ...faultContext, chatPath });
                        }
                        fs.unlinkSync(pathToGroup);
                        await runChatBranchFaultPoint('after-group-delete-metadata-removal', faultContext);
                        await runChatBranchFaultPoint('before-group-delete-commit', faultContext);
                        transaction.markCommitted();
                        await runChatBranchFaultPoint('after-group-delete-commit-marker', faultContext);
                        transaction.cleanup();
                    } catch (error) {
                        transaction.rollback();
                        throw error;
                    }
                    return response.send({ ok: true });
                });
            });
        });
    } catch (error) {
        console.error('Could not delete group and its chat artifacts.', error);
        return response.status(500).send({ error: 'group_delete_failed' });
    }
});
