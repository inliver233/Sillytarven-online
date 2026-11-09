/**
 * 邀请奖励的溯源：每条邀请记下关键时刻的 IP、设备号、浏览器（管理员可见），邀请参与者记下最近用过的
 * IP 和设备，用来比对「邀请人和被邀请人是不是同一个人 / 同一台设备」。原始 IP 和浏览器信息保留
 * RAW_RETENTION_DAYS 天，之后只留打码的网段和摘要（摘要照样能比对）。
 *
 * 设备号：浏览器里一个随机号，存在 cookie st_did 和 localStorage（referral-panel.js 两边互相补），
 * 同一个浏览器换账号登录还是同一个；两站是不同的网站，设备号各是各的。
 *
 * 存储（node-persist）：
 *   referral:seen:<账号>     最近用过的 [{ ip, net, ipHash, netHash, device, ua, first, last, count }]（最多 30 个）
 *   referral:visit:<设备号>  打开邀请链接 { code, at, ip, net, ipHash, netHash, ua }（30 天）
 *   referral:seen-index、referral:visit-index   有记录的账号 / 设备号（每天清理用）
 */
import crypto from 'node:crypto';

import ipaddr from 'ipaddr.js';
import storage from 'node-persist';

import { getRealIpFromHeader } from './express-common.js';
import { getCookieSecret } from './users.js';

const SEEN_PREFIX = 'referral:seen:';
const VISIT_PREFIX = 'referral:visit:';
const SEEN_INDEX = 'referral:seen-index';
const VISIT_INDEX = 'referral:visit-index';
export const DEVICE_COOKIE = 'st_did';
const DEVICE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_SEEN = 30;
/** 同一个 IP + 设备，隔这么久才再记一次（少写盘） */
const SEEN_REFRESH_MS = 6 * 3600e3;
export const RAW_RETENTION_DAYS = 90;
const VISIT_DAYS = 30;
const DAY_MS = 86_400_000;
/** Discord 雪花 ID 的起点（2015-01-01） */
const DISCORD_EPOCH = 1420070400000;

let secret = '';
/** 摘要用的密钥（本站自己的；跨站比对另用两站共用的 secret，见 referral-peer.js） */
function traceSecret() {
    if (!secret) {
        try {
            secret = String(getCookieSecret(globalThis.DATA_ROOT) || '');
        } catch {
            secret = '';
        }
        if (!secret) secret = crypto.randomBytes(32).toString('hex');
    }
    return secret;
}

const digest = (key, value) => (value ? crypto.createHmac('sha256', key).update(String(value)).digest('hex').slice(0, 32) : '');

/**
 * 打码的网段：IPv4 留前三段（1.2.3.x），IPv6 留前三组（/48）。
 * @param {string} ip
 */
export function maskIp(ip) {
    try {
        const parsed = ipaddr.process(String(ip));
        if (parsed.kind() === 'ipv4') return `${parsed.toString().split('.').slice(0, 3).join('.')}.x`;
        return `${parsed.toNormalizedString().split(':').slice(0, 3).join(':')}::/48`;
    } catch {
        return '';
    }
}

/**
 * 一个 IP 的记法：原始 IP、打码的网段，以及两者的摘要（比对用）。
 * @param {string} ip
 */
export function describeIp(ip) {
    const raw = String(ip ?? '').trim();
    if (!raw || raw === 'unknown') return { ip: '', net: '', ipHash: '', netHash: '' };
    const net = maskIp(raw);
    return { ip: raw, net, ipHash: digest(traceSecret(), `ip:${raw}`), netHash: net ? digest(traceSecret(), `net:${net}`) : '' };
}

/** @param {string} cookieHeader */
export function deviceFromCookies(cookieHeader) {
    for (const part of String(cookieHeader ?? '').split(';')) {
        const [name, ...rest] = part.trim().split('=');
        if (name === DEVICE_COOKIE) {
            const value = decodeURIComponent(rest.join('='));
            return DEVICE_PATTERN.test(value) ? value : '';
        }
    }
    return '';
}

/** 新的设备号 */
export const newDeviceId = () => crypto.randomBytes(16).toString('base64url');

/**
 * 这个浏览器的设备号；没有就发一个（cookie 一年，页面也会存一份到 localStorage）。
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 */
export function ensureDeviceCookie(request, response) {
    const existing = deviceFromCookies(request.headers?.cookie);
    if (existing) return existing;
    const device = newDeviceId();
    response.append('Set-Cookie', `${DEVICE_COOKIE}=${device}; Path=/; Max-Age=31536000; SameSite=Lax${request.secure ? '; Secure' : ''}`);
    return device;
}

/**
 * 一次请求的来路：IP、设备号、浏览器。
 * @param {import('express').Request} request
 */
export function traceContext(request) {
    if (!request) return null;
    let ip = '';
    try {
        ip = getRealIpFromHeader(request);
    } catch {
        ip = '';
    }
    return {
        ...describeIp(ip),
        device: deviceFromCookies(request.headers?.cookie),
        ua: String(request.headers?.['user-agent'] ?? '').slice(0, 300),
    };
}

/**
 * 记一个邀请时刻：{ type, at, ip, net, ipHash, netHash, device, ua, ...extra }。
 * @param {string} type
 * @param {any} context traceContext()
 * @param {object} [extra]
 */
