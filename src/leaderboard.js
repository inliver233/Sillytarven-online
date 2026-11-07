import crypto from 'node:crypto';

/**
 * Leaderboard across the two sites ("legacy" and "modern").
 *
 * Each site counts its own users and keeps the numbers per day (Beijing time). The sites
 * exchange their counts every few seconds (only what changed), so each one can rank everybody.
 * One person with an account on both sites (the same Discord account) is one entry: the sites
 * only ever exchange a keyed hash of the Discord id, never the id or the account name.
 *
 * Privacy: everybody takes part anonymously ("困倦的水獭·3f2a", stable but not traceable to the
 * account) until they choose otherwise; they can show a nickname or leave the board. The latest
 * choice made on either site counts. Accounts that left are still counted for their own rank,
 * which only they see. Administrators are not ranked.
 *
 * Counting is meant to be hard to inflate:
 * - an AI reply counts only against a generation request this user made around that time (a
 *   save can carry made-up messages; a request to the model cannot be made up for free), and a
 *   user message only when a generation request follows it;
 * - a message is counted once, by role and send time, whatever way the chat was saved;
 * - only messages sent in the last minutes count live (imported or copied chats do not);
 *   older history comes from a one-off scan of the chat files;
 * - online time comes from the page reporting that someone is using it (not from the heartbeat
 *   an idle open tab keeps sending), at most 16 hours a day;
 * - every count has a daily cap, so whatever slips through gains at most a full day;
 * - administrators can take someone off the board (on both sites).
 */

export const SITES = Object.freeze(['legacy', 'modern']);
export const SITE_FILTERS = Object.freeze(['all', ...SITES]);
export const METRICS = Object.freeze(['score', 'chat', 'words', 'online', 'talk', 'active', 'streak', 'night', 'variety', 'group', 'rookie']);
export const WINDOWS = Object.freeze(['today', 'week', 'month', 'all']);
export const MODES = Object.freeze(['anon', 'public', 'none']);

const DAY_MS = 864e5;
const BEIJING_OFFSET_MS = 8 * 3600e3;
/** A message counts live only if it was sent this recently (older ones come from the scan). */
const LIVE_WINDOW_MS = 15 * 60e3;
/** Leeway for the browser's clock after correcting it by the measured offset. */
const CLOCK_SKEW_MS = 2 * 60e3;
const CREDIT_MAX_AGE_MS = LIVE_WINDOW_MS + CLOCK_SKEW_MS;
const MAX_CREDITS = 200;
/** A user message counts when a generation request starts up to 2 minutes after it... */
const WITNESS_AFTER_MS = 2 * 60e3;
/** ...or shortly before it (the browser may date the message a moment late). */
const WITNESS_BEFORE_MS = 30e3;
/** One generation request vouches for this many user messages at most. */
const MAX_WITNESSED = 5;
const MAX_AI_PER_MINUTE = 20;
const MAX_USER_PER_MINUTE = 10;
const MAX_REPLY_CHARS = 20000;
const MAX_CHARACTERS_PER_DAY = 300;
const MAX_RECENT = 500;
/**
 * Counted per person, site and day at most, however it was made: a busy human stays well below
 * (hundreds of replies a day); anything farmed gains at most this much a day.
 */
export const DAILY_CAPS = Object.freeze({ ai: 1000, chars: 1500000, user: 800 });
/** Activity reports closer together than this count the time between them as online. */
const ONLINE_GAP_MS = 10 * 60e3;
const ONLINE_MIN_CREDIT_MS = 60e3;
const ONLINE_DAY_CAP_MS = 16 * 3600e3;
const ROOKIE_DAYS = 30;
const NICKNAME_MAX = 16;
const MAX_ROWS = 50;
/** Rankings are recomputed at most this often while the numbers keep changing. */
const BOARD_RECOMPUTE_MS = 1000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const RESERVED_NICKNAME = /管理|官方|系统|客服|站长|admin|staff|moderator|system|official/i;

/**
 * @param {number} ts Time in ms
 * @returns {number} Day number in Beijing time
 */
export function dayOf(ts) {
    return Math.floor((ts + BEIJING_OFFSET_MS) / DAY_MS);
}

/**
 * @param {number} ts Time in ms
 * @returns {number} Hour of the day in Beijing time
 */
