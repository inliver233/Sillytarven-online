import fs from 'node:fs';
import git from 'isomorphic-git';
import { applyCommitToWorkTree, createSafetyPoint, currentBranch, headOid, readSettings } from '../repo.js';
import { planMerge, writeMergeCommit } from '../merge.js';

const BRANCH_NAME = /^(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)(?!.*\.lock$)[\w.\-/一-龥]{1,100}$/;

/**
 * @param {import('../router.js').ModuleApi} api
 * @param {unknown} value
 */
function branchName(api, value) {
    const name = String(value ?? '').trim();
    if (!BRANCH_NAME.test(name)) throw api.userError(400, '分支名只能包含中英文、数字、-、_、. 和 /');
    return name;
}

/**
 * Resolves a branch, remote branch ("origin/main") or commit to a commit oid.
 * @param {import('../repo.js').RepoContext} ctx
 * @param {string} value
 */
export async function resolveTarget(ctx, value) {
    const text = String(value ?? '').trim();
    for (const ref of [`refs/heads/${text}`, `refs/remotes/${text}`, `refs/tags/${text}`]) {
        const oid = await git.resolveRef({ fs, gitdir: ctx.gitdir, ref }).catch(() => null);
        if (oid) {
            if (ref.startsWith('refs/tags/')) {
                return git.readTag({ fs, gitdir: ctx.gitdir, oid }).then(tag => tag.tag.object).catch(() => oid);
            }
            return oid;
        }
    }
    if (/^[0-9a-f]{4,40}$/.test(text)) return git.expandOid({ fs, gitdir: ctx.gitdir, oid: text });
    throw Object.assign(new Error(`找不到 ${text}`), { status: 404, userMessage: `找不到 ${text}` });
}

/**
 * Merges `theirs` into the current branch after the user settled every conflict, then
 * replaces the data with the result. Shared by "merge branch" and "pull".
 * @param {import('../repo.js').RepoContext} ctx
 * @param {import('express').Request} request
 * @param {import('../router.js').ModuleApi} api
 * @param {string} theirs Commit to merge
 * @param {string} theirsLabel Name shown in the message
 * @param {Record<string, 'ours'|'theirs'>|undefined} choices Omit to only plan
 */
export async function mergeIntoCurrent(ctx, request, api, theirs, theirsLabel, choices) {
    const ours = await headOid(ctx);
    const branch = await currentBranch(ctx);
    const settings = readSettings(ctx);
    const author = api.author(request, settings);
    if (!ours) {
        // Nothing local yet: just take theirs.
        if (!choices) return { type: 'fast-forward', conflicts: [], theirsChanges: 0 };
        await createSafetyPoint(ctx, settings, `合并 ${theirsLabel} 之前`, author);
        await applyCommitToWorkTree(ctx, theirs, { moveBranch: branch ?? 'main' });
        await api.afterWorkTreeChange(request);
        return { type: 'fast-forward', head: theirs, reload: true };
    }
    const plan = await planMerge(ctx, ours, theirs);
    if (!choices) return plan;
    if (plan.type === 'up-to-date') return { ...plan, head: ours };

    await createSafetyPoint(ctx, settings, `合并 ${theirsLabel} 之前`, author);
    const head = plan.type === 'fast-forward'
        ? theirs
        : await writeMergeCommit(ctx, plan, choices, { author, message: `合并 ${theirsLabel} 到 ${branch ?? '当前版本'}` });
    await applyCommitToWorkTree(ctx, head, { moveBranch: branch });
    await api.afterWorkTreeChange(request);
    return { type: plan.type, head, reload: true };
}

/**
 * Branches: list, create, switch, rename, delete, merge.
 * @type {import('../router.js').GitModule}
 */
