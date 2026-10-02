import fs from 'node:fs';
import path from 'node:path';

import { getLocalDateKey } from './storage-quota.js';

/**
 * Record of every backup, export and restore for the admin panel: whether it
 * worked, how big it was and who ran it.
 *
 * Each day is its own append-only JSON-lines file, so recording never rewrites
 * anything (two server processes can append side by side during a reload) and
 * old days are dropped by deleting their file.
 */
const DIRECTORY = path.join('_global', 'backup-activity');
const KEEP_DAYS = 14;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_USERS = 200;
const MAX_RECENT = 50;

/** @typedef {'full'|'partial'|'restore'} ActivityKind */
/** @typedef {'ok'|'failed'|'cancelled'|'rejected'|'downloaded'} ActivityStatus */

/**
 * @typedef {object} ActivityEvent
 * @property {number} t Time (ms)
 * @property {string} u User handle
 * @property {ActivityKind} k Kind
 * @property {ActivityStatus} s Outcome
 * @property {string} [id] Backup job id (links a download to its backup)
 * @property {boolean} [a] Done by an administrator
 * @property {number} [b] Bytes (archive size, or uploaded size for restores)
 * @property {number} [ms] Duration
 * @property {string} [r] Reason for a failure or rejection
 */

/** @type {Array<() => object[]>} */
const liveSources = [];
let lastPrunedDay = '';

function directoryPath() {
    return path.join(globalThis.DATA_ROOT, DIRECTORY);
}

function dayFile(date) {
    return path.join(directoryPath(), `${date}.jsonl`);
}

function pruneOldDays(today) {
    if (lastPrunedDay === today) return;
    lastPrunedDay = today;
    const cutoff = new Date(`${today}T00:00:00`);
    cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
    const oldest = getLocalDateKey(cutoff);
    for (const name of listDays()) {
        if (name < oldest) {
            fs.rm(dayFile(name), { force: true }, () => undefined);
        }
    }
}

/** @returns {string[]} Recorded days, newest first */
function listDays() {
    try {
        return fs.readdirSync(directoryPath())
            .filter(name => name.endsWith('.jsonl'))
            .map(name => name.slice(0, -'.jsonl'.length))
            .filter(name => DATE_PATTERN.test(name))
            .sort()
            .reverse();
    } catch {
        return [];
    }
}

/**
 * Records one event. Never throws: losing a log line must not fail a backup.
 * @param {Omit<ActivityEvent, 't'> & {t?: number}} event Event
 */
export function recordBackupActivity(event) {
    try {
        const entry = { t: Date.now(), ...event };
        for (const key of Object.keys(entry)) {
            if (entry[key] === undefined || entry[key] === false) delete entry[key];
        }
        const today = getLocalDateKey(new Date(entry.t));
        fs.mkdirSync(directoryPath(), { recursive: true });
        fs.appendFile(dayFile(today), `${JSON.stringify(entry)}\n`, error => {
            if (error) console.warn('Could not record backup activity:', error.message);
        });
        pruneOldDays(today);
    } catch (error) {
        console.warn('Could not record backup activity:', error?.message);
    }
}

/**
 * Adds a source of in-progress work (running backups, queued restores) to the admin view.
 * @param {() => object[]} source Returns the current items
 */
export function registerBackupLiveSource(source) {
    liveSources.push(source);
}

function readDay(date) {
    let text;
    try {
        text = fs.readFileSync(dayFile(date), 'utf8');
    } catch {
        return [];
    }
    /** @type {ActivityEvent[]} */
    const events = [];
    for (const line of text.split('\n')) {
        if (!line) continue;
        try {
            const event = JSON.parse(line);
            if (event && typeof event.u === 'string' && typeof event.k === 'string') events.push(event);
        } catch {
            // A line cut short by a crash.
        }
    }
    return events.sort((a, b) => a.t - b.t);
}

const emptyKind = () => ({ ok: 0, failed: 0, cancelled: 0, rejected: 0, bytes: 0, downloaded: 0 });

/**
 * One day of activity for the admin panel.
 * @param {string} [date] Day (YYYY-MM-DD), today by default
 */
export function getBackupActivitySummary(date) {
    const today = getLocalDateKey();
    const day = typeof date === 'string' && DATE_PATTERN.test(date) ? date : today;
    const events = readDay(day);
    const downloads = new Set(events.filter(event => event.s === 'downloaded' && event.id).map(event => event.id));

    const totals = { full: emptyKind(), partial: emptyKind(), restore: emptyKind(), users: 0 };
    /** @type {Map<string, any>} */
    const users = new Map();
    for (const event of events) {
        if (event.s === 'downloaded' || !totals[event.k]) continue;
        const user = users.get(event.u) ?? { handle: event.u, admin: false, full: emptyKind(), partial: emptyKind(), restore: emptyKind(), bytes: 0, lastAt: 0 };
        users.set(event.u, user);
        user.admin ||= Boolean(event.a);
        user.lastAt = Math.max(user.lastAt, event.t);
        for (const bucket of [totals[event.k], user[event.k]]) {
            bucket[event.s] = (bucket[event.s] ?? 0) + 1;
            if (event.s === 'ok') bucket.bytes += Number(event.b) || 0;
            if (event.s === 'ok' && event.id && downloads.has(event.id)) bucket.downloaded++;
        }
        if (event.s === 'ok') user.bytes += Number(event.b) || 0;
    }
    totals.users = users.size;

    const recent = events
        .filter(event => event.s !== 'downloaded')
        .slice(-MAX_RECENT)
        .reverse()
        .map(event => ({
            at: event.t,
            handle: event.u,
            admin: Boolean(event.a),
            kind: event.k,
            status: event.s,
            bytes: Number(event.b) || 0,
            durationMs: Number(event.ms) || 0,
            reason: event.r ?? '',
            downloaded: Boolean(event.id && downloads.has(event.id)),
        }));

    let live = [];
    for (const source of liveSources) {
        try {
            live = live.concat(source());
        } catch (error) {
            console.warn('Backup live source failed:', error?.message);
        }
    }

    return {
        date: day,
        today,
        days: [...new Set([today, ...listDays()])].sort().reverse().slice(0, KEEP_DAYS),
        totals,
        users: [...users.values()]
            .sort((a, b) => b.bytes - a.bytes || b.lastAt - a.lastAt)
            .slice(0, MAX_USERS),
        recent,
        live,
    };
}
