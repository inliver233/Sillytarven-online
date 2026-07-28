import { promises as fsPromises } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';

import storage from 'node-persist';
import express from 'express';
import lodash from 'lodash';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import {
    KEY_PREFIX,
    toKey,
    requireAdminMiddleware,
    getUserAvatar,
    getAllUserHandles,
    getPasswordSalt,
    getPasswordHash,
    getUserDirectories,
    ensurePublicDirectoriesExist,
    normalizeHandle,
} from '../users.js';
import { applyDefaultTemplateToUser } from '../default-template.js';
import { DEFAULT_USER } from '../constants.js';
import systemMonitor from '../system-monitor.js';
import { isEmailServiceAvailable, sendInactiveUserDeletionNotice } from '../email-service.js';
import { getConfigValue } from '../util.js';


export const router = express.Router();
const USER_STORAGE_ENABLED = getConfigValue('userStorage.enabled', false, 'boolean');
const USER_STORAGE_DEFAULT_LIMIT_MIB = getConfigValue('userStorage.defaultLimitMiB', 0, 'number');

/**
 * @typedef {import('../users.js').UserViewModel & {
 *   loadStats?: {
 *     loadPercentage?: number;
 *     totalMessages?: number;
 *     lastActivityFormatted?: string;
 *   } | null,
 *   storageSize?: number
 * }} AdminUserViewModel
 */

/**
 * 递归计算目录大小（字节）
 * @param {string} dirPath - 目录路径
 * @returns {Promise<number>} - 目录大小（字节）
 */
async function calculateDirectorySize(dirPath) {
    let totalSize = 0;

    try {
        if (!fs.existsSync(dirPath)) {
            return 0;
        }

        const items = await fsPromises.readdir(dirPath);

        for (const item of items) {
            const itemPath = path.join(dirPath, item);
            const stats = await fsPromises.stat(itemPath);

            if (stats.isDirectory()) {
                totalSize += await calculateDirectorySize(itemPath);
            } else {
                totalSize += stats.size;
            }
        }
    } catch (error) {
        console.error('Error calculating directory size:', error);
    }

    return totalSize;
}

