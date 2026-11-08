import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STATUS_CODES } from 'node:http';

import express from 'express';
import { WebSocketServer } from 'ws';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getConfigValue } from './util.js';
import { canPersistSharedState, getProcessPhase, onActivate, onDrain } from './process-lifecycle.js';
import { getCookieSecret, requireAdminMiddleware } from './users.js';

/**
 * Live channel: one WebSocket per open page, so the server can reach pages right away (reload
 * them, show a message, and whatever else registers a type). Kept small: plain JSON, one
 * connection per page, a heartbeat, and nothing else.
 *
 * Connecting: the page asks GET /api/live/ticket (an ordinary request, so login, IP whitelist and
 * everything else apply as usual) and opens /api/live?ticket=…&age=… within a minute. `age` is how
 * long ago the page was loaded.
 *
 * Messages are {t: type, d: data} both ways; commands also carry an id. The server sends
 * {t: 'ping'} every 30 s and the page answers {t: 'pong'}; either side drops a connection it has
 * not heard from in 75 s (the page then reconnects). The pings also keep Cloudflare, which closes
 * connections idle for 100 s, from closing it.
 *
 * Extending, on the server:
 *   live.send(target, type, data)       push to open pages; target {all: true} | {admins: true} | {handles: [...]}
 *   live.on(type, (client, data) => …)  handle a message pages send (client.send(type, data) answers)
 *   live.onConnect(client => …)         a page connected
 *   live.command(type, normalize, {keep})
 *                                       let administrators send `type`: from the admin panel,
 *                                       POST /api/live/send, or a file in <data>/_global/live/outbox/
 *                                       ({"type": …, "data": {…}, "target": {…}, "keep": seconds}).
 *                                       With `keep`, pages that were already open but not connected
 *                                       (asleep, or reconnecting after a restart) still get it when
 *                                       they connect within that many seconds.
 * and on the page (public/scripts/live.js): onLive(type, handler), sendLive(type, data), or
 * eventSource.on('live:<type>', handler) without importing anything.
 */

export const LIVE_PATH = '/api/live';
const HEARTBEAT_MS = 30e3;
const DEAD_AFTER_MS = 75e3;
const TICKET_MS = 60e3;
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_PAGES_PER_USER = 20;
const MAX_TARGET_HANDLES = 500;
const MAX_KEEP_S = 24 * 3600;
const MAX_KEPT = 50;
const MAX_PAGE_AGE_MS = 30 * 24 * 3600e3;
const OUTBOX_POLL_MS = 2000;

/**
 * @typedef {{all: true} | {admins: true} | {handles: string[]}} LiveTarget
 * @typedef {{id: string, type: string, data: any, target: LiveTarget, at: number, until: number}} KeptCommand
 * @typedef {{handle: string, admin: boolean}} LiveUser
 * @typedef {object} LiveClient
 * @property {import('ws').WebSocket} ws
 * @property {string} handle
 * @property {boolean} admin
 * @property {number} loadedAt When the page was loaded (server clock)
 * @property {number} heardAt
 * @property {(type: string, data?: unknown) => boolean} send
 */

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampInteger(value, min, max, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string} Trimmed text without control characters (line breaks kept)
 */
