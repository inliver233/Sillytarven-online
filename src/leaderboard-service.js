import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getConfigValue } from './util.js';
import { canPersistSharedState, onActivate, onDrain } from './process-lifecycle.js';
import { getAllEnabledUsers, getUserDirectories } from './users.js';
import { LeaderboardStore, SITES, discordIdOf, signPeerRequest, verifyPeerRequest } from './leaderboard.js';
import { live } from './live.js';

/**
 * The leaderboard of this server: the counting (see leaderboard.js), kept on disk across
 * restarts and reloads, and exchanged with the other site.
 *
 * config.yaml:
 *   leaderboard.enabled   on or off
 *   leaderboard.site      legacy (老站) or modern (新站): the badge this site's users get
 *   leaderboard.secret    the same long random text on both sites; anonymous names, the keys
 *                         people are merged by and the requests between the sites depend on it.
 *                         Empty: this site alone, with a secret made up once and kept in data.
 *   leaderboard.peers     the other sites: [{ url: https://... }]
 */

const DIRECTORY = path.join('_global', 'leaderboard');
const SAVE_INTERVAL_MS = 60e3;
const USER_SYNC_INTERVAL_MS = 10 * 60e3;
const PEER_TIMEOUT_MS = 15e3;
const PEER_MAX_BACKOFF_MS = 30e3;

/** Requests that ask a model for text: each pays for one AI reply. */
export const GENERATION_PATHS = new Set([
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/horde/generate-text',
    '/api/novelai/generate',
]);

/**
 * @param {import('./users.js').User} user
 * @returns {{handle: string, name: string, created: number, admin: boolean, discord: string|null}}
 */
function accountOf(user) {
    // name: the display name, shown with the number for real name (实名)
    return { handle: user.handle, name: String(user.name ?? ''), created: Number(user.created) || 0, admin: !!user.admin, discord: discordIdOf(user) };
}

class LeaderboardService {
    constructor() {
        this.enabled = false;
        /** @type {LeaderboardStore|null} */
        this.store = null;
        /** @type {Map<string, Map<string, number>>} administrators' trial values: handle → board → value */
        this.tests = new Map();
        this.secret = '';
        /** Whether the secret is shared with the peers (from config.yaml). */
        this.shared = false;
        /** @type {{id: string, url: string, failures: number, nextAt: number, syncedAt: number, error: string, running: boolean}[]} */
        this.peers = [];
        this.syncIntervalMs = 3000;
        this.dirty = false;
        this.timers = [];
        this.running = false;
        /** @type {Worker|null} */
        this.worker = null;
        this.backfill = { total: 0, done: 0, running: false, error: '' };
    }

    get directory() {
        return path.join(globalThis.DATA_ROOT, DIRECTORY);
    }

    get stateFile() {
        return path.join(this.directory, 'state.json');
    }

