/**
 * 用户层邀请码发放系统 (User-tier Invitation Issuance)
 *
 * 在现有管理员邀请码系统 (./invitation-codes.js) 之上，新增一层：
 *   - 资格判断（注册时长 + 在线时长，后端判断，前端不透露具体门槛）
 *   - 配额控制（周期配额 + 未使用上限 + 全局上限，服务端锁防超额）
 *   - 规则配置（node-persist，管理员可随时调节）
 *   - 发放统计聚合（管理员查看谁邀请了谁）
 *
 * 设计原则：
 *   1. 复用 invitation-codes.js 的存储与 createInvitationCode，不改动其签名
 *   2. 用户发放的邀请码固定为「永久」(permanent)
 *   3. 不建独立统计索引 —— 直接基于 getAllInvitationCodes() 过滤（≤800 条，毫秒级），零额外存储/零漂移
 *   4. 所有资格/配额校验在服务端，前端只做展示
 */
import storage from 'node-persist';
import systemMonitor from './system-monitor.js';
import { toKey } from './users.js';
import {
    createInvitationCode,
    getAllInvitationCodes,
    isInvitationCodesEnabled,
} from './invitation-codes.js';

const CONFIG_KEY = 'invitation:user-system-config';

/** 默认规则配置（管理员可改） */
const DEFAULT_CONFIG = Object.freeze({
    enabled: true,                  // 用户发放系统总开关
    minRegisteredDays: 30,          // 注册时长门槛（天）
    minOnlineHours: 72,             // 在线时长门槛（小时）
    quotaPerPeriod: 1,              // 每周期可生成数量
    periodDays: 1,                  // 周期天数（每天 = 1）
    requireUnusedConsumed: true,    // 上一个未使用前不能生成下一个
    maxUnusedPending: 1,            // 同时未使用上限（配合 requireUnusedConsumed）
    maxTotalCodes: 800,             // 全系统邀请码总量上限
});

/** per-handle 发放并发锁（防止连点绕过配额） */
const userIssueLocks = new Set();

/**
 * 读取规则配置（缺失则写入默认值）
 * @returns {Promise<typeof DEFAULT_CONFIG>}
 */
export async function getUserInvitationConfig() {
    const stored = await storage.getItem(CONFIG_KEY);
    if (!stored || typeof stored !== 'object') {
        await storage.setItem(CONFIG_KEY, DEFAULT_CONFIG);
        return { ...DEFAULT_CONFIG };
    }
    // 合并默认值，保证新增字段有默认
    return { ...DEFAULT_CONFIG, ...stored };
}

/**
 * 写入规则配置（合并）
 * @param {Partial<typeof DEFAULT_CONFIG>} partial
 * @returns {Promise<typeof DEFAULT_CONFIG>}
 */
export async function setUserInvitationConfig(partial) {
    const current = await getUserInvitationConfig();
    const merged = { ...current, ...partial };
    // 数值字段防御性 clamp
    merged.minRegisteredDays = Math.max(0, Number(merged.minRegisteredDays) || 0);
    merged.minOnlineHours = Math.max(0, Number(merged.minOnlineHours) || 0);
    merged.quotaPerPeriod = Math.max(1, Number(merged.quotaPerPeriod) || 1);
    merged.periodDays = Math.max(1, Number(merged.periodDays) || 1);
    merged.maxUnusedPending = Math.max(1, Number(merged.maxUnusedPending) || 1);
    merged.maxTotalCodes = Math.max(1, Number(merged.maxTotalCodes) || 1);
    merged.enabled = !!merged.enabled;
    merged.requireUnusedConsumed = !!merged.requireUnusedConsumed;
    await storage.setItem(CONFIG_KEY, merged);
    return merged;
}

/**
 * 取用户累计在线时长（毫秒，含当前会话）
 * @param {string} handle
 * @returns {number}
 */
function getOnlineDurationMs(handle) {
    const stats = systemMonitor.getUserLoadStats(handle, { includeDetails: false });
    return stats?.onlineDuration ?? 0;
}

