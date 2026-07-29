import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync, default as writeFileAtomic } from 'write-file-atomic';

import { color, tryParse } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';

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

    const id = String(Date.now());
    const groupMetadata = {
        id: id,
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
        if (Object.hasOwn(request.body, key)) {
            groupMetadata[key] = request.body[key];
        }
    }
    const pathToFile = path.join(request.user.directories.groups, sanitize(`${id}.json`));
    const fileData = JSON.stringify(groupMetadata, null, 4);

    if (!fs.existsSync(request.user.directories.groups)) {
        fs.mkdirSync(request.user.directories.groups);
    }

    writeFileAtomicSync(pathToFile, fileData);
    if (hasDeprecatedGroupMetadata(groupMetadata)) {
        await migrateImportedGroupMetadata(request.user.directories, path.basename(pathToFile));
        DEPRECATED_GROUP_METADATA_KEYS.forEach(key => delete groupMetadata[key]);
    }
    return response.send(groupMetadata);
});

router.post('/edit', getFileNameValidationFunction('id'), async (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }
    const id = request.body.id;
    const pathToFile = path.join(request.user.directories.groups, sanitize(`${id}.json`));
    const fileData = JSON.stringify(request.body, null, 4);

    writeFileAtomicSync(pathToFile, fileData);
    if (hasDeprecatedGroupMetadata(request.body)) {
        await migrateImportedGroupMetadata(request.user.directories, path.basename(pathToFile));
    }
    return response.send({ ok: true });
});

router.post('/delete', getFileNameValidationFunction('id'), async (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    const id = request.body.id;
    const pathToGroup = path.join(request.user.directories.groups, sanitize(`${id}.json`));

    try {
        // Delete group chats
        const group = JSON.parse(fs.readFileSync(pathToGroup, 'utf8'));

        if (group && Array.isArray(group.chats)) {
            for (const chat of group.chats) {
                console.info('Deleting group chat', chat);
                const pathToFile = path.join(request.user.directories.groupChats, sanitize(`${chat}.jsonl`));

                if (fs.existsSync(pathToFile)) {
                    fs.unlinkSync(pathToFile);
                }
            }
        }
    } catch (error) {
        console.error('Could not delete group chats. Clean them up manually.', error);
    }

    if (fs.existsSync(pathToGroup)) {
        fs.unlinkSync(pathToGroup);
    }

    return response.send({ ok: true });
});