export function hourOf(ts) {
    return Math.floor((((ts + BEIJING_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 3600e3);
}

/**
 * @param {string} window One of WINDOWS
 * @param {number} now Time in ms
 * @returns {[number, number]} First and last day of the window
 */
export function windowDays(window, now) {
    const today = dayOf(now);
    if (window === 'today') return [today, today];
    // Day 0 (1970-01-01) was a Thursday; weeks start on Monday.
    if (window === 'week') return [today - (today + 3) % 7, today];
    if (window === 'month') {
        const date = new Date(today * DAY_MS);
        return [dayOf(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) - BEIJING_OFFSET_MS), today];
    }
    return [-Infinity, Infinity];
}

/**
 * Parses a chat message send date (ISO, epoch ms, or the old "2024-01-01 @12h 30m 15s 123ms").
 * @param {unknown} value send_date
 * @returns {number|null}
 */
export function parseSendDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (/^\d{10,14}$/.test(text)) return Number(text);
    // Older formats carry the browser's local time without a zone: Beijing time for nearly everybody here.
    const humanized = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s*@(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s\s*(\d{1,3})ms$/);
    if (humanized) {
        const [, y, mo, d, h, mi, s, ms] = humanized.map(Number);
        return Date.UTC(y, mo - 1, d, h, mi, s, ms) - BEIJING_OFFSET_MS;
    }
    const written = text.match(/^([A-Za-z]+) (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2}) ?([ap]m)$/i);
    if (written) {
        const month = MONTHS.indexOf(written[1].slice(0, 3).toLowerCase());
        const hour = Number(written[4]) % 12 + (written[6].toLowerCase() === 'pm' ? 12 : 0);
        if (month >= 0) return Date.UTC(Number(written[3]), month, Number(written[2]), hour, Number(written[5])) - BEIJING_OFFSET_MS;
    }
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The Discord id of an account record ("discord_123", "123", or oauthIdentities.discord).
 * @param {{oauthProvider?: string, oauthUserId?: unknown, oauthIdentities?: Record<string, unknown>}} user
 * @returns {string|null}
 */
export function discordIdOf(user) {
    const identities = user?.oauthIdentities && typeof user.oauthIdentities === 'object' ? user.oauthIdentities : {};
    const raw = identities.discord ?? (user?.oauthProvider === 'discord' ? user.oauthUserId : null);
    const id = String(raw ?? '').replace(/^discord_/, '');
    return /^\d{5,25}$/.test(id) ? id : null;
}

/**
 * @param {unknown} value Requested nickname
 * @returns {string} Nickname safe to show ('' when unusable)
 */
export function cleanNickname(value) {
    return Array.from(String(value ?? '')
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f<>&"'`\\\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
        .replace(/\s+/g, ' ')
        .trim())
        .slice(0, NICKNAME_MAX)
        .join('')
        .trim();
}

const ADJECTIVES = ['困倦的', '快乐的', '安静的', '好奇的', '勇敢的', '温柔的', '迷路的', '认真的', '害羞的', '慵懒的', '机灵的', '倔强的',
    '优雅的', '冒失的', '神秘的', '贪吃的', '爱笑的', '发呆的', '沉思的', '热情的', '淡定的', '迷糊的', '执着的', '浪漫的',
    '活泼的', '谨慎的', '自由的', '孤独的', '闪亮的', '朦胧的', '清醒的', '跳跃的'];
const ANIMALS = ['水獭', '橘猫', '狐狸', '海豹', '企鹅', '仓鼠', '刺猬', '松鼠', '树懒', '浣熊', '柴犬', '兔子', '考拉', '小熊猫',
    '猫头鹰', '水母', '海豚', '鲸鱼', '鹦鹉', '羊驼', '小鹿', '狸猫', '雪豹', '白鹤', '萤火虫', '蜗牛', '章鱼', '河豚',
    '麻雀', '金鱼', '团子', '星星'];

/**
 * @typedef {{ai: number, chars: number, user: number, night: number, group: number, online: number, cset: string[], v: number}} DayStats
 * @typedef {{mode: string, nickname: string, explicit: boolean, updatedAt: number}} Prefs
 * @typedef {{handle: string, created: number, discord: string|null, admin: boolean, prefs: Prefs, days: Map<number, DayStats>, v: number}} Account
 * @typedef {{key: string, created: number, prefs: Prefs, days: Map<number, DayStats>}} RemoteAccount
 * @typedef {{site: string, epoch: string, version: number, accounts: Map<string, RemoteAccount>, syncedAt: number, error: string}} Peer
 * @typedef {{ts: number, len: number, tail: string, counted: boolean, name: string}} RecentMessage
 * @typedef {{recent: Map<string, RecentMessage>, credits: number[], generations: {at: number, w: number}[], pending: {ts: number}[], ai: number[], user: number[], offset: number, lastActivity: number}} LiveState
 */

const newDay = () => ({ ai: 0, chars: 0, user: 0, night: 0, group: 0, online: 0, cset: [], v: 0 });
const defaultPrefs = () => ({ mode: 'anon', nickname: '', explicit: false, updatedAt: 0 });
const tailOf = text => text.slice(-40);
const clampChars = length => Math.min(length, MAX_REPLY_CHARS);
const isActiveDay = stats => stats.ai + stats.user > 0;

/**
 * The overall board ("综合"): the boards it is made of, their weights (out of 100), the amount
 * counted as 1 (characters by the hundred, online time by the minute) and what each measures.
 *
 * Weighted by dimension rather than board: replies, characters and the user's messages all
 * measure how much someone chatted, so together they weigh 40, not three times as much. The
 * habit boards (days active, streak) weigh more: they cannot be farmed, only lived.
 */
export const SCORE_PARTS = Object.freeze([
    Object.freeze({ metric: 'chat', weight: 15, unit: 1, dimension: 'output' }),
    Object.freeze({ metric: 'words', weight: 15, unit: 100, dimension: 'output' }),
    Object.freeze({ metric: 'talk', weight: 10, unit: 1, dimension: 'output' }),
    Object.freeze({ metric: 'online', weight: 20, unit: 60e3, dimension: 'time' }),
    Object.freeze({ metric: 'active', weight: 20, unit: 1, dimension: 'habit' }),
    Object.freeze({ metric: 'streak', weight: 10, unit: 1, dimension: 'habit' }),
    Object.freeze({ metric: 'variety', weight: 10, unit: 1, dimension: 'breadth' }),
]);

/**
 * Overall score, 0–100: a weighted sum of log-normalized values.
 *
 *   part  = ln(1 + value / unit) / ln(1 + best / unit)        (0–1; the best one gets 1)
 *   score = 100 × Σ weight × part / Σ weight
 *
 * The logarithm makes each part grow ever slower (10 → 100 adds about as much as 100 → 1000),
 * so being active in every way beats grinding one number; dividing by the best value makes
 * counts, characters and minutes comparable. Parts nobody has yet (best 0) are left out, and
 * their weight with them.
 * @param {Record<string, number>} values One person's values
 * @param {Record<string, number>} best The best value of every part among the people shown
 * @returns {{score: number, parts: (number|null)[]}} parts: points per SCORE_PARTS entry (null: left out)
 */
export function compositeScore(values, best) {
    let total = 0;
    let weights = 0;
    const points = SCORE_PARTS.map(part => {
        const top = best?.[part.metric] ?? 0;
        if (!(top > 0)) return null;
        weights += part.weight;
        const share = Math.min(1, Math.log1p(Math.max(0, values?.[part.metric] ?? 0) / part.unit) / Math.log1p(top / part.unit));
        total += part.weight * share;
        return part.weight * share;
    });
    if (!weights) return { score: 0, parts: points.map(() => null) };
    return { score: 100 * total / weights, parts: points.map(point => point === null ? null : 100 * point / weights) };
}
const nicknameKey = nickname => nickname.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/** A day as an array, for the state file and the peers. */
const packDay = (day, stats) => [day, stats.ai, stats.chars, stats.user, stats.night, stats.group, Math.round(stats.online), stats.cset.join(',')];
const unpackDay = row => ({
    ai: Number(row[1]) || 0,
    chars: Number(row[2]) || 0,
    user: Number(row[3]) || 0,
    night: Number(row[4]) || 0,
    group: Number(row[5]) || 0,
    online: Number(row[6]) || 0,
    cset: row[7] ? String(row[7]).split(',').filter(Boolean).slice(0, MAX_CHARACTERS_PER_DAY) : [],
    v: 0,
});
const cleanPrefs = prefs => {
    const mode = MODES.includes(prefs?.mode) ? prefs.mode : 'anon';
    const nickname = mode === 'public' ? cleanNickname(prefs?.nickname) : '';
    return { mode: mode === 'public' && !nickname ? 'anon' : mode, nickname, explicit: !!prefs?.explicit, updatedAt: Number(prefs?.updatedAt) || 0 };
};

/**
 * @param {unknown} rows [key, banned (0/1), at][]
 * @returns {Map<string, {banned: boolean, at: number}>}
 */
function parseBans(rows) {
    const bans = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        if (Array.isArray(row) && row[0]) bans.set(String(row[0]), { banned: !!row[1], at: Number(row[2]) || 0 });
    }
    return bans;
}

