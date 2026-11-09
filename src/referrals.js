/**
 * 邀请奖励（推广，像 aff 那样）：每个用户一个可以反复使用的邀请码 / 邀请链接（/invite/<码>）。
 * 新账号（注册不满 claimWindowDays 天）绑定邀请人后，双方各加指定的存储空间；邀请人通过邀请拿到的
 * 空间有上限。可选：被邀请人收到第一条有效的 AI 回复（服务器转发生成时判断，usage-meter.js 调
 * noteValidReply）才算成功、才发奖励；等太久没成功的作废。
 *
 * 谁能邀请沿用用户邀请码的门槛（注册天数、在线时长，管理员在同一处设置）。用户发放的注册邀请码
 * 在注册时被用掉，也记一次邀请（bindFromInvitation）。
 *
 * 存储（node-persist）：
 *   referral:config                 设置
 *   referral:code:<码>              { code, owner, createdAt }
 *   referral:owner:<账号>           { code } 或 { blocked: { at, by } }（管理员停用了这个人的邀请）
 *   referral:link:<被邀请人>        { invitee, inviter, code, source, boundAt, status, successAt, inviterRewardMiB, inviteeRewardMiB, revokedAt, reclaimed }
 *   referral:inviter:<邀请人>       [被邀请人]
 *   referral:index                  [所有被邀请人]（管理员列表）
 */
import crypto from 'node:crypto';

import storage from 'node-persist';

import { live } from './live.js';
import { getStorageConfig, getUserLimitMiB } from './storage-quota.js';
import { getInvitationOnlineHours, getUserInvitationConfig } from './user-invitations.js';
import { toKey } from './users.js';

const CONFIG_KEY = 'referral:config';
const CODE_PREFIX = 'referral:code:';
const OWNER_PREFIX = 'referral:owner:';
const LINK_PREFIX = 'referral:link:';
const INVITER_PREFIX = 'referral:inviter:';
const INDEX_KEY = 'referral:index';
/** 不易看错的字符 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const DAY_MS = 86_400_000;

export const STATUS = Object.freeze({ PENDING: 'pending', SUCCESS: 'success', REVOKED: 'revoked', EXPIRED: 'expired' });

export const DEFAULT_REFERRAL_CONFIG = Object.freeze({
    enabled: false,
    inviterRewardMiB: 150,
    inviteeRewardMiB: 150,
    /** 邀请人通过邀请最多拿多少（0 = 不限） */
    inviterCapMiB: 1500,
    /** 被邀请人注册多少天内可以绑定 */
    claimWindowDays: 7,
    /** 收到第一条有效 AI 回复才算成功 */
    requireValidReply: true,
    /** 待成功的邀请多少天后作废（0 = 不作废） */
    pendingExpireDays: 30,
});

const LIMITS = Object.freeze({
    inviterRewardMiB: [0, 100_000],
    inviteeRewardMiB: [0, 100_000],
    inviterCapMiB: [0, 10_000_000],
    claimWindowDays: [0, 3650],
    pendingExpireDays: [0, 3650],
});

/**
 * @param {any} current
 * @param {any} [partial]
 * @returns {typeof DEFAULT_REFERRAL_CONFIG}
 */
