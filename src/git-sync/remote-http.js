import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * HTTP transport for isomorphic-git that only talks to public git hosts.
 *
 * Remote URLs come from users, so every connection checks the address it actually connects to
 * (not just the hostname typed in), every redirect is checked again, and responses are bounded.
 * Checking inside `lookup` means a hostname that resolves to a private address at connect time is
 * refused even if it looked public a moment earlier.
 */

const MAX_REDIRECTS = 5;

/**
 * Ranges that must never be reachable from a user-supplied remote. IPv4 and IPv6 are kept in
 * separate lists: a single BlockList holding ::ffff:0:0/96 also matches every plain IPv4 address.
 */
const BLOCKED_V4 = new net.BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) {
    BLOCKED_V4.addSubnet(address, prefix, 'ipv4');
}
const BLOCKED_V6 = new net.BlockList();
for (const [address, prefix] of [
    ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
    ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) {
    BLOCKED_V6.addSubnet(address, prefix, 'ipv6');
}

export class RemoteNotAllowedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RemoteNotAllowedError';
        this.code = 'RemoteNotAllowed';
    }
}

/**
 * @param {string} address
 * @returns {boolean}
 */
export function isBlockedAddress(address) {
    const family = net.isIP(address);
    if (!family) return true;
    if (family === 4) return BLOCKED_V4.check(address, 'ipv4');
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged as the IPv4 address it carries.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    if (mapped) return BLOCKED_V4.check(mapped, 'ipv4');
    if (/^::ffff:/i.test(address)) return true;
    return BLOCKED_V6.check(address, 'ipv6');
}

/**
 * Normalizes and checks a remote URL before it is stored or used.
 * @param {string} value
 * @param {{ allowPrivateNetworks?: boolean, allowHttp?: boolean }} [policy]
 * @returns {string} The normalized URL without credentials
 */
export function normalizeRemoteUrl(value, policy = {}) {
    let url;
    try {
        url = new URL(String(value ?? '').trim());
    } catch {
        throw new RemoteNotAllowedError('仓库地址格式不正确');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (policy.allowHttp || policy.allowPrivateNetworks))) {
        throw new RemoteNotAllowedError('只支持 https:// 开头的仓库地址');
    }
    if (url.username || url.password) {
        throw new RemoteNotAllowedError('请不要把账号或 token 写进地址，在“访问令牌”里填写');
    }
    if (!url.hostname || url.hash) {
        throw new RemoteNotAllowedError('仓库地址格式不正确');
    }
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (!policy.allowPrivateNetworks && (net.isIP(literal) ? isBlockedAddress(literal) : /(^|\.)(localhost|local|internal|lan|home|arpa)$/i.test(literal))) {
        throw new RemoteNotAllowedError('不能连接内网或本机地址');
    }
    url.search = '';
    return url.toString().replace(/\/$/, '');
}

/**
 * A `lookup` that refuses private addresses, used for every outgoing socket.
 * @param {boolean} allowPrivateNetworks
 */
function guardedLookup(allowPrivateNetworks) {
    return (hostname, options, callback) => {
        dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
            if (error) return callback(error);
            const list = /** @type {dns.LookupAddress[]} */ (addresses);
            const usable = allowPrivateNetworks ? list : list.filter(entry => !isBlockedAddress(entry.address));
            if (!usable.length) {
                return callback(new RemoteNotAllowedError('该仓库地址指向内网或本机，已拒绝连接'));
            }
            if (options?.all) return callback(null, usable);
            return callback(null, usable[0].address, usable[0].family);
        });
    };
}

/** Joins an async iterable of chunks (isomorphic-git request bodies) into one Buffer. */
async function collect(body) {
    if (!body) return undefined;
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

/**
 * Creates the `http` plugin passed to isomorphic-git.
 * @param {{ allowPrivateNetworks?: boolean, allowHttp?: boolean, timeoutMs?: number, maxResponseBytes?: number, signal?: AbortSignal }} [options]
 */
export function createGuardedHttp(options = {}) {
    const { allowPrivateNetworks = false, allowHttp = false, timeoutMs = 120_000, maxResponseBytes = 2 * 1024 ** 3, signal } = options;
    const lookup = guardedLookup(allowPrivateNetworks);

    /**
     * @param {{ url: string, method?: string, headers?: Record<string, string>, body?: AsyncIterable<Uint8Array> }} request
     */
    async function request({ url, method = 'GET', headers = {}, body }) {
        const payload = await collect(body);
        let target = new URL(normalizeRemoteUrl(url, { allowPrivateNetworks, allowHttp }) + new URL(url).search);
        const origin = target.origin;
        for (let redirects = 0; ; redirects++) {
            const response = await send(target, method, headers, payload);
            const location = response.headers.location;
            if (response.statusCode >= 300 && response.statusCode < 400 && location && redirects < MAX_REDIRECTS) {
                response.resume();
                const next = new URL(location, target);
                normalizeRemoteUrl(next.toString(), { allowPrivateNetworks, allowHttp });
                // Credentials only follow redirects that stay on the same origin.
                if (next.origin !== origin) {
                    headers = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'authorization'));
                }
                target = next;
                continue;
            }
            return {
                url: target.toString(),
                method,
                statusCode: response.statusCode,
                statusMessage: response.statusMessage,
                headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)])),
                body: bounded(response, maxResponseBytes),
            };
        }
    }

    function send(target, method, headers, payload) {
        return new Promise((resolve, reject) => {
            const client = target.protocol === 'https:' ? https : http;
            const req = client.request(target, {
                method,
                headers: { ...headers, ...(payload ? { 'content-length': String(payload.length) } : {}) },
                lookup,
                timeout: timeoutMs,
                signal,
            }, resolve);
            req.on('timeout', () => req.destroy(new Error('连接仓库超时')));
            req.on('error', reject);
            req.end(payload);
        });
    }

    async function* bounded(stream, limit) {
        let total = 0;
        for await (const chunk of stream) {
            total += chunk.length;
            if (total > limit) {
                stream.destroy();
                throw new Error('仓库返回的数据超过大小限制');
            }
            yield chunk;
        }
    }

    return { request };
}
