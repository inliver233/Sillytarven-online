import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { KeyedMutex } from '../keyed-mutex.js';
import { CATEGORIES, createTrackFilter, describePath, isHardExcluded, sanitizeTrackingRules } from './tracking.js';

/**
 * Repository storage and the operations every module builds on.
 *
 * A user's repository lives in `<data root>/_git/<handle>/repo.git` with the user's data
 * directory as its work tree. Keeping it outside the user directory means node snapshots and
 * replicas never copy git history. Every operation on one user's repository runs under that
 * user's lock.
 */

const locks = new KeyedMutex();
const SAFETY_PREFIX = 'refs/tavern/safety/';
const MAX_SAFETY_POINTS = 30;

/**
 * @typedef {object} RepoContext
 * @property {string} handle
 * @property {string} dir The user's data directory (work tree)
 * @property {string} gitdir
 * @property {string} root Directory holding the repository and its settings
 * @property {object} cache Shared isomorphic-git cache for one request
 */

/**
 * @param {string} handle
 * @param {string} dir
 * @returns {RepoContext}
 */
export function getRepoContext(handle, dir) {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(handle)) {
        throw new Error('Invalid user handle');
    }
    const root = path.join(globalThis.DATA_ROOT, '_git', handle);
    return { handle, dir, gitdir: path.join(root, 'repo.git'), root, cache: {} };
}

/**
 * Runs work on one user's repository while holding that user's lock.
 * @template T
 * @param {RepoContext} ctx
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withRepoLock(ctx, work) {
    try {
        return await locks.runExclusive(ctx.handle, work);
    } finally {
        scheduleMaintenance(ctx);
    }
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

/**
 * isomorphic-git writes every object loose and never as a delta, so each save of a grown chat
 * stores the whole file again (one user reached 530 MB in four days; 140 MB once packed).
 * Native git packs the repository once enough loose data piled up.
 *
 * isomorphic-git reads a whole pack into memory to use one object from it, so the layout
 * matters: commits and trees (all that status, commit and push read) go in one small pack,
 * file contents in packs of at most 32 MB, grouped by path so each file's versions delta
 * against each other. Only restoring or diffing old versions loads a content pack.
 */
const PACK_TRIGGER_KIB = 32 * 1024;
const PACK_TRIGGER_OBJECTS = 2000;
const MAX_PACKS = 16;
const MAX_CONTENT_PACK = '32m';
const maintenanceQueue = new KeyedMutex();
const pendingMaintenance = new Set();
/** Loose KiB left after the last packing, per handle (unreachable objects stay loose for a while). */
const looseAfterPacking = new Map();
let nativeGitMissing = false;

/**
 * @param {RepoContext} ctx
 * @param {string[]} args
 * @param {string} [input] Written to stdin
 * @returns {Promise<string>} stdout
 */