function cleanText(value, max) {
    return String(value ?? '').replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

/**
 * @param {unknown} target What to send to; leaving it out means all pages
 * @returns {LiveTarget|null}
 */
export function normalizeTarget(target = { all: true }) {
    if (!target || typeof target !== 'object') return null;
    const raw = /** @type {any} */ (target);
    if (raw.all === true) return { all: true };
    if (raw.admins === true) return { admins: true };
    const list = Array.isArray(raw.handles) ? raw.handles : typeof raw.handles === 'string' ? raw.handles.split(/[\s,，]+/) : [];
    const handles = [...new Set(list.map(handle => String(handle).trim()).filter(Boolean))].slice(0, MAX_TARGET_HANDLES);
    return handles.length ? { handles } : null;
}

/**
 * Reload the page `delay` seconds later; with `wait`, also not while a reply is being generated,
 * the user is typing or a dialog is open (ten minutes at most).
 * @param {any} data
 */
export function normalizeReload(data) {
    return { delay: clampInteger(data?.delay, 0, 300, 5), message: cleanText(data?.message, 200), wait: data?.wait !== false };
}

/**
 * A message in the corner of the page; `timeout` 0 keeps it until it is closed.
 * @param {any} data
 */
export function normalizeNotice(data) {
    const text = cleanText(data?.text, 1000);
    if (!text) return null;
    return {
        text,
        title: cleanText(data?.title, 60),
        level: ['info', 'success', 'warning', 'error'].includes(data?.level) ? data.level : 'info',
        timeout: clampInteger(data?.timeout, 0, 3600, 15),
    };
}

/**
 * @param {LiveTarget} target
 * @param {{handle: string, admin: boolean}} client
 * @returns {boolean}
 */
function targets(target, client) {
    if ('all' in target) return true;
    if ('admins' in target) return client.admin;
    return target.handles.includes(client.handle);
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {string} Path of the request, without the query
 */
function pathOf(request) {
    try {
        return new URL(request.url ?? '', 'http://localhost').pathname;
    } catch {
        return '';
    }
}

/**
 * @param {import('node:stream').Duplex} socket
 * @param {number} status
 */
function refuse(socket, status) {
    if (socket.writable) socket.write(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

export class LiveHub {
    constructor() {
        this.enabled = false;
        /** @type {Set<LiveClient>} */
        this.clients = new Set();
        /** @type {Map<string, (client: LiveClient, data: any) => void>} */
        this.handlers = new Map();
        /** @type {Map<string, {normalize: (data: any) => any, keep: number}>} */
        this.commands = new Map();
        /** @type {Array<(client: LiveClient) => void>} */
        this.connectHooks = [];
        /** @type {KeptCommand[]} */
        this.kept = [];
        /** @type {WebSocketServer|null} */
        this.wss = null;
        /** @type {NodeJS.Timeout[]} */
        this.timers = [];
        /** @type {Buffer|null} */
        this.key = null;
        this.command('reload', normalizeReload, { keep: 3600 });
        this.command('notice', normalizeNotice);
    }

    get folder() {
        return path.join(globalThis.DATA_ROOT, '_global', 'live');
    }

    /** The server calls this; scripts importing the module do not. */
    start() {
        if (this.wss) return;
        this.enabled = !!getConfigValue('live.enabled', true, 'boolean');
        if (!this.enabled) return;
        this.wss = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
        // Only the serving process pings, keeps commands and reads the outbox; one taking over starts then.
        if (canPersistSharedState()) this.run();
        else onActivate(() => this.run());
        onDrain(() => this.stop());
    }

    run() {
        if (this.timers.length) return;
        this.kept = this.loadKept();
        fs.mkdirSync(path.join(this.folder, 'outbox'), { recursive: true });
        this.timers.push(setInterval(() => this.heartbeat(), HEARTBEAT_MS));
        this.timers.push(setInterval(() => this.readOutbox(), OUTBOX_POLL_MS));
        for (const timer of this.timers) timer.unref?.();
    }

    /** Handing over to a new process: pages reconnect to it right away. */
    stop() {
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        const clients = [...this.clients];
        this.clients.clear();
        for (const client of clients) client.ws.close(1012, 'restarting');
        // A page that does not answer the close does not hold up the old process.
        setTimeout(() => clients.forEach(client => client.ws.terminate()), 3000).unref?.();
    }

    /** @param {import('node:http').Server} server */
    attach(server) {
        // Only WebSockets to the live channel are taken over; any other upgrade request (for
        // example h2c from some clients) stays an ordinary request, as before. Node 24.9+.
        server.shouldUpgradeCallback = request => !!this.wss && String(request.headers.upgrade ?? '').toLowerCase() === 'websocket' && pathOf(request) === LIVE_PATH;
        server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head));
    }

    /**
     * @param {import('node:http').IncomingMessage} request
     * @param {import('node:stream').Duplex} socket
     * @param {Buffer} head
     */
    upgrade(request, socket, head) {
        socket.on('error', () => socket.destroy());
        // Older Node versions send every upgrade request here.
        if (pathOf(request) !== LIVE_PATH || !this.wss) return refuse(socket, 404);
        const url = new URL(request.url ?? '', 'http://localhost');
        if (getProcessPhase() !== 'active') return refuse(socket, 503);
        const user = this.readTicket(url.searchParams.get('ticket'));
        if (!user) return refuse(socket, 401);
        const loadedAt = Date.now() - clampInteger(url.searchParams.get('age'), 0, MAX_PAGE_AGE_MS, 0);
        this.wss.handleUpgrade(request, socket, head, ws => this.connected(ws, user, loadedAt));
    }

    ticketKey() {
        this.key ??= crypto.createHmac('sha256', getCookieSecret(globalThis.DATA_ROOT)).update('live-ticket').digest();
        return this.key;
    }

    /**
     * @param {{handle: string, admin?: boolean}} user
     * @returns {string} A ticket to connect with, good for a minute
     */
    issueTicket(user) {
        const payload = Buffer.from(JSON.stringify({ h: user.handle, a: user.admin ? 1 : 0, e: Date.now() + TICKET_MS })).toString('base64url');
        return `${payload}.${crypto.createHmac('sha256', this.ticketKey()).update(payload).digest('base64url')}`;
    }

    /**
     * @param {unknown} ticket
     * @returns {LiveUser|null}
     */
    readTicket(ticket) {
        const [payload, signature, extra] = String(ticket ?? '').split('.');
        if (!payload || !signature || extra !== undefined) return null;
        const expected = crypto.createHmac('sha256', this.ticketKey()).update(payload).digest();
        const given = Buffer.from(signature, 'base64url');
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
        try {
            const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            if (typeof body?.h !== 'string' || !body.h || !(Number(body.e) > Date.now())) return null;
            return { handle: body.h, admin: body.a === 1 };
        } catch {
            return null;
        }
    }

    /**
     * @param {import('ws').WebSocket} ws
     * @param {LiveUser} user
     * @param {number} loadedAt
     */
    connected(ws, user, loadedAt) {
        /** @type {LiveClient} */
        const client = { ws, handle: user.handle, admin: user.admin, loadedAt, heardAt: Date.now(), send: (type, data) => this.deliver(client, type, data) };
        const pages = [...this.clients].filter(other => other.handle === client.handle);
        if (pages.length >= MAX_PAGES_PER_USER) {
            pages[0].ws.close(4008, 'too many pages');
            this.clients.delete(pages[0]);
        }
        this.clients.add(client);
        ws.on('message', (raw, isBinary) => this.receive(client, raw, isBinary));
        ws.on('close', () => this.clients.delete(client));
        ws.on('error', () => this.clients.delete(client));
        client.send('hello', { heartbeat: HEARTBEAT_MS });
        // Commands this page missed: sent after it was loaded, while it was not connected.
        const now = Date.now();
        for (const command of this.kept) {
            if (command.until > now && command.at > loadedAt && targets(command.target, client)) {
                this.deliver(client, command.type, command.data, command.id);
            }
        }
        for (const hook of this.connectHooks) {
            try {
                hook(client);
            } catch (error) {
                console.warn('[live] A connect hook failed:', error);
            }
        }
    }

    /**
     * @param {LiveClient} client
     * @param {import('ws').RawData} raw
     * @param {boolean} isBinary
     */
    receive(client, raw, isBinary) {
        client.heardAt = Date.now();
        if (isBinary) return;
        let message;
        try {
            message = JSON.parse(raw.toString());
        } catch {
            return;
        }
        const handler = typeof message?.t === 'string' ? this.handlers.get(message.t) : undefined;
        if (!handler) return;
        try {
            handler(client, message.d);
        } catch (error) {
            console.warn(`[live] Handling "${message.t}" failed:`, error);
        }
    }

    heartbeat() {
        const now = Date.now();
        for (const client of this.clients) {
            if (now - client.heardAt > DEAD_AFTER_MS) {
                this.clients.delete(client);
                client.ws.terminate();
            } else {
                client.send('ping');
            }
        }
    }

    /**
     * @param {LiveClient} client
     * @param {string} type
     * @param {unknown} [data]
     * @param {string} [id]
     * @returns {boolean} Whether it went out
     */
    deliver(client, type, data, id) {
        if (client.ws.readyState !== client.ws.OPEN) return false;
        /** @type {{t: string, d?: unknown, id?: string}} */
        const message = { t: type };
        if (data !== undefined) message.d = data;
        if (id) message.id = id;
        client.ws.send(JSON.stringify(message));
        return true;
    }

    /**
     * Pushes a message to the open pages of the target.
     * @param {unknown} target {all: true} | {admins: true} | {handles: [...]}
     * @param {string} type
     * @param {unknown} [data]
     * @param {string} [id] Lets a page tell a message it already had (commands)
     * @returns {number} Pages it went to
     */
    send(target, type, data, id) {
        const to = normalizeTarget(target);
        if (!to) return 0;
        let pages = 0;
        for (const client of this.clients) {
            if (targets(to, client) && this.deliver(client, type, data, id)) pages++;
        }
        return pages;
    }

    /**
     * Handles a message pages send.
     * @param {string} type
     * @param {(client: LiveClient, data: any) => void} handler
     */
    on(type, handler) {
        this.handlers.set(type, handler);
    }

    /** @param {(client: LiveClient) => void} hook */
    onConnect(hook) {
        this.connectHooks.push(hook);
    }

    /**
     * Lets administrators send this type.
     * @param {string} type
     * @param {(data: any) => any} normalize Checks and cleans the data; a falsy result refuses it
     * @param {{keep?: number}} [options] keep: seconds pages that connect later still get it (default)
     */
    command(type, normalize, { keep = 0 } = {}) {
        this.commands.set(type, { normalize, keep: clampInteger(keep, 0, MAX_KEEP_S, 0) });
    }

    /**
     * An administrator's command.
     * @param {any} request {type, data, target (default all pages), keep (seconds, default per type)}
     * @returns {{id?: string, pages?: number, kept?: boolean, error?: string}}
     */
    dispatch(request) {
        const command = this.commands.get(request?.type);
        if (!command) return { error: 'unknown_type' };
        const target = normalizeTarget(request.target ?? undefined);
        if (!target) return { error: 'bad_target' };
        const data = command.normalize(request.data ?? {});
        if (!data) return { error: 'bad_data' };
        const keep = clampInteger(request.keep, 0, MAX_KEEP_S, command.keep);
        const at = Date.now();
        const id = `${at.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
        if (keep > 0) {
            this.kept.push({ id, type: request.type, data, target, at, until: at + keep * 1000 });
            this.saveKept();
        }
        return { id, pages: this.send(target, request.type, data, id), kept: keep > 0 };
    }

    /**
     * Stops giving a kept command to pages that connect later.
     * @param {string} id
     * @returns {boolean}
     */
    cancel(id) {
        const count = this.kept.length;
        this.kept = this.kept.filter(command => command.id !== id);
        if (this.kept.length === count) return false;
        this.saveKept();
        return true;
    }

    /** @returns {KeptCommand[]} */
    loadKept() {
        try {
            const kept = JSON.parse(fs.readFileSync(path.join(this.folder, 'kept.json'), 'utf8'));
            return Array.isArray(kept) ? kept.filter(command => command?.until > Date.now() && normalizeTarget(command.target)) : [];
        } catch {
            return [];
        }
    }

    saveKept() {
        const now = Date.now();
        this.kept = this.kept.filter(command => command.until > now).slice(-MAX_KEPT);
        if (!canPersistSharedState()) return;
        try {
            fs.mkdirSync(this.folder, { recursive: true });
            writeFileAtomicSync(path.join(this.folder, 'kept.json'), JSON.stringify(this.kept), 'utf8');
        } catch (error) {
            console.warn('[live] Could not save kept commands:', error);
        }
    }

    /** Commands left as files, for scripts and deploys on the server itself. */
    readOutbox() {
        const outbox = path.join(this.folder, 'outbox');
        let names = [];
        try {
            names = fs.readdirSync(outbox).filter(name => name.endsWith('.json')).sort();
        } catch {
            return;
        }
        for (const name of names) {
            const file = path.join(outbox, name);
            let request = null;
            try {
                request = JSON.parse(fs.readFileSync(file, 'utf8'));
            } catch (error) {
                // Possibly still being written: try again next time, give up after a minute.
                if (Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) < 60e3) continue;
                console.warn(`[live] Unreadable command ${name}:`, error?.message ?? error);
            }
            fs.rmSync(file, { force: true });
            if (!request) continue;
            const result = this.dispatch(request);
            console.log(`[live] Command ${name}: ${request.type} → ${result.error ?? `${result.pages} page(s)${result.kept ? ', kept' : ''}`}`);
        }
    }

    status() {
        /** @type {Map<string, number>} */
        const users = new Map();
        let admins = 0;
        for (const client of this.clients) {
            users.set(client.handle, (users.get(client.handle) ?? 0) + 1);
            if (client.admin) admins++;
        }
        const now = Date.now();
        return {
            enabled: this.enabled,
            pages: this.clients.size,
            admins,
            users: [...users].map(([handle, pages]) => ({ handle, pages })).sort((a, b) => a.handle.localeCompare(b.handle)),
            commands: [...this.commands].map(([type, command]) => ({ type, keep: command.keep })),
            kept: this.kept.filter(command => command.until > now),
        };
    }
}

export const live = new LiveHub();

export const router = express.Router();

router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!live.enabled) return response.status(404).send({ error: 'disabled' });
    return next();
});

router.get('/ticket', (request, response) => {
    return response.send({ ticket: live.issueTicket(request.user.profile) });
});

router.get('/status', requireAdminMiddleware, (_request, response) => {
    return response.send(live.status());
});

router.post('/send', requireAdminMiddleware, (request, response) => {
    const result = live.dispatch(request.body);
    if (result.error) return response.status(400).send(result);
    console.log(`[live] ${request.user.profile.handle} sent ${request.body.type} → ${result.pages} page(s)${result.kept ? ', kept' : ''}`);
    return response.send(result);
});

router.post('/cancel', requireAdminMiddleware, (request, response) => {
    if (!live.cancel(String(request.body?.id ?? ''))) return response.status(404).send({ error: 'unknown_command' });
    return response.sendStatus(204);
});
