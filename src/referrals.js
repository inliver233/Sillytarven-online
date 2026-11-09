/**
 * 邀请奖励（推广，像 aff 那样）：每个用户一个可以反复使用的邀请码 / 邀请链接（/invite/<码>）。
 * 新账号（注册不满 claimWindowDays 天）绑定邀请人后，双方各加指定的存储空间；邀请人通过邀请拿到的
 * 空间有上限。可选：被邀请人收到第一条有效的 AI 回复（服务器转发生成时判断，usage-meter.js 调
 * noteValidReply）才算成功、才发奖励；等太久没成功的作废。
 *
 * 谁能邀请沿用用户邀请码的门槛（注册天数、在线时长，管理员在同一处设置）。用户发放的注册邀请码
 * 在注册时被用掉，也记一次邀请（bindFromInvitation）。
 *
 * 跨站邀请（crossSite，两个站都打开才生效；站间通信见 referral-peer.js）：本站找不到的邀请码去对方站查。
 * 被邀请人在哪个站注册，邀请关系就记在哪个站（inviterSite 记邀请人是哪个站的），由那个站判断成功、发
 * 被邀请人的奖励、给管理员撤销；邀请人的站记一份镜像（@<站>:<账号>），用来显示和算上限，邀请人的奖励由
 * 邀请人的站发。变化经 referral:peer-outbox 告诉对方站，对方站连不上就过几分钟再发。本站暂停注册时，
 * 用户的邀请链接指向对方站。
 *
 * 存储（node-persist）：
 *   referral:config                 设置
 *   referral:code:<码>              { code, owner, createdAt }
 *   referral:owner:<账号>           { code }
 *   referral:access                 管理员单独设置的邀请资格 { <账号>: { mode: 'allow'|'block', at, by } }
 *   referral:link:<被邀请人>        { invitee, inviter, inviterSite?, inviterName?, code, source, boundAt, status, successAt,
 *                                     inviterRewardMiB, inviteeRewardMiB, revokedAt, revokedBy, reclaimed, expiredAt }
 *   referral:link:@<站>:<账号>      对方站的被邀请人（镜像）{ ..., mirror: true, inviteeSite, remoteInvitee, inviteeName }
 *   referral:inviter:<邀请人>       [被邀请人]（含镜像）
 *   referral:index                  [所有被邀请人]（含镜像，管理员列表）
 *   referral:peer-outbox            ['sync:<被邀请人>' | 'revoked:@<站>:<账号>']
 *
 * 溯源（referral-trace.js）：每条邀请的 events 记下关键时刻（打开链接、绑定、第一条有效回复、成功、判定、撤销、
 * 作废）的 IP、设备号、浏览器；参与邀请的人记下最近用过的 IP 和设备。管理员查看时按这些算可疑标记（只标记，
 * 奖励照发）：同设备、同 IP、同网段、同一个邀请人的被邀请人共用设备或 IP、Discord 号很新、短时间大量绑定、
 * 成功后几乎不上线。跨站时只交换加了两站共用 secret 的摘要。
 */
import crypto from 'node:crypto';

import storage from 'node-persist';

import { discordIdOf } from './leaderboard.js';
import { live } from './live.js';
import { callPeer, getPeerInfo, identityKey, peerConfig, sharedDigest, siteLabel } from './referral-peer.js';
import { discordCreatedAt, findVisit, readSeen, recordSeen, recordVisit, scrubRaw, sweepTraces, traceEvent } from './referral-trace.js';
import { getRegistrationMethodConfig } from './registration-policy.js';
import { getStcontrolControllerUrl, isStcontrolEnabled } from './stcontrol.js';
import { getStorageConfig, getUserLimitMiB } from './storage-quota.js';
import { getInvitationOnlineHours, getUserInvitationConfig, roundOnlineHours } from './user-invitations.js';
import { toKey } from './users.js';

const CONFIG_KEY = 'referral:config';
const CODE_PREFIX = 'referral:code:';
const OWNER_PREFIX = 'referral:owner:';
const LINK_PREFIX = 'referral:link:';
const INVITER_PREFIX = 'referral:inviter:';
const INDEX_KEY = 'referral:index';
const OUTBOX_KEY = 'referral:peer-outbox';
const ACCESS_KEY = 'referral:access';
/** 不易看错的字符 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const DAY_MS = 86_400_000;
/** 对方站连不上时，过这么久再发 */
const OUTBOX_RETRY_MS = 5 * 60e3;
const REGISTRATION_METHODS = Object.freeze(['password', 'github', 'discord', 'linuxdo']);

export const STATUS = Object.freeze({ PENDING: 'pending', SUCCESS: 'success', REVOKED: 'revoked', EXPIRED: 'expired' });