export default {
    id: 'branches',
    label: '分支',
    register(router, api) {
        router.post('/branches', api.handle(async (ctx) => {
            const current = await currentBranch(ctx);
            const local = [];
            for (const name of await git.listBranches({ fs, gitdir: ctx.gitdir })) {
                const oid = await git.resolveRef({ fs, gitdir: ctx.gitdir, ref: `refs/heads/${name}` });
                const [entry] = await git.log({ fs, gitdir: ctx.gitdir, ref: oid, depth: 1, cache: ctx.cache }).catch(() => []);
                local.push({ name, oid, current: name === current, lastCommit: entry ? { title: entry.commit.message.split('\n')[0], timestamp: entry.commit.author.timestamp } : null });
            }
            const remote = [];
            for (const { remote: remoteName } of await git.listRemotes({ fs, gitdir: ctx.gitdir })) {
                for (const name of await git.listBranches({ fs, gitdir: ctx.gitdir, remote: remoteName })) {
                    if (name === 'HEAD') continue;
                    const oid = await git.resolveRef({ fs, gitdir: ctx.gitdir, ref: `refs/remotes/${remoteName}/${name}` }).catch(() => null);
                    if (oid) remote.push({ name: `${remoteName}/${name}`, remote: remoteName, branch: name, oid });
                }
            }
            return { current, head: await headOid(ctx), local, remote };
        }));

        /** New branch from the current commit or a given one; optionally switch to it. */
        router.post('/branch/create', api.handle(async (ctx, request) => {
            const name = branchName(api, request.body?.name);
            const head = await headOid(ctx);
            if (!head) throw api.userError(409, '请先提交一次，再创建分支');
            const start = request.body?.from ? await resolveTarget(ctx, request.body.from) : head;
            await git.writeRef({ fs, gitdir: ctx.gitdir, ref: `refs/heads/${name}`, value: start, force: false }).catch(() => {
                throw api.userError(409, `分支 ${name} 已存在`);
            });
            if (request.body?.checkout) {
                const settings = readSettings(ctx);
                await createSafetyPoint(ctx, settings, `切换到分支 ${name} 之前`, api.author(request, settings));
                await git.checkout({ fs, dir: ctx.dir, gitdir: ctx.gitdir, ref: name, force: true, cache: ctx.cache });
                await api.afterWorkTreeChange(request);
                return { name, oid: start, reload: true };
            }
            return { name, oid: start };
        }));

        /** Switches to a branch, replacing the data with that branch's version (after a safety point). */
        router.post('/branch/switch', api.handle(async (ctx, request) => {
            const name = branchName(api, request.body?.name);
            const settings = readSettings(ctx);
            const exists = await git.resolveRef({ fs, gitdir: ctx.gitdir, ref: `refs/heads/${name}` }).catch(() => null);
            if (!exists) {
                // Switching to "origin/x" creates a local branch tracking it.
                const remoteOid = await git.resolveRef({ fs, gitdir: ctx.gitdir, ref: `refs/remotes/${name}` }).catch(() => null);
                if (!remoteOid) throw api.userError(404, `找不到分支 ${name}`);
                const localName = name.split('/').slice(1).join('/');
                await createSafetyPoint(ctx, settings, `切换到分支 ${localName} 之前`, api.author(request, settings));
                await applyCommitToWorkTree(ctx, remoteOid, { moveBranch: localName });
                await git.setConfig({ fs, gitdir: ctx.gitdir, path: `branch.${localName}.remote`, value: name.split('/')[0] });
                await git.setConfig({ fs, gitdir: ctx.gitdir, path: `branch.${localName}.merge`, value: `refs/heads/${localName}` });
                await api.afterWorkTreeChange(request);
                return { branch: localName, reload: true };
            }
            await createSafetyPoint(ctx, settings, `切换到分支 ${name} 之前`, api.author(request, settings));
            await git.checkout({ fs, dir: ctx.dir, gitdir: ctx.gitdir, ref: name, force: true, cache: ctx.cache });
            await api.afterWorkTreeChange(request);
            return { branch: name, reload: true };
        }));

        router.post('/branch/rename', api.handle(async (ctx, request) => {
            const from = branchName(api, request.body?.from);
            const to = branchName(api, request.body?.to);
            await git.renameBranch({ fs, gitdir: ctx.gitdir, oldref: from, ref: to, checkout: (await currentBranch(ctx)) === from });
            return { branch: to };
        }));

        router.post('/branch/delete', api.handle(async (ctx, request) => {
            const name = branchName(api, request.body?.name);
            if ((await currentBranch(ctx)) === name) throw api.userError(409, '不能删除当前所在的分支，请先切换到别的分支');
            await git.deleteBranch({ fs, gitdir: ctx.gitdir, ref: name });
            return { deleted: name };
        }));

        /**
         * Merge another branch (or remote branch, tag, commit) into the current one.
         * Without `choices` it only returns the plan, including conflicts to settle.
         */
        router.post('/merge', api.handle(async (ctx, request) => {
            const target = String(request.body?.from ?? '');
            const theirs = await resolveTarget(ctx, target);
            const choices = request.body?.choices && typeof request.body.choices === 'object' ? request.body.choices : undefined;
            return mergeIntoCurrent(ctx, request, api, theirs, target, request.body?.apply ? (choices ?? {}) : undefined);
        }));
    },
};
