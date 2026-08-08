import storage from 'node-persist';
import crypto from 'node:crypto';
import { isInvitationCodeSystemEnabled } from './registration-policy.js';
import {
    ADMIN_INVITATION_SOURCE,
    getInvitationSource,
    USER_INVITATION_SOURCE,
} from './user-invitation-policy.js';

const INVITATION_PREFIX = 'invitation:';
const PURCHASE_LINK_KEY = 'invitation:purchaseLink';
const invitationUseLocks = new Set();

/**
 * @typedef {Object} InvitationCode
 * @property {string} code - 邀请码
 * @property {string} createdBy - 创建者用户句柄
 * @property {number} createdAt - 创建时间戳
 * @property {boolean} used - 是否已使用
 * @property {string | null} usedBy - 使用者用户句柄（如果已使用）
 * @property {number | null} usedAt - 使用时间戳（如果已使用）
 * @property {string} durationType - 新邀请码固定为 'permanent'；其他值仅用于读取旧数据
 * @property {number | null} durationDays - 新邀请码固定为 null
 * @property {number | null} userExpiresAt - 新账号固定为 null；非空值仅用于读取旧数据
 * @property {'admin' | 'user'} [issuanceSource] - 发放来源（旧数据缺失时视为 admin）
 */

/**
 * 生成邀请码key
 * @param {string} code 邀请码
 * @returns {string} 存储key
 */
function toInvitationKey(code) {
    return `${INVITATION_PREFIX}${code}`;
}

/**
 * 生成随机邀请码
 * @returns {string} 邀请码
 */
function generateInvitationCode() {
    return crypto.randomBytes(8).toString('hex').toUpperCase();
}

/**
 * 创建邀请码
 * @param {string} createdBy 创建者用户句柄
 * @param {string} durationType 旧客户端兼容参数；新邀请码始终为永久类型
 * @param {{issuanceSource?: 'admin' | 'user'}} [options] 发放来源
 * @returns {Promise<InvitationCode>} 创建的邀请码对象
 */
export async function createInvitationCode(createdBy, durationType = 'permanent', { issuanceSource = ADMIN_INVITATION_SOURCE } = {}) {
    if (!isInvitationCodesEnabled()) {
        throw new Error('邀请码功能未启用');
    }

    const code = generateInvitationCode();
    const now = Date.now();
    // Duration values from older clients are accepted for API compatibility,
    // but invitation codes now always create permanent accounts.
    const normalizedDurationType = durationType === 'permanent' ? durationType : 'permanent';
    const normalizedSource = issuanceSource === USER_INVITATION_SOURCE
        ? USER_INVITATION_SOURCE
        : ADMIN_INVITATION_SOURCE;

    const invitation = {
        code,
        createdBy,
        createdAt: now,
        used: false,
        usedBy: null,
        usedAt: null,
        durationType: normalizedDurationType,
        durationDays: null,
        userExpiresAt: null,  // 使用后会设置为用户的到期时间
        issuanceSource: normalizedSource,
    };

    await storage.setItem(toInvitationKey(code), invitation);
    console.log(`Invitation code created: ${code} by ${createdBy}, duration: permanent, source: ${normalizedSource}`);

    return invitation;
}

/**
 * 验证邀请码
 * @param {string} code 邀请码
 * @param {{required?: boolean, claimId?: string}} [options] Whether this operation requires a code and an optional durable claim identifier
 * @returns {Promise<{valid: boolean, reason?: string, invitation?: InvitationCode}>} 验证结果
 */
export async function validateInvitationCode(code, { required = isInvitationCodesEnabled() } = {}) {
    if (!required) {
        return { valid: true }; // 如果功能未启用，则认为有效
    }

    if (!code || typeof code !== 'string') {
        return { valid: false, reason: '邀请码格式无效' };
    }

    const invitation = await storage.getItem(toInvitationKey(code.toUpperCase()));

    if (!invitation) {
        return { valid: false, reason: '邀请码不存在' };
    }

    if (invitation.used) {
        return { valid: false, reason: '邀请码已被使用' };
    }

    // 邀请码永不过期

    return { valid: true, invitation };
}

/**
 * 使用邀请码
 * @param {string} code 邀请码
 * @param {string} usedBy 使用者用户句柄
 * @param {number | null} userExpiresAt 用户到期时间
 * @param {{required?: boolean}} [options] Whether this operation requires a code
 * @returns {Promise<{success: boolean, reason?: string, invitation?: InvitationCode}>} 使用结果及邀请码信息
 */
export async function useInvitationCode(code, usedBy, userExpiresAt = null, {
    required = isInvitationCodesEnabled(),
    claimId,
} = {}) {
    if (!required) {
        return { success: true }; // 如果功能未启用，则认为成功
    }

    if (!code || typeof code !== 'string') {
        return { success: false, reason: '邀请码格式无效' };
    }
    if (claimId !== undefined && (typeof claimId !== 'string' || !claimId || claimId.length > 128)) {
        throw new TypeError('Invalid invitation claim id');
    }

    const normalizedCode = code.toUpperCase();
    if (invitationUseLocks.has(normalizedCode)) {
        return { success: false, reason: '邀请码正在被使用，请稍后重试' };
    }

    invitationUseLocks.add(normalizedCode);
    try {
        // 在锁内重新读取，避免两个并发注册同时消费同一个邀请码。
        const invitation = await storage.getItem(toInvitationKey(normalizedCode));
        if (!invitation) {
            return { success: false, reason: '邀请码不存在' };
        }
        if (invitation.used) {
            // stcontrol registration may be interrupted after this durable
            // write. The same registration claim can resume, but another
            // registration (even for the same handle) can never reuse it.
            if (claimId && invitation.claimId === claimId && invitation.usedBy === usedBy) {
                return { success: true, invitation, replayed: true };
            }
            return { success: false, reason: '邀请码已被使用' };
        }
        invitation.used = true;
        invitation.usedBy = usedBy;
        invitation.usedAt = Date.now();
        invitation.userExpiresAt = userExpiresAt; // 记录用户的到期时间
        if (claimId) invitation.claimId = claimId;

        await storage.setItem(toInvitationKey(normalizedCode), invitation);
        console.log(`Invitation code used by ${usedBy}, duration: ${invitation.durationType}, user expires: ${userExpiresAt ? new Date(userExpiresAt).toLocaleString() : 'permanent'}`);

        return { success: true, invitation };
    } finally {
        invitationUseLocks.delete(normalizedCode);
    }
}

