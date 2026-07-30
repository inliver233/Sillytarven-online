/**
 * User invitation issuance system.
 *
 * It reuses invitation redemption while keeping issuance policy, source
 * metadata, statistics, limits and administration separate from legacy
 * administrator-created invitation codes.
 */
import storage from 'node-persist';
import systemMonitor from './system-monitor.js';
import { toKey } from './users.js';
import {
    createInvitationCode,
    deleteInvitationCode,
    getAllInvitationCodes,
    isInvitationCodesEnabled,
    setInvitationCodeSource,
} from './invitation-codes.js';
import {
    ADMIN_INVITATION_SOURCE,
    calculateUserInvitationQuota,
    DEFAULT_USER_INVITATION_CONFIG,
    isUserIssuedInvitation,
    mergeUserInvitationConfig,
    USER_INVITATION_SOURCE,
} from './user-invitation-policy.js';

// Keep user-system data outside the invitation:<code> namespace.
const CONFIG_KEY = 'user-invitation:config';
const LEGACY_CONFIG_KEY = 'invitation:user-system-config';
const ONLINE_BASELINE_PREFIX = 'user-invitation:online-baseline:';

/** Per-handle fast rejection for duplicate button clicks. */
const userIssueLocks = new Set();
/** Serializes all issuers so the configured global cap cannot be raced. */
let globalIssueQueue = Promise.resolve();
/** Stable online-duration values while monitor statistics are being reset. */
const onlineDurationSnapshots = new Map();

function getOnlineBaselineKey(handle) {
    return `${ONLINE_BASELINE_PREFIX}${handle}`;
}

async function runWithGlobalIssueLock(task) {
    const previous = globalIssueQueue;
    let release;
    globalIssueQueue = new Promise(resolve => {
        release = resolve;
    });
    await previous;
    try {
        return await task();
    } finally {
        release();
    }
}

/**
 * Read rule configuration, migrating the original key if necessary.
 * @returns {Promise<typeof DEFAULT_USER_INVITATION_CONFIG>}
 */
export async function getUserInvitationConfig() {
    let stored = await storage.getItem(CONFIG_KEY);
    const hasCurrentConfig = Boolean(stored && typeof stored === 'object');
    let migratedLegacy = false;
    if (!hasCurrentConfig) {
        const legacy = await storage.getItem(LEGACY_CONFIG_KEY);
        if (legacy && typeof legacy === 'object') {
            stored = legacy;
            migratedLegacy = true;
        }
    }

    const config = mergeUserInvitationConfig(DEFAULT_USER_INVITATION_CONFIG, stored || {});
    if (!hasCurrentConfig) {
        await storage.setItem(CONFIG_KEY, config);
    }
    if (migratedLegacy) {
        await storage.removeItem(LEGACY_CONFIG_KEY);
    }
    return config;
}

/**
 * Update administrator-controlled rules using a strict allow-list.
 * @param {Partial<typeof DEFAULT_USER_INVITATION_CONFIG>} partial Changes
 * @returns {Promise<typeof DEFAULT_USER_INVITATION_CONFIG>}
 */
export async function setUserInvitationConfig(partial) {
    const current = await getUserInvitationConfig();
    const merged = mergeUserInvitationConfig(current, partial);
    await storage.setItem(CONFIG_KEY, merged);
    return merged;
}

async function getOnlineBaselineMs(handle) {
    const stored = await storage.getItem(getOnlineBaselineKey(handle));
    const value = typeof stored === 'object' ? stored?.durationMs : stored;
    return Number.isFinite(value) && value > 0 ? value : 0;
}

async function getOnlineDurationMs(handle) {
    if (onlineDurationSnapshots.has(handle)) {
        return onlineDurationSnapshots.get(handle);
    }
    const baselineMs = await getOnlineBaselineMs(handle);
    const stats = systemMonitor.getUserLoadStats(handle, { includeDetails: false });
    return baselineMs + (stats?.onlineDuration ?? 0);
}

async function persistOnlineBaseline(handle, durationMs) {
    await storage.setItem(getOnlineBaselineKey(handle), {
        durationMs: Math.max(0, Number(durationMs) || 0),
        preservedAt: Date.now(),
    });
}

/**
 * Reset one monitor record without resetting invitation eligibility time.
 * @param {string} handle User handle
 * @returns {Promise<void>}
 */
export async function resetUserStatsPreservingInvitationDuration(handle) {
    const totalDurationMs = await getOnlineDurationMs(handle);
    onlineDurationSnapshots.set(handle, totalDurationMs);
    try {
        await persistOnlineBaseline(handle, totalDurationMs);
        systemMonitor.resetUserStats(handle);
        systemMonitor.saveDataToDisk();
    } finally {
        onlineDurationSnapshots.delete(handle);
    }
}

/**
 * Clear monitor data while retaining the cumulative duration used by policy.
 * @returns {Promise<void>}
 */
