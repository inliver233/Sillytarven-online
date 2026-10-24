import fs from 'node:fs';
import git from 'isomorphic-git';
import { createGuardedHttp, normalizeRemoteUrl } from './remote-http.js';

/**
 * Remote hosts. Any smart-HTTP git server works; providers only pick sensible defaults
 * for the login name that goes with an access token.
 */
export const PROVIDERS = Object.freeze({
    github: { label: 'GitHub', host: 'github.com', tokenUser: 'x-access-token', needsUsername: false, tokenUrl: 'https://github.com/settings/tokens/new?scopes=repo&description=Tavern%20backup' },
    gitlab: { label: 'GitLab', host: 'gitlab.com', tokenUser: 'oauth2', needsUsername: false, tokenUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens' },
    gitee: { label: 'Gitee', host: 'gitee.com', tokenUser: '', needsUsername: true, tokenUrl: 'https://gitee.com/profile/personal_access_tokens' },
    gitea: { label: 'Gitea / Forgejo', host: '', tokenUser: '', needsUsername: true, tokenUrl: '' },
    custom: { label: '其他 Git 服务', host: '', tokenUser: '', needsUsername: true, tokenUrl: '' },
});

/**
 * Guesses the provider from a URL's host.
 * @param {string} url
 */
export function detectProvider(url) {
    const host = new URL(url).hostname.toLowerCase();
    for (const [id, provider] of Object.entries(PROVIDERS)) {
        if (provider.host && (host === provider.host || host.endsWith(`.${provider.host}`))) return id;
    }
    return /gitea|forgejo|codeberg/.test(host) ? 'gitea' : 'custom';
}

/**
 * @typedef {object} RemoteAccess
 * @property {string} url
 * @property {string} provider
 * @property {string} username
 * @property {string} token
 */

/**
 * Options shared by every network call to one remote.
 * @param {RemoteAccess} access
 * @param {{ allowPrivateNetworks: boolean, allowHttp: boolean, signal?: AbortSignal }} policy
 */
export function networkOptions(access, policy) {
    const provider = PROVIDERS[access.provider] ?? PROVIDERS.custom;
    let attempts = 0;
    return {
        http: createGuardedHttp(policy),
        url: normalizeRemoteUrl(access.url, policy),
        onAuth: () => {
            // Without a token, let public repositories work anonymously.
            if (!access.token) return { cancel: attempts++ > 0 };
            return { username: access.username || provider.tokenUser || 'git', password: access.token };
        },
        onAuthFailure: () => ({ cancel: true }),
    };
}

/**
 * Turns isomorphic-git and network errors into messages a tavern user can act on.
 * @param {any} error
 */
export function explainNetworkError(error) {
    const status = error?.data?.statusCode;
    if (error?.code === 'RemoteNotAllowed') return error.message;
    if (status === 401 || error?.code === 'UserCanceledError') return '认证失败：请检查访问令牌（token）和用户名，确认 token 有读写仓库的权限';
    if (status === 403) return '没有权限：token 可能缺少写入权限，或仓库不属于你';
    if (status === 404) return '找不到仓库：请检查地址，私有仓库需要填写 token';
    if (error?.code === 'PushRejectedError') return '远程仓库有你本地没有的新提交，请先拉取合并，或选择强制推送';
    if (error?.code === 'ENOTFOUND' || error?.code === 'EAI_AGAIN') return '无法解析仓库域名，请检查地址';
    if (error?.code === 'ECONNREFUSED' || error?.code === 'ECONNRESET' || /超时/.test(error?.message)) return '连接仓库失败，请稍后再试';
    return error?.message || String(error);
}

/**
 * Lists the remote's branches without downloading anything.
 * @param {RemoteAccess} access
 * @param {object} policy
 * @param {boolean} [forPush]
 */
export async function listRemoteBranches(access, policy, forPush = false) {
    const { http, url, onAuth, onAuthFailure } = networkOptions(access, policy);
    // Protocol v2 servers (GitHub, Gitee, ...) only list refs on a separate request; v1 lists them directly.
    const info = await git.getRemoteInfo2({ http, url, onAuth, onAuthFailure, forPush, protocolVersion: 1 });
    const refs = info.refs ?? [];
    const branches = refs.filter(ref => ref.ref.startsWith('refs/heads/')).map(ref => ({ name: ref.ref.slice('refs/heads/'.length), oid: ref.oid }));
    const head = refs.find(ref => ref.ref === 'HEAD')?.target?.replace('refs/heads/', '') ?? null;
    return { branches, defaultBranch: head };
}

/**
 * Downloads a remote's branches and tags into refs/remotes/<name>/.
 * @param {import('./repo.js').RepoContext} ctx
 * @param {string} remoteName
 * @param {RemoteAccess} access
 * @param {object} policy
 * @param {(progress: { phase: string, loaded: number, total?: number }) => void} [onProgress]
 */
export async function fetchRemote(ctx, remoteName, access, policy, onProgress) {
    const { http, url, onAuth, onAuthFailure } = networkOptions(access, policy);
    await git.setConfig({ fs, gitdir: ctx.gitdir, path: `remote.${remoteName}.url`, value: url });
    await git.setConfig({ fs, gitdir: ctx.gitdir, path: `remote.${remoteName}.fetch`, value: `+refs/heads/*:refs/remotes/${remoteName}/*` });
    // fetch needs a starting branch; the remote's HEAD may be missing (new or odd repositories).
    const { branches, defaultBranch } = await listRemoteBranches(access, policy);
    if (!branches.length) {
        return { defaultBranch: null, fetchHead: null, empty: true };
    }
    const ref = branches.some(branch => branch.name === defaultBranch) ? defaultBranch : branches[0].name;
    try {
        const result = await git.fetch({
            fs, http, gitdir: ctx.gitdir, remote: remoteName, url, onAuth, onAuthFailure, onProgress,
            ref, tags: true, prune: true, singleBranch: false, cache: ctx.cache,
        });
        return { ...result, defaultBranch: ref, empty: false };
    } catch (error) {
        // isomorphic-git resolves the remote's HEAD only after the objects and remote branches
        // are stored, to guess a default branch for clone. A HEAD pointing at a missing branch
        // fails there although the fetch itself succeeded.
        if (error?.code === 'NotFoundError' && error?.data?.what === 'HEAD') {
            return { defaultBranch: ref, fetchHead: null, empty: false };
        }
        throw error;
    }
}

/**
 * @param {import('./repo.js').RepoContext} ctx
 * @param {string} remoteName
 * @param {RemoteAccess} access
 * @param {object} policy
 * @param {{ ref: string, remoteRef?: string, force?: boolean, delete?: boolean }} target
 * @param {(progress: object) => void} [onProgress]
 */
export async function pushRemote(ctx, remoteName, access, policy, target, onProgress) {
    const { http, url, onAuth, onAuthFailure } = networkOptions(access, policy);
    const result = await git.push({
        fs, http, gitdir: ctx.gitdir, remote: remoteName, url, onAuth, onAuthFailure, onProgress,
        ref: target.ref, remoteRef: target.remoteRef ?? target.ref, force: Boolean(target.force), delete: Boolean(target.delete), cache: ctx.cache,
    });
    if (!result.ok) {
        const reasons = Object.values(result.refs ?? {}).map(ref => ref.error).filter(Boolean);
        throw Object.assign(new Error(reasons.join('；') || '推送被远程仓库拒绝'), { code: 'PushRejectedError' });
    }
    return result;
}
