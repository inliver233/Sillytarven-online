import fs from 'node:fs';
import git from 'isomorphic-git';
import { getConfigValue } from '../../util.js';
import path from 'node:path';
import { currentBranch, ensureRepo, getRepoContext, headOid, readSettings, repoExists, withRepoLock, writeSettings } from '../repo.js';
import { explainNetworkError, pushRemote } from '../remotes.js';

/**
 * 酒馆云: a Forgejo/Gitea server run by the site, so "save it online" needs no account,
 * address or token from the user. Each tavern user gets one private repository
 * `<org>/<site>--<handle>`; the server reads and writes it with the site's own token,
 * which never leaves the server. The remote is stored as `{ provider: 'hosted', hosted: { site } }`
 * and its address is rebuilt from the config and the user's handle on every use, so a user
 * can only ever reach their own repositories.
 *
 * config.yaml:
 *   gitSync.hosted:
 *     url: https://git.example.com
 *     token: <Forgejo token with write:organization and write:repository>
 *     org: tavern
 *     site: dc                 # this site's id, part of repository names
 *     sites: { dc: 老站, sto: 新站 }   # sites sharing the server; Discord accounts may restore from any of them
 */

export const HOSTED_REMOTE = 'cloud';
const SITE_ID = /^[a-z0-9-]{1,20}$/;

/**
 * @returns {{ url: string, token: string, org: string, site: string, sites: Record<string, string>, label: string } | null}
 */
