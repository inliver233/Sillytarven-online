import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { getConfigValue } from '../util.js';
import { invalidateCharacterListCache } from '../character-list-cache.js';
import { invalidateRecentChatsCache } from '../recent-chats-cache.js';
import { invalidateSettingsCache } from '../settings-cache.js';
import { canConsumeStorage } from '../storage-quota.js';
import { authorOf, getRepoContext, readSettings, repoExists, withRepoLock } from './repo.js';
import { explainNetworkError } from './remotes.js';
import coreModule from './modules/core.js';
import historyModule from './modules/history.js';
import branchesModule from './modules/branches.js';
import remotesModule from './modules/remotes.js';
import tagsModule from './modules/tags.js';
import safetyModule from './modules/safety.js';
import autoBackupModule from './modules/auto-backup.js';
import hostedModule, { hostedAccess, hostedConfig } from './modules/hosted.js';

/**
 * Built-in git ("酒馆 Git"): per-user repositories of the user's tavern data.
 *
 * Each feature is a module with an id, a label and a `register(router, api)` function.
 * `gitSync.modules` in config.yaml picks which modules are served; core is always on.
 */

/** @typedef {{ id: string, label: string, register: (router: express.Router, api: ModuleApi) => void, start?: (api: ModuleApi) => void }} GitModule */

/** @type {GitModule[]} */
export const MODULES = [coreModule, historyModule, branchesModule, remotesModule, tagsModule, safetyModule, autoBackupModule, hostedModule];

export function getPolicy() {
    return {
        allowPrivateNetworks: Boolean(getConfigValue('gitSync.allowPrivateNetworks', false, 'boolean')),
        allowHttp: Boolean(getConfigValue('gitSync.allowHttp', false, 'boolean')),
    };
}

export function getEnabledModuleIds() {
    const configured = getConfigValue('gitSync.modules', null);
    const ids = Array.isArray(configured) ? configured.map(String) : MODULES.map(module => module.id);
    // 酒馆云 is on whenever it is configured (gitSync.hosted), together with remotes.
    const hosted = Boolean(hostedConfig()) && ids.includes('remotes');
    return MODULES.filter(module => module.id === 'core' || ids.includes(module.id) || (module.id === 'hosted' && hosted)).map(module => module.id);
}

/**
 * Errors carry a status and a message meant for the user.
 * @param {number} status
 * @param {string} message
 * @param {object} [extra]
 */
export function userError(status, message, extra = {}) {
    return Object.assign(new Error(message), { status, userMessage: message, ...extra });
}

// ---------------------------------------------------------------------------
// Credentials (kept beside the repository, never sent to the browser)
// ---------------------------------------------------------------------------

/** @param {import('./repo.js').RepoContext} ctx */
export function readCredentials(ctx) {
    try {
        return JSON.parse(fs.readFileSync(path.join(ctx.root, 'credentials.json'), 'utf8'));
    } catch {
        return {};
    }
}

/**
 * @param {import('./repo.js').RepoContext} ctx
 * @param {Record<string, string>} credentials Remote name → token
 */