export async function clearSystemStatsPreservingInvitationDurations() {
    const stats = systemMonitor.getAllUserLoadStats({ includeDetails: false });
    try {
        for (const userStats of stats) {
            const handle = userStats.userHandle;
            const totalDurationMs = await getOnlineDurationMs(handle);
            onlineDurationSnapshots.set(handle, totalDurationMs);
            await persistOnlineBaseline(handle, totalDurationMs);
        }
        systemMonitor.clearAllStats();
    } finally {
        onlineDurationSnapshots.clear();
    }
}

/**
 * Upgrade source-less records. Legacy issuance was admin-only, so a record
 * created by a currently known non-admin can safely be attributed to the user
 * issuance feature. All other source-less records remain legacy/admin records.
 * @param {object[]} invitations All invitation records
 * @returns {Promise<object[]>} Records with normalized source metadata
 */
async function migrateLegacyInvitationSources(invitations) {
    const userCache = new Map();
    for (const invitation of invitations) {
        if (invitation.issuanceSource) {
            continue;
        }
        const handle = invitation.createdBy;
        if (!userCache.has(handle)) {
            userCache.set(handle, handle ? await storage.getItem(toKey(handle)) : null);
        }
        const creator = userCache.get(handle);
        const source = creator && !creator.admin ? USER_INVITATION_SOURCE : ADMIN_INVITATION_SOURCE;
        invitation.issuanceSource = source;
        await setInvitationCodeSource(invitation.code, source);
    }
    return invitations;
}

async function getAllUserSystemInvitations() {
    const all = await migrateLegacyInvitationSources(await getAllInvitationCodes());
    return all.filter(isUserIssuedInvitation);
}

/**
 * Run storage-key and source metadata migrations before accepting requests.
 * @returns {Promise<void>}
 */
export async function initializeUserInvitationSystem() {
    try {
        await getUserInvitationConfig();
        await getAllUserSystemInvitations();
    } catch (error) {
        // This optional feature must not prevent the main server from starting.
        console.error('Failed to initialize user invitation system:', error);
    }
}

/**
 * Evaluate hidden registration and online-duration requirements.
 * @param {string} handle User handle
 * @returns {Promise<object>} Internal diagnostic result
 */
async function evaluateEligibility(handle) {
    const config = await getUserInvitationConfig();
    if (!isInvitationCodesEnabled()) {
        return { eligible: false, reasons: ['邀请码功能未启用'], metrics: {}, config, systemPaused: true };
    }
    if (!config.enabled) {
        return { eligible: false, reasons: ['用户发放系统已暂停'], metrics: {}, config, systemPaused: true };
    }

    const user = await storage.getItem(toKey(handle));
    if (!user) {
        return { eligible: false, reasons: ['用户不存在'], metrics: {}, config };
    }

    const now = Date.now();
    const createdAt = Number.isFinite(user.created) ? user.created : now;
    const registeredDays = Math.max(0, now - createdAt) / 86_400_000;
    const onlineHours = await getOnlineDurationMs(handle) / 3_600_000;
    const reasons = [];
    if (registeredDays < config.minRegisteredDays) {
        reasons.push('注册时长不足');
    }
    if (onlineHours < config.minOnlineHours) {
        reasons.push('在线时长不足');
    }

    return {
        eligible: reasons.length === 0,
        reasons,
        metrics: { registeredDays, onlineHours },
        config,
    };
}

/**
 * User-facing eligibility check; does not reveal thresholds.
 * @param {string} handle User handle
 * @returns {Promise<{eligible: boolean}>}
 */
export async function isUserEligible(handle) {
    const { eligible } = await evaluateEligibility(handle);
    return { eligible };
}

/**
 * Return only invitations issued by this user through the user system.
 * @param {string} handle User handle
 * @returns {Promise<object[]>}
 */
export async function getUserIssuedInvitations(handle) {
    const all = await getAllUserSystemInvitations();
    return all.filter(invitation => invitation.createdBy === handle);
}

function toClientIssuanceState(quota) {
    return {
        canIssue: quota.canIssue,
        blockedReason: quota.reason,
        nextIssueAt: quota.nextIssueAt,
    };
}

/**
 * Issue one permanent user-system invitation with all checks under one global
 * critical section.
 * @param {string} handle User handle
 * @returns {Promise<{success: boolean, reason?: string, invitation?: object}>}
 */