export class LeaderboardStore {
    /**
     * @param {{site: string, secret: string, now?: () => number, recomputeMs?: number}} options
     */
    constructor({ site, secret, now = Date.now, recomputeMs = BOARD_RECOMPUTE_MS }) {
        if (!SITES.includes(site)) throw new Error(`Unknown leaderboard site: ${site}`);
        if (!secret) throw new Error('The leaderboard needs a secret');
        this.site = site;
        this.secret = String(secret);
        this.now = now;
        /** @type {Map<string, Account>} */
        this.accounts = new Map();
        /** Local changes, for the peers' "what changed since" questions. */
        this.version = 0;
        /** Any change the boards show (local or from a peer). */
        this.boardVersion = 0;
        /** New for every process: a peer seeing another epoch asks for everything again. */
        this.epoch = crypto.randomBytes(8).toString('hex');
        /** When live counting started; the scan of the chat files covers what came before. */
        this.countingSince = now();
        /** Accounts whose chat files were scanned (and added) already. */
        this.backfilled = new Set();
        this.backfillFinished = false;
        /** @type {{key: string, v: number}[]} people that left (for the peers) */
        this.tombstones = [];
        /** @type {Map<string, LiveState>} */
        this.live = new Map();
        /** @type {Map<string, Peer>} */
        this.peers = new Map();
        /** @type {Map<string, {banned: boolean, at: number}>} administrators' decisions made on this site, by person */
        this.bans = new Map();
        /** @type {Map<string, any>} */
        this.boardCache = new Map();
        this.recomputeMs = recomputeMs;
        this.peopleCache = null;
    }

    /** @param {string} value @returns {string} */
    hash(value) {
        return crypto.createHmac('sha256', this.secret).update(value).digest('hex');
    }

    /**
     * The person an account belongs to: their Discord account, or else the account itself.
     * @param {Account} account
     * @returns {string}
     */
    personKey(account) {
        return this.hash(account.discord ? `discord:${account.discord}` : `${this.site}:${account.handle}`).slice(0, 24);
    }

    /**
     * @param {string} personKey
     * @returns {string} Anonymous name, the same on both sites
     */
    anonymousName(personKey) {
        const digest = this.hash(`label:${personKey}`);
        const adjective = ADJECTIVES[parseInt(digest.slice(0, 2), 16) % ADJECTIVES.length];
        const animal = ANIMALS[parseInt(digest.slice(2, 4), 16) % ANIMALS.length];
        // 32 × 32 × 65536 names: among a few thousand people two alike are unlikely.
        return `${adjective}${animal}·${digest.slice(4, 8)}`;
    }

    /** @param {string} name Character name @returns {string} */
    characterKey(name) {
        return this.hash(`character:${name}`).slice(0, 10);
    }

    /** Something changed that the peers should get. */
    bump() {
        this.version++;
        this.changed();
        return this.version;
    }

    /** Something changed that the boards show. */
    changed() {
        this.boardVersion++;
        this.peopleCache = null;
    }

    /**
     * @param {Account} account
     * @param {{created?: number, admin?: boolean, discord?: string|null}} user
     */
    updateAccount(account, user) {
        const created = Number(user.created) || account.created;
        const discord = user.discord ?? null;
        const admin = !!user.admin;
        if (account.created === created && account.discord === discord && account.admin === admin) return;
        // The peers know the account by its old key (or must forget it now that it is not ranked).
        if (account.discord !== discord || (admin && !account.admin)) {
            this.tombstones.push({ key: this.personKey(account), v: this.bump() });
        }
        account.created = created;
        account.discord = discord;
        account.admin = admin;
        account.v = this.bump();
        // Under a new key the peers need all of it again.
        for (const stats of account.days.values()) stats.v = account.v;
    }

    /**
     * The account of a signed-in user, added if it is new.
     * @param {{handle: string, created?: number, admin?: boolean, discord?: string|null}} user
     * @returns {Account|null}
     */
    ensureAccount(user) {
        if (!user?.handle) return null;
        let account = this.accounts.get(user.handle);
        if (!account) {
            account = { handle: user.handle, created: Number(user.created) || 0, discord: user.discord ?? null, admin: !!user.admin, prefs: defaultPrefs(), days: new Map(), v: 0 };
            this.accounts.set(user.handle, account);
            account.v = this.bump();
            return account;
        }
        this.updateAccount(account, user);
        return account;
    }

