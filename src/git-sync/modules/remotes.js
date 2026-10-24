import fs from 'node:fs';
import git from 'isomorphic-git';
import { PROVIDERS, detectProvider, explainNetworkError, fetchRemote, listRemoteBranches, pushRemote } from '../remotes.js';
import { normalizeRemoteUrl } from '../remote-http.js';
import { applyCommitToWorkTree, createSafetyPoint, currentBranch, ensureRepo, headOid, readSettings, writeSettings } from '../repo.js';
import { readCredentials, writeCredentials } from '../router.js';
import { mergeIntoCurrent } from './branches.js';
import { isReservedRemote } from './hosted.js';

const REMOTE_NAME = /^[\w.-]{1,50}$/;

/**
 * Runs a network step and turns failures into readable errors.
 * @template T
 * @param {import('../router.js').ModuleApi} api
 * @param {() => Promise<T>} step
 * @returns {Promise<T>}
 */
async function network(api, step) {
    try {
        return await step();
    } catch (error) {
        if (error?.userMessage) throw error;
        throw api.userError(502, explainNetworkError(error), { code: error?.code });
    }
}

/**
 * Remote repositories: GitHub, GitLab, Gitee, Gitea or any git host over HTTPS.
 * @type {import('../router.js').GitModule}
 */