export const DEFAULT_REFERRAL_CONFIG = Object.freeze({
    enabled: false,
    inviterRewardMiB: 150,
    inviteeRewardMiB: 150,
    /** 邀请人通过邀请最多拿多少（0 = 不限） */
    inviterCapMiB: 3000,
    /** 被邀请人注册多少天内可以绑定 */
    claimWindowDays: 7,
    /** 收到第一条有效 AI 回复才算成功 */
    requireValidReply: true,
    /** 待成功的邀请多少天后作废（0 = 不作废） */
    pendingExpireDays: 30,
    /** 跨站邀请：和另一个站互认邀请码（两站都打开才生效） */
    crossSite: false,
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
    for (const key of ['enabled', 'requireValidReply', 'crossSite']) {
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

/**
 * 本站的邀请链接开头：由总控托管的节点，新人在总控注册，链接是 <总控>/?ref=<码>（总控把码带到开户，
 * 见 bindFromLink）；没有总控的站是 <本站>/invite/<码>，这里返回空（页面用自己的地址）。
 */
export function inviteBase() {
    const controller = isStcontrolEnabled() ? getStcontrolControllerUrl() : '';
    return /^https?:\/\//i.test(controller) ? `${controller}/?ref=` : '';
}

/**
 * /invite/<码> 的页面：在这个浏览器里记下码（新账号登录后问要不要绑定），然后去首页；由总控托管的节点
 * 直接去总控的注册页（总控把码带到开户）。
 * @param {unknown} rawCode
 * @returns {string} HTML
 */
export function renderInvitePage(rawCode) {
    const code = normalizeCode(rawCode);
    const remember = code ? `try{localStorage.setItem('st_pending_referral',JSON.stringify({code:'${code}',at:Date.now()}))}catch(e){}` : '';
    const next = code && inviteBase() ? `${inviteBase()}${code}` : '/';
    const script = JSON.stringify(next).replace(/</g, '\\u003c');
    const attribute = next.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>邀请</title><script>${remember};location.replace(${script})</script><noscript><meta http-equiv="refresh" content="0;url=${attribute}"></noscript>`;
}

/** 本站开着注册没有（任何一种方式） */
export function registrationOpen() {
    return REGISTRATION_METHODS.some(method => {
        try {
            return Boolean(getRegistrationMethodConfig(method).enabled);
        } catch {
            return false;
        }
    });
}

// ---------------------------------------------------------------------------
// 一次只处理一件事：绑定、发奖励、撤销都在这里排队，上限和「只奖励一次」不会被并发绕过
// （等对方站的网络请求不在队列里）
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
        if (link?.status === STATUS.PENDING && !link.mirror) pendingInvitees.add(invitee);
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

async function removeFromList(key, item) {
    const list = await readList(key);
    if (list.includes(item)) await storage.setItem(key, list.filter(value => value !== item));
}

const MAX_EVENTS = 30;
/** 给一条邀请记一个时刻 */
function addEvent(link, event) {
    link.events = [...(Array.isArray(link.events) ? link.events : []), event].slice(-MAX_EVENTS);
}

/** 对方站的被邀请人在本站的记法 */
const mirrorKey = (site, handle) => `@${site}:${handle}`;
/** 排行、只看一个人时用的邀请人记法（对方站的人带站名） */
const inviterKeyOf = link => (link.inviterSite ? `${link.inviterSite}:${link.inviter}` : link.inviter);

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
        if (await isBlocked(handle)) throw new Error('邀请已被停用');
        const owned = await storage.getItem(OWNER_PREFIX + handle);
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
        if (await isBlocked(handle)) throw new Error('邀请已被停用');
        const owned = await storage.getItem(OWNER_PREFIX + handle);
        if (owned?.code) await storage.removeItem(CODE_PREFIX + owned.code);
        await storage.removeItem(OWNER_PREFIX + handle);
        return createCode(handle);
    });
}

// ---------------------------------------------------------------------------
// 资格
// ---------------------------------------------------------------------------

/**
 * 邀请人够不够格：管理员单独允许的够格、单独停用的不够格，其余按门槛（和用户邀请码共用；不把门槛告诉用户）。
 * @param {any} user
 * @returns {Promise<boolean>}
 */
async function inviterEligible(user) {
    if (!user || user.enabled === false) return false;
    const mode = await accessOf(user.handle);
    if (mode) return mode === 'allow';
    return (await measureInviter(user)).meetsThresholds;
}

/** 按门槛看这个人：注册几天、累计在线几小时（四舍五入后和门槛比，1.45 小时算 2 小时）、够不够 */
async function measureInviter(user) {
    const thresholds = await getUserInvitationConfig();
    const registeredDays = (Date.now() - (Number(user.created) || Date.now())) / DAY_MS;
    const online = roundOnlineHours(await getInvitationOnlineHours(user.handle).catch(() => 0) * 3_600_000);
    const meetsThresholds = registeredDays >= thresholds.minRegisteredDays && !(thresholds.minOnlineHours > 0 && online.hours < thresholds.minOnlineHours);
    return { registeredDays, onlineHours: online.tenths, roundedHours: online.hours, meetsThresholds };
}

/** 管理员单独设置的邀请资格 */
async function readAccess() {
    const value = await storage.getItem(ACCESS_KEY);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** @returns {Promise<'allow'|'block'|null>} */
async function accessOf(handle) {
    const mode = (await readAccess())[handle]?.mode;
    return mode === 'allow' || mode === 'block' ? mode : null;
}

/** 管理员停用了这个人的邀请 */
async function isBlocked(handle) {
    return await accessOf(handle) === 'block';
}

/** 注册多久以后就不能再绑定邀请人 */
function claimDeadline(user, config) {
    return (Number(user?.created) || 0) + config.claimWindowDays * DAY_MS;
}

// ---------------------------------------------------------------------------
// 绑定、成功、奖励
// ---------------------------------------------------------------------------

const shorten = name => (name.length > 24 ? `${name.slice(0, 22)}…` : name);

/** 给别人看的名字：显示名（没有就用账号名），太长的截短 */
async function nameOf(handle) {
    const user = await storage.getItem(toKey(handle));
    return shorten(String(user?.name || handle));
}

/** 被邀请人的名字（对方站的带站名） */
async function inviteeNameOf(link) {
    return link.mirror ? `${shorten(String(link.inviteeName || link.remoteInvitee))}（${siteLabel(link.inviteeSite)}）` : nameOf(link.invitee);
}

/** 邀请人的名字（对方站的带站名） */
async function inviterNameOf(link) {
    return link.inviterSite ? `${shorten(String(link.inviterName || link.inviter))}（${siteLabel(link.inviterSite)}）` : nameOf(link.inviter);
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

/** 邀请人已经通过邀请拿到多少（含对方站的被邀请人） */
async function earnedByInviter(inviter) {
    let total = 0;
    for (const invitee of await readList(INVITER_PREFIX + inviter)) {
        const link = await storage.getItem(LINK_PREFIX + invitee);
        if (link && link.status !== STATUS.REVOKED) total += Number(link.inviterRewardMiB) || 0;
    }
    return total;
}

/** 这次给邀请人多少：按本站设置，停用的不给，到上限为止 */
async function inviterRewardFor(inviter, config) {
    if (!rewardsAvailable() || await isBlocked(inviter)) return 0;
    let reward = config.inviterRewardMiB;
    if (reward > 0 && config.inviterCapMiB > 0) reward = Math.max(0, Math.min(reward, config.inviterCapMiB - await earnedByInviter(inviter)));
    return reward;
}

/** 告诉在线的人（不在线就算了，面板里看得到） */
function notify(handle, title, text) {
    try {
        live.send({ handles: [handle] }, 'notice', { title, text, level: 'success', timeout: 12 });
    } catch {
        // Not running (tests, scripts).
    }
}

/** 邀请成功后告诉本站的邀请人 */
async function notifyInviterSuccess(inviter, inviteeName, granted) {
    if (granted > 0) notify(inviter, '邀请成功', `${inviteeName} 已开始使用，你获得了 ${granted} MB 存储空间。`);
    else if (rewardsAvailable() && !await isBlocked(inviter)) notify(inviter, '邀请成功', `${inviteeName} 已开始使用。你通过邀请获得的空间已到上限，这次没有再加。`);
    else notify(inviter, '邀请成功', `${inviteeName} 已开始使用。`);
}

/**
 * 这一条邀请成功了：发奖励（必须在队列里调用）。邀请人是对方站的：被邀请人这边发，邀请人那边由对方站发。
 * @param {any} link
 * @param {typeof DEFAULT_REFERRAL_CONFIG} config
 */
async function settle(link, config, { by = '' } = {}) {
    link.status = STATUS.SUCCESS;
    link.successAt = Date.now();
    addEvent(link, by ? { type: 'approved', at: link.successAt, by } : { type: 'success', at: link.successAt });
    link.inviteeRewardMiB = await addStorage(link.invitee, rewardsAvailable() ? config.inviteeRewardMiB : 0);
    if (!link.inviterSite) link.inviterRewardMiB = await addStorage(link.inviter, await inviterRewardFor(link.inviter, config));
    await storage.setItem(LINK_PREFIX + link.invitee, link);
    pendingInvitees.delete(link.invitee);
    console.info(`[referrals] ${inviterKeyOf(link)} → ${link.invitee}: succeeded (+${link.inviterSite ? '?' : link.inviterRewardMiB} / +${link.inviteeRewardMiB} MiB)`);
    if (link.inviteeRewardMiB > 0) notify(link.invitee, '邀请奖励到账', `你已获得 ${link.inviteeRewardMiB} MB 存储空间（邀请人：${await inviterNameOf(link)}）。`);
    if (link.inviterSite) await tellPeer(`sync:${link.invitee}`);
    else await notifyInviterSuccess(link.inviter, await nameOf(link.invitee), link.inviterRewardMiB);
    await warnAdmins(link);
}

/** 成功的邀请有强可疑标记（同设备）：告诉在线的管理员（只提醒，奖励照发） */
async function warnAdmins(link) {
    try {
        const strong = (await assessLink(link)).filter(flag => flag.level === 'high');
        if (!strong.length) return;
        live.send({ admins: true }, 'notice', {
            title: '可疑邀请', level: 'warning', timeout: 30,
            text: `${await inviterNameOf(link)} 邀请的 ${await inviteeNameOf(link)} 已成功：${strong.map(flag => flag.text).join('；')}。可在管理面板「邀请奖励」里查看、撤销。`,
        });
    } catch {
        // Not running (tests, scripts).
    }
}

/** 待成功太久的作废（必须在队列里调用）；对方站的被邀请人由对方站判断 */
async function expireIfStale(link, config) {
    if (link?.status !== STATUS.PENDING || link.mirror || !(config.pendingExpireDays > 0)) return false;
    if (Date.now() - link.boundAt < config.pendingExpireDays * DAY_MS) return false;
    link.status = STATUS.EXPIRED;
    link.expiredAt = Date.now();
    addEvent(link, { type: 'expired', at: link.expiredAt });
    await storage.setItem(LINK_PREFIX + link.invitee, link);
    pendingInvitees.delete(link.invitee);
    if (link.inviterSite) await tellPeer(`sync:${link.invitee}`);
    return true;
}

/**
 * 绑定邀请人。本站没有这个邀请码、开着跨站邀请时，去对方站查。
 * @param {string} inviteeHandle
 * @param {unknown} rawCode
 * @param {{ source?: 'link'|'code'|'registration', hadValidReply?: boolean, inviter?: string }} [options]
 *     inviter：注册邀请码那条路，邀请人已知、不用推广码
 * @returns {Promise<{ ok: boolean, reason?: string, link?: any }>}
 */
export async function claimReferral(inviteeHandle, rawCode, options = {}) {
    const here = await serialized(() => claimHere(inviteeHandle, rawCode, options));
    if (!here.askPeer) return here;
    let answer;
    try {
        answer = await callPeer('/lookup', { code: here.code, inviteeSite: peerConfig().site, invitee: inviteeHandle, identity: here.identity });
    } catch (error) {
        console.warn(`[referrals] Could not ask the other site about a code: ${error?.message ?? error}`);
        return { ok: false, reason: '暂时查不到这个邀请码，请稍后再试' };
    }
    if (!answer?.ok || !answer.inviter || !answer.site) return { ok: false, reason: answer?.reason || '邀请码不存在或已更换' };
    const remote = { site: String(answer.site), inviter: String(answer.inviter), inviterName: String(answer.inviterName || answer.inviter) };
    return serialized(() => claimHere(inviteeHandle, rawCode, { ...options, remote }));
}

/**
 * 绑定（在队列里）。返回 askPeer 表示本站没有这个码、该去对方站查。
 * @param {string} inviteeHandle
 * @param {unknown} rawCode
 * @param {{ source?: string, hadValidReply?: boolean, inviter?: string, remote?: { site: string, inviter: string, inviterName: string }, context?: any, via?: string }} options
 *     context：绑定请求的来路（traceContext）；via：经谁绑定（'controller' = 在总控注册时）
 * @returns {Promise<any>}
 */
async function claimHere(inviteeHandle, rawCode, { source = 'code', hadValidReply = false, inviter: knownInviter, remote, context = null, via = '' } = {}) {
    const config = await getReferralConfig();
    if (!config.enabled) return { ok: false, reason: '邀请奖励暂未开放' };
    const invitee = await storage.getItem(toKey(inviteeHandle));
    if (!invitee) return { ok: false, reason: '用户不存在' };
    const code = knownInviter ? '' : normalizeCode(rawCode);
    const inviter = remote?.inviter ?? knownInviter ?? (code ? (await storage.getItem(CODE_PREFIX + code))?.owner : undefined);
    if (!remote && inviter === inviteeHandle) return { ok: false, reason: '不能填写自己的邀请码' };
    if (await storage.getItem(LINK_PREFIX + inviteeHandle)) return { ok: false, reason: '你已经绑定过邀请人了' };
    if (Date.now() > claimDeadline(invitee, config)) return { ok: false, reason: `只有注册 ${config.claimWindowDays} 天内的新账号可以绑定邀请人` };
    if (!inviter) {
        // 本站没有这个码：开着跨站邀请就去对方站查（不在队列里等）
        if (code && config.crossSite && peerConfig().ready) return { askPeer: true, code, identity: identityKey(discordIdOf(invitee)) };
        return { ok: false, reason: '邀请码不存在或已更换' };
    }
    if (!remote) {
        const reverse = await storage.getItem(LINK_PREFIX + inviter);
        if (reverse?.inviter === inviteeHandle && !reverse.inviterSite) return { ok: false, reason: '不能互相邀请' };
        if (!await inviterEligible(await storage.getItem(toKey(inviter)))) return { ok: false, reason: '这个邀请人暂时还不能邀请别人' };
    }

    const link = {
        invitee: inviteeHandle, inviter, code, source, boundAt: Date.now(), status: STATUS.PENDING, successAt: null, inviterRewardMiB: 0, inviteeRewardMiB: 0,
        ...(remote ? { inviterSite: remote.site, inviterName: remote.inviterName } : {}),
    };
    // 溯源：这台设备之前打开过这个码的邀请链接；绑定时的来路
    const visit = context?.device && code ? await findVisit(context.device, code) : null;
    if (visit) addEvent(link, { type: 'visit', at: visit.at, ip: visit.ip, net: visit.net, ipHash: visit.ipHash, netHash: visit.netHash, device: context.device, ua: visit.ua });
    addEvent(link, traceEvent('bound', context, { source, ...(via ? { via } : {}) }));
    if (context) await recordSeen(inviteeHandle, context);
    await storage.setItem(LINK_PREFIX + inviteeHandle, link);
    if (!remote) await addToList(INVITER_PREFIX + inviter, inviteeHandle);
    await addToList(INDEX_KEY, inviteeHandle);
    pendingInvitees.add(inviteeHandle);
    console.info(`[referrals] ${inviterKeyOf(link)} → ${inviteeHandle}: bound (${source})`);
    // 不要求有效回复，或者绑定前已经聊过：直接成功
    if (!config.requireValidReply || hadValidReply) await settle(link, config);
    else if (remote) await tellPeer(`sync:${inviteeHandle}`);
    else notify(inviter, '新的邀请', `${await nameOf(inviteeHandle)} 绑定了你的邀请，对方收到第一条 AI 回复后就算邀请成功。`);
    return { ok: true, link };
}

/**
 * 在总控上通过邀请链接（?ref=）注册：总控把码放在开户请求的 invitation_code 里，开户后直接绑定
 * （失败不影响注册；码是另一个站的也行）。
 * @param {string} inviteeHandle
 * @param {unknown} rawCode
 */
export async function bindFromLink(inviteeHandle, rawCode) {
    try {
        if (!normalizeCode(rawCode)) return;
        const result = await claimReferral(inviteeHandle, rawCode, { source: 'link', via: 'controller' });
        console.info(`[referrals] ${inviteeHandle} signed up through an invitation link: ${result.ok ? 'bound' : `not bound (${result.reason})`}`);
    } catch (error) {
        console.warn('[referrals] Could not bind an invitation link at sign-up:', error?.message ?? error);
    }
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
 * 邀请奖励关着时不结算（等待中的留着，打开后下一次有效回复再算）。
 * @param {string} handle
 * @param {any} [context] 生成请求的来路（traceContext）
 */
export function noteValidReply(handle, context = null) {
    if (!pendingLoaded) {
        void loadPending().then(() => noteValidReply(handle, context)).catch(() => undefined);
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
        // 溯源：第一条有效回复的来路
        if (context && !link.events?.some(event => event.type === 'reply')) {
            addEvent(link, traceEvent('reply', context));
            await recordSeen(handle, context);
            await storage.setItem(LINK_PREFIX + handle, link);
        }
        if (!config.enabled) return;
        await settle(link, config);
    }).catch(error => console.warn('[referrals] Could not settle a referral:', error?.message ?? error));
}

// ---------------------------------------------------------------------------
// 跨站：告诉对方站（发不出去就留在 outbox 里过几分钟再发），回答对方站
// ---------------------------------------------------------------------------

let flushing = false;
/** @type {ReturnType<typeof setTimeout>|null} */
let retryTimer = null;

/** 记下要告诉对方站的变化，马上试着发（必须在队列里调用） */
async function tellPeer(entry) {
    await addToList(OUTBOX_KEY, entry);
    setTimeout(() => void flushPeerOutbox().catch(() => undefined), 0);
}

/** 给对方站的这一条的情况 */
async function peerPayload(kind, link) {
    if (kind === 'revoked') {
        return { inviterSite: peerConfig().site, inviter: link.inviter, invitee: link.remoteInvitee, reclaim: Boolean(link.reclaimed) };
    }
    // 溯源：两站共用 secret 的摘要（邀请人那边拿去和邀请人比），本站自己算出的标记，记下的时刻（给那边的管理员看，
    // 只带打码的网段，原始 IP 和浏览器信息留在本站）
    const evidence = sharedEvidenceFrom([...(link.events ?? []), ...await readSeen(link.invitee)]);
    const localFlags = (await assessLink(link)).filter(flag => !INVITER_MATCHES.includes(flag.code));
    return {
        inviteeSite: peerConfig().site, invitee: link.invitee, inviteeName: await nameOf(link.invitee), inviter: link.inviter,
        code: link.code, source: link.source, status: link.status, boundAt: link.boundAt, successAt: link.successAt,
        revokedAt: link.revokedAt ?? null, reclaim: Boolean(link.reclaimed), inviteeRewardMiB: link.inviteeRewardMiB || 0,
        evidence: { devices: [...evidence.devices], ips: [...evidence.ips], nets: [...evidence.nets] }, flags: localFlags,
        events: (link.events ?? []).map(({ ip, ua, ipHash, netHash, ...event }) => event),
    };
}

/** 把 outbox 里的发给对方站；对方站没回就停下，过几分钟再试 */
export async function flushPeerOutbox() {
    if (flushing) return;
    flushing = true;
    let failed = false;
    try {
        for (const entry of await readList(OUTBOX_KEY)) {
            const kind = entry.startsWith('revoked:') ? 'revoked' : 'sync';
            const key = entry.slice(kind.length + 1);
            const link = await storage.getItem(LINK_PREFIX + key);
            if (!link) {
                await serialized(() => removeFromList(OUTBOX_KEY, entry));
                continue;
            }
            let answer;
            try {
                answer = await callPeer(kind === 'sync' ? '/sync' : '/revoked', await peerPayload(kind, link));
            } catch (error) {
                failed = true;
                console.warn(`[referrals] The other site did not take ${entry} (will try again): ${error?.message ?? error}`);
                break;
            }
            if (!answer?.ok) console.warn(`[referrals] The other site refused ${entry}: ${answer?.reason ?? 'no reason'}`);
            await serialized(async () => {
                const fresh = await storage.getItem(LINK_PREFIX + key);
                if (fresh && kind === 'sync' && answer?.ok && Number.isFinite(Number(answer.inviterRewardMiB))) {
                    fresh.inviterRewardMiB = Number(answer.inviterRewardMiB);
                    // 邀请人那边比出来的（同设备 / 同 IP / 同网段）
                    if (Array.isArray(answer.flags)) fresh.remoteFlags = sanitizeFlags(answer.flags);
                    await storage.setItem(LINK_PREFIX + key, fresh);
                }
                // 发的时候又变了：留着，下一轮发新的
                const changed = fresh && (fresh.status !== link.status || Boolean(fresh.reclaimed) !== Boolean(link.reclaimed));
                if (!changed) await removeFromList(OUTBOX_KEY, entry);
            });
        }
    } finally {
        flushing = false;
    }
    if ((await readList(OUTBOX_KEY)).length && !retryTimer) {
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void flushPeerOutbox().catch(() => undefined);
        }, failed ? OUTBOX_RETRY_MS : 1000);
        retryTimer.unref?.();
    }
}

/**
 * 对方站来问一个邀请码（本站是邀请人的站）。
 * @param {{ code?: unknown, identity?: unknown }} [request]
 */
export async function answerPeerLookup({ code: rawCode, identity } = {}) {
    const config = await getReferralConfig();
    if (!config.enabled || !config.crossSite) return { ok: false, reason: '这个邀请码所在的站没有开跨站邀请' };
    const code = normalizeCode(rawCode);
    const record = code ? await storage.getItem(CODE_PREFIX + code) : null;
    if (!record?.owner) return { ok: false, reason: '邀请码不存在或已更换' };
    const owner = await storage.getItem(toKey(record.owner));
    if (!await inviterEligible(owner)) return { ok: false, reason: '这个邀请人暂时还不能邀请别人' };
    const own = identityKey(discordIdOf(owner));
    if (identity && own && identity === own) return { ok: false, reason: '不能邀请自己在另一个站的账号' };
    return { ok: true, site: peerConfig().site, inviter: record.owner, inviterName: await nameOf(record.owner) };
}

/**
 * 对方站告诉本站：本站用户邀请的人在那边绑定了 / 成功了 / 作废了 / 被撤销了（本站是邀请人的站）。
 * 记镜像；成功时按本站的设置和上限给邀请人加空间，撤销且收回时收回。同一个状态收到几次都一样。
 * @param {any} payload
 * @returns {Promise<{ ok: boolean, reason?: string, inviterRewardMiB?: number, status?: string }>}
 */
export function applyPeerSync(payload) {
    return serialized(async () => {
        const site = String(payload?.inviteeSite ?? '');
        const invitee = String(payload?.invitee ?? '');
        const inviter = String(payload?.inviter ?? '');
        if (!site || !invitee || !inviter || !await storage.getItem(toKey(inviter))) return { ok: false, reason: '邀请人不存在' };
        const key = mirrorKey(site, invitee);
        let mirror = await storage.getItem(LINK_PREFIX + key);
        const isNew = !mirror;
        if (!mirror) {
            mirror = {
                invitee: key, remoteInvitee: invitee, inviteeSite: site, inviter, mirror: true, code: String(payload.code ?? ''), source: String(payload.source ?? 'code'),
                boundAt: Number(payload.boundAt) || Date.now(), status: STATUS.PENDING, successAt: null, inviterRewardMiB: 0, inviteeRewardMiB: 0,
            };
            await addToList(INVITER_PREFIX + inviter, key);
            await addToList(INDEX_KEY, key);
        }
        if (mirror.inviter !== inviter) return { ok: false, reason: '邀请人对不上' };
        mirror.inviteeName = String(payload.inviteeName || invitee).slice(0, 60);
        mirror.inviteeRewardMiB = Number(payload.inviteeRewardMiB) || 0;
        // 溯源：那边记下的时刻；那边传来的摘要和本站邀请人用过的比
        if (Array.isArray(payload.events)) mirror.events = sanitizeEvents(payload.events);
        const theirs = payload.evidence && typeof payload.evidence === 'object' ? payload.evidence : {};
        const matched = compareWithInviter(
            { devices: new Set(asStrings(theirs.devices)), ips: new Set(asStrings(theirs.ips)), nets: new Set(asStrings(theirs.nets)) },
            sharedEvidenceFrom(await readSeen(inviter)), '（跨站）');
        mirror.flags = [...matched, ...sanitizeFlags(payload.flags)];
        const name = `${shorten(mirror.inviteeName)}（${siteLabel(site)}）`;
        const status = String(payload.status ?? '');
        // 本站已经撤销（邀请人被停用）：保持撤销
        if (mirror.status !== STATUS.REVOKED) {
            if (status === STATUS.SUCCESS && mirror.status !== STATUS.SUCCESS) {
                const config = await getReferralConfig();
                mirror.status = STATUS.SUCCESS;
                mirror.successAt = Number(payload.successAt) || Date.now();
                mirror.inviterRewardMiB = config.enabled ? await addStorage(inviter, await inviterRewardFor(inviter, config)) : 0;
                console.info(`[referrals] ${inviter} → ${key}: succeeded over there (+${mirror.inviterRewardMiB} MiB here)`);
                await notifyInviterSuccess(inviter, name, mirror.inviterRewardMiB);
            } else if (status === STATUS.REVOKED) {
                if (payload.reclaim && mirror.status === STATUS.SUCCESS && !mirror.reclaimed) {
                    await addStorage(inviter, -(Number(mirror.inviterRewardMiB) || 0));
                    mirror.reclaimed = true;
                }
                mirror.status = STATUS.REVOKED;
                mirror.revokedAt = Number(payload.revokedAt) || Date.now();
                mirror.revokedBy = `${siteLabel(site)}管理员`;
            } else if (status === STATUS.EXPIRED && mirror.status === STATUS.PENDING) {
                mirror.status = STATUS.EXPIRED;
                mirror.expiredAt = Date.now();
            } else if (status === STATUS.PENDING && isNew) {
                notify(inviter, '新的邀请', `${name} 绑定了你的邀请，对方收到第一条 AI 回复后就算邀请成功。`);
            }
        }
        await storage.setItem(LINK_PREFIX + key, mirror);
        return { ok: true, inviterRewardMiB: mirror.inviterRewardMiB, status: mirror.status, flags: matched };
    });
}

/**
 * 对方站撤销了它的用户在本站邀请的人（那边停用了邀请人）：本站的这条也撤销（本站是被邀请人的站）。
 * @param {any} payload
 */
export function applyPeerRevoke(payload) {
    return serialized(async () => {
        const invitee = String(payload?.invitee ?? '');
        const link = invitee ? await storage.getItem(LINK_PREFIX + invitee) : null;
        if (!link || link.inviterSite !== String(payload?.inviterSite ?? '') || link.inviter !== String(payload?.inviter ?? '')) return { ok: false, reason: '没有这条邀请关系' };
        if (link.status === STATUS.REVOKED) return { ok: true };
        if (payload.reclaim && link.status === STATUS.SUCCESS) {
            await addStorage(link.invitee, -(Number(link.inviteeRewardMiB) || 0));
            link.reclaimed = true;
        }
        link.status = STATUS.REVOKED;
        link.revokedAt = Date.now();
        link.revokedBy = `${siteLabel(link.inviterSite)}管理员`;
        addEvent(link, { type: 'revoked', at: link.revokedAt, by: link.revokedBy, reclaim: Boolean(link.reclaimed) });
        await storage.setItem(LINK_PREFIX + invitee, link);
        pendingInvitees.delete(invitee);
        console.info(`[referrals] ${inviterKeyOf(link)} → ${invitee}: revoked over there${link.reclaimed ? ', rewards taken back' : ''}`);
        return { ok: true };
    });
}

const asStrings = value => (Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 200) : []);

/** 对方站传来的标记：只留认得的字段 */
function sanitizeFlags(flags) {
    return (Array.isArray(flags) ? flags : []).slice(0, 20)
        .filter(flag => flag && typeof flag.code === 'string' && LEVEL_ORDER[flag.level])
        .map(flag => ({ code: flag.code.slice(0, 40), level: flag.level, text: String(flag.text ?? '').slice(0, 200) }));
}

/** 对方站传来的时刻：只留认得的字段（不收原始 IP 和浏览器信息） */
function sanitizeEvents(events) {
    return events.slice(-MAX_EVENTS).filter(event => event && typeof event.type === 'string').map(event => {
        const kept = { type: event.type.slice(0, 20), at: Number(event.at) || 0 };
        for (const field of ['net', 'device', 'source', 'via', 'by']) {
            if (typeof event[field] === 'string' && event[field]) kept[field] = event[field].slice(0, 300);
        }
        if (event.reclaim) kept.reclaim = true;
        return kept;
    });
}

/** 对方站来问本站的情况 */
export async function answerPeerInfo() {
    const config = await getReferralConfig();
    return {
        ok: true, site: peerConfig().site, enabled: config.enabled, crossSite: config.crossSite, registrationOpen: registrationOpen(),
        inviterRewardMiB: config.inviterRewardMiB, inviteeRewardMiB: rewardsAvailable() ? config.inviteeRewardMiB : 0,
        claimWindowDays: config.claimWindowDays, requireValidReply: config.requireValidReply, inviteBase: inviteBase(),
    };
}

/**
 * 用户的邀请链接指向哪里：本站开着注册就是本站；开着跨站邀请、对方站也开着且开着注册就加上对方站。
 * @param {typeof DEFAULT_REFERRAL_CONFIG} config
 * @returns {Promise<Array<{ site: string, label: string, remote: boolean, base: string, friendRewardMiB: number, claimWindowDays: number, requireValidReply: boolean }>>}
 *     base：链接开头（加上码就是链接；空 = 页面自己的 /invite/）；好友那边的规则按好友注册的站
 */
async function inviteTargets(config) {
    const targets = [];
    const { site, url } = peerConfig();
    if (registrationOpen()) {
        targets.push({
            site, label: siteLabel(site) || '本站', remote: false, base: inviteBase(), friendRewardMiB: rewardsAvailable() ? config.inviteeRewardMiB : 0,
            claimWindowDays: config.claimWindowDays, requireValidReply: config.requireValidReply,
        });
    }
    if (config.crossSite && url) {
        const { value } = await getPeerInfo();
        if (value?.enabled && value.crossSite && value.registrationOpen) {
            const base = /^https?:\/\//i.test(String(value.inviteBase ?? '')) ? String(value.inviteBase) : `${url}/invite/`;
            targets.push({
                site: String(value.site), label: siteLabel(value.site), remote: true, base, friendRewardMiB: Number(value.inviteeRewardMiB) || 0,
                claimWindowDays: Number(value.claimWindowDays) || config.claimWindowDays, requireValidReply: value.requireValidReply !== false,
            });
        }
    }
    return targets;
}

// ---------------------------------------------------------------------------
// 溯源：记录、比对（只标记）
// ---------------------------------------------------------------------------

/**
 * 记下这个人用过的 IP 和设备：参与邀请的人（有邀请码，或绑定了邀请人）才记；force 时不看（在用邀请功能）。
 * @param {string} handle
 * @param {any} context traceContext()
 * @param {{ force?: boolean }} [options]
 */
export async function noteParticipant(handle, context, { force = false } = {}) {
    try {
        if (!handle || !context) return;
        if (!force && !await storage.getItem(OWNER_PREFIX + handle) && !await storage.getItem(LINK_PREFIX + handle)) return;
        await recordSeen(handle, context);
    } catch (error) {
        console.warn('[referrals] Could not note where someone came from:', error?.message ?? error);
    }
}

/**
 * 有人打开了邀请链接（还没登录也记）。
 * @param {string} device
 * @param {unknown} rawCode
 * @param {any} context
 */
export async function noteInviteVisit(device, rawCode, context) {
    try {
        const code = normalizeCode(rawCode);
        if (code && device) await recordVisit(device, code, context);
    } catch (error) {
        console.warn('[referrals] Could not note an invitation visit:', error?.message ?? error);
    }
}

const LEVEL_ORDER = Object.freeze({ high: 3, medium: 2, low: 1 });
const NEW_DISCORD_DAYS = 60;
const BURST_COUNT = 5;
const INACTIVE_AFTER_MS = 3 * DAY_MS;
const INACTIVE_HOURS = 0.5;
const INVITER_MATCHES = Object.freeze(['same-device', 'same-ip', 'same-network']);

/** 一组证据：设备号、IP 摘要、网段摘要（本站的摘要） */
function evidenceFrom(items) {
    const evidence = { devices: new Set(), ips: new Set(), nets: new Set() };
    for (const item of items) {
        if (item?.device) evidence.devices.add(item.device);
        if (item?.ipHash) evidence.ips.add(item.ipHash);
        if (item?.netHash) evidence.nets.add(item.netHash);
    }
    return evidence;
}

/** 跨站用的证据：用两站共用的 secret 重新算摘要（只有还留着原始 IP 的才算得出） */
function sharedEvidenceFrom(items) {
    const evidence = { devices: new Set(), ips: new Set(), nets: new Set() };
    for (const item of items) {
        if (item?.device) evidence.devices.add(sharedDigest('device', item.device));
        if (item?.ip) evidence.ips.add(sharedDigest('ip', item.ip));
        if (item?.net) evidence.nets.add(sharedDigest('net', item.net));
    }
    for (const set of Object.values(evidence)) set.delete('');
    return evidence;
}

function intersects(a, b) {
    for (const value of a) if (b.has(value)) return true;
    return false;
}

/** 两组证据比一比：同设备 > 同 IP > 同网段 */
function compareWithInviter(mine, theirs, suffix = '') {
    if (intersects(mine.devices, theirs.devices)) return [{ code: 'same-device', level: 'high', text: `和邀请人用过同一台设备${suffix}` }];
    if (intersects(mine.ips, theirs.ips)) return [{ code: 'same-ip', level: 'medium', text: `和邀请人用过同一个 IP${suffix}` }];
    if (intersects(mine.nets, theirs.nets)) return [{ code: 'same-network', level: 'low', text: `和邀请人在同一网段${suffix}` }];
    return [];
}

async function cached(cache, key, load) {
    if (!cache.has(key)) cache.set(key, load());
    return cache.get(key);
}

/** 被邀请人的证据：这条邀请记下的时刻 + 这个人最近用过的（对方站的被邀请人只有那边传来的时刻，摘要不能比） */
function inviteeEvidence(link, cache) {
    return cached(cache, `invitee:${link.invitee}`, async () => (link.mirror ? evidenceFrom([]) : evidenceFrom([...(link.events ?? []), ...await readSeen(link.invitee)])));
}

/** 同一个邀请人的其他邀请（本站的邀请人；列表时直接传进来） */
async function siblingsOf(link) {
    if (link.inviterSite || link.mirror) return [];
    const links = [];
    for (const invitee of await readList(INVITER_PREFIX + link.inviter)) {
        const other = await storage.getItem(LINK_PREFIX + invitee);
        if (other) links.push(other);
    }
    return links;
}

/**
 * 这条邀请可疑在哪（只标记，奖励照发）：[{ code, level: 'high'|'medium'|'low', text }]。
 * @param {any} link
 * @param {Map<string, any>} [cache]
 * @param {any[]|null} [siblings] 同一个邀请人的所有邀请（含自己）
 */
async function assessLink(link, cache = new Map(), siblings = null) {
    if (link.mirror) return Array.isArray(link.flags) ? link.flags : [];
    const flags = [];
    const mine = await inviteeEvidence(link, cache);
    if (link.inviterSite) flags.push(...(Array.isArray(link.remoteFlags) ? link.remoteFlags : []));
    else flags.push(...compareWithInviter(mine, await cached(cache, `seen:${link.inviter}`, async () => evidenceFrom(await readSeen(link.inviter)))));
    const others = (siblings ?? await siblingsOf(link)).filter(other => other.invitee !== link.invitee);
    let sharedIp = false;
    for (const other of others) {
        if (other.mirror) continue;
        const theirs = await inviteeEvidence(other, cache);
        if (intersects(mine.devices, theirs.devices)) {
            flags.push({ code: 'sibling-device', level: 'high', text: `和同一个邀请人的 ${await inviteeNameOf(other)} 用同一台设备` });
            break;
        }
        if (!sharedIp && intersects(mine.ips, theirs.ips)) {
            sharedIp = true;
            flags.push({ code: 'sibling-ip', level: 'medium', text: `和同一个邀请人的 ${await inviteeNameOf(other)} 用同一个 IP` });
        }
    }
    const user = await cached(cache, `user:${link.invitee}`, () => storage.getItem(toKey(link.invitee)));
    const created = discordCreatedAt(discordIdOf(user));
    if (created) {
        const days = Math.floor((Number(link.boundAt) - created) / DAY_MS);
        if (days < NEW_DISCORD_DAYS) flags.push({ code: 'new-discord', level: 'medium', text: `绑定时 Discord 号才注册 ${Math.max(0, days)} 天` });
    }
    const burst = others.filter(other => Math.abs(Number(other.boundAt) - Number(link.boundAt)) <= DAY_MS).length + 1;
    if (burst >= BURST_COUNT) flags.push({ code: 'burst', level: 'medium', text: `邀请人前后 24 小时内绑定了 ${burst} 个` });
    if (link.status === STATUS.SUCCESS && Date.now() - Number(link.successAt) > INACTIVE_AFTER_MS) {
        const hours = await getInvitationOnlineHours(link.invitee).catch(() => 0);
        if (hours < INACTIVE_HOURS) flags.push({ code: 'inactive', level: 'low', text: `成功后几乎没上线（累计在线 ${Math.round(hours * 10) / 10} 小时）` });
    }
    return flags;
}

/** 最高的可疑程度 */
const riskOf = flags => flags.reduce((top, flag) => (LEVEL_ORDER[flag.level] > (LEVEL_ORDER[top] ?? 0) ? flag.level : top), null);

/** 过了保留期的原始 IP、浏览器信息从邀请记录里去掉（每天一次） */
async function scrubLinks(now = Date.now()) {
    for (const invitee of await readList(INDEX_KEY)) {
        await serialized(async () => {
            const link = await storage.getItem(LINK_PREFIX + invitee);
            if (!Array.isArray(link?.events)) return;
            if (link.events.map(event => scrubRaw(event, now)).some(Boolean)) await storage.setItem(LINK_PREFIX + invitee, link);
        });
    }
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
        invitees.push({ name: await inviteeNameOf(link), status: link.status, boundAt: link.boundAt, successAt: link.successAt, rewardMiB: link.inviterRewardMiB || 0 });
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
        targets: config.enabled ? await inviteTargets(config) : [],
        earnedMiB: earned,
        invitees,
        invitedBy: mine ? { name: await inviterNameOf(mine), status: mine.status, rewardMiB: mine.inviteeRewardMiB || 0, boundAt: mine.boundAt } : null,
        canClaim: config.enabled && !mine && Date.now() <= deadline,
        claimDeadline: deadline,
    };
}

// ---------------------------------------------------------------------------
// 管理员
// ---------------------------------------------------------------------------

/** 管理员看的被邀请人情况：注册时间、累计在线（判断是不是小号）；对方站的看不到 */
async function describeInvitee(link) {
    if (link.mirror) return { inviteeSiteLabel: siteLabel(link.inviteeSite), inviteeHandle: link.remoteInvitee };
    const user = await storage.getItem(toKey(link.invitee));
    const hours = await getInvitationOnlineHours(link.invitee).catch(() => 0);
    return { inviteeCreated: Number(user?.created) || null, inviteeOnlineHours: Math.round(hours * 10) / 10, inviteeExists: Boolean(user) };
}

/** 管理员看本站的一个人：按门槛够不够、单独设置了什么、现在能不能邀请 */
async function describeInviter(handle) {
    const user = await storage.getItem(toKey(handle));
    if (!user) return { inviter: handle, inviterName: handle, remote: false, exists: false, blocked: false, mode: null };
    const measured = await measureInviter(user);
    const mode = await accessOf(handle);
    return {
        inviter: handle, inviterName: await nameOf(handle), remote: false, exists: true, mode, blocked: mode === 'block',
        registeredDays: Math.floor(measured.registeredDays), onlineHours: measured.onlineHours, roundedHours: measured.roundedHours, meetsThresholds: measured.meetsThresholds,
        seen: (await readSeen(handle)).slice(0, 8),
        eligible: user.enabled !== false && (mode ? mode === 'allow' : measured.meetsThresholds),
    };
}

/** 管理员搜索：账号、名字、邀请码，以及记下的 IP、网段、设备号 */
async function searchText(link) {
    const traces = [...(link.events ?? []), ...(link.mirror ? [] : await readSeen(link.invitee))].map(item => `${item.ip ?? ''} ${item.net ?? ''} ${item.device ?? ''}`);
    return `${link.inviter} ${link.invitee} ${link.inviteeName ?? ''} ${link.inviterName ?? ''} ${link.code} ${traces.join(' ')}`.toLowerCase();
}

/** 跨站邀请的情况（管理员面板）：配好了没有、对方站开没开、对方站开着注册没有 */
export async function getCrossSiteStatus() {
    const { site, url, ready } = peerConfig();
    if (!ready) return { configured: false, site, siteLabel: siteLabel(site), peerUrl: url };
    const { value, error } = await getPeerInfo({ fresh: true, waitMs: 9000 });
    return { configured: true, site, siteLabel: siteLabel(site), peerUrl: url, registrationOpen: registrationOpen(), peer: value, peerLabel: siteLabel(value?.site ?? ''), error };
}

/**
 * 所有邀请关系（顺带把过期的标成作废）。
 * @param {{ query?: string, status?: string, inviter?: string, offset?: number, limit?: number }} [options]
 *     inviter：只看这个人邀请的（精确匹配；对方站的人写成 <站>:<账号>）
 */
export function listReferrals({ query = '', status = '', inviter: onlyInviter = '', offset = 0, limit = 50 } = {}) {
    return serialized(async () => {
        const config = await getReferralConfig();
        const needle = String(query).trim().toLowerCase();
        const rows = [];
        const summary = { total: 0, pending: 0, success: 0, revoked: 0, expired: 0, suspicious: 0, inviterMiB: 0, inviteeMiB: 0 };
        /** @type {Map<string, { inviter: string, site: string, handle: string, success: number, pending: number, earnedMiB: number, link: any }>} */
        const inviters = new Map();
        const all = [];
        for (const invitee of await readList(INDEX_KEY)) {
            const link = await storage.getItem(LINK_PREFIX + invitee);
            if (!link) continue;
            await expireIfStale(link, config);
            all.push(link);
        }
        // 溯源：按同一个邀请人分组，算每条的可疑标记
        const groups = new Map();
        for (const link of all) groups.set(inviterKeyOf(link), [...(groups.get(inviterKeyOf(link)) ?? []), link]);
        const cache = new Map();
        for (const link of all) {
            link.flags = await assessLink(link, cache, groups.get(inviterKeyOf(link)));
            link.risk = riskOf(link.flags);
        }
        for (const link of all) {
            summary.total++;
            summary[link.status] = (summary[link.status] ?? 0) + 1;
            if (link.status !== STATUS.REVOKED) {
                summary.inviterMiB += Number(link.inviterRewardMiB) || 0;
                summary.inviteeMiB += Number(link.inviteeRewardMiB) || 0;
            }
            const key = inviterKeyOf(link);
            const row = inviters.get(key) ?? { inviter: key, site: link.inviterSite ?? '', handle: link.inviter, success: 0, pending: 0, earnedMiB: 0, link };
            if (link.status === STATUS.SUCCESS) row.success++;
            if (link.status === STATUS.PENDING) row.pending++;
            if (link.status !== STATUS.REVOKED) row.earnedMiB += Number(link.inviterRewardMiB) || 0;
            inviters.set(key, row);
            const suspicious = link.status !== STATUS.REVOKED && (link.risk === 'high' || link.risk === 'medium');
            if (suspicious) summary.suspicious++;
            if (status === 'suspicious' ? !suspicious : (status && link.status !== status)) continue;
            if (onlyInviter && key !== onlyInviter) continue;
            if (needle && !(await searchText(link)).includes(needle)) continue;
            rows.push(link);
        }
        rows.sort((a, b) => b.boundAt - a.boundAt);
        const top = [...inviters.values()].sort((a, b) => (b.success - a.success) || (b.earnedMiB - a.earnedMiB)).slice(0, 20);
        const topRows = [];
        for (const { link, ...row } of top) {
            topRows.push({ ...row, inviterName: await inviterNameOf(link), blocked: row.site ? false : await isBlocked(row.handle) });
        }
        const page = [];
        for (const link of rows.slice(offset, offset + limit)) {
            const user = link.mirror ? null : await storage.getItem(toKey(link.invitee));
            const discordAt = discordCreatedAt(discordIdOf(user));
            page.push({
                ...link, inviterKey: inviterKeyOf(link), inviterName: await inviterNameOf(link), inviteeName: await inviteeNameOf(link),
                inviterSiteLabel: link.inviterSite ? siteLabel(link.inviterSite) : '', inviterBlocked: link.inviterSite ? false : await isBlocked(link.inviter),
                ...await describeInvitee(link),
                inviteeDiscordDays: discordAt ? Math.floor((Date.now() - discordAt) / DAY_MS) : null,
                inviteeSeen: link.mirror ? [] : (await readSeen(link.invitee)).slice(0, 6),
            });
        }
        // 只看一个人时：这个人的情况（停用没有、一共邀请了多少、拿了多少）。对方站的人在对方站停用。
        let focus = null;
        if (onlyInviter) {
            const known = inviters.get(onlyInviter);
            const remote = Boolean(known?.site) || onlyInviter.includes(':');
            focus = remote
                ? {
                    inviter: onlyInviter, handle: known?.handle ?? onlyInviter.split(':').slice(1).join(':'), inviterName: known ? await inviterNameOf(known.link) : onlyInviter,
                    remote: true, siteLabel: siteLabel(known?.site ?? onlyInviter.split(':')[0]), blocked: false, total: rows.length, earnedMiB: known?.earnedMiB ?? 0,
                }
                : { ...await describeInviter(onlyInviter), total: (await readList(INVITER_PREFIX + onlyInviter)).length, earnedMiB: known?.earnedMiB ?? 0 };
        }
        return { summary, top: topRows, total: rows.length, rows: page, focus };
    });
}

/**
 * 管理员撤销一条邀请；reclaim 时把已经发的空间收回（跨站的两边各收各的）。
 * @param {string} invitee 被邀请人（对方站的写成 @<站>:<账号>）
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

/** 撤销一条（必须在队列里调用）；跨站的告诉对方站 */
async function revokeLink(link, { reclaim, by }) {
    if (reclaim && link.status === STATUS.SUCCESS) {
        // 本站发的那份本站收回；对方站发的由对方站收回
        if (!link.inviterSite) await addStorage(link.inviter, -(Number(link.inviterRewardMiB) || 0));
        if (!link.mirror) await addStorage(link.invitee, -(Number(link.inviteeRewardMiB) || 0));
        link.reclaimed = true;
    }
    link.status = STATUS.REVOKED;
    link.revokedAt = Date.now();
    link.revokedBy = by;
    addEvent(link, { type: 'revoked', at: link.revokedAt, by, reclaim: Boolean(link.reclaimed) });
    await storage.setItem(LINK_PREFIX + link.invitee, link);
    pendingInvitees.delete(link.invitee);
    console.info(`[referrals] ${inviterKeyOf(link)} → ${link.invitee}: revoked by ${by}${link.reclaimed ? ', rewards taken back' : ''}`);
    if (link.inviterSite) await tellPeer(`sync:${link.invitee}`);
    if (link.mirror) await tellPeer(`revoked:${link.invitee}`);
}

/**
 * 管理员单独设置一个人的邀请资格：
 *   allow    不够门槛也能邀请
 *   block    够门槛也不能邀请：邀请码作废、不能再生成，之后成功的邀请也不给邀请人空间；revokeAll 时把这个人
 *            已有的邀请都撤销（reclaim：连已发的空间一起收回）
 *   default  恢复按门槛（停用过的要重新生成邀请码）
 * @param {string} handle
 * @param {'allow'|'block'|'default'} mode
 * @param {{ revokeAll?: boolean, reclaim?: boolean, by?: string }} [options]
 */
export function setInviterAccess(handle, mode, { revokeAll = false, reclaim = false, by = '' } = {}) {
    return serialized(async () => {
        if (!['allow', 'block', 'default'].includes(mode)) return { ok: false, reason: '不认识的设置' };
        if (!handle || !await storage.getItem(toKey(handle))) return { ok: false, reason: '用户不存在' };
        const access = await readAccess();
        if (mode === 'default') delete access[handle];
        else access[handle] = { mode, at: Date.now(), by };
        await storage.setItem(ACCESS_KEY, access);
        let revoked = 0;
        if (mode === 'block') {
            const owned = await storage.getItem(OWNER_PREFIX + handle);
            if (owned?.code) await storage.removeItem(CODE_PREFIX + owned.code);
            await storage.removeItem(OWNER_PREFIX + handle);
            if (revokeAll) {
                for (const invitee of await readList(INVITER_PREFIX + handle)) {
                    const link = await storage.getItem(LINK_PREFIX + invitee);
                    if (!link || link.status === STATUS.REVOKED) continue;
                    await revokeLink(link, { reclaim, by });
                    revoked++;
                }
            }
        }
        console.info(`[referrals] ${handle}: invitations ${mode === 'default' ? 'back to the thresholds' : `${mode}ed`} by ${by}${revoked ? `, ${revoked} revoked${reclaim ? ' with rewards taken back' : ''}` : ''}`);
        return { ok: true, mode, revoked };
    });
}

/**
 * 停用 / 恢复（setInviterAccess 的简写）。
 * @param {string} handle
 * @param {boolean} blocked
 * @param {{ revokeAll?: boolean, reclaim?: boolean, by?: string }} [options]
 */
export function setInviterBlocked(handle, blocked, options = {}) {
    return setInviterAccess(handle, blocked ? 'block' : 'default', options);
}

/** 单独设置过邀请资格的人（管理员面板） */
export async function listAccess() {
    const rows = [];
    for (const [handle, entry] of Object.entries(await readAccess())) {
        if (entry?.mode !== 'allow' && entry?.mode !== 'block') continue;
        rows.push({ handle, name: await nameOf(handle), mode: entry.mode, at: Number(entry.at) || 0, by: String(entry.by ?? '') });
    }
    return rows.sort((a, b) => b.at - a.at);
}

/**
 * 管理员直接判定成功（不等有效回复），发奖励。对方站的被邀请人由对方站判定。
 * @param {string} invitee
 * @param {{ by?: string }} [options]
 */
export function approveReferral(invitee, { by = '' } = {}) {
    return serialized(async () => {
        const link = await storage.getItem(LINK_PREFIX + invitee);
        if (!link) return { ok: false, reason: '没有这条邀请关系' };
        if (link.mirror) return { ok: false, reason: `被邀请人在${siteLabel(link.inviteeSite)}，由那边判定` };
        if (link.status !== STATUS.PENDING && link.status !== STATUS.EXPIRED) return { ok: false, reason: '只有等待中或已作废的可以判定成功' };
        await settle(link, await getReferralConfig(), { by: by || 'admin' });
        return { ok: true, link };
    });
}

/** 启动时：载入等待中的名单，没发出去的跨站消息接着发；之后每小时把过期的作废 */
export function startReferrals() {
    void loadPending().catch(error => console.warn('[referrals] Could not load pending referrals:', error?.message ?? error));
    setTimeout(() => void flushPeerOutbox().catch(() => undefined), 30e3).unref?.();
    setInterval(() => void serialized(async () => {
        const config = await getReferralConfig();
        for (const invitee of [...pendingInvitees]) {
            await expireIfStale(await storage.getItem(LINK_PREFIX + invitee), config);
        }
    }).then(() => flushPeerOutbox()).catch(() => undefined), 3600e3).unref?.();
    // 溯源：原始 IP 和浏览器信息保留 90 天（每天清一次）
    const sweep = () => void sweepTraces().then(() => scrubLinks()).catch(error => console.warn('[referrals] Trace clean-up failed:', error?.message ?? error));
    setTimeout(sweep, 10 * 60e3).unref?.();
    setInterval(sweep, DAY_MS).unref?.();
}

/** 测试用 */
export function resetReferralMemory() {
    pendingInvitees.clear();
    pendingLoaded = false;
}