export function writeCredentials(ctx, credentials) {
    fs.mkdirSync(ctx.root, { recursive: true });
    const file = path.join(ctx.root, 'credentials.json');
    fs.writeFileSync(file, JSON.stringify(credentials), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
}

/**
 * Address and login for a remote. 酒馆云 remotes are rebuilt from the config and the handle,
 * never taken from the stored record.
 * @param {import('./repo.js').RepoContext} ctx
 * @param {string} remoteName
 * @returns {Promise<import('./remotes.js').RemoteAccess>}
 */
export async function remoteAccessFor(ctx, remoteName) {
    const remote = readSettings(ctx).remotes[remoteName];
    if (!remote) throw userError(404, `没有名为 ${remoteName} 的远程仓库`);
    if (remote.provider === 'hosted') return hostedAccess(ctx, remote, userError);
    return { url: remote.url, provider: remote.provider, username: remote.username, token: readCredentials(ctx)[remoteName] ?? '' };
}

/**
 * @typedef {object} ModuleApi
 * @property {(work: (ctx: import('./repo.js').RepoContext, request: express.Request, response: express.Response) => Promise<any>, options?: { needsRepo?: boolean }) => express.RequestHandler} handle
 * @property {typeof remoteAccessFor} remoteAccess
 * @property {typeof getPolicy} policy
 * @property {(request: express.Request, settings: import('./repo.js').RepoSettings) => { name: string, email: string }} author
 * @property {(request: express.Request) => Promise<void>} afterWorkTreeChange
 * @property {typeof userError} userError
 * @property {(user: object, directories: object) => Promise<void>} ensureQuota Refuses work that would grow storage past the user's limit
 */

/**
 * Throws when the user has no storage left; git history counts toward the quota.
 * @param {object} user User record (request.user.profile)
 * @param {object} directories
 */
export async function ensureQuota(user, directories) {
    const quota = await canConsumeStorage(user, directories, 1);
    if (!quota.allowed) {
        throw userError(507, '存储空间已满（Git 历史也计入空间），无法继续提交或下载。请清理不需要的数据、删除旧分支，或在设置里删除仓库后重建。');
    }
}

/**
 * Hooks run after an operation replaced files in a user's data directory.
 * Caches validated by file size and mtime (chat info) refresh by themselves; these do not.
 */
const workTreeHooks = [
    (handle) => invalidateSettingsCache(handle),
    (handle) => invalidateCharacterListCache(handle),
    (handle) => invalidateRecentChatsCache(handle),
];

/**
 * Lets other parts of the server drop what they cached about a user's files.
 * @param {(handle: string, directories: object) => void | Promise<void>} hook
 */
export function onWorkTreeChange(hook) {
    workTreeHooks.push(hook);
}

/** @type {ModuleApi} */
const api = {
    handle(work, { needsRepo = true } = {}) {
        return async (request, response) => {
            try {
                const ctx = getRepoContext(request.user.profile.handle, request.user.directories.root);
                if (needsRepo && !repoExists(ctx)) {
                    throw userError(409, '还没有创建酒馆 Git 仓库');
                }
                const result = await withRepoLock(ctx, () => work(ctx, request, response));
                if (!response.headersSent) response.json(result ?? { ok: true });
            } catch (error) {
                if (response.headersSent) return;
                if (error?.userMessage) {
                    return response.status(error.status ?? 400).json({ error: error.userMessage, code: error.code, ...(error.details ? { details: error.details } : {}) });
                }
                const network = error?.code && error.code !== 'ENOENT' ? explainNetworkError(error) : null;
                if (network && network !== error.message) {
                    return response.status(502).json({ error: network, code: error.code });
                }
                console.error('[git-sync]', error);
                return response.status(500).json({ error: error?.message || '操作失败' });
            }
        };
    },
    remoteAccess: remoteAccessFor,
    policy: getPolicy,
    author(request, settings) {
        return authorOf(settings, request.user.profile.name || request.user.profile.handle);
    },
    async afterWorkTreeChange(request) {
        for (const hook of workTreeHooks) {
            try {
                await hook(request.user.profile.handle, request.user.directories);
            } catch (error) {
                console.warn('[git-sync] cache refresh failed', error);
            }
        }
    },
    userError,
    ensureQuota,
};

export const router = express.Router();

router.use((request, response, next) => {
    if (!getConfigValue('gitSync.enabled', true, 'boolean')) {
        return response.status(404).json({ error: '酒馆 Git 未开启' });
    }
    return next();
});

const enabled = new Set(getEnabledModuleIds());
for (const module of MODULES) {
    if (enabled.has(module.id)) module.register(router, api);
}

/** Starts background work of enabled modules (auto backup). */
export function startGitSync() {
    if (!getConfigValue('gitSync.enabled', true, 'boolean')) return;
    for (const module of MODULES) {
        if (enabled.has(module.id)) module.start?.(api);
    }
}
