import fs from 'node:fs';
import path from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import { getLocalDateKey } from './storage-quota.js';
import { canPersistSharedState, onActivate } from './process-lifecycle.js';

/**
 * Daily limits for data exports, configured by administrators.
 * - full: complete user data backups (profile "Download backup")
 * - partial: multi-chat export bundles (chat import/export panel)
 */
export const BACKUP_KINDS = Object.freeze(['full', 'partial']);
export const BACKUP_LIMIT_MODES = Object.freeze(['unlimited', 'limited', 'disabled']);
const MAX_PER_DAY = 1000;
const STORAGE_DIRECTORY = '_global';
const POLICY_FILE = 'backup-limits.json';
const USAGE_FILE = 'backup-usage.json';

/** @typedef {'full'|'partial'} BackupKind */
/** @typedef {{mode: 'unlimited'|'limited'|'disabled', perDay: number}} BackupKindPolicy */
/** @typedef {{full: BackupKindPolicy, partial: BackupKindPolicy}} BackupLimitPolicy */

const DEFAULT_POLICY = Object.freeze({
    full: Object.freeze({ mode: 'unlimited', perDay: 3 }),
    partial: Object.freeze({ mode: 'unlimited', perDay: 10 }),
});

let queue = Promise.resolve();
/** @type {{date: string, users: Record<string, Record<string, number>>}|null} */
let usageCache = null;
// Hot reload: read the counts the previous server wrote.
onActivate(() => {
    usageCache = null;
});

function storagePath(file) {
    return path.join(globalThis.DATA_ROOT, STORAGE_DIRECTORY, file);
}

function serialize(task) {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(storagePath(file), 'utf8'));
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            console.warn(`Could not read ${file}, using defaults:`, error.message);
        }
        return fallback;
    }
}

async function writeJson(file, value) {
    // During a hot reload only the serving process owns these files.
    if (!canPersistSharedState()) return;
    await fs.promises.mkdir(path.dirname(storagePath(file)), { recursive: true });
    await writeFileAtomic(storagePath(file), JSON.stringify(value, null, 2), 'utf8');
}

/**
 * @param {unknown} value Raw policy for one kind
 * @param {BackupKindPolicy} fallback Default
 * @returns {BackupKindPolicy}
 */
function normalizeKindPolicy(value, fallback) {
    const input = value && typeof value === 'object' ? /** @type {any} */ (value) : {};
    const mode = BACKUP_LIMIT_MODES.includes(input.mode) ? input.mode : fallback.mode;
    const perDay = Number.isSafeInteger(Number(input.perDay)) ? Number(input.perDay) : fallback.perDay;
    return { mode, perDay: Math.min(MAX_PER_DAY, Math.max(1, perDay)) };
}

/**
 * @param {unknown} value Raw policy
 * @param {BackupLimitPolicy} [fallback] Values kept for fields that are missing or invalid
 * @returns {BackupLimitPolicy}
 */
export function normalizeBackupLimitPolicy(value, fallback = DEFAULT_POLICY) {
    const input = value && typeof value === 'object' ? /** @type {any} */ (value) : {};
    return {
        full: normalizeKindPolicy(input.full, fallback.full),
        partial: normalizeKindPolicy(input.partial, fallback.partial),
    };
}

/** @returns {BackupLimitPolicy} */
export function getBackupLimitPolicy() {
    return normalizeBackupLimitPolicy(readJson(POLICY_FILE, DEFAULT_POLICY));
}

/**
 * @param {unknown} value New policy from the admin panel
 * @returns {Promise<BackupLimitPolicy>} Saved policy
 */
export function saveBackupLimitPolicy(value) {
    return serialize(async () => {
        // Invalid fields keep the current setting instead of silently lifting a limit.
        const policy = normalizeBackupLimitPolicy(value, getBackupLimitPolicy());
        await writeJson(POLICY_FILE, policy);
        return policy;
    });
}

function loadUsage() {
    const today = getLocalDateKey();
    if (!usageCache) {
        const stored = readJson(USAGE_FILE, null);
        usageCache = stored && typeof stored === 'object' && stored.users && typeof stored.users === 'object'
            ? { date: String(stored.date || ''), users: stored.users }
            : { date: today, users: {} };
    }
    if (usageCache.date !== today) {
        usageCache = { date: today, users: {} };
    }
    return usageCache;
}

/**
 * @param {BackupKindPolicy} policy Policy for one kind
 * @param {number} used Uses today
 */
function describeQuota(policy, used) {
    const limit = policy.mode === 'limited' ? policy.perDay : policy.mode === 'disabled' ? 0 : null;
    return {
        mode: policy.mode,
        limit,
        used,
        remaining: limit === null ? null : Math.max(0, limit - used),
    };
}

/**
 * Today's quota for a user. Administrators are never limited.
 * @param {{handle: string, admin?: boolean}} profile User profile
 */
export function getBackupQuotaStatus(profile) {
    const policy = getBackupLimitPolicy();
    const usage = loadUsage();
    const counts = usage.users[profile.handle] ?? {};
    const exempt = Boolean(profile.admin);
    return {
        date: usage.date,
        exempt,
        full: exempt ? describeQuota({ mode: 'unlimited', perDay: 1 }, counts.full ?? 0) : describeQuota(policy.full, counts.full ?? 0),
        partial: exempt ? describeQuota({ mode: 'unlimited', perDay: 1 }, counts.partial ?? 0) : describeQuota(policy.partial, counts.partial ?? 0),
    };
}

