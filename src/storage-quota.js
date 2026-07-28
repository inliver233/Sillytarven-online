import fs from 'node:fs';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import { getConfigValue } from './util.js';

const MIB = 1024 * 1024;

export function getStorageConfig() {
    const enabled = getConfigValue('userStorage.enabled', false, 'boolean');
    const defaultLimitMiB = Number(getConfigValue('userStorage.defaultLimitMiB', 0, 'number')) || 0;
    const checkInRewardMiB = Number(getConfigValue('userStorage.checkInRewardMiB', 0, 'number')) || 0;

    return {
        enabled: Boolean(enabled),
        defaultLimitMiB: Math.max(0, defaultLimitMiB),
        checkInRewardMiB: Math.max(0, checkInRewardMiB),
    };
}

export function toMiB(bytes) {
    return Number.isFinite(bytes) ? bytes / MIB : 0;
}

export function toBytesFromMiB(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, value) * MIB;
}

export function getUserLimitMiB(user, config) {
    if (!config?.enabled) {
        return null;
    }

    const raw = Number.isFinite(user?.storageLimitMiB) ? user.storageLimitMiB : config.defaultLimitMiB;
    return Math.max(0, Number(raw) || 0);
}

export function getLocalDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export async function calculateDirectorySize(dirPath) {
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

export function buildStorageStatus({ usedBytes, limitMiB, rewardMiB, lastCheckInDate }) {
    const limitBytes = toBytesFromMiB(limitMiB);
    const remainingBytes = Math.max(0, limitBytes - usedBytes);
    const todayKey = getLocalDateKey();
    const canCheckIn = rewardMiB > 0 && lastCheckInDate !== todayKey;

    return {
        enabled: true,
        usedBytes,
        limitBytes,
        remainingBytes,
        usedMiB: toMiB(usedBytes),
        limitMiB,
        remainingMiB: toMiB(remainingBytes),
        checkInRewardMiB: rewardMiB,
        lastCheckInDate: lastCheckInDate || null,
        canCheckIn,
        todayKey,
    };
}

export async function canConsumeStorage(user, directories, additionalBytes) {
    const config = getStorageConfig();
    if (!config.enabled) {
        return { allowed: true, config, limitMiB: null, limitBytes: null, usedBytes: null, remainingBytes: null };
    }

    const limitMiB = getUserLimitMiB(user, config) ?? 0;
    const limitBytes = toBytesFromMiB(limitMiB);
    const usedBytes = await calculateDirectorySize(directories.root);
    const remainingBytes = Math.max(0, limitBytes - usedBytes);

    if (additionalBytes <= 0) {
        return {
            allowed: true,
            config,
            limitMiB,
            limitBytes,
            usedBytes,
            remainingBytes,
        };
    }

    return {
        allowed: remainingBytes >= additionalBytes,
        config,
        limitMiB,
        limitBytes,
        usedBytes,
        remainingBytes,
    };
}
