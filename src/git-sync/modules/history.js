import fs from 'node:fs';
import git from 'isomorphic-git';
import { applyCommitToWorkTree, createSafetyPoint, currentBranch, diffCommits, headOid, readSettings } from '../repo.js';
import { createTrackFilter, isHardExcluded } from '../tracking.js';

const MAX_TEXT_BYTES = 512 * 1024;
const OID = /^[0-9a-f]{4,40}$/;

/**
 * Lists the branches, remote branches and tags that history can start from.
 * @param {import('../repo.js').RepoContext} ctx
 */
async function listStartingRefs(ctx) {
    const refs = [];
    for (const name of await git.listBranches({ fs, gitdir: ctx.gitdir })) {
        refs.push({ type: 'branch', name, ref: `refs/heads/${name}` });
    }
    for (const remote of await git.listRemotes({ fs, gitdir: ctx.gitdir })) {
        for (const name of await git.listBranches({ fs, gitdir: ctx.gitdir, remote: remote.remote })) {
            if (name !== 'HEAD') refs.push({ type: 'remote', name: `${remote.remote}/${name}`, ref: `refs/remotes/${remote.remote}/${name}` });
        }
    }
    for (const name of await git.listTags({ fs, gitdir: ctx.gitdir })) {
        refs.push({ type: 'tag', name, ref: `refs/tags/${name}` });
    }
    for (const ref of refs) {
        ref.oid = await git.resolveRef({ fs, gitdir: ctx.gitdir, ref: ref.ref }).catch(() => null);
        if (ref.type === 'tag' && ref.oid) {
            // Annotated tags point at a tag object; history needs the commit.
            ref.oid = await git.readTag({ fs, gitdir: ctx.gitdir, oid: ref.oid }).then(tag => tag.tag.object).catch(() => ref.oid);
        }
    }
    return refs.filter(ref => ref.oid);
}

/**
 * @param {import('../repo.js').RepoContext} ctx
 * @param {string} value
 */
async function resolveCommit(ctx, value) {
    const text = String(value ?? '').trim();
    if (OID.test(text)) {
        return git.expandOid({ fs, gitdir: ctx.gitdir, oid: text, cache: ctx.cache });
    }
    return git.resolveRef({ fs, gitdir: ctx.gitdir, ref: text });
}

/**
 * Commit history, restore and comparison.
 * @type {import('../router.js').GitModule}
 */
export default {
    id: 'history',
    label: '历史与恢复',
    register(router, api) {
        /** Commits reachable from every branch, remote branch and tag, newest first, with parents for the graph. */
        router.post('/log', api.handle(async (ctx, request) => {
            const limit = Math.min(Math.max(Number(request.body?.limit) || 200, 1), 1000);
            const refs = await listStartingRefs(ctx);
            /** @type {Map<string, any>} */
            const commits = new Map();
            for (const ref of refs) {
                const entries = await git.log({ fs, gitdir: ctx.gitdir, ref: ref.oid, depth: limit, cache: ctx.cache }).catch(() => []);
                for (const entry of entries) {
                    if (commits.has(entry.oid)) continue;
                    const { message, author, parent } = entry.commit;
                    const [title, ...rest] = message.split('\n');
                    commits.set(entry.oid, { oid: entry.oid, title, body: rest.join('\n').trim(), author: author.name, timestamp: author.timestamp, parents: parent });
                }
            }
            const list = [...commits.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
            return { commits: list, refs, head: await headOid(ctx), branch: await currentBranch(ctx) };
        }));

        /** What one commit changed compared with its first parent. */
        router.post('/commit/detail', api.handle(async (ctx, request) => {
            const oid = await resolveCommit(ctx, request.body?.oid);
            const { commit } = await git.readCommit({ fs, gitdir: ctx.gitdir, oid, cache: ctx.cache });
            const changes = await diffCommits(ctx, commit.parent[0] ?? null, oid);
            return { oid, message: commit.message, author: commit.author, parents: commit.parent, changes };
        }));

        /** Compares any two commits (or a commit with the current data when `to` is omitted is not supported; use status). */
        router.post('/compare', api.handle(async (ctx, request) => {
            const from = await resolveCommit(ctx, request.body?.from);
            const to = await resolveCommit(ctx, request.body?.to);
            return { from, to, changes: await diffCommits(ctx, from, to) };
        }));

        /**
         * One file before and after a commit (or at a commit vs the current data).
         * Text files under 512 KB come back whole; others only as sizes.
         */
        router.post('/file', api.handle(async (ctx, request) => {
            const filepath = String(request.body?.path ?? '');
            // Never hand out excluded files such as secrets.json, even from the user's own directory.
            if (!filepath || isHardExcluded(filepath) || filepath.split('/').includes('..') || filepath.startsWith('/')) {
                throw api.userError(400, '不能查看这个文件');
            }
            const read = async (oid) => {
                if (!oid) return null;
                const blob = await git.readBlob({ fs, gitdir: ctx.gitdir, oid, filepath, cache: ctx.cache }).catch(() => null);
                return blob ? Buffer.from(blob.blob) : null;
            };
            let before;
            let after;
            if (request.body?.against === 'workdir') {
                before = await read(await headOid(ctx));
                const full = `${ctx.dir}/${filepath}`;
                after = fs.existsSync(full) ? fs.readFileSync(full) : null;
            } else {
                const oid = await resolveCommit(ctx, request.body?.oid);
                const { commit } = await git.readCommit({ fs, gitdir: ctx.gitdir, oid, cache: ctx.cache });
                [before, after] = await Promise.all([read(commit.parent[0] ?? null), read(oid)]);
            }
            const show = (buffer) => {
                if (!buffer) return { exists: false };
                const binary = buffer.subarray(0, 8000).includes(0);
                return { exists: true, size: buffer.length, binary, text: !binary && buffer.length <= MAX_TEXT_BYTES ? buffer.toString('utf8') : null };
            };
            return { path: filepath, before: show(before), after: show(after) };
        }));

        /** Puts some files (or a whole category) back to how they were in a commit. */
        router.post('/restore-files', api.handle(async (ctx, request) => {
            const oid = await resolveCommit(ctx, request.body?.oid);
            const settings = readSettings(ctx);
            const tracked = createTrackFilter(settings.rules);
            const paths = (Array.isArray(request.body?.paths) ? request.body.paths.map(String) : []).filter(tracked);
            if (!paths.length) throw api.userError(400, '没有选择要恢复的文件');
            await createSafetyPoint(ctx, settings, `恢复 ${paths.length} 个文件之前`, api.author(request, settings));
            await applyCommitToWorkTree(ctx, oid, { paths });
            await api.afterWorkTreeChange(request);
            return { restored: paths.length, reload: true };
        }));

        /** Makes the current branch (or a detached HEAD) point at a commit and replaces the data with it. */
        router.post('/reset', api.handle(async (ctx, request) => {
            const oid = await resolveCommit(ctx, request.body?.oid);
            const settings = readSettings(ctx);
            await createSafetyPoint(ctx, settings, `回到 ${oid.slice(0, 7)} 之前`, api.author(request, settings));
            const branch = await currentBranch(ctx);
            await applyCommitToWorkTree(ctx, oid, { moveBranch: branch });
            await api.afterWorkTreeChange(request);
            return { head: oid, branch, reload: true };
        }));
    },
};