function runGit(ctx, args, input) {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['-c', `safe.directory=${ctx.gitdir}`, '--git-dir', ctx.gitdir, ...args], {
            cwd: ctx.gitdir,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 10 * 60 * 1000,
        });
        try {
            os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
            // The process may already be gone; priority is only a courtesy.
        }
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', chunk => stdout.push(chunk));
        child.stderr.on('data', chunk => stderr.push(chunk));
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) return resolve(Buffer.concat(stdout).toString('utf8'));
            reject(new Error(`git ${args[0]} exited with ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input ?? '');
    });
}

/**
 * @param {RepoContext} ctx
 * @returns {Promise<{ count: number, size: number, packs: number }>} Loose objects, loose KiB, packs
 */
async function countObjects(ctx) {
    const output = await runGit(ctx, ['count-objects', '-v']);
    const value = name => Number(output.match(new RegExp(`^${name}: (\\d+)`, 'm'))?.[1] ?? 0);
    return { count: value('count'), size: value('size'), packs: value('packs') };
}

/**
 * Repacks the repository when enough loose data piled up (or always with `force`).
 * Call under the repository lock.
 * @param {RepoContext} ctx
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<boolean>} Whether it repacked
 */
export async function maintainRepository(ctx, { force = false } = {}) {
    if (!repoExists(ctx)) return false;
    const before = await countObjects(ctx);
    const newLooseKiB = before.size - Math.min(looseAfterPacking.get(ctx.handle) ?? 0, before.size);
    if (!force && newLooseKiB < PACK_TRIGGER_KIB && before.count < PACK_TRIGGER_OBJECTS && before.packs <= MAX_PACKS) {
        return false;
    }

    const packDir = path.join(ctx.gitdir, 'objects', 'pack');
    const oldPacks = fs.existsSync(packDir) ? fs.readdirSync(packDir).filter(name => name.endsWith('.pack')).map(name => name.slice(0, -5)) : [];

    // Everything reachable from refs (branches, safety points, remotes) and the index
    const listing = (await runGit(ctx, ['rev-list', '--objects', '--all', '--indexed-objects'])).split('\n').filter(Boolean);
    const objects = listing.map(line => {
        const space = line.indexOf(' ');
        return space === -1 ? { oid: line, name: '' } : { oid: line.slice(0, space), name: line.slice(space + 1) };
    });
    const types = new Map((await runGit(ctx, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], objects.map(o => o.oid).join('\n') + '\n'))
        .split('\n').filter(Boolean).map(line => line.split(' ')));
    const line = o => o.name ? `${o.oid} ${o.name}` : o.oid;
    const structure = objects.filter(o => types.get(o.oid) !== 'blob');
    const contents = objects.filter(o => types.get(o.oid) === 'blob').sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

    const prefix = path.join(packDir, 'pack');
    fs.mkdirSync(packDir, { recursive: true });
    const written = new Set();
    for (const [list, extra] of [[structure, []], [contents, [`--max-pack-size=${MAX_CONTENT_PACK}`]]]) {
        if (list.length === 0) continue;
        const names = await runGit(ctx, ['pack-objects', '--quiet', ...extra, prefix], list.map(line).join('\n') + '\n');
        names.split('\n').filter(Boolean).forEach(hash => written.add(`pack-${hash}`));
    }

    for (const pack of oldPacks) {
        if (written.has(pack)) continue;
        // Index first: readers find packs through their .idx
        for (const extension of ['.idx', '.pack', '.rev', '.bitmap']) {
            fs.rmSync(path.join(packDir, pack + extension), { force: true });
        }
    }
    await runGit(ctx, ['prune-packed', '--quiet']);
    await runGit(ctx, ['prune', '--expire=2.weeks.ago']);

    const after = await countObjects(ctx);
    looseAfterPacking.set(ctx.handle, after.size);
    console.info(`[git-sync] packed the repository of ${ctx.handle}: ${before.count} loose objects (${Math.round(before.size / 1024)} MiB) and ${before.packs} packs → ${after.packs} packs`);
    return true;
}

/**
 * Queues packing after work on a repository: one repository at a time, under its lock.
 * @param {RepoContext} ctx
 */
function scheduleMaintenance(ctx) {
    if (nativeGitMissing || pendingMaintenance.has(ctx.handle)) return;
    pendingMaintenance.add(ctx.handle);
    maintenanceQueue.runExclusive('pack', () => locks.runExclusive(ctx.handle, () => {
        pendingMaintenance.delete(ctx.handle);
        return maintainRepository(ctx);
    })).catch(error => {
        pendingMaintenance.delete(ctx.handle);
        if (error?.code === 'ENOENT') {
            nativeGitMissing = true;
            console.warn('[git-sync] git is not installed; repositories will not be packed.');
            return;
        }
        console.warn(`[git-sync] packing the repository of ${ctx.handle} failed:`, error?.message || error);
    });
}

/** @param {RepoContext} ctx */
export function repoExists(ctx) {
    return fs.existsSync(path.join(ctx.gitdir, 'HEAD'));
}

// ---------------------------------------------------------------------------
// Settings stored next to the repository
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RemoteSettings
 * @property {string} url
 * @property {string} provider github | gitlab | gitee | gitea | custom
 * @property {string} username
 */

/**
 * @typedef {object} RepoSettings
 * @property {import('./tracking.js').TrackingRules} rules
 * @property {Record<string, RemoteSettings>} remotes
 * @property {{ name: string, email: string }} author
 * @property {{ enabled: boolean, intervalHours: number, push: boolean, remote: string, branch: string, lastRunAt: number, lastError: string }} autoBackup
 * @property {SmartCommitSettings} smartCommit
 */

/**
 * Commits made by the browser while the user plays, plus AI-written messages.
 * @typedef {object} SmartCommitSettings
 * @property {boolean} onChatSwitch Commit when the user leaves a chat
 * @property {number} everyMessages Commit after this many new messages (0 = off)
 * @property {boolean} push Push after an automatic commit
 * @property {string} remote
 * @property {boolean} aiMessages Let the model write commit messages (manual and automatic)
 * @property {boolean} beforeReroll Save the open chat before a reply is regenerated or swiped
 * @property {boolean} beforeDelete Save before a message, chat, character, lorebook, ... is deleted
 */

/** @param {any} value @returns {SmartCommitSettings} */
export function sanitizeSmartCommit(value) {
    const every = Number(value?.everyMessages);
    return {
        onChatSwitch: Boolean(value?.onChatSwitch),
        everyMessages: Number.isFinite(every) && every > 0 ? Math.min(Math.round(every), 500) : 0,
        push: Boolean(value?.push),
        remote: typeof value?.remote === 'string' && /^[\w.-]{1,50}$/.test(value.remote) ? value.remote : 'origin',
        // On unless turned off: AI-written messages, and the saves that protect against mistakes.
        aiMessages: value?.aiMessages === undefined ? true : Boolean(value.aiMessages),
        beforeReroll: value?.beforeReroll === undefined ? true : Boolean(value.beforeReroll),
        beforeDelete: value?.beforeDelete === undefined ? true : Boolean(value.beforeDelete),
    };
}

/** @returns {RepoSettings} */
function defaultSettings() {
    return {
        rules: sanitizeTrackingRules(null),
        remotes: {},
        author: { name: '', email: '' },
        autoBackup: { enabled: false, intervalHours: 24, push: true, remote: 'origin', branch: '', lastRunAt: 0, lastError: '' },
        smartCommit: sanitizeSmartCommit(null),
    };
}

/**
 * @param {RepoContext} ctx
 * @returns {RepoSettings}
 */
export function readSettings(ctx) {
    const settings = defaultSettings();
    try {
        const stored = JSON.parse(fs.readFileSync(path.join(ctx.root, 'settings.json'), 'utf8'));
        settings.rules = sanitizeTrackingRules(stored.rules);
        if (stored.remotes && typeof stored.remotes === 'object') settings.remotes = stored.remotes;
        if (stored.author && typeof stored.author === 'object') {
            settings.author = { name: String(stored.author.name ?? '').slice(0, 100), email: String(stored.author.email ?? '').slice(0, 200) };
        }
        if (stored.autoBackup && typeof stored.autoBackup === 'object') settings.autoBackup = { ...settings.autoBackup, ...stored.autoBackup };
        if (stored.smartCommit) settings.smartCommit = sanitizeSmartCommit(stored.smartCommit);
    } catch {
        // No settings yet
    }
    return settings;
}

/**
 * @param {RepoContext} ctx
 * @param {RepoSettings} settings
 */
export function writeSettings(ctx, settings) {
    fs.mkdirSync(ctx.root, { recursive: true });
    const file = path.join(ctx.root, 'settings.json');
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(settings, null, 2));
    fs.renameSync(temp, file);
}

/**
 * @param {RepoContext} ctx
 * @param {RepoSettings} settings
 * @param {string} fallbackName
 */
export function authorOf(settings, fallbackName) {
    const name = settings.author.name || fallbackName || 'Tavern';
    const email = settings.author.email || `${name.replace(/[^\w.-]/g, '') || 'tavern'}@tavern.local`;
    return { name, email };
}

// ---------------------------------------------------------------------------
// Repository basics
// ---------------------------------------------------------------------------

/**
 * Creates the repository if it does not exist yet.
 * @param {RepoContext} ctx
 * @param {string} [defaultBranch]
 */
export async function ensureRepo(ctx, defaultBranch = 'main') {
    if (repoExists(ctx)) return false;
    fs.mkdirSync(ctx.root, { recursive: true });
    await git.init({ fs, dir: ctx.dir, gitdir: ctx.gitdir, defaultBranch });
    return true;
}

/** @param {RepoContext} ctx */
export async function headOid(ctx) {
    try {
        return await git.resolveRef({ fs, gitdir: ctx.gitdir, ref: 'HEAD' });
    } catch {
        return null;
    }
}

/** @param {RepoContext} ctx */
export async function currentBranch(ctx) {
    return (await git.currentBranch({ fs, gitdir: ctx.gitdir, fullname: false }).catch(() => null)) ?? null;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Change
 * @property {string} path
 * @property {'added'|'modified'|'deleted'|'untracked'} kind 'untracked' = no longer in the tracking scope
 * @property {string} category
 * @property {string} categoryLabel
 * @property {string} item
 * @property {number} [size]
 * @property {boolean} [tooLarge]
 */

/**
 * Lists what a commit would record now.
 * @param {RepoContext} ctx
 * @param {RepoSettings} settings
 * @param {{ filepaths?: string[] }} [options] Only look at these files (no full scan, no "stopped tracking" list)
 * @returns {Promise<{ changes: Change[], skipped: Change[] }>}
 */
export async function getStatus(ctx, settings, { filepaths } = {}) {
    const tracked = createTrackFilter(settings.rules);
    const maxBytes = settings.rules.maxFileSizeMiB * 1024 * 1024;
    const head = await headOid(ctx);
    const matrix = await git.statusMatrix({ fs, dir: ctx.dir, gitdir: ctx.gitdir, filter: tracked, cache: ctx.cache, ...(filepaths ? { filepaths } : {}) });

    // isomorphic-git trusts size + mtime in whole seconds. A file rewritten with the same size in
    // the same second the index was written looks unchanged ("racy git"); hash those to be sure.
    const indexSecond = (() => {
        try {
            return Math.floor(fs.statSync(path.join(ctx.gitdir, 'index')).mtimeMs / 1000);
        } catch {
            return Infinity;
        }
    })();
    for (const row of matrix) {
        const [filepath, headStatus, workdirStatus] = row;
        if (!head || headStatus !== 1 || workdirStatus !== 1) continue;
        let stat;
        try {
            stat = fs.statSync(path.join(ctx.dir, filepath));
        } catch {
            continue;
        }
        if (Math.floor(stat.mtimeMs / 1000) < indexSecond) continue;
        const [{ oid: current }, committed] = await Promise.all([
            git.hashBlob({ object: fs.readFileSync(path.join(ctx.dir, filepath)) }),
            git.readBlob({ fs, gitdir: ctx.gitdir, oid: head, filepath, cache: ctx.cache }).then(blob => blob.oid).catch(() => null),
        ]);
        if (current !== committed) row[2] = 2;
    }

    const changes = [];
    const skipped = [];
    for (const [filepath, headStatus, workdirStatus] of matrix) {
        if (headStatus === 1 && workdirStatus === 1) continue;
        let kind;
        if (headStatus === 0 && workdirStatus === 2) kind = 'added';
        else if (headStatus === 1 && workdirStatus === 2) kind = 'modified';
        else if (headStatus === 1 && workdirStatus === 0) kind = 'deleted';
        else continue;
        const change = { path: filepath, kind, ...describePath(filepath) };
        if (kind !== 'deleted') {
            change.size = fs.statSync(path.join(ctx.dir, filepath)).size;
            if (change.size > maxBytes) {
                skipped.push({ ...change, tooLarge: true });
                continue;
            }
        }
        changes.push(change);
    }

    // Files committed earlier that the current scope no longer includes are dropped from the next commit.
    // Files that should never have been stored (a later hard exclude) go quietly, not as a change.
    const cleanup = [];
    if (head && !filepaths) {
        const inHead = await git.listFiles({ fs, gitdir: ctx.gitdir, ref: head, cache: ctx.cache });
        for (const filepath of inHead) {
            if (isHardExcluded(filepath)) {
                cleanup.push(filepath);
            } else if (!tracked(filepath)) {
                changes.push({ path: filepath, kind: 'untracked', ...describePath(filepath) });
            }
        }
    }
    return { changes, skipped, cleanup };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

const KIND_LABEL = { added: '新增', modified: '更新', deleted: '删除', untracked: '停止同步' };

/**
 * Builds a commit message in tavern terms, e.g. "更新聊天：Seraphina · 初遇 等 3 项；新增角色卡：艾琳".
 * @param {Change[]} changes
 */
export function describeChanges(changes) {
    /** @type {Map<string, { kind: string, label: string, items: Set<string> }>} */
    const groups = new Map();
    for (const change of changes) {
        const key = `${change.kind}|${change.category}`;
        const group = groups.get(key) ?? { kind: change.kind, label: change.categoryLabel, items: new Set() };
        group.items.add(change.item);
        groups.set(key, group);
    }
    if (groups.size > 3) {
        // Many kinds at once (a first save, an import): counts per kind instead of names.
        const byKind = new Map();
        for (const { kind, label, items } of groups.values()) {
            if (!byKind.has(kind)) byKind.set(kind, []);
            byKind.get(kind).push({ label, count: items.size });
        }
        return [...byKind].map(([kind, list]) => {
            const total = list.reduce((sum, entry) => sum + entry.count, 0);
            const top = list.sort((a, b) => b.count - a.count).slice(0, 3).map(entry => `${entry.label} ${entry.count}`).join('、');
            return `${KIND_LABEL[kind]} ${total} 项：${top}${list.length > 3 ? ` 等 ${list.length} 类` : ''}`;
        }).join('；');
    }
    const parts = [...groups.values()].map(({ kind, label, items }) => {
        const names = [...items];
        const shown = names.slice(0, 2).join('、');
        return `${KIND_LABEL[kind]}${label}：${shown}${names.length > 2 ? ` 等 ${names.length} 项` : ''}`;
    });
    return parts.join('；') || '没有改动';
}

/**
 * Records the current tracked state. Returns null when there is nothing to record.
 * @param {RepoContext} ctx
 * @param {RepoSettings} settings
 * @param {{ message?: string, author: { name: string, email: string }, paths?: string[] }} options
 */
export async function commitAll(ctx, settings, { message, author, paths }) {
    const { changes, cleanup } = await getStatus(ctx, settings);
    const selected = paths ? changes.filter(change => paths.includes(change.path)) : changes;
    if (!selected.length) return null;
    // Start from HEAD so a previous, interrupted operation cannot leak staged files into this commit.
    await resetIndexToHead(ctx);
    return recordChanges(ctx, selected, { message, author, cleanup });
}

/**
 * Records a few known files (the open chat) without scanning the rest of the user's data, so it
 * is cheap enough to run every few messages. Returns null when they have not changed.
 * @param {RepoContext} ctx
 * @param {RepoSettings} settings
 * @param {{ message?: string, author: { name: string, email: string }, paths: string[] }} options
 */
export async function commitFiles(ctx, settings, { message, author, paths }) {
    const { changes } = await getStatus(ctx, settings, { filepaths: paths });
    if (!changes.length) return null;
    const head = await headOid(ctx);
    for (const change of changes) {
        await git.resetIndex({ fs, dir: ctx.dir, gitdir: ctx.gitdir, filepath: change.path, ...(head ? { ref: head } : {}), cache: ctx.cache });
    }
    return recordChanges(ctx, changes, { message, author });
}

/**
 * Records all changes as one commit per kind of data (chats, characters, lorebooks, ...), so the
 * history can be read and restored by kind.
 * @param {RepoContext} ctx
 * @param {RepoSettings} settings
 * @param {{ message?: string, author: { name: string, email: string } }} options The message goes on the chats commit (or the first one)
 * @returns {Promise<{ oid: string, summary: string, count: number, commits: { oid: string, summary: string }[] } | null>}
 */
export async function commitByCategory(ctx, settings, { message, author }) {
    const { changes, cleanup } = await getStatus(ctx, settings);
    if (!changes.length) return null;
    await resetIndexToHead(ctx);
    const order = CATEGORIES.map(category => category.id);
    const groups = new Map();
    for (const change of changes) {
        if (!groups.has(change.category)) groups.set(change.category, []);
        groups.get(change.category).push(change);
    }
    const sorted = [...groups.entries()].sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    const messageOn = groups.has('chats') ? 'chats' : sorted[0][0];
    const commits = [];
    for (const [category, group] of sorted) {
        const result = await recordChanges(ctx, group, { message: category === messageOn ? message : '', author, cleanup: commits.length ? [] : cleanup });
        commits.push({ oid: result.oid, summary: result.summary });
    }
    return { oid: commits.at(-1).oid, summary: commits.map(commit => commit.summary).join('；'), count: changes.length, commits };
}

/**
 * Stages the given changes on top of the current index and commits.
 * @param {RepoContext} ctx
 * @param {Change[]} selected
 * @param {{ message?: string, author: { name: string, email: string }, cleanup?: string[] }} options cleanup: stored files to drop without listing them
 */
async function recordChanges(ctx, selected, { message, author, cleanup = [] }) {
    const toAdd = selected.filter(change => change.kind === 'added' || change.kind === 'modified').map(change => change.path);
    const toRemove = selected.filter(change => change.kind === 'deleted' || change.kind === 'untracked').map(change => change.path);
    if (toAdd.some(isHardExcluded)) {
        throw new Error('Refusing to record an excluded file');
    }
    for (let i = 0; i < toAdd.length; i += 200) {
        await git.add({ fs, dir: ctx.dir, gitdir: ctx.gitdir, filepath: toAdd.slice(i, i + 200), cache: ctx.cache });
    }
    for (const filepath of [...toRemove, ...cleanup]) {
        await git.remove({ fs, dir: ctx.dir, gitdir: ctx.gitdir, filepath, cache: ctx.cache });
    }
    const summary = describeChanges(selected);
    const oid = await git.commit({
        fs, dir: ctx.dir, gitdir: ctx.gitdir, cache: ctx.cache, author,
        message: message?.trim() ? `${message.trim()}\n\n${summary}` : summary,
    });
    return { oid, summary, count: selected.length };
}

/**
 * Makes the index match HEAD, leaving the work tree alone.
 * @param {RepoContext} ctx
 */
async function resetIndexToHead(ctx) {
    const head = await headOid(ctx);
    const indexFile = path.join(ctx.gitdir, 'index');
    if (!head) {
        fs.rmSync(indexFile, { force: true });
        return;
    }
    const staged = await git.listFiles({ fs, gitdir: ctx.gitdir, cache: ctx.cache });
    const inHead = new Set(await git.listFiles({ fs, gitdir: ctx.gitdir, ref: head, cache: ctx.cache }));
    for (const filepath of new Set([...staged, ...inHead])) {
        await git.resetIndex({ fs, dir: ctx.dir, gitdir: ctx.gitdir, filepath, ref: head, cache: ctx.cache });
    }
}

// ---------------------------------------------------------------------------
// Safety points: the state before anything overwrites the user's data
// ---------------------------------------------------------------------------

/**
 * Records the current data (committed or not) under refs/tavern/safety/ without moving any branch.
 * @param {RepoContext} ctx
 * @param {RepoSettings} settings
 * @param {string} reason Shown in the list of safety points
 * @param {{ name: string, email: string }} author
 * @returns {Promise<string|null>} The safety point's commit, or null if there is no data yet
 */
export async function createSafetyPoint(ctx, settings, reason, author) {
    const head = await headOid(ctx);
    const { changes } = await getStatus(ctx, settings);
    let oid = head;
    if (changes.length) {
        await resetIndexToHead(ctx);
        const toAdd = changes.filter(change => change.kind === 'added' || change.kind === 'modified').map(change => change.path);
        for (let i = 0; i < toAdd.length; i += 200) {
            await git.add({ fs, dir: ctx.dir, gitdir: ctx.gitdir, filepath: toAdd.slice(i, i + 200), cache: ctx.cache });
        }
        for (const change of changes.filter(change => change.kind === 'deleted' || change.kind === 'untracked')) {
            await git.remove({ fs, dir: ctx.dir, gitdir: ctx.gitdir, filepath: change.path, cache: ctx.cache });
        }
        const tree = await git.writeTree({ fs, gitdir: ctx.gitdir, tree: await indexTree(ctx) });
        oid = await git.commit({
            fs, gitdir: ctx.gitdir, cache: ctx.cache, author, tree, parent: head ? [head] : [],
            message: `安全存档：${reason}\n\n${describeChanges(changes)}`, noUpdateBranch: true,
        });
        await resetIndexToHead(ctx);
    }
    if (!oid) return null;
    const ref = `${SAFETY_PREFIX}${Date.now()}`;
    await git.writeRef({ fs, gitdir: ctx.gitdir, ref, value: oid, force: true });
    fs.writeFileSync(path.join(ctx.root, 'safety-reasons.json'), JSON.stringify({ ...readSafetyReasons(ctx), [ref]: reason }));
    await pruneSafetyPoints(ctx);
    return oid;
}

/** Tree entries for the current index, as git.writeTree expects (nested trees written first). */
async function indexTree(ctx) {
    /** @type {Map<string, { mode: string, oid: string }>} */
    const flat = new Map();
    await git.walk({
        fs, dir: ctx.dir, gitdir: ctx.gitdir, cache: ctx.cache, trees: [git.STAGE()],
        map: async (filepath, [entry]) => {
            if (!entry || filepath === '.') return true;
            if ((await entry.type()) === 'blob') {
                flat.set(filepath, { mode: (await entry.mode()).toString(8), oid: await entry.oid() });
            }
            return true;
        },
    });
    return writeTreesFromFlat(ctx, flat);
}

/**
 * Writes nested tree objects for a flat map of file paths and returns the root tree's entries.
 * @param {RepoContext} ctx
 * @param {Map<string, { mode: string, oid: string }>} flat
 */
export async function writeTreesFromFlat(ctx, flat) {
    /** @type {Map<string, Map<string, { mode: string, oid: string, type: string }>>} */
    const dirs = new Map([['', new Map()]]);
    for (const [filepath, entry] of flat) {
        const parts = filepath.split('/');
        for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i - 1).join('/');
            const child = parts.slice(0, i).join('/');
            if (!dirs.has(child)) dirs.set(child, new Map());
            if (!dirs.has(parent)) dirs.set(parent, new Map());
            dirs.get(parent).set(parts[i - 1], { mode: '040000', oid: '', type: 'tree' });
        }
        dirs.get(parts.slice(0, -1).join('/')).set(parts[parts.length - 1], { ...entry, type: 'blob' });
    }
    const order = [...dirs.keys()].sort((a, b) => b.split('/').length - a.split('/').length || (b.length - a.length));
    /** @type {Map<string, string>} */
    const treeOids = new Map();
    let rootEntries = [];
    for (const dirPath of order) {
        const entries = [...dirs.get(dirPath)].map(([name, entry]) => ({
            mode: entry.mode, path: name, type: entry.type,
            oid: entry.type === 'tree' ? treeOids.get(dirPath ? `${dirPath}/${name}` : name) : entry.oid,
        }));
        if (dirPath === '') {
            rootEntries = entries;
        } else {
            treeOids.set(dirPath, await git.writeTree({ fs, gitdir: ctx.gitdir, tree: entries }));
        }
    }
    return rootEntries;
}

function readSafetyReasons(ctx) {
    try {
        return JSON.parse(fs.readFileSync(path.join(ctx.root, 'safety-reasons.json'), 'utf8'));
    } catch {
        return {};
    }
}

/** @param {RepoContext} ctx */
export async function listSafetyPoints(ctx) {
    const reasons = readSafetyReasons(ctx);
    const refs = await git.listRefs({ fs, gitdir: ctx.gitdir, filepath: SAFETY_PREFIX.slice(0, -1) }).catch(() => []);
    const points = [];
    for (const name of refs) {
        const ref = `${SAFETY_PREFIX}${name}`;
        const oid = await git.resolveRef({ fs, gitdir: ctx.gitdir, ref });
        points.push({ id: name, ref, oid, createdAt: Number(name), reason: reasons[ref] ?? '' });
    }
    return points.sort((a, b) => b.createdAt - a.createdAt);
}

async function pruneSafetyPoints(ctx) {
    const points = await listSafetyPoints(ctx);
    const reasons = readSafetyReasons(ctx);
    for (const point of points.slice(MAX_SAFETY_POINTS)) {
        await git.deleteRef({ fs, gitdir: ctx.gitdir, ref: point.ref });
        delete reasons[point.ref];
    }
    fs.writeFileSync(path.join(ctx.root, 'safety-reasons.json'), JSON.stringify(reasons));
}

// ---------------------------------------------------------------------------
// Changing the work tree
// ---------------------------------------------------------------------------

/**
 * Replaces the tracked data with a commit's content (after a safety point), optionally only some paths.
 * Untracked and excluded files (secrets, extensions when not tracked, ...) are left alone.
 * @param {RepoContext} ctx
 * @param {string} oid Commit to apply
 * @param {{ paths?: string[], moveBranch?: string|null }} [options] moveBranch: point this branch at oid and check it out
 */
export async function applyCommitToWorkTree(ctx, oid, { paths, moveBranch } = {}) {
    if (paths?.length) {
        await git.checkout({ fs, dir: ctx.dir, gitdir: ctx.gitdir, ref: oid, filepaths: paths, force: true, noUpdateHead: true, cache: ctx.cache });
        // The index keeps HEAD's view so restored files show up as changes to record.
        for (const filepath of paths) {
            await git.resetIndex({ fs, dir: ctx.dir, gitdir: ctx.gitdir, filepath, cache: ctx.cache }).catch(() => {});
        }
        dropChatRevisions(ctx, paths);
        return;
    }
    if (moveBranch) {
        await git.writeRef({ fs, gitdir: ctx.gitdir, ref: `refs/heads/${moveBranch}`, value: oid, force: true });
        await git.checkout({ fs, dir: ctx.dir, gitdir: ctx.gitdir, ref: moveBranch, force: true, cache: ctx.cache });
    } else {
        await git.checkout({ fs, dir: ctx.dir, gitdir: ctx.gitdir, ref: oid, force: true, cache: ctx.cache });
    }
    dropChatRevisions(ctx, null);
}

const CHAT_FOLDERS = ['chats', 'group chats'];
const REVISION_SUFFIX = '.jsonl.revision.json';

/**
 * Chats whose files were just replaced keep their save token (.jsonl.revision.json) otherwise,
 * old ones written back by a checkout included. Removing it makes the server derive a new token
 * from the restored content, so a page still holding the old chat cannot save over it.
 * @param {RepoContext} ctx
 * @param {string[]|null} paths Restored files, or null for all chats
 */
function dropChatRevisions(ctx, paths) {
    const remove = (file) => {
        try {
            fs.rmSync(path.join(ctx.dir, file), { force: true });
        } catch (error) {
            console.warn('[git-sync] could not remove chat revision', file, error?.message);
        }
    };
    if (paths) {
        const bases = new Set(paths.filter(file => CHAT_FOLDERS.some(folder => file.startsWith(`${folder}/`))).map(file => file.replace(/\.jsonl(\..*)?$/, '')));
        for (const base of bases) remove(`${base}${REVISION_SUFFIX}`);
        return;
    }
    const walk = (relative) => {
        let entries;
        try {
            entries = fs.readdirSync(path.join(ctx.dir, relative), { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const child = `${relative}/${entry.name}`;
            if (entry.isDirectory() && !entry.name.endsWith('.chunks')) walk(child);
            else if (entry.isFile() && entry.name.endsWith(REVISION_SUFFIX)) remove(child);
        }
    };
    CHAT_FOLDERS.forEach(walk);
}

/**
 * Lists files that differ between two commits (either may be null for "empty").
 * @param {RepoContext} ctx
 * @param {string|null} fromOid
 * @param {string|null} toOid
 */
export async function diffCommits(ctx, fromOid, toOid) {
    // A missing side is compared against an empty tree, written once so the walker can read it.
    const empty = (!fromOid || !toOid) ? await git.writeTree({ fs, gitdir: ctx.gitdir, tree: [] }) : null;
    const results = [];
    await git.walk({
        fs, gitdir: ctx.gitdir, cache: ctx.cache, trees: [git.TREE({ ref: fromOid ?? empty }), git.TREE({ ref: toOid ?? empty })],
        map: async (filepath, [a, b]) => {
            if (filepath === '.') return true;
            const [aType, bType] = await Promise.all([a?.type(), b?.type()]);
            if (aType === 'tree' || bType === 'tree') return true;
            const [aOid, bOid] = await Promise.all([a?.oid(), b?.oid()]);
            if (aOid === bOid) return undefined;
            const kind = !aOid ? 'added' : !bOid ? 'deleted' : 'modified';
            results.push({ path: filepath, kind, ...describePath(filepath) });
            return undefined;
        },
    });
    return results;
}

// ---------------------------------------------------------------------------
// Change digest: what changed inside the files, for AI-written commit messages
// ---------------------------------------------------------------------------

const DIGEST_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** @param {Buffer|null} buffer */
function jsonOf(buffer) {
    try {
        return buffer ? JSON.parse(buffer.toString('utf8')) : null;
    } catch {
        return null;
    }
}

/**
 * Keys that differ between two JSON values, as dotted paths two levels deep.
 * @param {any} before
 * @param {any} after
 */
function changedKeys(before, after, prefix = '', depth = 0) {
    const out = [];
    const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
    if (!isObject(before) || !isObject(after) || depth >= 2) {
        return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix || '(内容)'];
    }
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
        const path = prefix ? `${prefix}.${key}` : key;
        if (isObject(before[key]) && isObject(after[key]) && depth < 1) out.push(...changedKeys(before[key], after[key], path, depth + 1));
        else out.push(path);
    }
    return out;
}

/** Messages present now but not before, from JSONL chat text. */
function addedMessages(beforeText, afterText) {
    const seen = new Set((beforeText ?? '').split('\n'));
    const messages = [];
    for (const line of (afterText ?? '').split('\n')) {
        if (!line || seen.has(line)) continue;
        try {
            const entry = JSON.parse(line);
            if (typeof entry?.mes === 'string' && entry.mes.trim()) {
                messages.push({ name: String(entry.name ?? '').slice(0, 40), text: entry.mes.replace(/\s+/g, ' ').trim().slice(0, 120) });
            }
        } catch {
            // Not a message line
        }
    }
    return messages;
}

/**
 * Describes what changed inside the changed files, grouped by tavern item.
 * @param {RepoContext} ctx
 * @param {Change[]} changes
 * @param {{ maxItems?: number, maxMessages?: number }} [limits]
 */
export async function getChangeDigest(ctx, changes, { maxItems = 30, maxMessages = 6 } = {}) {
    const head = await headOid(ctx);
    const readHead = async (filepath) => {
        if (!head) return null;
        const blob = await git.readBlob({ fs, gitdir: ctx.gitdir, oid: head, filepath, cache: ctx.cache }).catch(() => null);
        return blob && blob.blob.length <= DIGEST_MAX_FILE_BYTES ? Buffer.from(blob.blob) : null;
    };
    const readNow = (filepath) => {
        try {
            const full = path.join(ctx.dir, filepath);
            return fs.statSync(full).size <= DIGEST_MAX_FILE_BYTES ? fs.readFileSync(full) : null;
        } catch {
            return null;
        }
    };

    /** @type {Map<string, any>} */
    const items = new Map();
    for (const change of changes) {
        const key = `${change.category}|${change.item}`;
        const item = items.get(key) ?? { category: change.category, categoryLabel: change.categoryLabel, item: change.item, kind: change.kind, messages: [], keys: [] };
        if (item.kind !== change.kind) item.kind = 'modified';
        items.set(key, item);
        if (items.size > maxItems || change.kind === 'deleted' || change.kind === 'untracked') continue;

        if ((change.category === 'chats' || change.category === 'groupChats') && /\.jsonl$/.test(change.path)) {
            const [before, after] = await Promise.all([readHead(change.path), readNow(change.path)]);
            item.messages.push(...addedMessages(before?.toString('utf8'), after?.toString('utf8')));
        } else if (/\.json$/i.test(change.path) && change.kind === 'modified') {
            const [before, after] = await Promise.all([readHead(change.path), readNow(change.path)]);
            const a = jsonOf(before);
            const b = jsonOf(after);
            if (change.category === 'worlds' && a?.entries && b?.entries) {
                // Lorebooks: name the entries that changed.
                for (const uid of new Set([...Object.keys(a.entries), ...Object.keys(b.entries)])) {
                    if (JSON.stringify(a.entries[uid]) === JSON.stringify(b.entries[uid])) continue;
                    const entry = b.entries[uid] ?? a.entries[uid];
                    const label = entry?.comment || (Array.isArray(entry?.key) ? entry.key.join('/') : '') || `条目 ${uid}`;
                    item.keys.push(`${!a.entries[uid] ? '新增' : !b.entries[uid] ? '删除' : '修改'}条目「${String(label).slice(0, 30)}」`);
                }
            } else if (a && b) {
                item.keys.push(...changedKeys(a, b));
            }
        }
    }
    return [...items.values()].slice(0, maxItems).map(item => ({
        ...item,
        messageCount: item.messages.length,
        messages: item.messages.slice(-maxMessages),
        keys: [...new Set(item.keys)].slice(0, 12),
    }));
}
