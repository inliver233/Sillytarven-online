import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import crypto from 'node:crypto';

import storage from 'node-persist';
import express from 'express';

import { getUserAvatar, toKey, getPasswordHash, getPasswordSalt, createBackupArchive, ensurePublicDirectoriesExist, toAvatarKey, normalizeHandle, getUserDirectories } from '../users.js';
import { SETTINGS_FILE } from '../constants.js';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import { color, Cache } from '../util.js';
import { BackupJobError, UserBackupManager } from '../user-backup-manager.js';

const RESET_CACHE = new Cache(5 * 60 * 1000);
const userBackupManager = new UserBackupManager({
    directory: path.join(globalThis.DATA_ROOT, '_exports'),
});

export const router = express.Router();

router.post('/logout', async (request, response) => {
    try {
        if (!request.session) {
            console.error('Session not available');
            return response.sendStatus(500);
        }

        request.session = null;
        return response.sendStatus(204);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.get('/me', async (request, response) => {
    try {
        if (!request.user) {
            return response.sendStatus(403);
        }

        const user = request.user.profile;
        const viewModel = {
            handle: user.handle,
            name: user.name,
            avatar: await getUserAvatar(user.handle),
            admin: user.admin,
            password: !!user.password,
            created: user.created,
        };

        return response.json(viewModel);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/change-avatar', async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Change avatar failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change avatar failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        // Avatar is not a data URL or not an empty string
        if (!request.body.avatar.startsWith('data:image/') && request.body.avatar !== '') {
            console.warn('Change avatar failed: Invalid data URL');
            return response.status(400).json({ error: 'Invalid data URL' });
        }

        // 规范化用户名
        const normalizedHandle = normalizeHandle(request.body.handle);

        if (!normalizedHandle) {
            console.warn('Change avatar failed: Invalid handle format');
            return response.status(400).json({ error: 'Invalid handle format' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(normalizedHandle));

        if (!user) {
            console.error('Change avatar failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        await storage.setItem(toAvatarKey(normalizedHandle), request.body.avatar);

        return response.sendStatus(204);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/change-password', async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Change password failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        // 规范化用户名
        const normalizedHandle = normalizeHandle(request.body.handle);

        if (!normalizedHandle) {
            console.warn('Change password failed: Invalid handle format');
            return response.status(400).json({ error: 'Invalid handle format' });
        }

        if (normalizedHandle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change password failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(normalizedHandle));

        if (!user) {
            console.error('Change password failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        if (!user.enabled) {
            console.error('Change password failed: User is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        // 检查旧密码（如果用户已有密码）
        // OAuth 用户首次设置密码时不需要验证旧密码
        if (!request.user.profile.admin && user.password && user.salt) {
            // 用户已有密码，需要验证旧密码
            if (!request.body.oldPassword || user.password !== getPasswordHash(request.body.oldPassword, user.salt)) {
                console.error('Change password failed: Incorrect old password');
                return response.status(403).json({ error: '旧密码错误' });
            }
        } else if (!user.password && !user.salt) {
            // OAuth 用户首次设置密码，记录日志
            console.info(`OAuth user ${normalizedHandle} is setting password for the first time`);
        }

        if (request.body.newPassword) {
            const salt = getPasswordSalt();
            user.password = getPasswordHash(request.body.newPassword, salt);
            user.salt = salt;
            console.info(`Password updated for user: ${normalizedHandle}`);
        } else {
            user.password = '';
            user.salt = '';
            console.info(`Password removed for user: ${normalizedHandle}`);
        }

        await storage.setItem(toKey(normalizedHandle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/backup', async (request, response) => {
    try {
        const handle = request.body.handle;

        if (!handle) {
            console.warn('Backup failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Backup failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        await createBackupArchive(handle, response);
    } catch (error) {
        console.error('Backup failed', error);
        return response.sendStatus(500);
    }
});

router.post('/backup/start', async (request, response) => {
    try {
        const handle = normalizeHandle(request.body?.handle);
        if (!handle) {
            return response.status(400).json({ error: 'Missing or invalid handle' });
        }

        if (handle !== request.user.profile.handle && !request.user.profile.admin) {
            return response.status(403).json({ error: 'Unauthorized' });
        }

        const user = await storage.getItem(toKey(handle));
        if (!user) {
            return response.status(404).json({ error: 'User not found' });
        }

        const job = await userBackupManager.startJob({
            handle,
            requestedBy: request.user.profile.handle,
            rootPath: getUserDirectories(handle).root,
        });

        return response.status(job.reused ? 200 : 202).json(job);
    } catch (error) {
        if (error instanceof BackupJobError) {
            const status = error.code === 'BACKUP_BUSY' ? 429 : 400;
            return response.status(status).json({ error: error.message, code: error.code });
        }
        console.error('Failed to start backup:', error);
        return response.status(500).json({ error: 'Failed to start backup' });
    }
});

router.get('/backup/status/:jobId', async (request, response) => {
    const job = userBackupManager.getStatus(
        request.params.jobId,
        request.user.profile.handle,
        request.user.profile.admin,
    );

    if (!job) {
        return response.status(404).json({ error: 'Backup job not found or expired' });
    }

    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    return response.json(job);
});

router.get('/backup/download/:jobId', async (request, response) => {
    const download = userBackupManager.getDownload(
        request.params.jobId,
        request.user.profile.handle,
        request.user.profile.admin,
    );

    if (!download) {
        return response.status(404).json({ error: 'Backup is not ready or has expired' });
    }

    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    response.setHeader('Accept-Ranges', 'bytes');
    return response.download(download.filePath, download.filename, {
        acceptRanges: true,
        cacheControl: false,
    }, error => {
        if (error && !response.headersSent) {
            console.error('Backup download failed:', error);
            response.sendStatus(500);
        }
    });
});

router.delete('/backup/:jobId', async (request, response) => {
    const cancelled = await userBackupManager.cancelJob(
        request.params.jobId,
        request.user.profile.handle,
        request.user.profile.admin,
    );

    return cancelled ? response.sendStatus(204) : response.sendStatus(404);
});

router.post('/reset-settings', async (request, response) => {
    try {
        const password = request.body.password;

        if (request.user.profile.password && request.user.profile.password !== getPasswordHash(password, request.user.profile.salt)) {
            console.warn('Reset settings failed: Incorrect password');
            return response.status(403).json({ error: 'Incorrect password' });
        }

        const pathToFile = path.join(request.user.directories.root, SETTINGS_FILE);
        await fsPromises.rm(pathToFile, { force: true });
        await checkForNewContent([request.user.directories], [CONTENT_TYPES.SETTINGS]);

        return response.sendStatus(204);
    } catch (error) {
        console.error('Reset settings failed', error);
        return response.sendStatus(500);
    }
});

router.post('/change-name', async (request, response) => {
    try {
        if (!request.body.name || !request.body.handle) {
            console.warn('Change name failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        // 规范化用户名
        const normalizedHandle = normalizeHandle(request.body.handle);

        if (!normalizedHandle) {
            console.warn('Change name failed: Invalid handle format');
            return response.status(400).json({ error: 'Invalid handle format' });
        }

        if (normalizedHandle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change name failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(normalizedHandle));

        if (!user) {
            console.warn('Change name failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.name = request.body.name;
        await storage.setItem(toKey(normalizedHandle), user);

        return response.sendStatus(204);
    } catch (error) {
        console.error('Change name failed', error);
        return response.sendStatus(500);
    }
});

router.post('/reset-step1', async (request, response) => {
    try {
        const resetCode = String(crypto.randomInt(1000, 9999));
        console.log();
        console.log(color.magenta(`${request.user.profile.name}, your account reset code is: `) + color.red(resetCode));
        console.log();
        RESET_CACHE.set(request.user.profile.handle, resetCode);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Recover step 1 failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/reset-step2', async (request, response) => {
    try {
        if (!request.body.code) {
            console.warn('Recover step 2 failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.user.profile.password && request.user.profile.password !== getPasswordHash(request.body.password, request.user.profile.salt)) {
            console.warn('Recover step 2 failed: Incorrect password');
            return response.status(400).json({ error: 'Incorrect password' });
        }

        const code = RESET_CACHE.get(request.user.profile.handle);

        if (!code || code !== request.body.code) {
            console.warn('Recover step 2 failed: Incorrect code');
            return response.status(400).json({ error: 'Incorrect code' });
        }

        console.info('Resetting account data:', request.user.profile.handle);
        await fsPromises.rm(request.user.directories.root, { recursive: true, force: true });

        await ensurePublicDirectoriesExist();
        await checkForNewContent([request.user.directories]);

        RESET_CACHE.remove(request.user.profile.handle);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Recover step 2 failed:', error);
        return response.sendStatus(500);
    }
});
