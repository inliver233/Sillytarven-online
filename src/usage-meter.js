import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import express from 'express';
import fetch from 'node-fetch';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { readSecret, SECRET_KEYS } from './endpoints/secrets.js';
import { canPersistSharedState, onActivate } from './process-lifecycle.js';
import { describeRelay, detectRelay, FREE_RELAYS, knownRelay, readRelaySpend, RELAY_LABELS } from './relay-billing.js';
import { getLocalDateKey } from './storage-quota.js';

/**
 * Usage meter: reads the tokens each AI service reports in its answer (streamed or not) and adds
 * them to the user's daily totals. Nothing is estimated: what the service reports is what it bills,
 * whatever the model is called. Money, all kept in US dollars:
 * - official services: their published prices, from models.dev's list (fetched once a day);
 * - relays (custom endpoint or reverse proxy), the first that applies:
 *   1. what the relay itself says the key spent (relay-billing.js: new-api, sub2api, gpt-load, ...),
 *      read after generations; the difference is shared out among them;
 *   2. the user's own price for that relay (free, per call, per million tokens, or official × ratio);
 *   3. the prices models.dev lists for that address (OpenCode Zen, DeepSeek, OpenRouter, ...);
 *   otherwise only the tokens.
 *
 * Off unless the user turns it on (the page then sends X-Usage-Meter: on with generations). Off, only
 * the tokens (and local prices) are recorded: no relay is asked anything, no request is changed.
 *
 * Per user, <data>/_usage/<handle>.json:
 *   { days: { 'YYYY-MM-DD': Totals & { models } }, recent: Entry[], relays: { [relay id]: last reading },
 *     settings: { rate, pricing: { [relay address]: Pricing } } }
 * The page sends an X-Usage-Id header with each generation and reads its entry back afterwards.
 */

const PRICES_URL = 'https://models.dev/api.json';
const PRICES_MAX_AGE_MS = 24 * 3600e3;
const KEEP_DAYS = 60;
const KEEP_RECENT = 40;
/** Larger answers without line breaks are not searched for usage. */
const MAX_PENDING_CHARS = 16 * 1024 * 1024;

/** Sources billed by the token at published prices → their providers on models.dev. */
const OFFICIAL_PROVIDERS = Object.freeze({
    vertexai: ['google-vertex', 'google'],
    makersuite: ['google'],
    openai: ['openai'],
    claude: ['anthropic'],
    deepseek: ['deepseek'],
    openrouter: ['openrouter'],
    xai: ['xai'],
    mistralai: ['mistral'],
    moonshot: ['moonshotai'],
    zai: ['zai'],
    groq: ['groq'],
});
/** Sources that cost the user nothing. */
const FREE_SOURCES = new Set(['free-gemini']);

/**
 * @typedef {{ input: number, cached: number, cacheWrite: number, output: number, reasoning: number, reportedCost?: number }} Usage
 * @typedef {{ requests: number, reported: number, input: number, cached: number, output: number, reasoning: number, cost: number, priced: number }} Totals
 * @typedef {{ id: string, at: number, source: string, model: string, input: number, cached: number, output: number, reasoning: number, cost: number|null, priced: string|null, provider?: string, relay?: { address: string, kind: string|null }, pending?: boolean }} Entry
 * @typedef {{ mode: 'free'|'call'|'token'|'ratio', currency?: 'USD'|'CNY', value?: number, input?: number, output?: number, ratio?: number }} Pricing
 */

const finite = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Picks the usage out of an answer as it streams by (SSE lines or a JSON body). */
export class UsageReader {
    constructor() {
        this.decoder = new StringDecoder('utf8');
        this.pending = '';
        /** @type {{ gemini?: any, openai?: any, claude?: any }} */
        this.found = {};
    }

    /** @param {Buffer|string} chunk */
    feed(chunk) {
        this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
        let start = 0;
        let end;
        while ((end = this.pending.indexOf('\n', start)) >= 0) {
            this.line(this.pending.slice(start, end));
            start = end + 1;
        }
        this.pending = this.pending.slice(start);
        if (this.pending.length > MAX_PENDING_CHARS) this.pending = '';
    }

    end() {
        this.pending += this.decoder.end();
        if (this.pending) this.line(this.pending);
        this.pending = '';
    }

    /** @param {string} line */
    line(line) {
        if (!line.includes('sage')) return; // usage / usageMetadata
        const text = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
        if (!text.startsWith('{') && !text.startsWith('[')) return;
        try {
            this.observe(JSON.parse(text));
        } catch {
            // Not a whole JSON line (or not JSON): nothing to read.
        }
    }