/**
 * 获取所有邀请码
 * @returns {Promise<InvitationCode[]>} 邀请码列表
 */
export async function getAllInvitationCodes() {
    if (!isInvitationCodesEnabled()) {
        return [];
    }

    const keys = await storage.keys();
    // Only 16-character hexadecimal suffixes are invitation records. Do not
    // delete unrelated values that happen to share the "invitation:" namespace.
    const invitationKeys = keys.filter(key => {
        if (!key.startsWith(INVITATION_PREFIX) || key === PURCHASE_LINK_KEY) {
            return false;
        }
        return /^[A-F0-9]{16}$/.test(key.slice(INVITATION_PREFIX.length));
    });

    const invitations = [];
    for (const key of invitationKeys) {
        const invitation = await storage.getItem(key);
        // 过滤掉无效的邀请码（code为undefined、null或空字符串）
        if (invitation && invitation.code && typeof invitation.code === 'string') {
            invitations.push(invitation);
        } else if (invitation) {
            // 删除无效的邀请码
            await storage.removeItem(key);
        }
    }

    // 按创建时间降序排序
    return invitations.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 获取指定发放系统的邀请码。
 * @param {'admin' | 'user'} issuanceSource 发放来源
 * @returns {Promise<InvitationCode[]>} 邀请码列表
 */
export async function getInvitationCodesBySource(issuanceSource) {
    const invitations = await getAllInvitationCodes();
    return invitations.filter(invitation => getInvitationSource(invitation) === issuanceSource);
}

/**
 * 为旧邀请码补写发放来源。
 * @param {string} code 邀请码
 * @param {'admin' | 'user'} issuanceSource 发放来源
 * @returns {Promise<boolean>} 是否更新成功
 */
export async function setInvitationCodeSource(code, issuanceSource) {
    if (!code || ![ADMIN_INVITATION_SOURCE, USER_INVITATION_SOURCE].includes(issuanceSource)) {
        return false;
    }
    const normalizedCode = String(code).toUpperCase();
    const invitation = await storage.getItem(toInvitationKey(normalizedCode));
    if (!invitation) {
        return false;
    }
    invitation.issuanceSource = issuanceSource;
    await storage.setItem(toInvitationKey(normalizedCode), invitation);
    return true;
}

/**
 * 删除邀请码
 * @param {string} code 邀请码
 * @param {{issuanceSource?: 'admin' | 'user'}} [options] 限定来源，防止跨系统误删
 * @returns {Promise<boolean>} 是否成功删除
 */
export async function deleteInvitationCode(code, { issuanceSource } = {}) {
    if (!isInvitationCodesEnabled()) {
        return false;
    }

    const key = toInvitationKey(code.toUpperCase());
    const invitation = await storage.getItem(key);

    if (!invitation) {
        return false;
    }

    if (issuanceSource && getInvitationSource(invitation) !== issuanceSource) {
        return false;
    }

    await storage.removeItem(key);
    console.log(`Invitation code deleted: ${code}`);

    return true;
}

/**
 * 检查是否启用邀请码功能
 * @returns {boolean} 是否启用
 */
export function isInvitationCodesEnabled() {
    return isInvitationCodeSystemEnabled();
}

/**
 * 清理已使用的邀请码（可选功能）
 * @returns {Promise<number>} 清理的数量
 */
export async function cleanupExpiredInvitationCodes() {
    if (!isInvitationCodesEnabled()) {
        return 0;
    }

    let cleanedCount = 0;

    // 只清理已使用的邀请码（可选）
    // 注释掉此功能，因为已使用的邀请码可能需要保留用于记录
    /*
    const invitations = await getAllInvitationCodes();
    for (const invitation of invitations) {
        if (invitation.used) {
            await deleteInvitationCode(invitation.code);
            cleanedCount++;
        }
    }
    */

    if (cleanedCount > 0) {
        console.log(`Cleaned up ${cleanedCount} used invitation codes`);
    }

    return cleanedCount;
}

/**
 * 设置购买链接
 * @param {string} purchaseLink 购买链接URL
 * @returns {Promise<void>}
 */
export async function setPurchaseLink(purchaseLink) {
    await storage.setItem(PURCHASE_LINK_KEY, purchaseLink || '');
    console.log('Purchase link updated:', purchaseLink || '(cleared)');
}

/**
 * 获取购买链接
 * @returns {Promise<string>} 购买链接URL
 */
export async function getPurchaseLink() {
    const link = await storage.getItem(PURCHASE_LINK_KEY);
    return link || '';
}
