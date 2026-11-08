import crypto from 'node:crypto';

import fetch from 'node-fetch';

/**
 * Relays (中转站): what a key has spent, read from the relay itself. The common relay projects
 * answer with the same key the user chats with:
 *   new-api (and one-api, one-hub and other forks)  /v1/dashboard/billing/usage (unit from /api/status)
 *   sub2api                                         /v1/usage
 *   gpt-load (v2)                                   /v1/user/balance
 *   LiteLLM                                         /key/info
 *   OpenRouter                                      /api/v1/key
 * gcli2api and CLIProxyAPI pass free or subscription quota along and have nothing to report; they
 * are only recognised. A relay that changed these interfaces is simply not recognised.
 *
 * The usage meter reads the amount spent after generations: the difference is what they cost.
 */

const PROBE_TIMEOUT_MS = 6000;
const MAX_BODY_BYTES = 256 * 1024;
const DETECT_TTL_MS = 12 * 3600e3;
const UNKNOWN_TTL_MS = 3 * 3600e3;
/** Not recognised without a key to ask with: soon ask again, someone else may have one. */
const KEYLESS_TTL_MS = 5 * 60e3;
/** Reads per relay (all users together) in a 3-minute window: relays rate-limit by IP. */
const READS_PER_WINDOW = 40;
const READ_WINDOW_MS = 3 * 60e3;

export const RELAY_LABELS = Object.freeze({
    'new-api': 'new-api / one-api',
    sub2api: 'sub2api',
    'gpt-load': 'gpt-load',
    litellm: 'LiteLLM',
    openrouter: 'OpenRouter',
    gcli2api: 'gcli2api',
    cliproxyapi: 'CLIProxyAPI',
});
/** Free or subscription pass-through: no money to report. */
export const FREE_RELAYS = new Set(['gcli2api', 'cliproxyapi']);

/**
 * @typedef {{ base: string, root: string, host: string, address: string, key: string, id: string }} Relay
 * @typedef {{ kind: string|null, at: number, meta?: any, keyless?: boolean }} Detection
 * @typedef {{ usedUsd: number, remainingUsd: number|null }} Spend
 */

/**
 * The relay a generation goes to: the custom endpoint, or a reverse proxy.
 * @param {string} base Address as configured (usually ending in /v1)
 * @param {string} key
 * @returns {Relay|null}
 */
export function describeRelay(base, key) {
    let url;
    try {
        url = new URL(String(base ?? '').trim());
    } catch {
        return null;
    }
    if (!/^https?:$/.test(url.protocol)) return null;
    const path = url.pathname.replace(/\/+$/, '');
    // Where the relay's own endpoints live: the address without its /v1 (or /v1beta) ending.
    const root = `${url.origin}${path.replace(/\/v1(beta)?$/, '')}`;
    const keyHash = key ? crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 10) : 'nokey';
    const address = `${url.host}${path}`.toLowerCase();
    return { base: `${url.origin}${path}`, root, host: url.host, address, key: String(key ?? ''), id: `${address}#${keyHash}` };
}

/**
 * GET a small JSON answer; null on anything unexpected (no redirects: the key stays with the relay).
 * @param {string} url
 * @param {string} [key]
 */
async function getJson(url, key) {
    try {
        const response = await fetch(url, {
            headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
            redirect: 'manual',
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!response.ok || !response.body) return null;
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) return null;
            chunks.push(chunk);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return value && typeof value === 'object' ? value : null;
    } catch {
        return null;
    }
}

const number = value => (value === null || value === undefined || value === '' ? NaN : Number(value));