/**
 * 内部资格判断 —— 返回完整诊断（仅供后端日志/管理员，不返回给普通用户）
 * @param {string} handle
 * @returns {Promise<{eligible: boolean, reasons: string[], metrics: object}>}
 */
async function evaluateEligibility(handle) {
    const config = await getUserInvitationConfig();

    // 读取用户对象
    /** @type {any} */
    const user = await storage.getItem(toKey(handle));
    if (!user) {
        return { eligible: false, reasons: ['用户不存在'], metrics: {}, config };
    }

    // 管理员：完全豁免（不受系统开关/门槛/配额限制），保证管理员随时可管理与发放
    if (user.admin) {
        return { eligible: true, reasons: [], metrics: {}, config, isAdmin: true };
    }

    // 以下仅普通用户：主邀请码系统未启用 → 用户系统也不可用
    if (!isInvitationCodesEnabled()) {
        return { eligible: false, reasons: ['邀请码功能未启用'], metrics: {}, config };
    }
    if (!config.enabled) {
        return { eligible: false, reasons: ['用户发放系统已暂停'], metrics: {}, config, systemPaused: true };
    }

    const now = Date.now();
    const registeredDays = (now - (user.created || now)) / 86_400_000;
    const onlineHours = getOnlineDurationMs(handle) / 3_600_000;

    const reasons = [];
    if (registeredDays < config.minRegisteredDays) {
        reasons.push(`注册时长不足`);
    }
    if (onlineHours < config.minOnlineHours) {
        reasons.push(`在线时长不足`);
    }

    return {
        eligible: reasons.length === 0,
        reasons,
        metrics: { registeredDays, onlineHours },
        config,
    };
}

/**
 * 用户端：是否拥有发放资格（只返回布尔，不泄露门槛）
 * @param {string} handle
 * @returns {Promise<{eligible: boolean}>}
 */
export async function isUserEligible(handle) {
    const { eligible } = await evaluateEligibility(handle);
    return { eligible };
}

/**
 * 取某用户发放的全部邀请码（按创建时间降序）
 * @param {string} handle
 * @returns {Promise<object[]>}
 */
export async function getUserIssuedInvitations(handle) {
    const all = await getAllInvitationCodes();
    return all.filter(c => c.createdBy === handle);
}

/**
 * 计算当前配额状态（基于主数据实时聚合，无索引）
 * @param {string} handle
 * @param {object} config
 * @returns {Promise<{canIssue: boolean, quotaReason: string | null, periodIssued: number, unusedPending: number}>}
 */
async function evaluateQuota(handle, config) {
    const issued = await getUserIssuedInvitations(handle);
    const now = Date.now();
    const periodMs = config.periodDays * 86_400_000;

    // 本周期起点（对齐到 periodDays 天的边界）
    const periodStart = now - (now % periodMs);
    const periodIssued = issued.filter(c => c.createdAt >= periodStart).length;
    const unusedPending = issued.filter(c => !c.used).length;

    // 1. 周期配额
    if (periodIssued >= config.quotaPerPeriod) {
        return { canIssue: false, quotaReason: '当前周期可生成数量已达上限，请稍后再试', periodIssued, unusedPending };
    }
    // 2. 未使用上限（上一个用完才能发下一个）
    if (config.requireUnusedConsumed && unusedPending >= config.maxUnusedPending) {
        return { canIssue: false, quotaReason: '您还有未使用的邀请码，待其被使用后方可生成新的', periodIssued, unusedPending };
    }
    // 3. 全局上限
    const all = await getAllInvitationCodes();
    if (all.length >= config.maxTotalCodes) {
        return { canIssue: false, quotaReason: '系统邀请码总量已达上限，请联系管理员', periodIssued, unusedPending };
    }

    return { canIssue: true, quotaReason: null, periodIssued, unusedPending };
}

/**
 * 用户端：发放一个永久邀请码（全套服务端校验 + 锁）
 * @param {string} handle
 * @returns {Promise<{success: boolean, reason?: string, invitation?: object}>}
 */