router.post('/get', requireAdminMiddleware, async (request, response) => {
    try {
        /** @type {import('../users.js').User[]} */
        const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));

        // 是否计算存储大小（默认为false以提高性能）
        const includeStorageSize = request.body?.includeStorageSize === true;

        /** @type {Promise<AdminUserViewModel>[]} */
        const viewModelPromises = users
            .map(user => new Promise(async (resolve) => {
                const avatar = await getUserAvatar(user.handle);
                // 获取用户负载统计（如果可用）
                const loadStats = systemMonitor.getUserLoadStats(user.handle);

                // 只有在明确请求时才计算用户目录大小
                let storageSize = undefined;
                if (includeStorageSize) {
                    const directories = getUserDirectories(user.handle);
                    storageSize = await calculateDirectorySize(directories.root);
                }

                resolve({
                    handle: user.handle,
                    name: user.name,
                    avatar: avatar,
                    admin: user.admin,
                    enabled: user.enabled,
                    created: user.created,
                    password: !!user.password,
                    email: user.email || undefined,
                    storageSize: storageSize,
                    expiresAt: user.expiresAt || null,
                    loadStats: loadStats ? {
                        loadPercentage: loadStats.loadPercentage,
                        totalMessages: loadStats.totalMessages,
                        lastActivityFormatted: loadStats.lastActivityFormatted,
                    } : null,
                });
            }));

        const viewModels = await Promise.all(viewModelPromises);
        viewModels.sort((x, y) => (x.created ?? 0) - (y.created ?? 0));
        return response.json(viewModels);
    } catch (error) {
        console.error('User list failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * 获取指定用户的存储占用大小
 * 支持单个用户或批量查询
 */
router.post('/storage-size', requireAdminMiddleware, async (request, response) => {
    try {
        const { handles } = request.body;

        if (!handles || !Array.isArray(handles) || handles.length === 0) {
            console.warn('Get storage size failed: Missing or invalid handles');
            return response.status(400).json({ error: 'Missing or invalid handles array' });
        }

        const results = {};

        // 并行计算所有用户的存储大小
        await Promise.all(handles.map(async (handle) => {
            try {
                const normalizedHandle = normalizeHandle(handle);
                if (!normalizedHandle) {
                    results[handle] = { error: 'Invalid handle format' };
                    return;
                }

                const directories = getUserDirectories(normalizedHandle);
                const storageSize = await calculateDirectorySize(directories.root);
                results[normalizedHandle] = { storageSize };
            } catch (error) {
                console.error(`Error calculating storage size for ${handle}:`, error);
                results[handle] = { error: error.message };
            }
        }));

        return response.json(results);
    } catch (error) {
        console.error('Get storage size failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/disable', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Disable user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        // 规范化用户名
        const normalizedHandle = normalizeHandle(request.body.handle);

        if (!normalizedHandle) {
            console.warn('Disable user failed: Invalid handle format');
            return response.status(400).json({ error: 'Invalid handle format' });
        }

        if (normalizedHandle === request.user.profile.handle) {
            console.warn('Disable user failed: Cannot disable yourself');
            return response.status(400).json({ error: 'Cannot disable yourself' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(normalizedHandle));

        if (!user) {
            console.error('Disable user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.enabled = false;
        await storage.setItem(toKey(normalizedHandle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User disable failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/enable', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Enable user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        // 规范化用户名
        const normalizedHandle = normalizeHandle(request.body.handle);

        if (!normalizedHandle) {
            console.warn('Enable user failed: Invalid handle format');
            return response.status(400).json({ error: 'Invalid handle format' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(normalizedHandle));

        if (!user) {
            console.error('Enable user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.enabled = true;
        await storage.setItem(toKey(normalizedHandle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User enable failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/promote', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Promote user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        // 规范化用户名
        const normalizedHandle = normalizeHandle(request.body.handle);

        if (!normalizedHandle) {
            console.warn('Promote user failed: Invalid handle format');
            return response.status(400).json({ error: 'Invalid handle format' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(normalizedHandle));

        if (!user) {
            console.error('Promote user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.admin = true;
        await storage.setItem(toKey(normalizedHandle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User promote failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/demote', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Demote user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        // 规范化用户名
        const normalizedHandle = normalizeHandle(request.body.handle);

        if (!normalizedHandle) {
            console.warn('Demote user failed: Invalid handle format');
            return response.status(400).json({ error: 'Invalid handle format' });
        }

        if (normalizedHandle === request.user.profile.handle) {
            console.warn('Demote user failed: Cannot demote yourself');
            return response.status(400).json({ error: 'Cannot demote yourself' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(normalizedHandle));

        if (!user) {
            console.error('Demote user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.admin = false;
        await storage.setItem(toKey(normalizedHandle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User demote failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/create', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle || !request.body.name) {
            console.warn('Create user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const handles = await getAllUserHandles();
        // 使用统一的规范化函数
        const handle = normalizeHandle(request.body.handle);

        if (!handle) {
            console.warn('Create user failed: Invalid handle');
            return response.status(400).json({ error: 'Invalid handle' });
        }

        if (handles.some(x => x === handle)) {
            console.warn('Create user failed: User with that handle already exists');
            return response.status(409).json({ error: 'User already exists' });
        }

        const salt = getPasswordSalt();
        const password = request.body.password ? getPasswordHash(request.body.password, salt) : '';

        const newUser = {
            handle: handle,
            name: request.body.name || 'Anonymous',
            created: Date.now(),
            password: password,
            salt: salt,
            admin: !!request.body.admin,
            enabled: true,
            expiresAt: null, // 管理员创建的用户默认为永久账户
        };

        if (USER_STORAGE_ENABLED) {
            const limitMiB = Number(USER_STORAGE_DEFAULT_LIMIT_MIB) || 0;
            newUser.storageLimitMiB = Math.max(0, limitMiB);
        }

        await storage.setItem(toKey(handle), newUser);

        // Create user directories
        console.info('Creating data directories for', newUser.handle);
        await ensurePublicDirectoriesExist();
        const directories = getUserDirectories(newUser.handle);
        await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);
        applyDefaultTemplateToUser(directories, { userName: newUser.name });
        return response.json({ handle: newUser.handle });
    } catch (error) {
        console.error('User create failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/delete', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Delete user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle === request.user.profile.handle) {
            console.warn('Delete user failed: Cannot delete yourself');
            return response.status(400).json({ error: 'Cannot delete yourself' });
        }

        if (request.body.handle === DEFAULT_USER.handle) {
            console.warn('Delete user failed: Cannot delete default user');
            return response.status(400).json({ error: 'Sorry, but the default user cannot be deleted. It is required as a fallback.' });
        }

        // 规范化用户名
        const normalizedHandle = normalizeHandle(request.body.handle);

        if (!normalizedHandle) {
            console.warn('Delete user failed: Invalid handle format');
            return response.status(400).json({ error: 'Invalid handle format' });
        }

        await storage.removeItem(toKey(normalizedHandle));

        if (request.body.purge) {
            const directories = getUserDirectories(normalizedHandle);
            console.info('Deleting data directories for', normalizedHandle);
            await fsPromises.rm(directories.root, { recursive: true, force: true });
        }

        console.info('Deleted user:', normalizedHandle, 'purge:', !!request.body.purge);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User delete failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/slugify', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.text) {
            console.warn('Slugify failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        // 使用统一的规范化函数
        const text = normalizeHandle(request.body.text);

        return response.send(text);
    } catch (error) {
        console.error('Slugify failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * 清理单个用户的备份文件
 */
router.post('/clear-backups', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Clear backups failed: Missing required fields');
            return response.status(400).json({ error: '缺少必需字段' });
        }

        const handle = request.body.handle;
        const directories = getUserDirectories(handle);

        let deletedSize = 0;
        let deletedFiles = 0;

        // 只清理备份目录
        if (fs.existsSync(directories.backups)) {
            const backupsSize = await calculateDirectorySize(directories.backups);
            deletedSize += backupsSize;
            const files = await fsPromises.readdir(directories.backups);
            deletedFiles += files.length;
            await fsPromises.rm(directories.backups, { recursive: true, force: true });
            // 重新创建空目录
            await fsPromises.mkdir(directories.backups, { recursive: true });
        }

        console.info(`Cleared backups for user ${handle}: ${deletedFiles} files, ${deletedSize} bytes`);
        return response.json({
            success: true,
            deletedSize: deletedSize,
            deletedFiles: deletedFiles,
            message: `已清理 ${deletedFiles} 个备份文件，释放 ${(deletedSize / 1024 / 1024).toFixed(2)} MB 空间`,
        });
    } catch (error) {
        console.error('Clear backups failed:', error);
        return response.status(500).json({ error: '清理备份文件失败: ' + error.message });
    }
});

/**
 * 一键清理所有用户的备份文件
 */
router.post('/clear-all-backups', requireAdminMiddleware, async (request, response) => {
    try {
        const userHandles = await getAllUserHandles();
        let totalDeletedSize = 0;
        let totalDeletedFiles = 0;
        const results = [];

        for (const handle of userHandles) {
            try {
                const directories = getUserDirectories(handle);
                let userDeletedSize = 0;
                let userDeletedFiles = 0;

                // 只清理备份目录
                if (fs.existsSync(directories.backups)) {
                    const backupsSize = await calculateDirectorySize(directories.backups);
                    userDeletedSize += backupsSize;
                    const files = await fsPromises.readdir(directories.backups);
                    userDeletedFiles += files.length;
                    await fsPromises.rm(directories.backups, { recursive: true, force: true });
                    await fsPromises.mkdir(directories.backups, { recursive: true });
                }

                totalDeletedSize += userDeletedSize;
                totalDeletedFiles += userDeletedFiles;
                results.push({
                    handle: handle,
                    deletedSize: userDeletedSize,
                    deletedFiles: userDeletedFiles,
                });

                console.info(`Cleared backups for user ${handle}: ${userDeletedFiles} files, ${userDeletedSize} bytes`);
            } catch (error) {
                console.error(`Error clearing backups for user ${handle}:`, error);
                results.push({
                    handle: handle,
                    error: error.message,
                });
            }
        }

        console.info(`Cleared all backups: ${totalDeletedFiles} files, ${totalDeletedSize} bytes`);
        return response.json({
            success: true,
            totalDeletedSize: totalDeletedSize,
            totalDeletedFiles: totalDeletedFiles,
            results: results,
            message: `已清理 ${userHandles.length} 个用户的备份文件，共 ${totalDeletedFiles} 个文件，释放 ${(totalDeletedSize / 1024 / 1024).toFixed(2)} MB 空间`,
        });
    } catch (error) {
        console.error('Clear all backups failed:', error);
        return response.status(500).json({ error: '清理所有备份文件失败: ' + error.message });
    }
});

/**
 * 一键删除长时间未登录且占用存储较少的用户数据
 */
router.post('/delete-inactive-users', requireAdminMiddleware, async (request, response) => {
    try {
        const { dryRun = false, inactiveDays: requestedInactiveDays, maxStorageMiB: requestedMaxStorageMiB } = request.body || {};
        const allowedInactiveDays = new Set([7, 15, 30, 60]);
        const parsedInactiveDays = Number.parseInt(requestedInactiveDays, 10);
        const inactiveDays = allowedInactiveDays.has(parsedInactiveDays) ? parsedInactiveDays : 60;
        const inactiveThreshold = inactiveDays * 24 * 60 * 60 * 1000;
        const parsedMaxStorageMiB = Number(requestedMaxStorageMiB);
        const maxStorageMiB = Number.isFinite(parsedMaxStorageMiB) && parsedMaxStorageMiB > 0 ? parsedMaxStorageMiB : null;
        const maxStorageBytes = maxStorageMiB ? maxStorageMiB * 1024 * 1024 : null;
        const storageFilterMessage = maxStorageMiB ? ` 且存储占用不超过 ${maxStorageMiB} MiB` : '';
        const now = Date.now();
        const forwardedProto = request.get('x-forwarded-proto');
        const protocol = forwardedProto ? forwardedProto.split(',')[0] : request.protocol;
        const host = request.get('x-forwarded-host') || request.get('host');
        const siteUrl = host ? `${protocol}://${host}` : '';

        // 获取所有用户
        const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));

        const inactiveUsers = [];
        const results = [];
        let totalDeletedSize = 0;

        for (const user of users) {
            // 不能删除管理员自己
            if (user.handle === request.user.profile.handle) {
                continue;
            }

            // 不能删除默认用户
            if (user.handle === DEFAULT_USER.handle) {
                continue;
            }

            // 不能删除管理员账户
            if (user.admin) {
                continue;
            }

            // 获取用户的最后活动时间
            const userStats = systemMonitor.getUserLoadStats(user.handle);
            let lastActivityTime = null;

            if (userStats && userStats.lastActivity) {
                // 如果有心跳记录，优先使用心跳时间
                if (userStats.lastHeartbeat) {
                    lastActivityTime = userStats.lastHeartbeat;
                } else {
                    lastActivityTime = userStats.lastActivity;
                }
            } else {
                // 如果没有活动记录，使用用户创建时间作为最后活动时间
                lastActivityTime = user.created || 0;
            }

            const timeSinceLastActivity = now - lastActivityTime;
            const daysSinceLastActivity = Math.floor(timeSinceLastActivity / (24 * 60 * 60 * 1000));
            const hasBoundEmail = typeof user.email === 'string' && user.email.trim().length > 0;

            // 如果超过指定天数未登录
            if (timeSinceLastActivity > inactiveThreshold) {
                const directories = getUserDirectories(user.handle);
                const storageSize = await calculateDirectorySize(directories.root);

                if (maxStorageBytes && storageSize > maxStorageBytes) {
                    continue;
                }

                inactiveUsers.push({
                    handle: user.handle,
                    name: user.name,
                    lastActivity: lastActivityTime,
                    lastActivityFormatted: new Date(lastActivityTime).toLocaleString('zh-CN'),
                    daysSinceLastActivity: daysSinceLastActivity,
                    storageSize: storageSize,
                    hasEmail: hasBoundEmail,
                });

                // 如果不是试运行模式，执行删除
                if (!dryRun) {
                    let emailNotified = false;
                    let emailError = null;

                    try {
                        if (hasBoundEmail) {
                            if (isEmailServiceAvailable()) {
                                const sent = await sendInactiveUserDeletionNotice(
                                    user.email.trim(),
                                    user.name,
                                    daysSinceLastActivity,
                                    storageSize,
                                    siteUrl,
                                );
                                emailNotified = sent;
                                if (!sent) {
                                    emailError = 'Failed to send notification email';
                                }
                            } else {
                                emailError = 'Email service not available';
                            }
                        }

                        // 删除用户记录
                        await storage.removeItem(toKey(user.handle));

                        // 删除用户数据目录
                        if (fs.existsSync(directories.root)) {
                            await fsPromises.rm(directories.root, { recursive: true, force: true });
                        }

                        // 重置用户统计数据
                        systemMonitor.resetUserStats(user.handle);

                        totalDeletedSize += storageSize;
                        results.push({
                            handle: user.handle,
                            name: user.name,
                            success: true,
                            deletedSize: storageSize,
                            emailNotified: emailNotified,
                            emailError: emailError,
                            message: `已删除用户 ${user.handle}，释放 ${(storageSize / 1024 / 1024).toFixed(2)} MB 空间`,
                        });

                        console.info(`Deleted inactive user ${user.handle}: ${(storageSize / 1024 / 1024).toFixed(2)} MB`);
                    } catch (error) {
                        console.error(`Error deleting user ${user.handle}:`, error);
                        results.push({
                            handle: user.handle,
                            name: user.name,
                            success: false,
                            error: error.message,
                            emailNotified: emailNotified,
                            emailError: emailError,
                        });
                    }
                }
            }
        }

        if (dryRun) {
            // 试运行模式，只返回将要删除的用户列表
            return response.json({
                success: true,
                dryRun: true,
                inactiveDays: inactiveDays,
                maxStorageMiB: maxStorageMiB,
                inactiveUsers: inactiveUsers,
                totalUsers: inactiveUsers.length,
                totalSize: inactiveUsers.reduce((sum, u) => sum + u.storageSize, 0),
                message: `发现 ${inactiveUsers.length} 个用户超过 ${inactiveDays} 天未登录${storageFilterMessage}`,
            });
        } else {
            // 实际删除模式
            return response.json({
                success: true,
                dryRun: false,
                inactiveDays: inactiveDays,
                maxStorageMiB: maxStorageMiB,
                deletedUsers: results.filter(r => r.success),
                failedUsers: results.filter(r => !r.success),
                totalDeleted: results.filter(r => r.success).length,
                totalFailed: results.filter(r => !r.success).length,
                totalDeletedSize: totalDeletedSize,
                message: `已删除 ${results.filter(r => r.success).length} 个用户，释放 ${(totalDeletedSize / 1024 / 1024).toFixed(2)} MB 空间`,
            });
        }
    } catch (error) {
        console.error('Delete inactive users failed:', error);
        return response.status(500).json({ error: '删除不活跃用户失败: ' + error.message });
    }
});