/** How each kind reports the amount spent (US dollars, all-time for this key). */
const READERS = {
    /** @returns {Promise<Spend|null>} */
    async 'new-api'(relay, meta) {
        // The OpenAI billing endpoint, in the unit the site displays. (/api/usage/token/ would give
        // the key's own quota, but is limited to a few calls per IP, and all our users share one IP.)
        const usage = await getJson(`${relay.root}/v1/dashboard/billing/usage`, relay.key);
        const shown = number(usage?.total_usage) / 100;
        if (!Number.isFinite(shown)) return null;
        const type = String(meta?.displayType ?? 'USD').toUpperCase();
        const perUnit = Number(meta?.quotaPerUnit) || 500000;
        const usedUsd = type === 'CNY' ? shown / (Number(meta?.rate) || 7.2) : type === 'TOKENS' ? shown / perUnit : shown;
        return { usedUsd, remainingUsd: null };
    },
    async sub2api(relay) {
        const usage = await getJson(`${relay.root}/v1/usage`, relay.key);
        const total = usage?.usage?.total;
        const used = number(total?.actual_cost ?? total?.cost);
        if (!Number.isFinite(used)) return null;
        const remaining = number(usage.remaining ?? usage.quota?.remaining);
        return { usedUsd: used, remainingUsd: Number.isFinite(remaining) ? remaining : null };
    },
    async 'gpt-load'(relay) {
        const usage = await getJson(`${relay.root}/v1/user/balance`, relay.key);
        const used = number(usage?.used);
        if (!Number.isFinite(used)) return null;
        return { usedUsd: used, remainingUsd: number(usage.total) > 0 && Number.isFinite(number(usage.balance)) ? number(usage.balance) : null };
    },
    async litellm(relay) {
        const usage = await getJson(`${relay.root}/key/info`, relay.key);
        const used = number(usage?.info?.spend);
        if (!Number.isFinite(used)) return null;
        const budget = number(usage.info.max_budget);
        return { usedUsd: used, remainingUsd: Number.isFinite(budget) ? Math.max(0, budget - used) : null };
    },
    async openrouter(relay) {
        const usage = await getJson(`${relay.root}/v1/key`, relay.key);
        const used = number(usage?.data?.usage);
        if (!Number.isFinite(used)) return null;
        const remaining = number(usage.data.limit_remaining);
        return { usedUsd: used, remainingUsd: Number.isFinite(remaining) ? remaining : null };
    },
};

/**
 * Works out which project a relay runs (the public status pages first, then with the key).
 * @param {Relay} relay
 * @returns {Promise<Detection>}
 */
async function probe(relay) {
    const at = Date.now();
    const status = await getJson(`${relay.root}/api/status`);
    if (status?.success && Number(status.data?.quota_per_unit) > 0) {
        const data = status.data;
        return {
            kind: 'new-api', at,
            meta: {
                quotaPerUnit: Number(data.quota_per_unit),
                displayType: data.quota_display_type ?? (data.display_in_currency === false ? 'TOKENS' : 'USD'),
                rate: Number(data.usd_exchange_rate) || null,
                name: typeof data.system_name === 'string' ? data.system_name.slice(0, 60) : '',
            },
        };
    }
    if (relay.key) {
        for (const kind of ['sub2api', 'gpt-load', 'litellm', 'openrouter']) {
            if (await READERS[kind](relay)) return { kind, at };
        }
    }
    const home = await getJson(`${relay.root}/`);
    if (typeof home?.message === 'string' && home.message.includes('CLI Proxy API')) return { kind: 'cliproxyapi', at };
    const version = await getJson(`${relay.root}/version/info`);
    if (version?.success === true && typeof version.full_hash === 'string' && 'date' in version) return { kind: 'gcli2api', at };
    return { kind: null, at, keyless: !relay.key };
}

/** @type {Map<string, Detection>} By relay root: what it runs does not depend on whose key asks */
const detections = new Map();
/** @type {Map<string, Promise<Detection>>} */
const probing = new Map();
/** @type {Map<string, number[]>} Recent reads per relay root */
const reads = new Map();

/**
 * Which project the relay runs, from memory if known (probes at most every few hours).
 * @param {Relay} relay
 * @returns {Promise<Detection>}
 */
export function detectRelay(relay) {
    const known = detections.get(relay.root);
    if (known && Date.now() - known.at < (known.kind ? DETECT_TTL_MS : known.keyless ? KEYLESS_TTL_MS : UNKNOWN_TTL_MS)) return Promise.resolve(known);
    if (!probing.has(relay.root)) {
        probing.set(relay.root, probe(relay).then(found => {
            detections.set(relay.root, found);
            return found;
        }).finally(() => probing.delete(relay.root)));
    }
    return /** @type {Promise<Detection>} */ (probing.get(relay.root));
}

/**
 * @param {Relay} relay
 * @returns {Detection|null} What is known without asking
 */
export function knownRelay(relay) {
    return detections.get(relay.root) ?? null;
}

/** Whether another read of this relay fits in its window (all users together). */
function mayRead(relay) {
    const now = Date.now();
    const recent = (reads.get(relay.root) ?? []).filter(at => now - at < READ_WINDOW_MS);
    if (recent.length >= READS_PER_WINDOW) {
        reads.set(relay.root, recent);
        return false;
    }
    recent.push(now);
    reads.set(relay.root, recent);
    return true;
}

/**
 * What the key has spent so far, in US dollars; null when the relay cannot tell (or not now).
 * @param {Relay} relay
 * @returns {Promise<Spend|null>}
 */
export async function readRelaySpend(relay) {
    const found = await detectRelay(relay);
    const reader = found.kind ? READERS[found.kind] : null;
    if (!reader || !mayRead(relay)) return null;
    return reader(relay, found.meta);
}

/** For tests: forget what was learned. */
export function resetRelayBilling() {
    detections.clear();
    probing.clear();
    reads.clear();
}