    /**
     * Reads the settings and the saved numbers. Only the server calls this (not scripts that
     * merely import the module); it starts counting once this process serves.
     */
    start() {
        if (this.store) return;
        this.enabled = !!getConfigValue('leaderboard.enabled', false, 'boolean');
        if (!this.enabled) return;
        const site = String(getConfigValue('leaderboard.site', 'legacy'));
        if (!SITES.includes(site)) {
            console.warn(`[leaderboard] leaderboard.site must be one of ${SITES.join(', ')}; the leaderboard is off.`);
            this.enabled = false;
            return;
        }
        const configured = String(getConfigValue('leaderboard.secret', '') ?? '').trim();
        this.shared = configured.length >= 16;
        this.secret = this.shared ? configured : this.localSecret();
        const peers = getConfigValue('leaderboard.peers', []);
        this.peers = (Array.isArray(peers) ? peers : [])
            .map(peer => String(typeof peer === 'string' ? peer : peer?.url ?? '').trim().replace(/\/+$/, ''))
            .filter(url => /^https?:\/\//.test(url))
            .map(url => ({ id: url, url, failures: 0, nextAt: 0, syncedAt: 0, error: '', running: false }));
        if (this.peers.length && !this.shared) {
            console.warn('[leaderboard] leaderboard.peers needs leaderboard.secret (at least 16 characters, the same on both sites); counting this site alone.');
            this.peers = [];
        }
        this.syncIntervalMs = Math.max(1000, Number(getConfigValue('leaderboard.syncIntervalMs', 3000, 'number')) || 3000);
        this.store = new LeaderboardStore({ site, secret: this.secret });
        this.load();
        if (canPersistSharedState()) {
            void this.run();
        } else {
            // Next to a running server: it owns the numbers until this one takes over.
            // Counting starts at once; listing the users must not hold up the takeover.
            onActivate(() => {
                this.load();
                void this.run();
            });
        }
        onDrain(() => this.stop());
        const saveOnSignal = () => this.save();
        process.prependListener('SIGINT', saveOnSignal);
        process.prependListener('SIGTERM', saveOnSignal);
        console.log(`[leaderboard] ${site}, ${this.peers.length ? `exchanging with ${this.peers.length} site(s)` : 'this site alone'}`);
    }

    /** @returns {string} A secret for a site that does not share one */
    localSecret() {
        const file = path.join(this.directory, 'local-secret.txt');
        try {
            const existing = fs.readFileSync(file, 'utf8').trim();
            if (existing) return existing;
        } catch {
            // Made up below.
        }
        const secret = crypto.randomBytes(32).toString('hex');
        fs.mkdirSync(this.directory, { recursive: true });
        writeFileAtomicSync(file, secret, 'utf8');
        return secret;
    }

    load() {
        if (!this.store) return;
        try {
            if (!fs.existsSync(this.stateFile)) return;
            const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
            if (!this.store.importState(state)) console.warn('[leaderboard] The saved numbers are for another site; starting over.');
        } catch (error) {
            console.error('[leaderboard] Could not read the saved numbers:', error);
        }
    }

    save() {
        if (!this.store || !this.dirty || !canPersistSharedState()) return;
        try {
            fs.mkdirSync(this.directory, { recursive: true });
            writeFileAtomicSync(this.stateFile, JSON.stringify(this.store.exportState()), 'utf8');
            this.dirty = false;
        } catch (error) {
            console.error('[leaderboard] Could not save the numbers:', error);
        }
    }

    /** This process serves: count, save, exchange. */
    async run() {
        if (!this.store || this.running) return;
        this.running = true;
        this.timers.push(setInterval(() => this.save(), SAVE_INTERVAL_MS));
        this.timers.push(setInterval(() => void this.syncUsers(), USER_SYNC_INTERVAL_MS));
        if (this.peers.length) this.timers.push(setInterval(() => this.pullPeers(), Math.min(1000, this.syncIntervalMs)));
        for (const timer of this.timers) timer.unref?.();
        await this.syncUsers();
        this.pullPeers();
        this.startBackfill();
    }

    stop() {
        this.save();
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        this.running = false;
        if (this.worker) {
            void this.worker.terminate();
            this.worker = null;
        }
    }

    async syncUsers() {
        if (!this.store) return;
        try {
            const users = await getAllEnabledUsers();
            this.store.syncUsers(users.filter(user => user?.handle).map(accountOf));
            this.dirty = true;
        } catch (error) {
            console.error('[leaderboard] Could not list the users:', error);
        }
    }

    /**
     * @param {import('./users.js').User} profile Signed-in user
     * @returns {string|null} Their handle, once their account is known to the board
     */
    account(profile) {
        if (!this.store || !this.running || !profile?.handle) return null;
        this.store.ensureAccount(accountOf(profile));
        return profile.handle;
    }

    /**
     * @param {import('./users.js').User} profile
     * @returns {(() => void)|null} Call when the request failed
     */
    onGeneration(profile) {
        try {
            const handle = this.account(profile);
            if (!handle) return null;
            const credit = this.store.recordGeneration(handle);
            this.store.recordActivity(handle);
            this.dirty = true;
            return credit === undefined ? null : () => this.store?.revokeGeneration(handle, credit);
        } catch (error) {
            console.error('[leaderboard] Counting a generation failed:', error);
            return null;
        }
    }

    /**
     * @param {import('./users.js').User} profile
     * @param {unknown[]} messages
     * @param {{isGroup?: boolean, fromStart?: boolean}} options
     */
    onChatSave(profile, messages, options) {
        try {
            const handle = this.account(profile);
            if (!handle) return;
            this.store.recordMessages(handle, messages, options);
            // Even when nothing counted: which messages were seen must survive a reload.
            this.dirty = true;
        } catch (error) {
            console.error('[leaderboard] Counting a chat save failed:', error);
        }
    }

    /**
     * The page says somebody is using it.
     * @param {import('./users.js').User} profile
     * @param {number} clientNow The page's clock
     */
    onPing(profile, clientNow) {
        const handle = this.account(profile);
        if (!handle) return;
        if (Number.isFinite(clientNow)) this.store.recordClock(handle, clientNow);
        this.store.recordActivity(handle);
        this.dirty = true;
    }

    pullPeers() {
        const now = Date.now();
        for (const peer of this.peers) {
            if (peer.running || now < peer.nextAt) continue;
            peer.running = true;
            void this.pullPeer(peer).finally(() => {
                peer.running = false;
            });
        }
    }

    /** @param {typeof this.peers[number]} peer */
    async pullPeer(peer) {
        const known = this.store?.peers.get(peer.id);
        const query = `since=${known ? known.version : -1}&epoch=${known ? known.epoch : 'none'}`;
        try {
            const response = await fetch(`${peer.url}/api/leaderboard/peer?${query}`, {
                headers: { 'x-leaderboard-auth': signPeerRequest(this.secret, Date.now(), query), 'accept': 'application/json' },
                signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            if (!this.store?.applyPeer(peer.id, payload)) throw new Error('unexpected answer');
            // An administrator over there asked someone to choose again: their pages here too.
            for (const key of this.store.takeChoiceResets()) this.askToChoose(key);
            peer.failures = 0;
            peer.syncedAt = Date.now();
            peer.error = '';
            peer.nextAt = Date.now() + this.syncIntervalMs;
        } catch (error) {
            peer.failures++;
            peer.error = String(error?.message || error).slice(0, 200);
            peer.nextAt = Date.now() + Math.min(PEER_MAX_BACKOFF_MS, this.syncIntervalMs * 2 ** peer.failures);
            if (peer.failures === 1 || peer.failures % 50 === 0) console.warn(`[leaderboard] ${peer.url}: ${peer.error}`);
        }
    }

    /**
     * Administrators trying the board out: their own value on a board, which only they see. Kept in
     * memory only (gone when the server restarts) and never sent to the other site.
     * @param {string} handle
     * @param {string} board metric|window|site
     * @returns {number|undefined}
     */
    testValue(handle, board) {
        return this.tests.get(handle)?.get(board);
    }

    /**
     * @param {string} handle
     * @param {string} board metric|window|site
     * @param {number|null} value null: back to the real one
     */
    setTestValue(handle, board, value) {
        if (!this.tests.has(handle)) this.tests.set(handle, new Map());
        if (value === null) this.tests.get(handle).delete(board);
        else this.tests.get(handle).set(board, value);
    }

    /**
     * The open pages of this person on this site show the launch notice again at once (live channel;
     * pages without it find out when they next report being used).
     * @param {string} key Person key
     * @returns {number} Pages told
     */
    askToChoose(key) {
        const handles = this.store?.people().get(key)?.handles ?? [];
        return handles.length ? live.send({ handles }, 'leaderboard-choose') : 0;
    }

    /**
     * Answers another site (signed with the shared secret).
     * @param {import('express').Request} request
     * @param {import('express').Response} response
     */
    answerPeer(request, response) {
        if (!this.store || !this.running || !this.shared) return response.sendStatus(404);
        const query = request.originalUrl.split('?')[1] ?? '';
        if (!verifyPeerRequest(this.secret, request.get('x-leaderboard-auth'), query, Date.now())) return response.sendStatus(403);
        response.set('Cache-Control', 'no-store');
        return response.json(this.store.exportForPeer(Number(request.query.since), String(request.query.epoch ?? '')));
    }

    /**
     * Scans the chat files once for what happened before counting started (in a worker, slowly):
     * for every account from before then that was not scanned yet (also ones that come back, and
     * administrators, who were left out before they were ranked).
     */
    startBackfill() {
        if (!this.store || this.worker) return;
        const users = [...this.store.accounts.values()]
            .filter(account => !this.store.backfilled.has(account.handle) && !(account.created >= this.store.countingSince))
            .map(account => {
                const directories = getUserDirectories(account.handle);
                return { handle: account.handle, created: account.created, chats: directories.chats, groupChats: directories.groupChats };
            });
        this.backfill = { total: this.store.backfilled.size + users.length, done: this.store.backfilled.size, running: users.length > 0, error: '' };
        if (!users.length) {
            if (!this.store.backfillFinished) this.finishBackfill();
            return;
        }
        const worker = new Worker(new URL('./leaderboard-backfill.js', import.meta.url), {
            workerData: { secret: this.secret, countingSince: this.store.countingSince, users },
        });
        this.worker = worker;
        worker.on('message', message => {
            if (this.worker !== worker || !this.store || message?.type !== 'user') return;
            if (this.store.applyBackfill(message.handle, message.days)) {
                this.backfill.done++;
                this.dirty = true;
            }
        });
        worker.on('error', error => {
            console.error('[leaderboard] Scanning the chats failed:', error);
            this.backfill.error = String(error?.message || error);
        });
        worker.on('exit', code => {
            if (this.worker !== worker) return;
            this.worker = null;
            this.backfill.running = false;
            if (code === 0 && !this.backfill.error) this.finishBackfill();
        });
    }

    finishBackfill() {
        if (!this.store) return;
        this.store.backfillFinished = true;
        this.backfill.running = false;
        this.dirty = true;
        this.save();
        console.log(`[leaderboard] Chat history counted for ${this.store.backfilled.size} accounts.`);
    }

    /** @returns {{site: string, syncedAt: number, error: string}[]} */
    peerStatus() {
        return this.peers.map(peer => ({
            site: this.store?.peers.get(peer.id)?.site ?? '',
            syncedAt: peer.syncedAt,
            error: peer.error,
        }));
    }

    status() {
        const store = this.store;
        return {
            enabled: this.enabled,
            running: this.running,
            site: store?.site ?? null,
            shared: this.shared,
            accounts: store?.accounts.size ?? 0,
            people: store ? store.people().size : 0,
            version: store?.version ?? 0,
            epoch: store?.epoch ?? null,
            countingSince: store?.countingSince ?? null,
            backfill: { ...this.backfill, finished: !!store?.backfillFinished },
            peers: this.peers.map(peer => ({
                url: peer.url,
                site: store?.peers.get(peer.id)?.site ?? null,
                accounts: store?.peers.get(peer.id)?.accounts.size ?? 0,
                syncedAt: peer.syncedAt,
                failures: peer.failures,
                error: peer.error,
            })),
        };
    }
}

export const leaderboard = new LeaderboardService();

/**
 * Generation requests pay for AI replies. Runs after login, before the routers.
 * @type {import('express').RequestHandler}
 */
export function leaderboardGenerationMiddleware(request, response, next) {
    if (leaderboard.running && request.method === 'POST' && GENERATION_PATHS.has(request.path) && request.user?.profile) {
        // Paid at the start (a streamed reply is saved while it comes in), taken back if the model refused.
        const revoke = leaderboard.onGeneration(request.user.profile);
        if (revoke) response.on('finish', () => response.statusCode >= 400 && revoke());
    }
    next();
}

/**
 * Counts the new messages of a chat save. Never throws.
 * @param {import('express').Request} request
 * @param {unknown[]} messages
 * @param {{isGroup?: boolean, fromStart?: boolean}} options
 */
export function recordLeaderboardChatSave(request, messages, options) {
    if (leaderboard.running && request.user?.profile) leaderboard.onChatSave(request.user.profile, messages, options);
}

/**
 * GET /api/leaderboard/peer, for the other site. Mounted before login.
 * @type {import('express').RequestHandler}
 */
export function leaderboardPeerHandler(request, response) {
    return leaderboard.answerPeer(request, response);
}