export function mergeReferralConfig(current, partial = {}) {
    const merged = { ...DEFAULT_REFERRAL_CONFIG, ...(current && typeof current === 'object' ? current : {}) };
    const requested = partial && typeof partial === 'object' ? partial : {};
    for (const key of ['enabled', 'requireValidReply']) {
        merged[key] = typeof requested[key] === 'boolean' ? requested[key] : Boolean(merged[key]);
    }
    for (const [key, [min, max]] of Object.entries(LIMITS)) {
        const value = Object.hasOwn(requested, key) ? Number(requested[key]) : Number(merged[key]);
        merged[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : DEFAULT_REFERRAL_CONFIG[key];
    }
    return /** @type {any} */ (Object.fromEntries(Object.keys(DEFAULT_REFERRAL_CONFIG).map(key => [key, merged[key]])));
}

export async function getReferralConfig() {
    return mergeReferralConfig(await storage.getItem(CONFIG_KEY));
}

/** @param {any} partial */
export async function setReferralConfig(partial) {
    const merged = mergeReferralConfig(await getReferralConfig(), partial);
    await storage.setItem(CONFIG_KEY, merged);
    return merged;
}

/** 奖励空间要有存储上限这套才有意义 */
export function rewardsAvailable() {
    return getStorageConfig().enabled;
}

// ---------------------------------------------------------------------------
// 一次只处理一件事：绑定、发奖励、撤销都在这里排队，上限和「只奖励一次」不会被并发绕过
// ---------------------------------------------------------------------------

let queue = Promise.resolve();
function serialized(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
}

/** 等待成功的被邀请人（收到有效回复时只查内存） @type {Set<string>} */
const pendingInvitees = new Set();
let pendingLoaded = false;

async function loadPending() {
    if (pendingLoaded) return;
    pendingLoaded = true;
    for (const invitee of await readList(INDEX_KEY)) {
        const link = await storage.getItem(LINK_PREFIX + invitee);
        if (link?.status === STATUS.PENDING) pendingInvitees.add(invitee);
    }
}

async function readList(key) {
    const value = await storage.getItem(key);
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

async function addToList(key, item) {
    const list = await readList(key);
    if (!list.includes(item)) {
        list.push(item);
        await storage.setItem(key, list);
    }
}

// ---------------------------------------------------------------------------
// 邀请码
// ---------------------------------------------------------------------------

function generateCode() {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    return Array.from(bytes, byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

/** @param {unknown} code */
export function normalizeCode(code) {
    const text = String(code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    return text.length === CODE_LENGTH ? text : '';
}

/**
 * 这个用户的邀请码，没有就生成一个。
 * @param {string} handle
 * @returns {Promise<string>}
 */
export function ensureCode(handle) {
    return serialized(async () => {
        const owned = await storage.getItem(OWNER_PREFIX + handle);
        if (owned?.blocked) throw new Error('邀请已被停用');
        if (owned?.code) return owned.code;
        return createCode(handle);
    });
}

async function createCode(handle) {
    for (let attempt = 0; attempt < 10; attempt++) {
        const code = generateCode();
        if (await storage.getItem(CODE_PREFIX + code)) continue;
        await storage.setItem(CODE_PREFIX + code, { code, owner: handle, createdAt: Date.now() });
        await storage.setItem(OWNER_PREFIX + handle, { code });
        return code;
    }
    throw new Error('生成邀请码失败');
}

/**
 * 换一个邀请码（旧的作废；已经绑定的不受影响）。
 * @param {string} handle
 */
export function resetCode(handle) {
    return serialized(async () => {
        const owned = await storage.getItem(OWNER_PREFIX + handle);
        if (owned?.blocked) throw new Error('邀请已被停用');
        if (owned?.code) await storage.removeItem(CODE_PREFIX + owned.code);
        await storage.removeItem(OWNER_PREFIX + handle);
        return createCode(handle);
    });
}

// ---------------------------------------------------------------------------
// 资格
// ---------------------------------------------------------------------------

/**
 * 邀请人够不够格（门槛和用户邀请码共用；不把门槛告诉用户）。
 * @param {any} user
 * @returns {Promise<boolean>}
 */
async function inviterEligible(user) {
    if (!user || user.enabled === false) return false;
    if (await isBlocked(user.handle)) return false;
    const thresholds = await getUserInvitationConfig();
    const registeredDays = (Date.now() - (Number(user.created) || Date.now())) / DAY_MS;
    if (registeredDays < thresholds.minRegisteredDays) return false;
    if (thresholds.minOnlineHours > 0 && await getInvitationOnlineHours(user.handle) < thresholds.minOnlineHours) return false;
    return true;
}

/** 管理员停用了这个人的邀请 */
async function isBlocked(handle) {
    return Boolean((await storage.getItem(OWNER_PREFIX + handle))?.blocked);
}

/** 注册多久以后就不能再绑定邀请人 */
function claimDeadline(user, config) {
    return (Number(user?.created) || 0) + config.claimWindowDays * DAY_MS;
}

// ---------------------------------------------------------------------------
// 绑定、成功、奖励
// ---------------------------------------------------------------------------

/** 给别人看的名字：显示名（没有就用账号名），太长的截短 */
async function nameOf(handle) {
    const user = await storage.getItem(toKey(handle));
    const name = String(user?.name || handle);
    return name.length > 24 ? `${name.slice(0, 22)}…` : name;
}

/** 给用户加空间（MiB，可以是负数：收回） */
async function addStorage(handle, mib) {
    if (!mib) return 0;
    const user = await storage.getItem(toKey(handle));
    if (!user) return 0;
    const current = getUserLimitMiB(user, getStorageConfig()) ?? 0;
    const next = Math.max(0, current + mib);
    user.storageLimitMiB = next;
    await storage.setItem(toKey(handle), user);
    return next - current;
}

/** 邀请人已经通过邀请拿到多少 */
async function earnedByInviter(inviter) {
    let total = 0;
    for (const invitee of await readList(INVITER_PREFIX + inviter)) {
        const link = await storage.getItem(LINK_PREFIX + invitee);
        if (link && link.status !== STATUS.REVOKED) total += Number(link.inviterRewardMiB) || 0;
    }
    return total;
}

/** 告诉在线的人（不在线就算了，面板里看得到） */
function notify(handle, title, text) {
    try {
        live.send({ handles: [handle] }, 'notice', { title, text, level: 'success', timeout: 12 });
    } catch {
        // Not running (tests, scripts).
    }
}

/**
 * 这一条邀请成功了：发奖励（必须在队列里调用）。
 * @param {any} link
 * @param {typeof DEFAULT_REFERRAL_CONFIG} config
 */
async function settle(link, config) {
    const rewards = rewardsAvailable();
    // 邀请被停用的人不再得到空间（被邀请人照常）
    const inviterBlocked = await isBlocked(link.inviter);
    let inviterReward = rewards && !inviterBlocked ? config.inviterRewardMiB : 0;
    if (inviterReward > 0 && config.inviterCapMiB > 0) {
        inviterReward = Math.max(0, Math.min(inviterReward, config.inviterCapMiB - await earnedByInviter(link.inviter)));
    }
    const inviteeReward = rewards ? config.inviteeRewardMiB : 0;
    link.status = STATUS.SUCCESS;
    link.successAt = Date.now();
    link.inviterRewardMiB = await addStorage(link.inviter, inviterReward);
    link.inviteeRewardMiB = await addStorage(link.invitee, inviteeReward);
    await storage.setItem(LINK_PREFIX + link.invitee, link);
    pendingInvitees.delete(link.invitee);
    console.info(`[referrals] ${link.inviter} → ${link.invitee}: succeeded (+${link.inviterRewardMiB} / +${link.inviteeRewardMiB} MiB)`);
    if (link.inviteeRewardMiB > 0) notify(link.invitee, '邀请奖励到账', `你已获得 ${link.inviteeRewardMiB} MB 存储空间（邀请人：${await nameOf(link.inviter)}）。`);
    const invitee = await nameOf(link.invitee);
    if (link.inviterRewardMiB > 0) notify(link.inviter, '邀请成功', `${invitee} 已开始使用，你获得了 ${link.inviterRewardMiB} MB 存储空间。`);
    else if (rewards && !inviterBlocked) notify(link.inviter, '邀请成功', `${invitee} 已开始使用。你通过邀请获得的空间已到上限，这次没有再加。`);
    else notify(link.inviter, '邀请成功', `${invitee} 已开始使用。`);
}

/** 待成功太久的作废（必须在队列里调用） */
async function expireIfStale(link, config) {
    if (link?.status !== STATUS.PENDING || !(config.pendingExpireDays > 0)) return false;
    if (Date.now() - link.boundAt < config.pendingExpireDays * DAY_MS) return false;
    link.status = STATUS.EXPIRED;
    link.expiredAt = Date.now();
    await storage.setItem(LINK_PREFIX + link.invitee, link);
    pendingInvitees.delete(link.invitee);
    return true;
}

/**
 * 绑定邀请人。
 * @param {string} inviteeHandle
 * @param {unknown} rawCode
 * @param {{ source?: 'link'|'code'|'registration', hadValidReply?: boolean, inviter?: string }} [options]
 *     inviter：注册邀请码那条路，邀请人已知、不用推广码
 * @returns {Promise<{ ok: boolean, reason?: string, link?: any }>}
 */
export function claimReferral(inviteeHandle, rawCode, { source = 'code', hadValidReply = false, inviter: knownInviter } = {}) {
    return serialized(async () => {
        const config = await getReferralConfig();
        if (!config.enabled) return { ok: false, reason: '邀请奖励暂未开放' };
        let inviter = knownInviter;
        let code = '';
        if (!inviter) {
            code = normalizeCode(rawCode);
            const record = code ? await storage.getItem(CODE_PREFIX + code) : null;
            if (!record?.owner) return { ok: false, reason: '邀请码不存在或已更换' };
            inviter = record.owner;
        }
        if (inviter === inviteeHandle) return { ok: false, reason: '不能填写自己的邀请码' };
        const invitee = await storage.getItem(toKey(inviteeHandle));
        if (!invitee) return { ok: false, reason: '用户不存在' };
        if (await storage.getItem(LINK_PREFIX + inviteeHandle)) return { ok: false, reason: '你已经绑定过邀请人了' };
        if (Date.now() > claimDeadline(invitee, config)) return { ok: false, reason: `只有注册 ${config.claimWindowDays} 天内的新账号可以绑定邀请人` };
        const reverse = await storage.getItem(LINK_PREFIX + inviter);
        if (reverse?.inviter === inviteeHandle) return { ok: false, reason: '不能互相邀请' };
        if (!await inviterEligible(await storage.getItem(toKey(inviter)))) return { ok: false, reason: '这个邀请人暂时还不能邀请别人' };

        const link = { invitee: inviteeHandle, inviter, code, source, boundAt: Date.now(), status: STATUS.PENDING, successAt: null, inviterRewardMiB: 0, inviteeRewardMiB: 0 };
        await storage.setItem(LINK_PREFIX + inviteeHandle, link);
        await addToList(INVITER_PREFIX + inviter, inviteeHandle);
        await addToList(INDEX_KEY, inviteeHandle);
        pendingInvitees.add(inviteeHandle);
        console.info(`[referrals] ${inviter} → ${inviteeHandle}: bound (${source})`);
        // 不要求有效回复，或者绑定前已经聊过：直接成功
        if (!config.requireValidReply || hadValidReply) await settle(link, config);
        else notify(inviter, '新的邀请', `${await nameOf(inviteeHandle)} 绑定了你的邀请，对方收到第一条 AI 回复后就算邀请成功。`);
        return { ok: true, link };
    });
}

/**
 * 用户发放的注册邀请码在注册时被用掉：记一次邀请（失败不影响注册）。
 * @param {any} invitation 注册邀请码记录
 * @param {string} inviteeHandle
 */
export async function bindFromInvitation(invitation, inviteeHandle) {
    try {
        if (invitation?.issuanceSource !== 'user' || !invitation.createdBy) return;
        const result = await claimReferral(inviteeHandle, '', { source: 'registration', inviter: invitation.createdBy });
        if (!result.ok) console.info(`[referrals] Registration code of ${invitation.createdBy} not counted for ${inviteeHandle}: ${result.reason}`);
    } catch (error) {
        console.warn('[referrals] Could not record a registration invitation:', error?.message ?? error);
    }
}

/**
 * 服务器转发的生成拿到了有效回复（usage-meter.js 调用）：这个人有待成功的邀请就算成功。
 * @param {string} handle
 */
export function noteValidReply(handle) {
    if (!pendingLoaded) {
        void loadPending().then(() => noteValidReply(handle)).catch(() => undefined);
        return;
    }
    if (!pendingInvitees.has(handle)) return;
    void serialized(async () => {
        const link = await storage.getItem(LINK_PREFIX + handle);
        const config = await getReferralConfig();
        if (link?.status !== STATUS.PENDING || await expireIfStale(link, config)) {
            pendingInvitees.delete(handle);
            return;
        }
        await settle(link, config);
    }).catch(error => console.warn('[referrals] Could not settle a referral:', error?.message ?? error));
}

// ---------------------------------------------------------------------------
// 用户面板
// ---------------------------------------------------------------------------


/**
 * 用户面板的数据（不透露邀请资格的门槛）。
 * @param {string} handle
 */
export async function getMyReferralData(handle) {
    const config = await getReferralConfig();
    const user = await storage.getItem(toKey(handle));
    const blocked = await isBlocked(handle);
    const eligible = config.enabled && await inviterEligible(user);
    const owned = eligible ? await storage.getItem(OWNER_PREFIX + handle) : null;
    const invitees = [];
    let earned = 0;
    for (const invitee of await readList(INVITER_PREFIX + handle)) {
        const link = await storage.getItem(LINK_PREFIX + invitee);
        if (!link) continue;
        if (link.status !== STATUS.REVOKED) earned += Number(link.inviterRewardMiB) || 0;
        invitees.push({ name: await nameOf(invitee), status: link.status, boundAt: link.boundAt, successAt: link.successAt, rewardMiB: link.inviterRewardMiB || 0 });
    }
    invitees.sort((a, b) => b.boundAt - a.boundAt);
    const mine = await storage.getItem(LINK_PREFIX + handle);
    const deadline = claimDeadline(user, config);
    return {
        enabled: config.enabled,
        rewardsAvailable: rewardsAvailable(),
        rules: {
            inviterRewardMiB: config.inviterRewardMiB,
            inviteeRewardMiB: config.inviteeRewardMiB,
            inviterCapMiB: config.inviterCapMiB,
            claimWindowDays: config.claimWindowDays,
            requireValidReply: config.requireValidReply,
            pendingExpireDays: config.pendingExpireDays,
        },
        eligible,
        blocked,
        code: owned?.code ?? null,
        earnedMiB: earned,
        invitees,
        invitedBy: mine ? { name: await nameOf(mine.inviter), status: mine.status, rewardMiB: mine.inviteeRewardMiB || 0, boundAt: mine.boundAt } : null,
        canClaim: config.enabled && !mine && Date.now() <= deadline,
        claimDeadline: deadline,
    };
}

// ---------------------------------------------------------------------------
// 管理员
// ---------------------------------------------------------------------------

/** 管理员看的被邀请人情况：注册时间、累计在线（判断是不是小号） */
async function describeInvitee(handle) {
    const user = await storage.getItem(toKey(handle));
    const hours = await getInvitationOnlineHours(handle).catch(() => 0);
    return { inviteeCreated: Number(user?.created) || null, inviteeOnlineHours: Math.round(hours * 10) / 10, inviteeExists: Boolean(user) };
}

/**
 * 所有邀请关系（顺带把过期的标成作废）。
 * @param {{ query?: string, status?: string, inviter?: string, offset?: number, limit?: number }} [options]
 *     inviter：只看这个人邀请的（精确匹配）
 */
export function listReferrals({ query = '', status = '', inviter: onlyInviter = '', offset = 0, limit = 50 } = {}) {
    return serialized(async () => {
        const config = await getReferralConfig();
        const needle = String(query).trim().toLowerCase();
        const rows = [];
        const summary = { total: 0, pending: 0, success: 0, revoked: 0, expired: 0, inviterMiB: 0, inviteeMiB: 0 };
        /** @type {Map<string, { inviter: string, success: number, pending: number, earnedMiB: number }>} */
        const inviters = new Map();
        for (const invitee of await readList(INDEX_KEY)) {
            const link = await storage.getItem(LINK_PREFIX + invitee);
            if (!link) continue;
            await expireIfStale(link, config);
            summary.total++;
            summary[link.status] = (summary[link.status] ?? 0) + 1;
            if (link.status !== STATUS.REVOKED) {
                summary.inviterMiB += Number(link.inviterRewardMiB) || 0;
                summary.inviteeMiB += Number(link.inviteeRewardMiB) || 0;
            }
            const row = inviters.get(link.inviter) ?? { inviter: link.inviter, success: 0, pending: 0, earnedMiB: 0 };
            if (link.status === STATUS.SUCCESS) row.success++;
            if (link.status === STATUS.PENDING) row.pending++;
            if (link.status !== STATUS.REVOKED) row.earnedMiB += Number(link.inviterRewardMiB) || 0;
            inviters.set(link.inviter, row);
            if (status && link.status !== status) continue;
            if (onlyInviter && link.inviter !== onlyInviter) continue;
            if (needle && !`${link.inviter} ${link.invitee} ${link.code}`.toLowerCase().includes(needle)) continue;
            rows.push(link);
        }
        rows.sort((a, b) => b.boundAt - a.boundAt);
        const top = [...inviters.values()].sort((a, b) => (b.success - a.success) || (b.earnedMiB - a.earnedMiB)).slice(0, 20);
        for (const row of top) Object.assign(row, { inviterName: await nameOf(row.inviter), blocked: await isBlocked(row.inviter) });
        const page = [];
        for (const link of rows.slice(offset, offset + limit)) {
            page.push({ ...link, inviterName: await nameOf(link.inviter), inviteeName: await nameOf(link.invitee), inviterBlocked: await isBlocked(link.inviter), ...await describeInvitee(link.invitee) });
        }
        // 只看一个人时：这个人的情况（停用没有、一共邀请了多少、拿了多少）
        let focus = null;
        if (onlyInviter) {
            const mine = (await readList(INVITER_PREFIX + onlyInviter)).length;
            focus = { inviter: onlyInviter, inviterName: await nameOf(onlyInviter), blocked: await isBlocked(onlyInviter), total: mine, earnedMiB: inviters.get(onlyInviter)?.earnedMiB ?? 0 };
        }
        return { summary, top, total: rows.length, rows: page, focus };
    });
}

/**
 * 管理员撤销一条邀请；reclaim 时把已经发的空间收回。
 * @param {string} invitee
 * @param {{ reclaim?: boolean, by?: string }} [options]
 */
export function revokeReferral(invitee, { reclaim = false, by = '' } = {}) {
    return serialized(async () => {
        const link = await storage.getItem(LINK_PREFIX + invitee);
        if (!link) return { ok: false, reason: '没有这条邀请关系' };
        if (link.status === STATUS.REVOKED) return { ok: false, reason: '已经撤销过了' };
        await revokeLink(link, { reclaim, by });
        return { ok: true, link };
    });
}

/** 撤销一条（必须在队列里调用） */
async function revokeLink(link, { reclaim, by }) {
    if (reclaim && link.status === STATUS.SUCCESS) {
        await addStorage(link.inviter, -(Number(link.inviterRewardMiB) || 0));
        await addStorage(link.invitee, -(Number(link.inviteeRewardMiB) || 0));
        link.reclaimed = true;
    }
    link.status = STATUS.REVOKED;
    link.revokedAt = Date.now();
    link.revokedBy = by;
    await storage.setItem(LINK_PREFIX + link.invitee, link);
    pendingInvitees.delete(link.invitee);
    console.info(`[referrals] ${link.inviter} → ${link.invitee}: revoked by ${by}${link.reclaimed ? ', rewards taken back' : ''}`);
}

/**
 * 管理员停用 / 恢复一个人的邀请。停用：邀请码作废、不能再邀请，之后成功的邀请也不给邀请人空间；
 * revokeAll 时把这个人已有的邀请都撤销（reclaim：连已发的空间一起收回）。恢复后可以重新生成邀请码。
 * @param {string} handle
 * @param {boolean} blocked
 * @param {{ revokeAll?: boolean, reclaim?: boolean, by?: string }} [options]
 */
export function setInviterBlocked(handle, blocked, { revokeAll = false, reclaim = false, by = '' } = {}) {
    return serialized(async () => {
        if (!handle || !await storage.getItem(toKey(handle))) return { ok: false, reason: '用户不存在' };
        const owned = await storage.getItem(OWNER_PREFIX + handle);
        if (blocked) {
            if (owned?.code) await storage.removeItem(CODE_PREFIX + owned.code);
            await storage.setItem(OWNER_PREFIX + handle, { blocked: { at: Date.now(), by } });
        } else if (owned?.blocked) {
            await storage.removeItem(OWNER_PREFIX + handle);
        }
        let revoked = 0;
        if (blocked && revokeAll) {
            for (const invitee of await readList(INVITER_PREFIX + handle)) {
                const link = await storage.getItem(LINK_PREFIX + invitee);
                if (!link || link.status === STATUS.REVOKED) continue;
                await revokeLink(link, { reclaim, by });
                revoked++;
            }
        }
        console.info(`[referrals] ${handle}: invitations ${blocked ? 'blocked' : 'allowed again'} by ${by}${revoked ? `, ${revoked} revoked${reclaim ? ' with rewards taken back' : ''}` : ''}`);
        return { ok: true, revoked };
    });
}

/**
 * 管理员直接判定成功（不等有效回复），发奖励。
 * @param {string} invitee
 */
export function approveReferral(invitee) {
    return serialized(async () => {
        const link = await storage.getItem(LINK_PREFIX + invitee);
        if (!link) return { ok: false, reason: '没有这条邀请关系' };
        if (link.status !== STATUS.PENDING && link.status !== STATUS.EXPIRED) return { ok: false, reason: '只有等待中或已作废的可以判定成功' };
        await settle(link, await getReferralConfig());
        return { ok: true, link };
    });
}

/** 启动时：载入等待中的名单，之后每小时把过期的作废 */
export function startReferrals() {
    void loadPending().catch(error => console.warn('[referrals] Could not load pending referrals:', error?.message ?? error));
    setInterval(() => void serialized(async () => {
        const config = await getReferralConfig();
        for (const invitee of [...pendingInvitees]) {
            await expireIfStale(await storage.getItem(LINK_PREFIX + invitee), config);
        }
    }).catch(() => undefined), 3600e3).unref?.();
}

/** 测试用 */
export function resetReferralMemory() {
    pendingInvitees.clear();
    pendingLoaded = false;
}
