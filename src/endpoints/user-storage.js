import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import express from 'express';
import storage from 'node-persist';

import { requireAdminMiddleware, requireLoginMiddleware, toKey } from '../users.js';
import { getStorageConfig, getUserLimitMiB, calculateDirectorySize, buildStorageStatus, getLocalDateKey } from '../storage-quota.js';
import { createStorageCodes, useStorageCode } from '../storage-codes.js';

export const router = express.Router();

function loadConfigFile() {
    const configPath = path.join(process.cwd(), 'config.yaml');
    if (!fs.existsSync(configPath)) {
        return {};
    }

    const content = fs.readFileSync(configPath, 'utf8');
    return yaml.parse(content) || {};
}

function saveConfigFile(config) {
    const configPath = path.join(process.cwd(), 'config.yaml');
    const newConfigContent = yaml.stringify(config);
    fs.writeFileSync(configPath, newConfigContent, 'utf8');
}

router.get('/config', requireAdminMiddleware, async (_request, response) => {
    try {
        const config = loadConfigFile();
        const storageConfig = config.userStorage || {};

        return response.json({
            enabled: storageConfig.enabled ?? false,
            defaultLimitMiB: storageConfig.defaultLimitMiB ?? 0,
            checkInRewardMiB: storageConfig.checkInRewardMiB ?? 0,
        });
    } catch (error) {
        console.error('Get user storage config failed:', error);
        return response.status(500).json({ error: '获取配置失败' });
    }
});

router.post('/config', requireAdminMiddleware, async (request, response) => {
    try {
        const enabled = Boolean(request.body?.enabled);
        const defaultLimitMiB = Number.parseFloat(request.body?.defaultLimitMiB);
        const checkInRewardMiB = Number.parseFloat(request.body?.checkInRewardMiB);

        const config = loadConfigFile();
        config.userStorage = {
            enabled,
            defaultLimitMiB: Number.isFinite(defaultLimitMiB) ? Math.max(0, defaultLimitMiB) : 0,
            checkInRewardMiB: Number.isFinite(checkInRewardMiB) ? Math.max(0, checkInRewardMiB) : 0,
        };

        saveConfigFile(config);

        return response.json({ success: true, message: '用户空间配置已保存。部分更改可能需要重启服务器才能生效。' });
    } catch (error) {
        console.error('Save user storage config failed:', error);
        return response.status(500).json({ error: `保存配置失败: ${error.message}` });
    }
});

router.post('/codes', requireAdminMiddleware, async (request, response) => {
    try {
        const count = Number.parseInt(request.body?.count, 10);
        const addMiB = Number.parseFloat(request.body?.addMiB);

        if (!Number.isFinite(count) || count <= 0) {
            return response.status(400).json({ error: '请输入有效的生成数量' });
        }

        if (!Number.isFinite(addMiB) || addMiB <= 0) {
            return response.status(400).json({ error: '请输入有效的扩容大小' });
        }

        const codes = await createStorageCodes(request.user.profile.handle, count, addMiB);
        return response.json({ success: true, codes });
    } catch (error) {
        console.error('Create storage codes failed:', error);
        return response.status(500).json({ error: '生成激活码失败: ' + error.message });
    }
});

router.get('/status', requireLoginMiddleware, async (request, response) => {
    try {
        const config = getStorageConfig();
        if (!config.enabled) {
            return response.json({ enabled: false });
        }

        const user = await storage.getItem(toKey(request.user.profile.handle));
        if (!user) {
            return response.status(404).json({ error: '用户不存在' });
        }

        const limitMiB = getUserLimitMiB(user, config);
        if (!Number.isFinite(user.storageLimitMiB)) {
            user.storageLimitMiB = limitMiB ?? 0;
            await storage.setItem(toKey(user.handle), user);
        }

        const usedBytes = await calculateDirectorySize(request.user.directories.root);
        const status = buildStorageStatus({
            usedBytes,
            limitMiB: limitMiB ?? 0,
            rewardMiB: config.checkInRewardMiB,
            lastCheckInDate: user.storageLastCheckInDate,
        });

        return response.json(status);
    } catch (error) {
        console.error('Get user storage status failed:', error);
        return response.status(500).json({ error: '获取存储状态失败' });
    }
});

router.post('/redeem', requireLoginMiddleware, async (request, response) => {
    try {
        const config = getStorageConfig();
        if (!config.enabled) {
            return response.status(400).json({ error: '存储空间限制未启用' });
        }

        const code = String(request.body?.code || '').trim();
        if (!code) {
            return response.status(400).json({ error: '请输入激活码' });
        }

        const user = await storage.getItem(toKey(request.user.profile.handle));
        if (!user) {
            return response.status(404).json({ error: '用户不存在' });
        }

        const result = await useStorageCode(code, user.handle);
        if (!result.success) {
            return response.status(400).json({ error: result.reason || '激活码无效' });
        }

        const currentLimit = getUserLimitMiB(user, config) ?? 0;
        const newLimit = currentLimit + Number(result.code.addMiB || 0);
        user.storageLimitMiB = Math.max(0, newLimit);
        await storage.setItem(toKey(user.handle), user);

        return response.json({
            success: true,
            addedMiB: result.code.addMiB,
            limitMiB: user.storageLimitMiB,
        });
    } catch (error) {
        console.error('Redeem storage code failed:', error);
        return response.status(500).json({ error: '激活码使用失败' });
    }
});

router.post('/check-in', requireLoginMiddleware, async (request, response) => {
    try {
        const config = getStorageConfig();
        if (!config.enabled) {
            return response.status(400).json({ error: '存储空间限制未启用' });
        }

        if (!Number.isFinite(config.checkInRewardMiB) || config.checkInRewardMiB <= 0) {
            return response.status(400).json({ error: '签到奖励已关闭' });
        }

        const user = await storage.getItem(toKey(request.user.profile.handle));
        if (!user) {
            return response.status(404).json({ error: '用户不存在' });
        }

        const todayKey = getLocalDateKey();
        if (user.storageLastCheckInDate === todayKey) {
            return response.status(400).json({ error: '今天已经签到过了' });
        }

        const currentLimit = getUserLimitMiB(user, config) ?? 0;
        const newLimit = currentLimit + config.checkInRewardMiB;
        user.storageLimitMiB = Math.max(0, newLimit);
        user.storageLastCheckInDate = todayKey;
        await storage.setItem(toKey(user.handle), user);

        return response.json({
            success: true,
            addedMiB: config.checkInRewardMiB,
            limitMiB: user.storageLimitMiB,
            checkedInDate: todayKey,
        });
    } catch (error) {
        console.error('Check-in failed:', error);
        return response.status(500).json({ error: '签到失败，请稍后重试' });
    }
});