    /**
     * Brings the accounts in line with the site's users (new ones, Discord ids, removed ones).
     * @param {{handle: string, created?: number, admin?: boolean, discord?: string|null}[]} users
     */
    syncUsers(users) {
        const seen = new Set();
        for (const user of users) {
            if (!user?.handle) continue;
            seen.add(user.handle);
            this.ensureAccount(user);
        }
        for (const [handle, account] of this.accounts) {
            if (seen.has(handle)) continue;
            this.accounts.delete(handle);
            this.live.delete(handle);
            this.backfilled.delete(handle);
            if (!account.admin) this.tombstones.push({ key: this.personKey(account), v: this.bump() });
        }
        if (this.tombstones.length > 5000) this.tombstones.splice(0, this.tombstones.length - 5000);
    }

    /**
     * @param {Account} account
     * @param {number} day
     * @returns {DayStats}
     */
    dayStats(account, day) {
        let stats = account.days.get(day);
        if (!stats) {
            stats = newDay();
            account.days.set(day, stats);
        }
        return stats;
    }

    /**
     * A day changed: it goes to the peers with the next exchange.
     * @param {Account} account
     * @param {DayStats} stats
     */
    touch(account, stats) {
        stats.v = this.bump();
        account.v = stats.v;
    }

    /** @param {string} handle @returns {LiveState} */
    liveOf(handle) {
        let state = this.live.get(handle);
        if (!state) {
            state = { recent: new Map(), credits: [], generations: [], pending: [], ai: [], user: [], offset: 0, lastActivity: 0 };
            this.live.set(handle, state);
        }
        return state;
    }

    /**
     * How far the user's clock is off (their time minus ours), as their page reported it.
     * @param {string} handle
     * @param {number} clientNow The page's clock
     * @param {number} [at]
     */
    recordClock(handle, clientNow, at = this.now()) {
        const offset = Number(clientNow) - at;
        if (!this.accounts.has(handle) || !Number.isFinite(offset) || Math.abs(offset) > 7 * DAY_MS) return;
        this.liveOf(handle).offset = Math.round(offset);
    }

    /**
     * A generation request started: it pays for one AI reply and vouches for the user's
     * messages just before it.
     * @param {string} handle
     * @param {number} [at]
     * @returns {number|undefined} The credit, for revokeGeneration
     */
    recordGeneration(handle, at = this.now()) {
        const account = this.accounts.get(handle);
        if (!account || account.admin) return;
        const state = this.liveOf(handle);
        // Two requests in the same millisecond still make two credits (see revokeGeneration).
        while (state.credits.includes(at)) at++;
        state.credits.push(at);
        while (state.credits.length > MAX_CREDITS || (state.credits.length && at - state.credits[0] > CREDIT_MAX_AGE_MS)) state.credits.shift();
        const generation = { at, w: 0 };
        state.generations.push(generation);
        while (state.generations.length && at - state.generations[0].at > CREDIT_MAX_AGE_MS) state.generations.shift();
        const waiting = state.pending;
        state.pending = [];
        for (const message of waiting) {
            if (at - message.ts > WITNESS_AFTER_MS) continue;
            if (message.ts - at <= WITNESS_BEFORE_MS && generation.w < MAX_WITNESSED) {
                generation.w++;
                this.countUserMessage(account, state, message.ts, at);
            } else {
                state.pending.push(message);
            }
        }
        return at;
    }

    /**
     * The generation request failed: it pays for nothing (if no reply used it already).
     * @param {string} handle
     * @param {number} at What recordGeneration returned
     */
    revokeGeneration(handle, at) {
        const state = this.live.get(handle);
        const index = state ? state.credits.indexOf(at) : -1;
        if (index >= 0) state.credits.splice(index, 1);
    }

    /**
     * The page reported that someone is using it (or they did something): online time.
     * @param {string} handle
     * @param {number} [at]
     */
    recordActivity(handle, at = this.now()) {
        const account = this.accounts.get(handle);
        if (!account || account.admin) return;
        const state = this.liveOf(handle);
        const gap = state.lastActivity ? at - state.lastActivity : Infinity;
        if (gap < 0) return;
        state.lastActivity = at;
        const credit = gap <= ONLINE_GAP_MS ? gap : ONLINE_MIN_CREDIT_MS;
        if (credit <= 0) return;
        const stats = this.dayStats(account, dayOf(at));
        const before = stats.online;
        stats.online = Math.min(ONLINE_DAY_CAP_MS, stats.online + credit);
        // The boards and the peers only need online time by the minute.
        if (Math.floor(before / 60e3) !== Math.floor(stats.online / 60e3)) this.touch(account, stats);
    }

    /**
     * @param {LiveState} state
     * @param {'ai'|'user'} kind
     * @param {number} at
     * @returns {boolean} Whether another message of this kind may count this minute
     */
    withinRate(state, kind, at) {
        const times = state[kind].filter(time => at - time < 60e3);
        state[kind] = times;
        return times.length < (kind === 'ai' ? MAX_AI_PER_MINUTE : MAX_USER_PER_MINUTE);
    }

    /**
     * @param {Account} account
     * @param {LiveState} state
     * @param {number} ts Send time (server clock)
     * @param {number} at
     * @returns {boolean}
     */
    countUserMessage(account, state, ts, at) {
        if (!this.withinRate(state, 'user', at)) return false;
        const stats = this.dayStats(account, dayOf(ts));
        if (stats.user >= DAILY_CAPS.user) return false;
        state.user.push(at);
        stats.user++;
        this.touch(account, stats);
        return true;
    }