export async function issueUserInvitation(handle) {
    if (!handle) {
        return { success: false, reason: '无效的用户' };
    }

    // per-handle 并发锁
    if (userIssueLocks.has(handle)) {
        return { success: false, reason: '请稍候，正在处理上一个请求' };
    }
    userIssueLocks.add(handle);
    try {
        // 1. 资格（不泄露门槛，失败只返回通用提示）
        const elig = await evaluateEligibility(handle);
        if (!elig.eligible) {
            // 系统暂停/功能关闭属配置类，可明确告知；资格门槛不足一律模糊提示
            if (elig.systemPaused) {
                return { success: false, reason: '用户邀请码发放系统暂未开放' };
            }
            if (!isInvitationCodesEnabled()) {
                return { success: false, reason: '邀请码功能未启用' };
            }
            return { success: false, reason: '未达到发放邀请码的资格' };
        }

        // 2. 配额（管理员豁免周期配额与未使用上限，仅保留全局上限保护）
        if (elig.isAdmin) {
            const all = await getAllInvitationCodes();
            if (all.length >= elig.config.maxTotalCodes) {
                return { success: false, reason: '系统邀请码总量已达上限，请联系管理员' };
            }
        } else {
            const quota = await evaluateQuota(handle, elig.config);
            if (!quota.canIssue) {
                return { success: false, reason: quota.quotaReason };
            }
        }

        // 3. 真正创建（永久码）
        const invitation = await createInvitationCode(handle, 'permanent');
        console.log(`User invitation issued by ${handle}: ${invitation.code}`);
        return { success: true, invitation };
    } catch (error) {
        console.error('issueUserInvitation failed:', error);
        return { success: false, reason: error.message || '生成邀请码失败' };
    } finally {
        userIssueLocks.delete(handle);
    }
}

/**
 * 管理员端：发放者统计聚合（谁发了多少 / 邀请了谁）
 * @param {object} [opts]
 * @param {number} [opts.limit=100]
 * @returns {Promise<object[]>}
 */
export async function getIssuerStats({ limit = 100 } = {}) {
    const all = await getAllInvitationCodes();
    /** @type {Map<string, {handle: string, totalIssued: number, totalUsed: number, unusedPending: number, lastIssueAt: number, invitedUsers: string[]})>} */
    const map = new Map();
    for (const c of all) {
        const key = c.createdBy || '(unknown)';
        if (!map.has(key)) {
            map.set(key, {
                handle: key,
                totalIssued: 0,
                totalUsed: 0,
                unusedPending: 0,
                lastIssueAt: 0,
                invitedUsers: [],
            });
        }
        const s = map.get(key);
        s.totalIssued++;
        if (c.used) {
            s.totalUsed++;
            if (c.usedBy) s.invitedUsers.push(c.usedBy);
        } else {
            s.unusedPending++;
        }
        if (c.createdAt > s.lastIssueAt) s.lastIssueAt = c.createdAt;
    }
    return [...map.values()]
        .sort((a, b) => b.totalIssued - a.totalIssued)
        .slice(0, limit);
}

/**
 * 用户端：一次性返回面板所需全部数据（资格布尔 + 我的邀请码列表）
 * 注意：不返回 reasons/metrics/config，防止泄露门槛
 * @param {string} handle
 * @returns {Promise<{eligible: boolean, codes: object[]}>}
 */
export async function getMyInvitationData(handle) {
    const config = await getUserInvitationConfig();
    const evalResult = await evaluateEligibility(handle);
    const codes = await getUserIssuedInvitations(handle);
    // 管理员总能进入（便于管理与开启）；普通用户受系统开关限制
    const systemEnabled = !!evalResult.isAdmin || (config.enabled && isInvitationCodesEnabled());
    return {
        eligible: evalResult.eligible,
        codes,
        systemEnabled,
        isAdmin: !!evalResult.isAdmin,
    };
}