export async function issueUserInvitation(handle) {
    if (!handle) {
        return { success: false, reason: '无效的用户' };
    }
    if (userIssueLocks.has(handle)) {
        return { success: false, reason: '请稍候，正在处理上一个请求' };
    }

    userIssueLocks.add(handle);
    try {
        return await runWithGlobalIssueLock(async () => {
            const eligibility = await evaluateEligibility(handle);
            if (!eligibility.eligible) {
                return {
                    success: false,
                    reason: eligibility.systemPaused ? '用户邀请码发放系统暂未开放' : '未达到发放邀请码的资格',
                };
            }

            // Re-read all user-system records inside the lock. This makes both
            // per-user quota and the global maximum authoritative server-side.
            const allUserCodes = await getAllUserSystemInvitations();
            const issuedByUser = allUserCodes.filter(invitation => invitation.createdBy === handle);
            const quota = calculateUserInvitationQuota(
                issuedByUser,
                allUserCodes.length,
                eligibility.config,
            );
            if (!quota.canIssue) {
                return { success: false, reason: quota.reason };
            }

            const invitation = await createInvitationCode(handle, 'permanent', {
                issuanceSource: USER_INVITATION_SOURCE,
            });
            console.log(`User invitation issued by ${handle}: ${invitation.code}`);
            return { success: true, invitation };
        });
    } catch (error) {
        console.error('issueUserInvitation failed:', error);
        return { success: false, reason: '生成邀请码失败' };
    } finally {
        userIssueLocks.delete(handle);
    }
}

function aggregateIssuerStats(all, limit) {
    const map = new Map();
    for (const invitation of all) {
        const key = invitation.createdBy || '(unknown)';
        if (!map.has(key)) {
            map.set(key, {
                handle: key,
                totalIssued: 0,
                totalUsed: 0,
                unusedPending: 0,
                lastIssueAt: 0,
                invitedUsers: [],
                invitations: [],
            });
        }
        const stats = map.get(key);
        stats.totalIssued++;
        if (invitation.used) {
            stats.totalUsed++;
            if (invitation.usedBy) {
                stats.invitedUsers.push(invitation.usedBy);
            }
        } else {
            stats.unusedPending++;
        }
        stats.lastIssueAt = Math.max(stats.lastIssueAt, invitation.createdAt || 0);
        stats.invitations.push({
            code: invitation.code,
            createdAt: invitation.createdAt,
            used: Boolean(invitation.used),
            usedBy: invitation.usedBy || null,
            usedAt: invitation.usedAt || null,
        });
    }
    return [...map.values()]
        .sort((a, b) => b.totalIssued - a.totalIssued)
        .slice(0, limit);
}

/**
 * Administrator issuer statistics for the independent user system only.
 * @param {object} [options] Query options
 * @param {number} [options.limit=100] Maximum issuers
 * @returns {Promise<object[]>} Issuer rows
 */
export async function getIssuerStats({ limit = 100 } = {}) {
    const all = await getAllUserSystemInvitations();
    return aggregateIssuerStats(all, limit);
}

/**
 * Return administrator dashboard data in one storage scan.
 * @param {object} [options] Query options
 * @param {number} [options.limit=100] Maximum issuers
 * @returns {Promise<{stats: object[], summary: object}>} Dashboard data
 */
export async function getUserInvitationAdminData({ limit = 100 } = {}) {
    const all = await getAllUserSystemInvitations();
    const issuerCount = new Set(all.map(invitation => invitation.createdBy)).size;
    return {
        stats: aggregateIssuerStats(all, limit),
        summary: {
            totalIssued: all.length,
            totalUsed: all.filter(invitation => invitation.used).length,
            unusedPending: all.filter(invitation => !invitation.used).length,
            totalIssuers: issuerCount,
        },
    };
}

/**
 * Delete one user-system invitation without allowing cross-system deletion.
 * @param {string} code Invitation code
 * @returns {Promise<{deleted: boolean, reason?: string}>} Deletion result
 */
export async function deleteUserInvitation(code) {
    const normalizedCode = String(code || '').toUpperCase();
    const invitation = (await getAllUserSystemInvitations())
        .find(item => item.code === normalizedCode);
    if (!invitation) {
        return { deleted: false, reason: '用户邀请码不存在' };
    }
    if (invitation.used) {
        return { deleted: false, reason: '已使用的邀请码需要保留邀请关系，不能撤销' };
    }
    const deleted = await deleteInvitationCode(normalizedCode, {
        issuanceSource: USER_INVITATION_SOURCE,
    });
    return { deleted, reason: deleted ? undefined : '用户邀请码不存在' };
}

/**
 * Return all data needed by the user panel without exposing qualification
 * thresholds or metrics.
 * @param {string} handle User handle
 * @returns {Promise<object>} User panel data
 */
export async function getMyInvitationData(handle) {
    const eligibility = await evaluateEligibility(handle);
    const allUserCodes = await getAllUserSystemInvitations();
    const codes = allUserCodes.filter(invitation => invitation.createdBy === handle);
    const systemEnabled = eligibility.config.enabled && isInvitationCodesEnabled();
    const issuance = eligibility.eligible
        ? toClientIssuanceState(calculateUserInvitationQuota(
            codes,
            allUserCodes.length,
            eligibility.config,
        ))
        : { canIssue: false, blockedReason: null, nextIssueAt: null };

    return {
        eligible: eligibility.eligible,
        codes,
        systemEnabled,
        issuance,
    };
}