    /**
     * Counts the messages of a chat save that were sent in the last minutes and not counted yet.
     * @param {string} handle
     * @param {unknown[]} messages The saved messages (all of them, or the tail)
     * @param {{isGroup?: boolean, fromStart?: boolean, at?: number}} [options] fromStart: messages[0] is the chat's first message
     * @returns {number} Messages counted
     */
    recordMessages(handle, messages, { isGroup = false, fromStart = false, at = this.now() } = {}) {
        const account = this.accounts.get(handle);
        if (!account || account.admin || !Array.isArray(messages)) return 0;
        const state = this.liveOf(handle);
        const recent = state.recent;
        for (const [key, entry] of recent) {
            if (at - entry.ts > LIVE_WINDOW_MS * 2 || recent.size > MAX_RECENT) recent.delete(key);
        }
        const cutoff = Math.max(this.countingSince, at - LIVE_WINDOW_MS);
        let counted = 0;
        let older = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = /** @type {any} */ (messages[i]);
            if (!message || typeof message !== 'object' || message.is_system) continue;
            // Narrator and other system notes.
            if (typeof message.extra?.type === 'string' && message.extra.type) continue;
            const sent = parseSendDate(message.send_date);
            if (sent === null) continue;
            const ts = sent - state.offset;
            if (ts < cutoff) {
                // Messages are in order: a few old ones in a row mean the rest is old too.
                if (++older >= 3) break;
                continue;
            }
            older = 0;
            if (ts > at + CLOCK_SKEW_MS) continue;
            const text = typeof message.mes === 'string' ? message.mes : '';
            const key = `${message.is_user ? 'u' : 'a'}${sent}`;
            const entry = recent.get(key);
            if (message.is_user) {
                if (entry) continue;
                recent.set(key, { ts, len: 0, tail: '', counted: false, name: '' });
                const generation = state.generations.find(item => item.at >= ts - WITNESS_BEFORE_MS && item.at <= ts + WITNESS_AFTER_MS && item.w < MAX_WITNESSED);
                if (generation) {
                    generation.w++;
                    if (this.countUserMessage(account, state, ts, at)) counted++;
                } else if (state.pending.length < 50) {
                    state.pending.push({ ts });
                }
                continue;
            }
            const name = typeof message.name === 'string' ? message.name.trim().slice(0, 100) : '';
            if (entry) {
                // The same reply saved again: it grows while it streams in.
                if (entry.counted && text.length > entry.len) this.addChars(account, entry, text);
                continue;
            }
            // The character's greeting is not a reply.
            if (fromStart && i === 0) {
                recent.set(key, { ts, len: text.length, tail: tailOf(text), counted: false, name });
                continue;
            }
            const stats = this.dayStats(account, dayOf(ts));
            if (stats.ai >= DAILY_CAPS.ai || !this.withinRate(state, 'ai', at) || !this.takeCredit(state, ts)) {
                recent.set(key, { ts, len: text.length, tail: tailOf(text), counted: false, name });
                continue;
            }
            state.ai.push(at);
            // "Continue" appends to a reply already counted: only the new text adds characters.
            let base = 0;
            for (const [otherKey, other] of recent) {
                if (other.counted && other.name === name && other.len > 0 && text.length > other.len &&
                    text.slice(other.len - other.tail.length, other.len) === other.tail) {
                    base = other.len;
                    recent.delete(otherKey);
                    break;
                }
            }
            stats.ai++;
            stats.chars = Math.min(DAILY_CAPS.chars, stats.chars + Math.max(0, clampChars(text.length) - clampChars(base)));
            if (hourOf(ts) < 5) stats.night++;
            if (isGroup) stats.group++;
            if (name && stats.cset.length < MAX_CHARACTERS_PER_DAY) {
                const characterKey = this.characterKey(name);
                if (!stats.cset.includes(characterKey)) stats.cset.push(characterKey);
            }
            this.touch(account, stats);
            recent.set(key, { ts, len: text.length, tail: tailOf(text), counted: true, name });
            counted++;
        }
        return counted;
    }

    /**
     * @param {Account} account
     * @param {RecentMessage} entry
     * @param {string} text
     */
    addChars(account, entry, text) {
        const add = clampChars(text.length) - clampChars(entry.len);
        entry.len = text.length;
        entry.tail = tailOf(text);
        if (add <= 0) return;
        const stats = this.dayStats(account, dayOf(entry.ts));
        const chars = Math.min(DAILY_CAPS.chars, stats.chars + add);
        if (chars === stats.chars) return;
        stats.chars = chars;
        this.touch(account, stats);
    }

    /**
     * @param {LiveState} state
     * @param {number} ts Send time of the reply (server clock)
     * @returns {boolean} Whether a generation request paid for it
     */
    takeCredit(state, ts) {
        const index = state.credits.findIndex(start => start >= ts - LIVE_WINDOW_MS && start <= ts + CLOCK_SKEW_MS);
        if (index < 0) return false;
        state.credits.splice(index, 1);
        return true;
    }

    /**
     * @param {string} handle
     * @param {{mode?: unknown, nickname?: unknown}} prefs
     * @returns {{prefs?: Prefs, error?: string}}
     */
    setPrefs(handle, { mode, nickname }) {
        const account = this.accounts.get(handle);
        if (!account) return { error: 'unknown_account' };
        if (!MODES.includes(String(mode))) return { error: 'bad_mode' };
        const clean = mode === 'public' ? cleanNickname(nickname) : '';
        if (mode === 'public') {
            if (!clean) return { error: 'nickname_empty' };
            if (RESERVED_NICKNAME.test(clean)) return { error: 'nickname_reserved' };
            const myKey = this.personKey(account);
            const wanted = nicknameKey(clean);
            for (const person of this.people().values()) {
                if (person.key !== myKey && person.prefs.mode === 'public' && nicknameKey(person.prefs.nickname) === wanted) {
                    return { error: 'nickname_taken' };
                }
            }
        }
        account.prefs = { mode: String(mode), nickname: clean, explicit: true, updatedAt: Math.max(this.now(), account.prefs.updatedAt + 1) };
        account.v = this.bump();
        // The user looks at the board right after: show the change at once.
        this.boardCache.clear();
        return { prefs: account.prefs };
    }

    /**
     * An administrator takes someone off the board (or back). Applies on both sites; the latest
     * decision made on either site counts.
     * @param {string} key Person key (as the board gives it to administrators)
     * @param {boolean} banned
     * @returns {boolean} Whether there is such a person
     */
    setBan(key, banned) {
        if (!this.people().has(key)) return false;
        const latest = this.latestBan(key);
        this.bans.set(key, { banned: !!banned, at: Math.max(this.now(), (latest?.at ?? 0) + 1) });
        this.changed();
        this.boardCache.clear();
        return true;
    }

    /**
     * @param {string} key Person key
     * @returns {{banned: boolean, at: number}|null} The latest decision made about them on any site
     */
    latestBan(key) {
        let latest = this.bans.get(key) ?? null;
        for (const peer of this.peers.values()) {
            const other = peer.bans?.get(key);
            if (other && (!latest || other.at > latest.at)) latest = other;
        }
        return latest;
    }

    /**
     * Adds what the chat file scan found for one account (messages before live counting started).
     * @param {string} handle
     * @param {Record<string, (number|string)[]>} days day -> packed day without the day number
     */
    applyBackfill(handle, days) {
        const account = this.accounts.get(handle);
        if (!account || this.backfilled.has(handle)) return false;
        for (const [day, row] of Object.entries(days ?? {})) {
            const found = unpackDay([Number(day), ...row]);
            const stats = this.dayStats(account, Number(day));
            // The day live counting started has both parts: together they stay within the caps.
            stats.ai = Math.min(DAILY_CAPS.ai, stats.ai + found.ai);
            stats.chars = Math.min(DAILY_CAPS.chars, stats.chars + found.chars);
            stats.user = Math.min(DAILY_CAPS.user, stats.user + found.user);
            stats.night = Math.min(stats.ai, stats.night + found.night);
            stats.group = Math.min(stats.ai, stats.group + found.group);
            for (const key of found.cset) {
                if (stats.cset.length >= MAX_CHARACTERS_PER_DAY) break;
                if (!stats.cset.includes(key)) stats.cset.push(key);
            }
            this.touch(account, stats);
        }
        this.backfilled.add(handle);
        return true;
    }

    /** @returns {object} Everything worth keeping across restarts */
    exportState() {
        const now = this.now();
        const live = {};
        for (const [handle, state] of this.live) {
            const recent = [...state.recent].filter(([, entry]) => now - entry.ts < LIVE_WINDOW_MS * 2)
                .map(([key, entry]) => [key, entry.ts, entry.len, entry.tail, entry.counted ? 1 : 0, entry.name]);
            live[handle] = {
                r: recent,
                c: state.credits.filter(at => now - at < CREDIT_MAX_AGE_MS),
                g: state.generations.filter(item => now - item.at < CREDIT_MAX_AGE_MS).map(item => [item.at, item.w]),
                p: state.pending.filter(item => now - item.ts < WITNESS_AFTER_MS).map(item => item.ts),
                o: state.offset,
                a: state.lastActivity,
            };
        }
        return {
            version: 1,
            site: this.site,
            savedAt: now,
            countingSince: this.countingSince,
            backfilled: [...this.backfilled],
            backfillFinished: this.backfillFinished,
            bans: [...this.bans].map(([key, ban]) => [key, ban.banned ? 1 : 0, ban.at]),
            accounts: [...this.accounts.values()].map(account => ({
                h: account.handle,
                c: account.created,
                d: account.discord,
                a: account.admin,
                p: account.prefs,
                days: [...account.days.entries()].map(([day, stats]) => packDay(day, stats)),
            })),
            live,
        };
    }

    /**
     * @param {any} state What exportState returned (in an earlier process)
     * @returns {boolean}
     */
    importState(state) {
        if (!state || state.version !== 1 || state.site !== this.site) return false;
        this.countingSince = Number(state.countingSince) || this.countingSince;
        this.backfilled = new Set(Array.isArray(state.backfilled) ? state.backfilled : []);
        this.backfillFinished = !!state.backfillFinished;
        this.bans = parseBans(state.bans);
        this.accounts.clear();
        for (const row of state.accounts ?? []) {
            if (!row?.h) continue;
            const days = new Map((row.days ?? []).map(packed => [Number(packed[0]), unpackDay(packed)]));
            this.accounts.set(row.h, { handle: row.h, created: Number(row.c) || 0, discord: row.d ?? null, admin: !!row.a, prefs: cleanPrefs(row.p), days, v: 0 });
        }
        this.live.clear();
        for (const [handle, saved] of Object.entries(state.live ?? {})) {
            if (!this.accounts.has(handle)) continue;
            const live = this.liveOf(handle);
            for (const [key, ts, len, tail, counted, name] of saved.r ?? []) {
                live.recent.set(String(key), { ts: Number(ts), len: Number(len) || 0, tail: String(tail ?? ''), counted: !!counted, name: String(name ?? '') });
            }
            live.credits = (saved.c ?? []).map(Number);
            live.generations = (saved.g ?? []).map(([at, w]) => ({ at: Number(at), w: Number(w) || 0 }));
            live.pending = (saved.p ?? []).map(ts => ({ ts: Number(ts) }));
            live.offset = Number(saved.o) || 0;
            live.lastActivity = Number(saved.a) || 0;
        }
        // A new epoch: the peers will ask for everything again.
        this.version = 0;
        this.tombstones = [];
        this.changed();
        return true;
    }

    /**
     * What a peer asked for: the people (by key, without account names) changed since its last look.
     * @param {number} since Version the peer saw last
     * @param {string} epoch Epoch the peer saw last
     */
    exportForPeer(since, epoch) {
        const full = epoch !== this.epoch || !(since >= 0) || since > this.version;
        const from = full ? 0 : since;
        const accounts = [];
        for (const account of this.accounts.values()) {
            if (account.admin || (!full && account.v <= from)) continue;
            const days = [];
            for (const [day, stats] of account.days) {
                if (full || stats.v > from) days.push(packDay(day, stats));
            }
            const prefs = account.prefs;
            accounts.push({
                k: this.personKey(account),
                c: account.created,
                p: { mode: prefs.mode, nickname: prefs.mode === 'public' ? prefs.nickname : '', explicit: prefs.explicit, updatedAt: prefs.updatedAt },
                days,
            });
        }
        const removed = full ? [] : this.tombstones.filter(item => item.v > from).map(item => item.key);
        const bans = [...this.bans].map(([key, ban]) => [key, ban.banned ? 1 : 0, ban.at]);
        return { site: this.site, epoch: this.epoch, version: this.version, full, accounts, removed, bans };
    }

    /**
     * Takes in a peer's answer.
     * @param {string} peerId Which peer (its address)
     * @param {any} payload
     * @returns {boolean}
     */
    applyPeer(peerId, payload) {
        if (!payload || !SITES.includes(payload.site) || typeof payload.epoch !== 'string') return false;
        let peer = this.peers.get(peerId);
        if (!peer || payload.full || peer.epoch !== payload.epoch) {
            if (!payload.full && peer) return false;
            peer = { site: payload.site, epoch: payload.epoch, version: 0, accounts: new Map(), bans: new Map(), syncedAt: 0, error: '' };
            this.peers.set(peerId, peer);
        }
        peer.site = payload.site;
        let changed = !!payload.full;
        for (const key of payload.removed ?? []) changed = peer.accounts.delete(String(key)) || changed;
        for (const row of payload.accounts ?? []) {
            if (!row?.k) continue;
            let account = peer.accounts.get(row.k);
            if (!account) {
                account = { key: String(row.k), created: 0, prefs: defaultPrefs(), days: new Map() };
                peer.accounts.set(account.key, account);
            }
            account.created = Number(row.c) || account.created;
            account.prefs = cleanPrefs(row.p);
            for (const packed of row.days ?? []) account.days.set(Number(packed[0]), unpackDay(packed));
            changed = true;
        }
        const bans = parseBans(payload.bans);
        if (JSON.stringify([...bans]) !== JSON.stringify([...(peer.bans ?? new Map())])) {
            peer.bans = bans;
            changed = true;
        }
        peer.epoch = payload.epoch;
        peer.version = Number(payload.version) || 0;
        peer.syncedAt = this.now();
        peer.error = '';
        if (changed) this.changed();
        return true;
    }

    /**
     * Everybody, merged by person: local accounts (not administrators) and the peers' accounts.
     * @returns {Map<string, {key: string, sites: Set<string>, created: number, prefs: Prefs, parts: {site: string, days: Map<number, DayStats>}[]}>}
     */
    people() {
        if (this.peopleCache?.version === this.boardVersion) return this.peopleCache.people;
        const people = new Map();
        const add = (key, site, created, prefs, days) => {
            let person = people.get(key);
            if (!person) {
                person = { key, sites: new Set(), created: Infinity, prefs: defaultPrefs(), parts: [] };
                people.set(key, person);
            }
            person.sites.add(site);
            if (created > 0) person.created = Math.min(person.created, created);
            // The latest choice made on either site counts.
            if (prefs.explicit && (!person.prefs.explicit || prefs.updatedAt >= person.prefs.updatedAt)) person.prefs = prefs;
            person.parts.push({ site, days });
        };
        for (const account of this.accounts.values()) {
            if (!account.admin) add(this.personKey(account), this.site, account.created, account.prefs, account.days);
        }
        for (const peer of this.peers.values()) {
            for (const account of peer.accounts.values()) add(account.key, peer.site, account.created, account.prefs, account.days);
        }
        for (const person of people.values()) person.banned = !!this.latestBan(person.key)?.banned;
        this.peopleCache = { version: this.boardVersion, people };
        return people;
    }

    /**
     * Everything one person did in a window, in one pass (over the given site, or both).
     * @param {{parts: {site: string, days: Map<number, DayStats>}[], created: number}} person
     * @param {[number, number]} range Days of the window
     * @param {string} site 'all' or one site
     * @param {number} now
     * @returns {Record<string, number>} A value for every metric but 'score'
     */
    static values(person, [first, last], site, now) {
        const values = { chat: 0, words: 0, online: 0, talk: 0, active: 0, streak: 0, night: 0, variety: 0, group: 0, rookie: 0 };
        const parts = site === 'all' ? person.parts : person.parts.filter(part => part.site === site);
        if (!parts.length) return values;
        const activeDays = new Set();
        const activeInRange = new Set();
        const characters = new Set();
        const onlinePerDay = new Map();
        for (const part of parts) {
            for (const [day, stats] of part.days) {
                const active = isActiveDay(stats);
                if (active) activeDays.add(day);
                if (day < first || day > last) continue;
                if (active) activeInRange.add(day);
                values.chat += stats.ai;
                values.words += stats.chars;
                values.talk += stats.user;
                values.night += stats.night;
                values.group += stats.group;
                for (const key of stats.cset) characters.add(key);
                // Two sites open at once are still one person's time.
                if (stats.online) onlinePerDay.set(day, (onlinePerDay.get(day) ?? 0) + stats.online);
            }
        }
        let online = 0;
        for (const value of onlinePerDay.values()) online += Math.min(ONLINE_DAY_CAP_MS, value);
        values.online = Math.floor(online / 60e3) * 60e3;
        values.active = activeInRange.size;
        values.variety = characters.size;
        // The current streak, whatever the window; today not done yet does not break it.
        let day = activeDays.has(dayOf(now)) ? dayOf(now) : dayOf(now) - 1;
        while (activeDays.has(day)) {
            values.streak++;
            day--;
        }
        values.rookie = person.created > now - ROOKIE_DAYS * DAY_MS ? values.chat : 0;
        return values;
    }

    /**
     * @param {string} metric One of METRICS but 'score'
     * @param {{parts: {site: string, days: Map<number, DayStats>}[], created: number}} person
     * @param {[number, number]} range Days of the window
     * @param {string} site 'all' or one site
     * @param {number} now
     * @returns {number}
     */
    static value(metric, person, range, site, now) {
        return LeaderboardStore.values(person, range, site, now)[metric] ?? 0;
    }

    /**
     * The ranking for a board, shared by everybody looking at it.
     * @param {string} metric
     * @param {string} window
     * @param {string} site
     */
    ranking(metric, window, site) {
        const now = this.now();
        const cacheKey = `${metric}|${window}|${site}|${dayOf(now)}`;
        const cached = this.boardCache.get(cacheKey);
        if (cached && (cached.version === this.boardVersion || now - cached.computedAt < this.recomputeMs)) return cached;
        const people = this.people();
        const range = windowDays(window, now);
        /** @type {{person: any, value: number, values: Record<string, number>}[]} */
        const visible = [];
        /** The best value of every part of the score among the people shown. */
        const best = {};
        for (const person of people.values()) {
            if (person.prefs.mode === 'none' || person.banned) continue;
            const values = LeaderboardStore.values(person, range, site, now);
            visible.push({ person, value: values[metric] ?? 0, values });
            for (const part of SCORE_PARTS) best[part.metric] = Math.max(best[part.metric] ?? 0, values[part.metric]);
        }
        if (metric === 'score') {
            for (const entry of visible) entry.value = compositeScore(entry.values, best).score;
        }
        const shown = visible.filter(entry => entry.value > 0);
        shown.sort((a, b) => b.value - a.value || (a.person.key < b.person.key ? -1 : 1));
        // Competition ranking: equal values share a rank.
        const ranks = [];
        for (let i = 0; i < shown.length; i++) ranks.push(i > 0 && shown[i].value === shown[i - 1].value ? ranks[i - 1] : i + 1);
        const ranking = { version: this.boardVersion, computedAt: now, people, range, visible: shown, ranks, best };
        if (this.boardCache.size > 200) this.boardCache.clear();
        this.boardCache.set(cacheKey, ranking);
        return ranking;
    }

    /**
     * @param {{prefs: Prefs, key: string}} person
     * @returns {string}
     */
    label(person) {
        return person.prefs.mode === 'public' && person.prefs.nickname ? person.prefs.nickname : this.anonymousName(person.key);
    }

    /**
     * A board as one user sees it.
     * @param {{metric: string, window: string, site: string, handle: string}} query
     */
    board({ metric, window, site, handle }) {
        const now = this.now();
        const ranking = this.ranking(metric, window, site);
        const account = this.accounts.get(handle);
        const myKey = account && !account.admin ? this.personKey(account) : null;
        const isScore = metric === 'score';
        const admin = !!account?.admin;
        const rows = ranking.visible.slice(0, MAX_ROWS).map((entry, index) => ({
            ...(admin ? { id: entry.person.key } : {}),
            rank: ranking.ranks[index],
            name: this.label(entry.person),
            anonymous: !(entry.person.prefs.mode === 'public' && entry.person.prefs.nickname),
            sites: [...entry.person.sites].sort(),
            value: entry.value,
            ...(isScore ? { parts: compositeScore(entry.values, ranking.best).parts } : {}),
            me: entry.person.key === myKey,
        }));
        let me = null;
        const person = myKey ? ranking.people.get(myKey) : null;
        if (person) {
            const values = LeaderboardStore.values(person, ranking.range, site, now);
            // Someone off the board gets the score they would have, against the same best values.
            const composite = isScore ? compositeScore(values, ranking.best) : null;
            const value = composite ? composite.score : (values[metric] ?? 0);
            let ahead = 0;
            let next = null;
            for (const entry of ranking.visible) {
                if (entry.person.key === myKey || entry.value <= value) continue;
                ahead++;
                next = entry.value;
            }
            me = {
                rank: value > 0 ? ahead + 1 : null,
                value,
                gap: next === null ? null : next - value,
                ...(composite ? { parts: composite.parts } : {}),
                banned: !!person.banned,
                name: this.label(person),
                mode: person.prefs.mode,
                explicit: person.prefs.explicit,
                sites: [...person.sites].sort(),
            };
        }
        return {
            version: `${ranking.version}-${dayOf(now)}`,
            site: this.site,
            rows,
            me,
            admin,
            ...(admin ? {
                removed: [...ranking.people.values()].filter(other => other.banned)
                    .map(other => ({ id: other.key, name: this.label(other), sites: [...other.sites].sort() })),
            } : {}),
            participants: ranking.visible.length,
            peers: [...this.peers.values()].map(peer => ({ site: peer.site, syncedAt: peer.syncedAt, error: peer.error })),
            // For the explanations: the same numbers the boards are computed with.
            scoreParts: SCORE_PARTS,
            dailyCaps: DAILY_CAPS,
        };
    }

    /**
     * The user's own settings, merged over both sites.
     * @param {string} handle
     */
    prefsOf(handle) {
        const account = this.accounts.get(handle);
        if (!account) return null;
        const key = this.personKey(account);
        const person = account.admin ? null : this.people().get(key);
        const prefs = person?.prefs ?? account.prefs;
        return {
            mode: prefs.mode,
            nickname: prefs.nickname,
            explicit: prefs.explicit,
            anonymousName: this.anonymousName(key),
            sites: [...(person?.sites ?? [this.site])].sort(),
            admin: account.admin,
        };
    }
}