export default {
    id: 'remotes',
    label: '远程仓库',
    register(router, api) {
        /** Adds or updates a remote. The token is kept when the field is left empty. */
        router.post('/remote/save', api.handle(async (ctx, request) => {
            const body = request.body ?? {};
            const name = String(body.name || 'origin').trim();
            if (!REMOTE_NAME.test(name)) throw api.userError(400, '远程名称只能包含字母、数字、-、_ 和 .');
            if (isReservedRemote(name) || isReservedRemote(String(body.previousName ?? ''))) throw api.userError(400, '酒馆云由本站管理，不能修改');
            let url;
            try {
                url = normalizeRemoteUrl(body.url, api.policy());
            } catch (error) {
                throw api.userError(400, error.message);
            }
            const provider = PROVIDERS[body.provider] ? body.provider : detectProvider(url);
            const username = String(body.username ?? '').trim().slice(0, 100);
            if (PROVIDERS[provider].needsUsername && !username && body.token) {
                throw api.userError(400, `${PROVIDERS[provider].label} 需要填写用户名`);
            }
            await ensureRepo(ctx);
            const settings = readSettings(ctx);
            if (body.previousName && body.previousName !== name && settings.remotes[body.previousName]) {
                delete settings.remotes[body.previousName];
                await git.deleteRemote({ fs, gitdir: ctx.gitdir, remote: body.previousName }).catch(() => {});
            }
            settings.remotes[name] = { url, provider, username };
            writeSettings(ctx, settings);
            await git.addRemote({ fs, gitdir: ctx.gitdir, remote: name, url, force: true });
            const credentials = readCredentials(ctx);
            if (body.previousName && body.previousName !== name && credentials[body.previousName]) {
                credentials[name] = credentials[body.previousName];
                delete credentials[body.previousName];
            }
            if (typeof body.token === 'string' && body.token.trim()) credentials[name] = body.token.trim();
            if (body.clearToken) delete credentials[name];
            writeCredentials(ctx, credentials);
            return { name, url, provider, username, hasToken: Boolean(credentials[name]) };
        }, { needsRepo: false }));

        router.post('/remote/delete', api.handle(async (ctx, request) => {
            const name = String(request.body?.name ?? '');
            if (name === 'cloud' && isReservedRemote(name)) throw api.userError(400, '酒馆云由本站管理，不能删除');
            const settings = readSettings(ctx);
            delete settings.remotes[name];
            writeSettings(ctx, settings);
            const credentials = readCredentials(ctx);
            delete credentials[name];
            writeCredentials(ctx, credentials);
            await git.deleteRemote({ fs, gitdir: ctx.gitdir, remote: name }).catch(() => {});
            return { deleted: name };
        }));

        /** Checks the address and token, and lists the remote's branches. */
        router.post('/remote/test', api.handle(async (ctx, request) => {
            const access = await api.remoteAccess(ctx, String(request.body?.name || 'origin'));
            const read = await network(api, () => listRemoteBranches(access, api.policy(), false));
            const write = await listRemoteBranches(access, api.policy(), true).then(() => true).catch(() => false);
            return { ...read, canPush: write };
        }, { needsRepo: false }));

        router.post('/fetch', api.handle(async (ctx, request) => {
            await api.ensureQuota(request.user.profile, request.user.directories);
            const name = String(request.body?.remote || 'origin');
            const access = await api.remoteAccess(ctx, name);
            const result = await network(api, () => fetchRemote(ctx, name, access, api.policy()));
            return { remote: name, defaultBranch: result.defaultBranch, fetchHead: result.fetchHead };
        }));

        /**
         * Fetches and merges a remote branch into the current branch. Without `apply`, returns the
         * plan (conflicts included) so the panel can ask which side to keep.
         */
        router.post('/pull', api.handle(async (ctx, request) => {
            await api.ensureQuota(request.user.profile, request.user.directories);
            const name = String(request.body?.remote || 'origin');
            const access = await api.remoteAccess(ctx, name);
            const branch = String(request.body?.branch || await currentBranch(ctx) || 'main');
            if (!request.body?.apply) {
                await network(api, () => fetchRemote(ctx, name, access, api.policy()));
            }
            const theirs = await git.resolveRef({ fs, gitdir: ctx.gitdir, ref: `refs/remotes/${name}/${branch}` }).catch(() => null);
            if (!theirs) throw api.userError(404, `远程仓库没有 ${branch} 分支`);
            const choices = request.body?.choices && typeof request.body.choices === 'object' ? request.body.choices : {};
            return mergeIntoCurrent(ctx, request, api, theirs, `${name}/${branch}`, request.body?.apply ? choices : undefined);
        }));

        /** Pushes the current branch (or a named one) and optionally all tags. */
        router.post('/push', api.handle(async (ctx, request) => {
            const name = String(request.body?.remote || 'origin');
            const access = await api.remoteAccess(ctx, name);
            const branch = String(request.body?.branch || await currentBranch(ctx) || '');
            if (!branch || !(await headOid(ctx))) throw api.userError(409, '还没有可以推送的提交');
            const remoteBranch = String(request.body?.remoteBranch || branch);
            await network(api, () => pushRemote(ctx, name, access, api.policy(), { ref: branch, remoteRef: remoteBranch, force: Boolean(request.body?.force) }));
            await git.setConfig({ fs, gitdir: ctx.gitdir, path: `branch.${branch}.remote`, value: name });
            await git.setConfig({ fs, gitdir: ctx.gitdir, path: `branch.${branch}.merge`, value: `refs/heads/${remoteBranch}` });
            const pushedTags = [];
            if (request.body?.tags) {
                for (const tag of await git.listTags({ fs, gitdir: ctx.gitdir })) {
                    await network(api, () => pushRemote(ctx, name, access, api.policy(), { ref: `refs/tags/${tag}`, force: Boolean(request.body?.force) }));
                    pushedTags.push(tag);
                }
            }
            return { remote: name, branch, remoteBranch, pushedTags };
        }));

        /** Deletes a branch on the remote. */
        router.post('/remote/delete-branch', api.handle(async (ctx, request) => {
            const name = String(request.body?.remote || 'origin');
            const branch = String(request.body?.branch ?? '');
            if (!branch) throw api.userError(400, '没有指定分支');
            const access = await api.remoteAccess(ctx, name);
            await network(api, () => pushRemote(ctx, name, access, api.policy(), { ref: branch, delete: true }));
            await git.deleteRef({ fs, gitdir: ctx.gitdir, ref: `refs/remotes/${name}/${branch}` }).catch(() => {});
            return { deleted: `${name}/${branch}` };
        }));

        /**
         * "Clone": replaces this account's tracked data with a remote branch, keeping a safety
         * point of the current data. Works for a brand-new repository too.
         */
        router.post('/import', api.handle(async (ctx, request) => {
            await api.ensureQuota(request.user.profile, request.user.directories);
            const name = String(request.body?.remote || 'origin');
            const access = await api.remoteAccess(ctx, name);
            await ensureRepo(ctx);
            const result = await network(api, () => fetchRemote(ctx, name, access, api.policy()));
            if (result.empty) throw api.userError(404, '远程仓库是空的，还没有可以导入的内容');
            const branch = String(request.body?.branch || result.defaultBranch || 'main');
            const oid = await git.resolveRef({ fs, gitdir: ctx.gitdir, ref: `refs/remotes/${name}/${branch}` }).catch(() => null);
            if (!oid) throw api.userError(404, `远程仓库没有 ${branch} 分支`);
            const settings = readSettings(ctx);
            await createSafetyPoint(ctx, settings, `从 ${name}/${branch} 导入之前`, api.author(request, settings));
            await applyCommitToWorkTree(ctx, oid, { moveBranch: branch });
            await git.setConfig({ fs, gitdir: ctx.gitdir, path: `branch.${branch}.remote`, value: name });
            await git.setConfig({ fs, gitdir: ctx.gitdir, path: `branch.${branch}.merge`, value: `refs/heads/${branch}` });
            await api.afterWorkTreeChange(request);
            writeSettings(ctx, readSettings(ctx));
            return { branch, head: oid, reload: true };
        }));
    },
};