export function hostedConfig() {
    const url = String(getConfigValue('gitSync.hosted.url', '') || '').replace(/\/+$/, '');
    const token = String(getConfigValue('gitSync.hosted.token', '') || '');
    const site = String(getConfigValue('gitSync.hosted.site', '') || '');
    if (!/^https:\/\//.test(url) || !token || !SITE_ID.test(site)) return null;
    const configured = getConfigValue('gitSync.hosted.sites', null);
    const sites = Object.fromEntries(Object.entries(configured && typeof configured === 'object' ? configured : {})
        .filter(([id]) => SITE_ID.test(id)).map(([id, label]) => [id, String(label || id)]));
    if (!sites[site]) sites[site] = '本站';
    return {
        url,
        token,
        site,
        sites,
        org: String(getConfigValue('gitSync.hosted.org', 'tavern') || 'tavern'),
        label: String(getConfigValue('gitSync.hosted.label', '酒馆云') || '酒馆云'),
    };
}

/** @param {string} site @param {string} handle */
function repoName(site, handle) {
    return `${site}--${handle}`.toLowerCase();
}

/**
 * Which sites' repositories this user may use: always this site's; other sites' only for
 * Discord accounts, whose handle comes from the Discord id and so names the same person everywhere.
 * @param {string} handle
 */
function allowedSites(cfg, handle) {
    return Object.keys(cfg.sites).filter(site => site === cfg.site || handle.startsWith('discord-'));
}

/**
 * @param {ReturnType<typeof hostedConfig>} cfg
 * @param {string} method
 * @param {string} route
 * @param {object} [body]
 */
async function forgejo(cfg, method, route, body) {
    const response = await fetch(`${cfg.url}/api/v1${route}`, {
        method,
        headers: { Authorization: `token ${cfg.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
}

let serviceUser = { token: '', login: '' };
/** Login name that owns the token (git over HTTPS wants it next to the token). */
async function tokenOwner(cfg) {
    if (serviceUser.token === cfg.token && serviceUser.login) return serviceUser.login;
    const { status, data } = await forgejo(cfg, 'GET', '/user');
    if (status !== 200 || !data?.login) throw new Error(`酒馆云认证失败（${status}）`);
    serviceUser = { token: cfg.token, login: data.login };
    return data.login;
}

/**
 * Network access for a hosted remote, rebuilt from the config and the user's handle.
 * @param {import('../repo.js').RepoContext} ctx
 * @param {any} remote Stored remote record
 * @param {typeof import('../router.js').userError} userError
 * @returns {Promise<import('../remotes.js').RemoteAccess>}
 */
export async function hostedAccess(ctx, remote, userError) {
    const cfg = hostedConfig();
    if (!cfg) throw userError(503, '酒馆云暂时没有开启');
    const site = String(remote?.hosted?.site ?? '');
    if (!allowedSites(cfg, ctx.handle).includes(site)) throw userError(403, '不能使用这个酒馆云仓库');
    return { url: `${cfg.url}/${cfg.org}/${repoName(site, ctx.handle)}.git`, provider: 'hosted', username: await tokenOwner(cfg), token: cfg.token };
}

/** @param {any} repository Forgejo repository */
function describe(site, cfg, repository) {
    return { site, label: cfg.sites[site], exists: Boolean(repository), empty: repository ? Boolean(repository.empty) : true, updatedAt: repository?.updated_at ?? null, sizeKiB: repository?.size ?? 0 };
}

/** Remote name for a site's repository: `cloud` for this site, `cloud-<site>` for another (read only). */
function remoteNameFor(cfg, site) {
    return site === cfg.site ? HOSTED_REMOTE : `${HOSTED_REMOTE}-${site}`;
}

/** Remote names the user may not add, change or delete while 酒馆云 is on. */
export function isReservedRemote(name) {
    return Boolean(hostedConfig()) && (name === HOSTED_REMOTE || name.startsWith(`${HOSTED_REMOTE}-`));
}

/**
 * Connects a site's repository as a remote. This site's repository is created when missing;
 * another site's must exist (restoring a Discord account's backup).
 * @param {import('../repo.js').RepoContext} ctx
 * @param {string} site
 */
export async function attachCloud(ctx, site, userError) {
    const cfg = hostedConfig();
    if (!cfg) throw userError(503, '酒馆云暂时没有开启');
    if (!allowedSites(cfg, ctx.handle).includes(site)) throw userError(403, '不能使用这个酒馆云仓库');
    const name = repoName(site, ctx.handle);
    let { status, data } = await forgejo(cfg, 'GET', `/repos/${cfg.org}/${name}`);
    if (status === 404 && site === cfg.site) {
        ({ status, data } = await forgejo(cfg, 'POST', `/orgs/${cfg.org}/repos`, { name, private: true, auto_init: false, default_branch: 'main', description: `${cfg.sites[site]} ${ctx.handle}` }));
        if (status !== 201) throw userError(502, `酒馆云建仓库失败（${status}）`);
    } else if (status === 404) {
        throw userError(404, `${cfg.sites[site]}没有你的备份`);
    } else if (status !== 200) {
        throw userError(502, `连不上酒馆云（${status}）`);
    }
    await ensureRepo(ctx);
    const remote = remoteNameFor(cfg, site);
    const settings = readSettings(ctx);
    // The address is never stored where the page can read it; hostedAccess rebuilds it.
    settings.remotes[remote] = { url: '', provider: 'hosted', username: '', hosted: { site } };
    writeSettings(ctx, settings);
    await git.addRemote({ fs, gitdir: ctx.gitdir, remote, url: `${cfg.url}/${cfg.org}/${name}.git`, force: true });
    return { remote, ...describe(site, cfg, data) };
}

/**
 * With 酒馆云 on, no repository stays local only: connects this site's repository when the
 * user's repository has none yet. Errors are left to the caller.
 * @param {import('../repo.js').RepoContext} ctx
 */
export async function ensureCloud(ctx, userError) {
    const cfg = hostedConfig();
    if (!cfg || readSettings(ctx).remotes[HOSTED_REMOTE]?.provider === 'hosted') return false;
    await attachCloud(ctx, cfg.site, userError);
    return true;
}

/**
 * Copies the current branch to this site's 酒馆云 repository. The cloud copy mirrors the
 * tavern's repository, so it is overwritten (after "回到这个版本" the local branch moves back;
 * the newer commits stay in the safety points).
 * @param {import('../repo.js').RepoContext} ctx
 * @returns {Promise<{ pushed: boolean, error: string }>}
 */
export async function mirrorToCloud(ctx, userError, policy) {
    if (!hostedConfig()) return { pushed: false, error: '' };
    try {
        await ensureCloud(ctx, userError);
        const branch = await currentBranch(ctx);
        if (!branch || !(await headOid(ctx))) return { pushed: false, error: '' };
        const access = await hostedAccess(ctx, readSettings(ctx).remotes[HOSTED_REMOTE], userError);
        await pushRemote(ctx, HOSTED_REMOTE, access, policy, { ref: branch, force: true });
        return { pushed: true, error: '' };
    } catch (error) {
        console.warn('[git-sync] 酒馆云 push failed', error?.message);
        return { pushed: false, error: hideHostedAddress(error?.userMessage || explainNetworkError(error)) };
    }
}

/** Saves of the open chat (every few messages) are gathered and uploaded at most this often. */
export const MIRROR_DELAY_MS = 5 * 60 * 1000;
/** Bigger saves (leaving a chat, saving by hand) go up shortly after. */
export const MIRROR_SOON_MS = 15 * 1000;

/** @type {Map<string, { timer: NodeJS.Timeout, due: number }>} handle → pending upload */
const pendingMirrors = new Map();

/** Last upload result, shown in the panel. */
export function readCloudStatus(ctx) {
    try {
        return JSON.parse(fs.readFileSync(path.join(ctx.root, 'cloud-status.json'), 'utf8'));
    } catch {
        return { lastPushAt: 0, lastError: '' };
    }
}

/**
 * Uploads to 酒馆云 in the background after `delayMs`; a pending upload that is due sooner wins,
 * so many small saves become one upload.
 * @param {import('../repo.js').RepoContext} ctx
 * @param {number} delayMs
 */
export function scheduleMirror(ctx, userError, policy, delayMs) {
    if (!hostedConfig()) return false;
    const due = Date.now() + delayMs;
    const pending = pendingMirrors.get(ctx.handle);
    if (pending && pending.due <= due) return true;
    if (pending) clearTimeout(pending.timer);
    const { handle, dir } = ctx;
    const timer = setTimeout(async () => {
        pendingMirrors.delete(handle);
        const fresh = getRepoContext(handle, dir);
        if (!repoExists(fresh)) return;
        const result = await withRepoLock(fresh, () => mirrorToCloud(fresh, userError, policy));
        const status = { ...readCloudStatus(fresh), ...(result.pushed ? { lastPushAt: Date.now(), lastError: '' } : {}), ...(result.error ? { lastError: result.error, lastErrorAt: Date.now() } : {}) };
        fs.writeFileSync(path.join(fresh.root, 'cloud-status.json'), JSON.stringify(status));
    }, delayMs);
    timer.unref?.();
    pendingMirrors.set(handle, { timer, due });
    return true;
}

/**
 * Whether this site's 酒馆云 copy is behind the tavern's repository (e.g. an upload was lost to
 * a restart), checked by the periodic task.
 * @param {import('../repo.js').RepoContext} ctx
 */
export async function cloudIsBehind(ctx) {
    if (!hostedConfig() || readSettings(ctx).remotes[HOSTED_REMOTE]?.provider !== 'hosted') return false;
    const branch = await currentBranch(ctx);
    const head = await headOid(ctx);
    if (!branch || !head) return false;
    const remote = await git.resolveRef({ fs, gitdir: ctx.gitdir, ref: `refs/remotes/${HOSTED_REMOTE}/${branch}` }).catch(() => null);
    return remote !== head;
}

/** Replaces the 酒馆云 address in text that goes to the page. */
export function hideHostedAddress(text) {
    const cfg = hostedConfig();
    if (!cfg || typeof text !== 'string') return text;
    const host = new URL(cfg.url).host;
    return text.split(cfg.url).join(cfg.label).split(host).join(cfg.label);
}

/**
 * @type {import('../router.js').GitModule}
 */
export default {
    id: 'hosted',
    label: '酒馆云',
    register(router, api) {
        /** This user's repositories on the hosted server (this site's, plus other sites' for Discord accounts). */
        router.post('/hosted/info', api.handle(async (ctx) => {
            const cfg = hostedConfig();
            if (!cfg) return { available: false };
            const repositories = [];
            for (const site of allowedSites(cfg, ctx.handle)) {
                const { status, data } = await forgejo(cfg, 'GET', `/repos/${cfg.org}/${repoName(site, ctx.handle)}`).catch(() => ({ status: 0, data: null }));
                if (status === 0 || status >= 500) throw api.userError(502, '连不上酒馆云，等会儿再试');
                repositories.push(describe(site, cfg, status === 200 ? data : null));
            }
            return { available: true, label: cfg.label, site: cfg.site, repositories };
        }, { needsRepo: false }));

        /** Connects this site's repository (`cloud`) or, for restoring, another site's (`cloud-<site>`). */
        router.post('/hosted/connect', api.handle(async (ctx, request) => {
            const cfg = hostedConfig();
            if (!cfg) throw api.userError(503, '酒馆云暂时没有开启');
            return attachCloud(ctx, String(request.body?.site || cfg.site), api.userError);
        }, { needsRepo: false }));
    },
};