/**
 * Signs a peer request: the time and what is asked, keyed with the shared secret.
 * @param {string} secret
 * @param {number} ts
 * @param {string} query
 * @returns {string} Value for the x-leaderboard-auth header
 */
export function signPeerRequest(secret, ts, query) {
    return `${ts}.${crypto.createHmac('sha256', secret).update(`${ts}\n${query}`).digest('hex')}`;
}

/**
 * @param {string} secret
 * @param {unknown} header x-leaderboard-auth
 * @param {string} query
 * @param {number} now
 * @returns {boolean}
 */
export function verifyPeerRequest(secret, header, query, now) {
    const [tsText, signature] = String(header || '').split('.');
    const ts = Number(tsText);
    if (!secret || !Number.isFinite(ts) || Math.abs(now - ts) > 120e3 || !signature) return false;
    const expected = signPeerRequest(secret, ts, query).split('.')[1];
    return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export const LIMITS = Object.freeze({
    LIVE_WINDOW_MS, CLOCK_SKEW_MS, WITNESS_AFTER_MS, WITNESS_BEFORE_MS, MAX_AI_PER_MINUTE, MAX_USER_PER_MINUTE,
    MAX_REPLY_CHARS, ONLINE_GAP_MS, ONLINE_DAY_CAP_MS, NICKNAME_MAX, MAX_ROWS, ROOKIE_DAYS,
});
