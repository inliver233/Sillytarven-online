import storage from 'node-persist';
import crypto from 'node:crypto';

const STORAGE_CODE_PREFIX = 'storage-code:';

/**
 * @typedef {Object} StorageCode
 * @property {string} code - 激活码
 * @property {string} createdBy - 创建者用户句柄
 * @property {number} createdAt - 创建时间戳
 * @property {boolean} used - 是否已使用
 * @property {string | null} usedBy - 使用者用户句柄（如果已使用）
 * @property {number | null} usedAt - 使用时间戳（如果已使用）
 * @property {number} addMiB - 增加的空间大小（MiB）
 */

function toStorageCodeKey(code) {
    return `${STORAGE_CODE_PREFIX}${code}`;
}

function generateStorageCode() {
    return crypto.randomBytes(8).toString('hex').toUpperCase();
}

export async function createStorageCodes(createdBy, count, addMiB) {
    const sanitizedCount = Math.max(1, Math.min(5000, Number.parseInt(count, 10) || 0));
    const sanitizedMiB = Math.max(0.01, Number(addMiB) || 0);
    const createdAt = Date.now();

    const codes = [];
    for (let i = 0; i < sanitizedCount; i += 1) {
        const code = generateStorageCode();
        const payload = {
            code,
            createdBy,
            createdAt,
            used: false,
            usedBy: null,
            usedAt: null,
            addMiB: sanitizedMiB,
        };
        await storage.setItem(toStorageCodeKey(code), payload);
        codes.push(payload);
    }

    console.log(`Storage codes created: ${codes.length} by ${createdBy}, addMiB: ${sanitizedMiB}`);
    return codes;
}

export async function validateStorageCode(code) {
    if (!code || typeof code !== 'string') {
        return { valid: false, reason: '激活码格式无效' };
    }

    const normalized = code.toUpperCase().trim();
    const entry = await storage.getItem(toStorageCodeKey(normalized));
    if (!entry) {
        return { valid: false, reason: '激活码不存在' };
    }

    if (entry.used) {
        return { valid: false, reason: '激活码已被使用' };
    }

    return { valid: true, code: entry };
}

export async function useStorageCode(code, usedBy) {
    const validation = await validateStorageCode(code);
    if (!validation.valid || !validation.code) {
        return { success: false, reason: validation.reason || '激活码无效' };
    }

    const entry = validation.code;
    entry.used = true;
    entry.usedBy = usedBy;
    entry.usedAt = Date.now();

    await storage.setItem(toStorageCodeKey(entry.code.toUpperCase()), entry);
    console.log(`Storage code used: ${entry.code} by ${usedBy}, addMiB: ${entry.addMiB}`);
    return { success: true, code: entry };
}
