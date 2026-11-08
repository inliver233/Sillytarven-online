import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import express from 'express';
import fetch from 'node-fetch';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { canPersistSharedState, onActivate } from './process-lifecycle.js';
import { getLocalDateKey } from './storage-quota.js';

/**
 * Usage meter: reads the tokens each AI service reports in its answer (streamed or not) and adds
 * them to the user's daily totals. Nothing is estimated: what the service reports is what it bills,
 * whatever the model is called. Services that bill by the token at their published prices also get
 * a price, from models.dev's list (fetched once a day); for relays only the tokens are known.
 *
 * Per user, <data>/_usage/<handle>.json: { days: { 'YYYY-MM-DD': Totals & { models } }, recent: Entry[] }.
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
 * @typedef {{ id: string, at: number, source: string, model: string, input: number, cached: number, output: number, reasoning: number, cost: number|null, priced: string|null, provider?: string }} Entry
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

/** @type {{ fetchedAt: number, providers: Record<string, Record<string, any>> }|null} */
let prices = null;
let refreshing = null;

const pricesFile = () => path.join(globalThis.DATA_ROOT, '_global', 'model-prices.json');

function loadPrices() {
    try {
        const stored = JSON.parse(fs.readFileSync(pricesFile(), 'utf8'));
        if (stored?.providers && typeof stored.providers === 'object') prices = stored;
    } catch {
        // Not fetched yet.
    }
}

/** Fetches models.dev and keeps the prices of the providers above. */
export async function refreshPrices() {
    refreshing ??= (async () => {
        try {
            const response = await fetch(PRICES_URL, { signal: AbortSignal.timeout(60e3) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = /** @type {any} */ (await response.json());
            /** @type {Record<string, Record<string, any>>} */
            const providers = {};
            for (const id of new Set(Object.values(OFFICIAL_PROVIDERS).flat())) {
                providers[id] = {};
                for (const [model, info] of Object.entries(data?.[id]?.models ?? {})) {
                    const cost = /** @type {any} */ (info)?.cost;
                    if (!Number.isFinite(cost?.input) || !Number.isFinite(cost?.output)) continue;
                    providers[id][model] = {
                        input: cost.input, output: cost.output,
                        ...(Number.isFinite(cost.cache_read) ? { cache_read: cost.cache_read } : {}),
                        ...(Number.isFinite(cost.cache_write) ? { cache_write: cost.cache_write } : {}),
                        ...(Array.isArray(cost.tiers) ? { tiers: cost.tiers } : {}),
                        ...(cost.context_over_200k ? { context_over_200k: cost.context_over_200k } : {}),
                    };
                }
            }
            prices = { fetchedAt: Date.now(), providers };
            fs.mkdirSync(path.dirname(pricesFile()), { recursive: true });
            writeFileAtomicSync(pricesFile(), JSON.stringify(prices), 'utf8');
            console.info(`[usage] Prices updated from models.dev (${Object.values(providers).reduce((sum, list) => sum + Object.keys(list).length, 0)} models)`);
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

// ---------------------------------------------------------------------------
// Totals per user
// ---------------------------------------------------------------------------

/** @type {Map<string, Promise<void>>} */
const writing = new Map();

const usageFile = handle => path.join(globalThis.DATA_ROOT, '_usage', `${handle}.json`);

/** @param {string} handle */
export function readUsage(handle) {
    try {
        const stored = JSON.parse(fs.readFileSync(usageFile(handle), 'utf8'));
        return { days: stored?.days && typeof stored.days === 'object' ? stored.days : {}, recent: Array.isArray(stored?.recent) ? stored.recent : [] };
    } catch {
        return { days: {}, recent: [] };
    }
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
 * Adds one generation to the user's totals (the file is read again each time, so a process
 * handing over to another one does not lose the other's additions).
 * @param {string} handle
 * @param {Entry} entry
 * @param {boolean} reported Whether the service reported its usage
 */
export function recordUsage(handle, entry, reported) {
    const previous = writing.get(handle) ?? Promise.resolve();
    const next = previous.then(() => {
        const data = readUsage(handle);
        const day = getLocalDateKey(new Date(entry.at));
        const today = data.days[day] ??= { ...emptyTotals(), models: {} };
        add(today, entry, reported);
        const key = `${entry.source}|${entry.model}`;
        add(today.models[key] ??= emptyTotals(), entry, reported);
        const oldest = getLocalDateKey(new Date(entry.at - KEEP_DAYS * 86400e3));
        for (const date of Object.keys(data.days)) {
            if (date < oldest) delete data.days[date];
        }
        data.recent = [...data.recent.filter(item => item.id !== entry.id), entry].slice(-KEEP_RECENT);
        fs.mkdirSync(path.dirname(usageFile(handle)), { recursive: true });
        writeFileAtomicSync(usageFile(handle), JSON.stringify(data), 'utf8');
    }).catch(error => console.warn('[usage] Could not record usage of', handle, error?.message ?? error));
    writing.set(handle, next);
    void next.then(() => {
        if (writing.get(handle) === next) writing.delete(handle);
    });
    return next;
}

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
    response.once('close', () => {
        reader.end();
        const usage = reader.result();
        // Refused before reaching the service, or failed: nothing was used.
        if (response.statusCode >= 400 || (failed && !usage)) return;
        const source = String(request.body?.chat_completion_source ?? '');
        const model = String(request.body?.model ?? '');
        let cost = null;
        let priced = null;
        let provider;
        if (usage && FREE_SOURCES.has(source)) {
            cost = 0;
            priced = 'free';
        } else if (usage && source === 'openrouter' && Number.isFinite(usage.reportedCost)) {
            // OpenRouter reports what it charged, in dollars (relays may use their own units).
            cost = usage.reportedCost;
            priced = 'reported';
        } else if (usage) {
            const price = findPrice(source, model, request.body);
            if (price) {
                cost = priceUsage(price.cost, usage);
                priced = 'official';
                provider = price.provider;
            }
        }
        /** @type {Entry} */
        const entry = {
            id, at: startedAt, source, model,
            input: usage?.input ?? 0, cached: usage?.cached ?? 0, output: usage?.output ?? 0, reasoning: usage?.reasoning ?? 0,
            cost, priced, ...(provider ? { provider } : {}),
        };
        void recordUsage(handle, entry, Boolean(usage));
    });
}

/** The server calls this: prices are fetched by the serving process, once a day. */
export function startUsageMeter() {
    loadPrices();
    const run = () => {
        if (!prices || Date.now() - prices.fetchedAt > PRICES_MAX_AGE_MS) void refreshPrices();
        setInterval(() => void refreshPrices(), PRICES_MAX_AGE_MS).unref?.();
    };
    if (canPersistSharedState()) run();
    else onActivate(run);
}

export const router = express.Router();

/** Today's totals, the last 7 days, and (with ?id=) one generation. */
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
        pricesFetchedAt: prices?.fetchedAt ?? null,
    });
});