    /** @param {any} value An answer, or one event of a streamed answer */
    observe(value) {
        if (Array.isArray(value)) {
            value.forEach(item => this.observe(item));
            return;
        }
        if (!value || typeof value !== 'object') return;
        // Gemini / Vertex AI: every chunk carries the totals so far.
        const meta = value.usageMetadata ?? value.response?.usageMetadata;
        if (meta && typeof meta === 'object') this.found.gemini = meta;
        // Claude: input with message_start, output with message_delta (or all at once).
        if (value.type === 'message_start' && value.message?.usage) this.found.claude = { ...this.found.claude, ...value.message.usage };
        const usage = value.usage;
        if (usage && typeof usage === 'object') {
            if ('prompt_tokens' in usage || 'completion_tokens' in usage) this.found.openai = usage;
            else if ('input_tokens' in usage || 'output_tokens' in usage) this.found.claude = { ...this.found.claude, ...usage };
        }
    }

    /** @returns {Usage|null} */
    result() {
        const { gemini, openai, claude } = this.found;
        if (gemini) {
            const thoughts = finite(gemini.thoughtsTokenCount);
            return {
                input: finite(gemini.promptTokenCount) + finite(gemini.toolUsePromptTokenCount),
                cached: finite(gemini.cachedContentTokenCount),
                cacheWrite: 0,
                output: finite(gemini.candidatesTokenCount) + thoughts,
                reasoning: thoughts,
            };
        }
        if (openai) {
            return {
                input: finite(openai.prompt_tokens),
                cached: finite(openai.prompt_tokens_details?.cached_tokens) || finite(openai.prompt_cache_hit_tokens),
                cacheWrite: 0,
                output: finite(openai.completion_tokens),
                reasoning: finite(openai.completion_tokens_details?.reasoning_tokens),
                ...(Number.isFinite(openai.cost) ? { reportedCost: openai.cost } : {}),
            };
        }
        if (claude) {
            const read = finite(claude.cache_read_input_tokens);
            const write = finite(claude.cache_creation_input_tokens);
            return { input: finite(claude.input_tokens) + read + write, cached: read, cacheWrite: write, output: finite(claude.output_tokens), reasoning: 0 };
        }
        return null;
    }
}

// ---------------------------------------------------------------------------
// Prices (models.dev)
// ---------------------------------------------------------------------------

/** For "official price × ratio": the providers whose model names relays copy, best first. */
const OFFICIAL_ORDER = Object.freeze(['google', 'openai', 'anthropic', 'deepseek', 'xai', 'mistral', 'moonshotai', 'zai']);

/**
 * @type {{ fetchedAt: number, providers: Record<string, Record<string, any>>, catalog: { provider: string, name: string, base: string }[] }|null}
 */
let prices = null;
let refreshing = null;

const pricesFile = () => path.join(globalThis.DATA_ROOT, '_global', 'model-prices.json');

function loadPrices() {
    try {
        const stored = JSON.parse(fs.readFileSync(pricesFile(), 'utf8'));
        if (stored?.providers && typeof stored.providers === 'object') prices = { catalog: [], ...stored };
    } catch {
        // Not fetched yet.
    }
}