export class BackupQuotaError extends Error {
    /**
     * @param {string} code Stable error code
     * @param {string} message User-facing message
     * @param {object} quota Quota status for the kind
     */
    constructor(code, message, quota) {
        super(message);
        this.name = 'BackupQuotaError';
        this.code = code;
        this.quota = quota;
    }
}

const KIND_LABELS = Object.freeze({ full: '全量备份', partial: '批量导出' });

/**
 * Failed or cancelled exports give their quota back, but each one still costs
 * the server work. After this many failures within the window, further
 * attempts wait until the oldest failure leaves the window.
 */
export const BACKUP_FAILURE_LIMIT = 5;
export const BACKUP_FAILURE_WINDOW_MS = 30 * 60 * 1000;

/** @type {Map<string, number[]>} Recent failure times per `${handle}\0${kind}` (in memory). */
const recentFailures = new Map();

function failureKey(handle, kind) {
    return `${handle}\0${kind}`;
}

function getRecentFailures(handle, kind, now = Date.now()) {
    const key = failureKey(handle, kind);
    const kept = (recentFailures.get(key) ?? []).filter(time => now - time < BACKUP_FAILURE_WINDOW_MS);
    if (kept.length) {
        recentFailures.set(key, kept);
    } else {
        recentFailures.delete(key);
    }
    return kept;
}

function recordBackupFailure(handle, kind) {
    const now = Date.now();
    recentFailures.set(failureKey(handle, kind), [...getRecentFailures(handle, kind, now), now]);
}

/** Test hook: forget recorded failures. */
export function resetBackupFailuresForTests() {
    recentFailures.clear();
}

/**
 * Atomically checks and consumes one use of today's quota.
 * @param {{handle: string, admin?: boolean}} profile Requesting user's profile
 * @param {BackupKind} kind Export kind
 * @returns {Promise<{release: (options?: {failed?: boolean}) => Promise<void>}>} Call release() if the
 *     export did not happen; pass `{ failed: false }` when nothing was attempted (e.g. joining a running job)
 * @throws {BackupQuotaError} When the export is disabled, today's quota is used up, or it failed too often recently
 */
export function consumeBackupQuota(profile, kind) {
    if (!BACKUP_KINDS.includes(kind)) {
        throw new TypeError(`Unknown backup kind: ${kind}`);
    }
    const noop = { release: async () => {} };
    if (profile.admin) {
        return Promise.resolve(noop);
    }
    return serialize(async () => {
        const policy = getBackupLimitPolicy()[kind];
        const usage = loadUsage();
        const counts = usage.users[profile.handle] ?? {};
        const used = counts[kind] ?? 0;
        const quota = describeQuota(policy, used);
        const label = KIND_LABELS[kind];
        if (policy.mode === 'disabled') {
            throw new BackupQuotaError('backup_disabled', `管理员已关闭${label}功能`, quota);
        }
        if (policy.mode === 'limited' && used >= policy.perDay) {
            throw new BackupQuotaError('backup_quota_exceeded', `今日${label}次数已用完（${used}/${policy.perDay}），请明天再试`, quota);
        }
        const failures = getRecentFailures(profile.handle, kind);
        if (failures.length >= BACKUP_FAILURE_LIMIT) {
            const waitMinutes = Math.max(1, Math.ceil((failures[0] + BACKUP_FAILURE_WINDOW_MS - Date.now()) / 60000));
            throw new BackupQuotaError('backup_retry_throttled', `${label}最近失败次数过多，请约 ${waitMinutes} 分钟后再试`, quota);
        }

        // Usage is recorded in every mode so administrators can see real demand.
        const date = usage.date;
        usage.users[profile.handle] = { ...counts, [kind]: used + 1 };
        await writeJson(USAGE_FILE, usage);
        let released = false;
        return {
            release: ({ failed = true } = {}) => serialize(async () => {
                if (released) {
                    return;
                }
                released = true;
                if (failed) {
                    recordBackupFailure(profile.handle, kind);
                }
                const current = loadUsage();
                if (current.date !== date) {
                    return;
                }
                const currentCounts = current.users[profile.handle] ?? {};
                current.users[profile.handle] = { ...currentCounts, [kind]: Math.max(0, (currentCounts[kind] ?? 0) - 1) };
                await writeJson(USAGE_FILE, current);
            }),
        };
    });
}

/**
 * Today's totals for the admin panel.
 * @param {number} [top] Number of heaviest users to list
 */
export function getBackupUsageSummary(top = 10) {
    const usage = loadUsage();
    const users = Object.entries(usage.users).map(([handle, counts]) => ({
        handle,
        full: counts.full ?? 0,
        partial: counts.partial ?? 0,
    }));
    return {
        date: usage.date,
        totals: {
            full: users.reduce((sum, user) => sum + user.full, 0),
            partial: users.reduce((sum, user) => sum + user.partial, 0),
            users: users.filter(user => user.full + user.partial > 0).length,
        },
        topUsers: users
            .filter(user => user.full + user.partial > 0)
            .sort((a, b) => (b.full + b.partial) - (a.full + a.partial) || a.handle.localeCompare(b.handle))
            .slice(0, top),
    };
}