export function traceEvent(type, context, extra = {}) {
    const event = { type, at: Date.now(), ...extra };
    if (context) Object.assign(event, { ip: context.ip, net: context.net, ipHash: context.ipHash, netHash: context.netHash, device: context.device, ua: context.ua });
    return event;
}

/**
 * 记下这个人用过的 IP + 设备（同一组 6 小时内只记一次）。
 * @param {string} handle
 * @param {any} context
 */
export async function recordSeen(handle, context) {
    if (!handle || !context || (!context.ipHash && !context.device)) return;
    const key = SEEN_PREFIX + handle;
    const list = await readSeen(handle);
    const now = Date.now();
    const same = list.find(item => item.ipHash === context.ipHash && item.device === context.device);
    if (same && now - same.last < SEEN_REFRESH_MS) return;
    if (same) {
        Object.assign(same, { last: now, count: (same.count || 1) + 1, ip: context.ip || same.ip, ua: context.ua || same.ua });
    } else {
        list.push({ ip: context.ip, net: context.net, ipHash: context.ipHash, netHash: context.netHash, device: context.device, ua: context.ua, first: now, last: now, count: 1 });
    }
    list.sort((a, b) => b.last - a.last);
    await storage.setItem(key, list.slice(0, MAX_SEEN));
    if (!same) await addToIndex(SEEN_INDEX, handle);
}

async function addToIndex(key, item) {
    const list = await storage.getItem(key);
    const items = Array.isArray(list) ? list : [];
    if (items.includes(item)) return;
    items.push(item);
    await storage.setItem(key, items);
}

/** @param {string} handle */
export async function readSeen(handle) {
    const value = await storage.getItem(SEEN_PREFIX + handle);
    return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
}

/**
 * 打开邀请链接（还没登录也记，按设备号存，绑定时找回来）。
 * @param {string} device
 * @param {string} code
 * @param {any} context
 */
export async function recordVisit(device, code, context) {
    if (!device || !code) return;
    await storage.setItem(VISIT_PREFIX + device, { code, at: Date.now(), ip: context?.ip ?? '', net: context?.net ?? '', ipHash: context?.ipHash ?? '', netHash: context?.netHash ?? '', ua: context?.ua ?? '' });
    await addToIndex(VISIT_INDEX, device);
}

/**
 * 这个设备打开过这个码的邀请链接没有。
 * @param {string} device
 * @param {string} code
 */
export async function findVisit(device, code) {
    if (!device || !code) return null;
    const visit = await storage.getItem(VISIT_PREFIX + device);
    return visit?.code === code && Date.now() - Number(visit.at) < VISIT_DAYS * DAY_MS ? visit : null;
}

/**
 * Discord 号是什么时候注册的（雪花 ID 里带着时间）。
 * @param {string|null} discordId
 * @returns {number|null}
 */
export function discordCreatedAt(discordId) {
    if (!/^\d{5,25}$/.test(String(discordId ?? ''))) return null;
    // 高 42 位是毫秒数；ID 超出双精度整数的部分只差几毫秒，算天数够用
    const at = Math.floor(Number(discordId) / 4194304) + DISCORD_EPOCH;
    return Number.isFinite(at) ? at : null;
}

/**
 * 过了保留期：去掉原始 IP 和浏览器信息，只留网段和摘要。
 * @param {any} item 一个时刻或一条「用过的」
 * @param {number} [now]
 * @returns {boolean} 改了没有
 */
export function scrubRaw(item, now = Date.now()) {
    const at = Number(item?.last ?? item?.at) || 0;
    if (!item || (!item.ip && !item.ua) || now - at < RAW_RETENTION_DAYS * DAY_MS) return false;
    delete item.ip;
    delete item.ua;
    return true;
}

/** 每天一次：用过的记录过了保留期去掉原始 IP，半年没再出现的删掉；打开链接的记录 30 天后删 */
export async function sweepTraces(now = Date.now()) {
    const handles = await storage.getItem(SEEN_INDEX);
    const keptHandles = [];
    for (const handle of Array.isArray(handles) ? handles : []) {
        const list = await storage.getItem(SEEN_PREFIX + handle);
        const kept = (Array.isArray(list) ? list : []).filter(item => now - Number(item?.last) < 2 * RAW_RETENTION_DAYS * DAY_MS);
        const scrubbed = kept.map(item => scrubRaw(item, now)).some(Boolean);
        if (!kept.length) {
            await storage.removeItem(SEEN_PREFIX + handle);
            continue;
        }
        if (scrubbed || kept.length !== list.length) await storage.setItem(SEEN_PREFIX + handle, kept);
        keptHandles.push(handle);
    }
    await storage.setItem(SEEN_INDEX, keptHandles);
    const devices = await storage.getItem(VISIT_INDEX);
    const keptDevices = [];
    for (const device of Array.isArray(devices) ? devices : []) {
        const visit = await storage.getItem(VISIT_PREFIX + device);
        if (!visit || now - Number(visit.at) > VISIT_DAYS * DAY_MS) await storage.removeItem(VISIT_PREFIX + device);
        else keptDevices.push(device);
    }
    await storage.setItem(VISIT_INDEX, keptDevices);
}