/** A relay address as "host/path" for comparing with the addresses models.dev lists. */
const addressKey = url => {
    try {
        const parsed = new URL(url);
        return `${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
        return '';
    }
};

/** Fetches models.dev: the prices of the official providers and of every service with an address. */
export async function refreshPrices() {
    refreshing ??= (async () => {
        try {
            const response = await fetch(PRICES_URL, { signal: AbortSignal.timeout(60e3) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = /** @type {any} */ (await response.json());
            const official = new Set([...Object.values(OFFICIAL_PROVIDERS).flat(), ...OFFICIAL_ORDER]);
            /** @type {Record<string, Record<string, any>>} */
            const providers = {};
            const catalog = [];
            for (const [id, provider] of Object.entries(data ?? {})) {
                const base = addressKey(provider?.api ?? '');
                const host = base.split('/')[0];
                const listed = Boolean(base) && !/^(localhost|127\.|0\.0\.0\.0|\[)/.test(host);
                if (!official.has(id) && !listed) continue;
                const models = {};
                for (const [model, info] of Object.entries(provider?.models ?? {})) {
                    const cost = /** @type {any} */ (info)?.cost;
                    if (!Number.isFinite(cost?.input) || !Number.isFinite(cost?.output)) continue;
                    models[model] = {
                        input: cost.input, output: cost.output,
                        ...(Number.isFinite(cost.cache_read) ? { cache_read: cost.cache_read } : {}),
                        ...(Number.isFinite(cost.cache_write) ? { cache_write: cost.cache_write } : {}),
                        ...(Array.isArray(cost.tiers) ? { tiers: cost.tiers } : {}),
                        ...(cost.context_over_200k ? { context_over_200k: cost.context_over_200k } : {}),
                    };
                }
                providers[id] = models;
                if (listed) catalog.push({ provider: id, name: String(provider.name ?? id).slice(0, 60), base });
            }
            prices = { fetchedAt: Date.now(), providers, catalog };
            fs.mkdirSync(path.dirname(pricesFile()), { recursive: true });
            writeFileAtomicSync(pricesFile(), JSON.stringify(prices), 'utf8');
            console.info(`[usage] Prices updated from models.dev (${Object.keys(providers).length} services, ${catalog.length} with an address)`);
        } catch (error) {
            console.warn('[usage] Could not update prices from models.dev:', error?.message ?? error);
        } finally {
            refreshing = null;
        }
    })();
    return refreshing;
}

/**
 * The price per million tokens of a model on an official service, or null when not known.
 * @param {string} source
 * @param {string} model
 * @param {any} body The generation request
 * @returns {{ provider: string, cost: any }|null}
 */
export function findPrice(source, model, body = {}) {
    const providers = OFFICIAL_PROVIDERS[source];
    if (!providers || !prices || !model) return null;
    // Through a reverse proxy: a relay, with its own prices.
    if (body.reverse_proxy) return null;
    const id = String(model).replace(/^models\//, '');
    for (const provider of providers) {
        const cost = prices.providers[provider]?.[id];
        if (cost) return { provider, cost };
    }
    return null;
}

/** Words relays put around model names (抗截断-pg-gemini-…), without telling anything about the model. */
const DECORATION = /^(?:抗截断|假流式|流式保活|流式|保活|满血|官逆|公益|捐赠|反代|pggo|pg|build|agy|antigravity|aistudio|ai-studio|vertex|gcli|cli)(?:[-_ .:]+|(?=[一-鿿])|(?=gemini|claude|gpt|o\d|deepseek|glm|kimi|grok|qwen|mistral))/i;
const SUFFIX = /[-_](?:high|low|medium|minimal|max|ci|search|online|thinking|nothinking|no-thinking|fc|latest|free)$/i;

/**
 * Candidate official names for a relay's model name, most specific first:
 * "【次哈-0.11】 抗截断-pg-gemini-4-argon-high" → gemini-4-argon-high, gemini-4-argon.
 * @param {string} name
 * @returns {string[]}
 */
export function officialNames(name) {
    let text = String(name ?? '').trim().toLowerCase();
    text = text.replace(/[[【(（{<][^\]】)）}>]*[\]】)）}>]/g, ' ').trim();
    text = text.replace(/\/(?:fc|search|thinking)$/, '');
    text = text.split('/').map(part => part.trim()).filter(Boolean).pop() ?? '';
    for (let i = 0; i < 6; i++) {
        const next = text.replace(DECORATION, '').trim();
        if (next === text) break;
        text = next;
    }
    const names = [];
    for (let i = 0; i < 5 && text; i++) {
        names.push(text);
        const next = text.replace(SUFFIX, '');
        if (next === text) break;
        text = next;
    }
    return names;
}

/**
 * The official price of a relay's model, by its name without the relay's decorations.
 * @param {string} model
 * @returns {{ provider: string, cost: any, model: string }|null}
 */
export function officialPrice(model) {
    if (!prices) return null;
    for (const name of officialNames(model)) {
        for (const provider of OFFICIAL_ORDER) {
            const cost = prices.providers[provider]?.[name];
            if (cost) return { provider, cost, model: name };
        }
    }
    return null;
}

/**
 * The prices models.dev lists for a relay's address (OpenCode Zen, DeepSeek, OpenRouter, ...).
 * @param {string} base The relay address
 * @param {string} model
 * @returns {{ provider: string, name: string, cost: any }|null}
 */
export function catalogPrice(base, model) {
    if (!prices?.catalog?.length) return null;
    const key = addressKey(base);
    const listed = prices.catalog
        .filter(item => key === item.base || key.startsWith(`${item.base}/`) || item.base.startsWith(`${key}/`))
        .sort((a, b) => b.base.length - a.base.length)[0];
    if (!listed) return null;
    const models = prices.providers[listed.provider] ?? {};
    const cost = models[model] ?? officialNames(model).map(name => models[name]).find(Boolean);
    return cost ? { provider: listed.provider, name: listed.name, cost } : null;
}

/**
 * @param {any} cost Prices per million tokens (models.dev)
 * @param {Usage} usage
 * @returns {number} US dollars
 */
export function priceUsage(cost, usage) {
    let rates = cost;
    const tier = (Array.isArray(cost.tiers) ? cost.tiers : [])
        .filter(item => item?.tier?.type === 'context' && usage.input > Number(item.tier.size))
        .sort((a, b) => b.tier.size - a.tier.size)[0];
    if (tier) rates = { ...cost, ...tier };
    else if (cost.context_over_200k && usage.input > 200_000) rates = { ...cost, ...cost.context_over_200k };
    const plain = Math.max(0, usage.input - usage.cached - usage.cacheWrite);
    return (plain * rates.input
        + usage.cached * (rates.cache_read ?? rates.input)
        + usage.cacheWrite * (rates.cache_write ?? rates.input)
        + usage.output * rates.output) / 1e6;
}

/**
 * The user's own price for a relay.
 * @param {Pricing} pricing
 * @param {string} model
 * @param {Usage} usage
 * @param {number} rate Yuan per dollar
 * @returns {{ cost: number, provider?: string }|null} US dollars
 */
export function applyPricing(pricing, model, usage, rate) {
    const toUsd = value => (pricing.currency === 'CNY' ? value / rate : value);
    switch (pricing.mode) {
        case 'free': return { cost: 0 };
        case 'call': return { cost: toUsd(finite(pricing.value)) };
        case 'token': return { cost: toUsd((usage.input * finite(pricing.input) + usage.output * finite(pricing.output)) / 1e6) };
        case 'ratio': {
            const official = officialPrice(model);
            return official ? { cost: priceUsage(official.cost, usage) * finite(pricing.ratio), provider: official.provider } : null;
        }
        default: return null;
    }
}

/**
 * @param {any} value
 * @returns {Pricing|null}
 */
export function sanitizePricing(value) {
    if (!value || typeof value !== 'object') return null;
    const positive = item => Math.max(0, Math.min(1e6, Number(item) || 0));
    const currency = value.currency === 'CNY' ? 'CNY' : 'USD';
    switch (value.mode) {
        case 'free': return { mode: 'free' };
        case 'call': return { mode: 'call', currency, value: positive(value.value) };
        case 'token': return { mode: 'token', currency, input: positive(value.input), output: positive(value.output) };
        case 'ratio': return { mode: 'ratio', ratio: Math.max(0, Math.min(100, Number(value.ratio) || 0)) };
        default: return null;
    }
}

/**
 * What a relay's model names say about its price: "[公益]…" is free, "[0.06/次]" or "次哈-0.11" per call.
 * Only a suggestion for the user, never applied by itself.
 * @param {string[]} models
 * @returns {Pricing|null}
 */
export function pricingHint(models) {
    for (const model of models) {
        const name = String(model ?? '');
        const perCall = name.match(/(\d+(?:\.\d+)?)\s*(?:元|¥|￥)?\s*\/\s*次/) ?? name.match(/次[^\d\s/]{0,4}[-:：]?\s*(\d+(?:\.\d+)?)/);
        if (perCall) return { mode: 'call', currency: 'CNY', value: Number(perCall[1]) };
        if (/公益|免费|free/i.test(name)) return { mode: 'free' };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Totals per user
// ---------------------------------------------------------------------------

const DEFAULT_RATE = 7.2;

/** @type {Map<string, Promise<void>>} */
const writing = new Map();

const usageFile = handle => path.join(globalThis.DATA_ROOT, '_usage', `${handle}.json`);

/** @param {string} handle */
export function readUsage(handle) {
    let stored = null;
    try {
        stored = JSON.parse(fs.readFileSync(usageFile(handle), 'utf8'));
    } catch {
        // Nothing recorded yet.
    }
    const settings = stored?.settings && typeof stored.settings === 'object' ? stored.settings : {};
    return {
        days: stored?.days && typeof stored.days === 'object' ? stored.days : {},
        recent: Array.isArray(stored?.recent) ? stored.recent : [],
        relays: stored?.relays && typeof stored.relays === 'object' ? stored.relays : {},
        settings: {
            rate: Number(settings.rate) > 0 ? Number(settings.rate) : DEFAULT_RATE,
            pricing: settings.pricing && typeof settings.pricing === 'object' ? settings.pricing : {},
        },
    };
}

/**
 * Changes the user's file, one change at a time (the file is read again each time, so a process
 * handing over to another one does not lose the other's additions).
 * @param {string} handle
 * @param {(data: ReturnType<typeof readUsage>) => void} change
 */
function updateUsage(handle, change) {
    const previous = writing.get(handle) ?? Promise.resolve();
    const next = previous.then(() => {
        const data = readUsage(handle);
        change(data);
        fs.mkdirSync(path.dirname(usageFile(handle)), { recursive: true });
        writeFileAtomicSync(usageFile(handle), JSON.stringify(data), 'utf8');
    }).catch(error => console.warn('[usage] Could not update the usage of', handle, error?.message ?? error));
    writing.set(handle, next);
    void next.then(() => {
        if (writing.get(handle) === next) writing.delete(handle);
    });
    return next;
}

/** @returns {Totals} */
const emptyTotals = () => ({ requests: 0, reported: 0, input: 0, cached: 0, output: 0, reasoning: 0, cost: 0, priced: 0 });

/**
 * @param {Totals} totals
 * @param {Entry} entry
 * @param {boolean} reported
 */
function add(totals, entry, reported) {
    totals.requests++;
    if (!reported) return;
    totals.reported++;
    totals.input += entry.input;
    totals.cached += entry.cached;
    totals.output += entry.output;
    totals.reasoning += entry.reasoning;
    if (entry.cost !== null) {
        totals.cost += entry.cost;
        totals.priced++;
    }
}

/**
 * Adds one generation to the user's totals.
 * @param {string} handle
 * @param {Entry} entry
 * @param {boolean} reported Whether the service reported its usage
 */
export function recordUsage(handle, entry, reported) {
    return updateUsage(handle, data => {
        const day = getLocalDateKey(new Date(entry.at));
        const today = data.days[day] ??= { ...emptyTotals(), models: {} };
        add(today, entry, reported);
        add(today.models[`${entry.source}|${entry.model}`] ??= emptyTotals(), entry, reported);
        const oldest = getLocalDateKey(new Date(entry.at - KEEP_DAYS * 86400e3));
        for (const date of Object.keys(data.days)) {
            if (date < oldest) delete data.days[date];
        }
        data.recent = [...data.recent.filter(item => item.id !== entry.id), entry].slice(-KEEP_RECENT);
    });
}

/**
 * Prices generations recorded earlier (relay spending, known only after reading the relay).
 * @param {ReturnType<typeof readUsage>} data
 * @param {Map<string, number|null>} costs Entry id → US dollars (null: could not tell)
 */
function settleEntries(data, costs) {
    for (const entry of data.recent) {
        if (!costs.has(entry.id) || !entry.pending) continue;
        const cost = costs.get(entry.id);
        entry.pending = false;
        if (cost === null || cost === undefined) continue;
        entry.cost = cost;
        entry.priced = 'relay';
        const day = data.days[getLocalDateKey(new Date(entry.at))];
        for (const totals of [day, day?.models?.[`${entry.source}|${entry.model}`]]) {
            if (!totals) continue;
            totals.cost += cost;
            totals.priced++;
        }
    }
}

// ---------------------------------------------------------------------------
// Relays that report what a key spent
// ---------------------------------------------------------------------------

/** Between two reads of one relay key: lets several quick generations settle together. */
const SETTLE_INTERVAL_MS = 15e3;
/** A first wait after a generation, so the relay has booked it. */
const SETTLE_DELAY_MS = 1500;
/** An older reading is taken again before a generation (other apps may have used the key since). */
const BASELINE_MAX_AGE_MS = 30 * 60e3;
const SETTLE_TRIES = 3;

/** @type {Map<string, { pending: { id: string, weight: number }[], timer: NodeJS.Timeout|null, lastReadAt: number, tries: number }>} */
const settling = new Map();

/**
 * The relay of a generation (custom endpoint or reverse proxy), or null for an official service.
 * @param {import('express').Request} request
 */
function relayOf(request) {
    const body = request.body ?? {};
    try {
        if (body.chat_completion_source === 'custom' && body.custom_url) {
            return describeRelay(body.custom_url, readSecret(request.user.directories, SECRET_KEYS.CUSTOM, body.secret_id) ?? '');
        }
        if (body.reverse_proxy) return describeRelay(body.reverse_proxy, body.proxy_password ?? '');
    } catch (error) {
        // Metering never gets in the way of the generation itself.
        console.warn('[usage] Could not tell the relay of a generation:', error?.message ?? error);
    }
    return null;
}

const billed = kind => Boolean(kind) && !FREE_RELAYS.has(kind);

/** Relay projects that answer stream_options.include_usage with the tokens in the last chunk. */
const STREAM_USAGE_RELAYS = new Set(['new-api', 'sub2api', 'gpt-load', 'litellm']);

/**
 * Whether the user turned the usage meter on (sent by the page with each generation).
 * @param {import('express').Request} request
 */
export function usageMeterOn(request) {
    return String(request.get?.('x-usage-meter') ?? '') === 'on';
}

/**
 * Whether to ask a custom endpoint for the tokens in its streamed answer: only relays recognised
 * as projects that support it, and only for users who turned the meter on.
 * @param {import('express').Request} request
 */
export function relayStreamsUsage(request) {
    if (!usageMeterOn(request) || !request.body?.custom_url) return false;
    const relay = describeRelay(request.body.custom_url, '');
    return Boolean(relay) && STREAM_USAGE_RELAYS.has(knownRelay(/** @type {any} */ (relay))?.kind ?? '');
}

/**
 * Takes a reading of what the key has spent, to compare with after later generations (not while
 * earlier generations still wait for theirs).
 * @param {string} handle
 * @param {import('./relay-billing.js').Relay} relay
 * @param {string} kind
 */
async function takeReading(handle, relay, kind) {
    if (settling.get(`${handle}|${relay.id}`)?.pending.length) return;
    const spend = await readRelaySpend(relay);
    if (!spend || settling.get(`${handle}|${relay.id}`)?.pending.length) return;
    await updateUsage(handle, data => {
        data.relays[relay.id] = { address: relay.address, kind, used: spend.usedUsd, remaining: spend.remainingUsd, at: Date.now() };
    });
}

/**
 * Before a generation through a relay already known to report spending: an old reading is taken
 * again (the key may have been used elsewhere since). Unknown relays are not asked anything here.
 * @param {string} handle
 * @param {import('./relay-billing.js').Relay} relay
 */
async function prepareRelay(handle, relay) {
    const kind = knownRelay(relay)?.kind;
    if (!billed(kind)) return;
    const last = readUsage(handle).relays[relay.id];
    if (last && Date.now() - last.at < BASELINE_MAX_AGE_MS) return;
    await takeReading(handle, relay, /** @type {string} */ (kind));
}

/**
 * After a generation through such a relay: read what the key has spent since the last reading and
 * share it out among the generations that waited for it (by tokens).
 * @param {string} handle
 * @param {import('./relay-billing.js').Relay} relay
 * @param {string} id
 * @param {number} weight
 */
function settleRelay(handle, relay, id, weight) {
    const key = `${handle}|${relay.id}`;
    const state = settling.get(key) ?? { pending: [], timer: null, lastReadAt: 0, tries: 0 };
    settling.set(key, state);
    state.pending.push({ id, weight });
    if (state.timer) return;
    const wait = Math.max(SETTLE_DELAY_MS, SETTLE_INTERVAL_MS - (Date.now() - state.lastReadAt));
    state.timer = setTimeout(() => void readAndShare(handle, relay, key), wait);
    state.timer.unref?.();
}

async function readAndShare(handle, relay, key) {
    const state = settling.get(key);
    if (!state) return;
    state.timer = null;
    state.lastReadAt = Date.now();
    const spend = await readRelaySpend(relay).catch(() => null);
    if (!spend && ++state.tries < SETTLE_TRIES) {
        // Not now (rate window, network): try again a little later.
        state.timer = setTimeout(() => void readAndShare(handle, relay, key), SETTLE_INTERVAL_MS * state.tries);
        state.timer.unref?.();
        return;
    }
    const batch = state.pending.splice(0);
    state.tries = 0;
    const kind = knownRelay(relay)?.kind ?? null;
    await updateUsage(handle, data => {
        const last = data.relays[relay.id];
        // Generations still waiting from before a restart: their spending is in this reading too.
        const waiting = new Set(batch.map(item => item.id));
        for (const entry of data.recent) {
            if (entry.pending && entry.relay?.address === relay.address && !waiting.has(entry.id) && Date.now() - entry.at > 60e3) {
                batch.push({ id: entry.id, weight: Math.max(1, entry.input + entry.output) });
            }
        }
        /** @type {Map<string, number|null>} */
        const costs = new Map(batch.map(item => [item.id, null]));
        if (spend && last && spend.usedUsd >= last.used) {
            const spent = spend.usedUsd - last.used;
            const total = batch.reduce((sum, item) => sum + item.weight, 0);
            for (const item of batch) costs.set(item.id, total > 0 ? spent * (item.weight / total) : spent / batch.length);
        }
        settleEntries(data, costs);
        if (spend) data.relays[relay.id] = { address: relay.address, kind, used: spend.usedUsd, remaining: spend.remainingUsd, at: Date.now() };
    });
    if (state.pending.length) {
        state.timer = setTimeout(() => void readAndShare(handle, relay, key), SETTLE_INTERVAL_MS);
        state.timer.unref?.();
    } else {
        settling.delete(key);
    }
}

// ---------------------------------------------------------------------------
// Metering a generation
// ---------------------------------------------------------------------------

/**
 * Meters one generation: reads the usage from the answer (forwardFetchResponse feeds streamed
 * answers in; answers sent at once are read here) and records it when the response is over.
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 */
export function meterGeneration(request, response) {
    const handle = request.user?.profile?.handle;
    if (!handle) return;
    const reader = new UsageReader();
    response.locals.usageMeter = reader;
    const send = response.send.bind(response);
    let failed = false;
    response.send = body => {
        if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
            reader.observe(body);
            // Some failures are sent as { error } with status 200.
            if (body.error) failed = true;
        } else if (typeof body === 'string' && body.includes('sage')) {
            reader.line(body);
        }
        return send(body);
    };
    const id = String(request.get('x-usage-id') ?? '').slice(0, 64).replace(/[^\w-]/g, '') || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    const relay = relayOf(request);
    // Asking relays anything is only for users who turned the meter on.
    const enabled = usageMeterOn(request);
    if (relay && enabled) void prepareRelay(handle, relay).catch(error => console.warn('[usage] Relay reading failed:', error?.message ?? error));
    response.once('close', () => {
        reader.end();
        void record().catch(error => console.warn('[usage] Could not meter a generation:', error?.message ?? error));
    });

    async function record() {
        const usage = reader.result();
        // Refused before reaching the service, or failed: nothing was used.
        if (response.statusCode >= 400 || (failed && !usage)) return;
        const source = String(request.body?.chat_completion_source ?? '');
        const model = String(request.body?.model ?? '');
        /** @type {Entry} */
        const entry = {
            id, at: startedAt, source, model,
            input: usage?.input ?? 0, cached: usage?.cached ?? 0, output: usage?.output ?? 0, reasoning: usage?.reasoning ?? 0,
            cost: null, priced: null,
        };
        let waitForRelay = false;
        let firstReading = false;
        if (relay) {
            // Only after a generation went through is the relay asked what it runs (once in a while).
            const found = enabled ? await detectRelay(relay).catch(() => null) : null;
            entry.relay = { address: relay.address, kind: found?.kind ?? null };
            const { settings, relays } = readUsage(handle);
            const own = sanitizePricing(settings.pricing[relay.address]);
            const listed = usage ? catalogPrice(relay.base, model) : null;
            if (billed(found?.kind) && !relays[relay.id]) {
                // No earlier reading to compare with: this one becomes it (this generation stays unpriced).
                firstReading = true;
            } else if (billed(found?.kind)) {
                // What the relay booked comes after reading it again.
                entry.pending = true;
                waitForRelay = true;
            } else if (usage && own) {
                const priced = applyPricing(own, model, usage, settings.rate);
                if (priced) Object.assign(entry, { cost: priced.cost, priced: 'custom' }, priced.provider ? { provider: priced.provider } : {});
            } else if (listed) {
                Object.assign(entry, { cost: priceUsage(listed.cost, usage), priced: 'catalog', provider: listed.provider });
            }
        } else if (usage && FREE_SOURCES.has(source)) {
            Object.assign(entry, { cost: 0, priced: 'free' });
        } else if (usage && source === 'openrouter' && Number.isFinite(usage.reportedCost)) {
            // OpenRouter reports what it charged, in dollars.
            Object.assign(entry, { cost: usage.reportedCost, priced: 'reported' });
        } else if (usage) {
            const price = findPrice(source, model, request.body);
            if (price) Object.assign(entry, { cost: priceUsage(price.cost, usage), priced: 'official', provider: price.provider });
        }
        await recordUsage(handle, entry, Boolean(usage));
        if (waitForRelay && relay) settleRelay(handle, relay, id, Math.max(1, entry.input + entry.output));
        if (firstReading && relay && entry.relay?.kind) await takeReading(handle, relay, entry.relay.kind);
    }
}

/** The server calls this: prices are fetched by the serving process, once a day. */
export function startUsageMeter() {
    loadPrices();
    const run = () => {
        if (!prices || !prices.catalog?.length || Date.now() - prices.fetchedAt > PRICES_MAX_AGE_MS) void refreshPrices();
        setInterval(() => void refreshPrices(), PRICES_MAX_AGE_MS).unref?.();
    };
    if (canPersistSharedState()) run();
    else onActivate(run);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export const router = express.Router();

/**
 * The relays the user went through lately: what they are, what they report, how they are priced.
 * @param {ReturnType<typeof readUsage>} data
 */
function describeRelays(data) {
    /** @type {Map<string, any>} */
    const relays = new Map();
    const since = Date.now() - 7 * 86400e3;
    for (const entry of data.recent) {
        if (!entry.relay?.address || entry.at < since) continue;
        const item = relays.get(entry.relay.address) ?? { address: entry.relay.address, kind: null, models: [], catalog: null, at: 0 };
        if (entry.at >= item.at) {
            item.at = entry.at;
            item.kind = entry.relay.kind ?? item.kind;
        }
        if (!item.models.includes(entry.model)) item.models.push(entry.model);
        if (entry.priced === 'catalog') item.catalog = prices?.catalog?.find(listed => listed.provider === entry.provider)?.name ?? entry.provider;
        relays.set(entry.relay.address, item);
    }
    for (const [id, reading] of Object.entries(data.relays)) {
        const item = relays.get(reading.address);
        if (!item || (item.checkedAt ?? 0) > reading.at) continue;
        Object.assign(item, { remaining: reading.remaining ?? null, checkedAt: reading.at, relayId: id });
    }
    return [...relays.values()].map(({ at, relayId, ...item }) => ({
        ...item,
        label: item.kind ? RELAY_LABELS[item.kind] ?? item.kind : null,
        billing: billed(item.kind),
        free: FREE_RELAYS.has(item.kind),
        pricing: sanitizePricing(data.settings.pricing[item.address]),
        hint: pricingHint(item.models),
        official: item.models.map(model => officialPrice(model)?.model).find(Boolean) ?? null,
    }));
}

/** Today's totals, the last 7 days, the relays and settings, and (with ?id=) one generation. */
router.get('/summary', (request, response) => {
    const handle = request.user?.profile?.handle;
    if (!handle) return response.sendStatus(403);
    const data = readUsage(handle);
    const now = Date.now();
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const date = getLocalDateKey(new Date(now - i * 86400e3));
        const day = data.days[date] ?? emptyTotals();
        days.push({ date, ...Object.fromEntries(Object.keys(emptyTotals()).map(key => [key, day[key] ?? 0])) });
    }
    const today = data.days[getLocalDateKey(new Date(now))] ?? { ...emptyTotals(), models: {} };
    const id = String(request.query.id ?? '');
    response.set('Cache-Control', 'no-store');
    return response.send({
        today,
        days,
        item: id ? data.recent.find(item => item.id === id) ?? null : null,
        relays: describeRelays(data),
        settings: { rate: data.settings.rate },
        pricesFetchedAt: prices?.fetchedAt ?? null,
    });
});

/** The exchange rate, and the user's own price for a relay ({ address, pricing } – null pricing removes it). */
router.post('/settings', async (request, response) => {
    const handle = request.user?.profile?.handle;
    if (!handle) return response.sendStatus(403);
    const body = request.body ?? {};
    const rate = Number(body.rate);
    const address = typeof body.address === 'string' ? body.address.trim().toLowerCase().slice(0, 300) : '';
    await updateUsage(handle, data => {
        data.settings ??= { rate: DEFAULT_RATE, pricing: {} };
        if (Number.isFinite(rate) && rate > 0 && rate < 1000) data.settings.rate = rate;
        if (address && 'pricing' in body) {
            const pricing = sanitizePricing(body.pricing);
            if (pricing) data.settings.pricing[address] = pricing;
            else delete data.settings.pricing[address];
        }
    });
    return response.sendStatus(204);
});
