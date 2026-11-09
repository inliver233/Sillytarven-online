/**
 * 跨站邀请的站间通信：沿用排行榜的站间配置（leaderboard.site / secret / peers，两站同一个 secret），
 * 请求用 secret 签名（x-referral-auth，和排行榜同样的签法，两分钟内有效）。接口在 /api/referrals/peer/*，
 * 不需要登录（src/endpoints/referrals.js）。
 */
import crypto from 'node:crypto';

import { signPeerRequest, verifyPeerRequest } from './leaderboard.js';
import { getConfigValue } from './util.js';

const TIMEOUT_MS = 8000;
/** 对方站的情况（开没开、注册开没开）记多久 */
const INFO_TTL_MS = 5 * 60e3;
const SITE_LABELS = Object.freeze({ legacy: '老站', modern: '新站' });

/** @param {string} site */
export const siteLabel = site => SITE_LABELS[site] ?? site ?? '';

/**
 * @returns {{ site: string, secret: string, url: string, ready: boolean }} 本站是哪个站、对方站的地址
 */
export function peerConfig() {
    const site = String(getConfigValue('leaderboard.site', '') ?? '').trim();
    const secret = String(getConfigValue('leaderboard.secret', '') ?? '').trim();
    const peers = getConfigValue('leaderboard.peers', []);
    const url = (Array.isArray(peers) ? peers : [])
        .map(peer => String(typeof peer === 'string' ? peer : peer?.url ?? '').trim().replace(/\/+$/, ''))
        .find(value => /^https?:\/\//.test(value)) ?? '';
    return { site, secret, url, ready: Boolean(SITE_LABELS[site] && secret.length >= 16 && url) };
}

/**
 * 同一个人在两站的账号：用 Discord 身份认，传的是加了 secret 的摘要，不传 ID 本身。
 * @param {string|null} discordId
 */
export function identityKey(discordId) {
    const { secret } = peerConfig();
    return discordId && secret ? crypto.createHmac('sha256', secret).update(`discord:${discordId}`).digest('hex') : '';
}

/**
 * 跨站比对用的摘要（两站共用的 secret，同一个 IP / 设备在两站算出来一样）。
 * @param {string} kind ip | net | device
 * @param {string} value
 */
export function sharedDigest(kind, value) {
    const { secret } = peerConfig();
    return value && secret ? crypto.createHmac('sha256', secret).update(`${kind}:${value}`).digest('hex').slice(0, 32) : '';
}

/** @type {((path: string, payload: any) => Promise<any>)|null} 测试换成假的对方站 */
let transport = null;
/** @type {{ at: number, value: any, error: string }|null} 对方站的情况 */
let info = null;
/** @type {Promise<void>|null} */
let fetching = null;

/** @param {((path: string, payload: any) => Promise<any>)|null} fake */
export function setPeerTransport(fake) {
    transport = fake;
    info = null;
}

/**
 * 发给对方站。
 * @param {string} path /info、/lookup、/sync、/revoked
 * @param {any} payload
 * @returns {Promise<any>}
 */
export async function callPeer(path, payload = {}) {
    if (transport) return transport(path, payload);
    const { secret, url, ready } = peerConfig();
    if (!ready) throw new Error('没有配置另一个站');
    const body = JSON.stringify(payload);
    const response = await fetch(`${url}/api/referrals/peer${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'application/json', 'x-referral-auth': signPeerRequest(secret, Date.now(), `${path}\n${body}`) },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
}

/**
 * 对方站发来的请求是不是真的（body 已经由 express.json 解析）。
 * @param {import('express').Request} request
 * @param {string} path
 */
export function verifyPeer(request, path) {
    const { secret, ready } = peerConfig();
    if (!ready) return false;
    return verifyPeerRequest(secret, request.get('x-referral-auth'), `${path}\n${JSON.stringify(request.body ?? {})}`, Date.now());
}

/**
 * 对方站的情况：{ site, enabled, crossSite, registrationOpen, inviteeRewardMiB, inviterRewardMiB }；
 * 查不到为 null。旧的先用着，后台再查；没有时最多等 waitMs。
 * @param {{ waitMs?: number, fresh?: boolean }} [options]
 * @returns {Promise<{ value: any, error: string }>}
 */
export async function getPeerInfo({ waitMs = 1500, fresh = false } = {}) {
    if (!transport && !peerConfig().ready) return { value: null, error: '没有配置另一个站' };
    if (fresh || !info || Date.now() - info.at > INFO_TTL_MS) {
        fetching ??= callPeer('/info')
            .then(value => { info = { at: Date.now(), value, error: '' }; })
            .catch(error => { info = { at: Date.now(), value: null, error: String(error?.message || error).slice(0, 200) }; })
            .finally(() => { fetching = null; });
        const waiting = fetching;
        await Promise.race([waiting, new Promise(resolve => setTimeout(resolve, waitMs).unref?.())]);
    }
    return { value: info?.value ?? null, error: info?.error ?? '' };
}
