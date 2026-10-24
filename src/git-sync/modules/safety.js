import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import { applyCommitToWorkTree, createSafetyPoint, currentBranch, diffCommits, headOid, listSafetyPoints, readSettings } from '../repo.js';

/**
 * Safety points: automatic snapshots taken before anything replaced the user's data.
 * @type {import('../router.js').GitModule}
 */
export default {
    id: 'safety',
    label: '安全存档',
    register(router, api) {
        router.post('/safety', api.handle(async (ctx) => {
            const points = [];
            for (const point of await listSafetyPoints(ctx)) {
                const { commit } = await git.readCommit({ fs, gitdir: ctx.gitdir, oid: point.oid, cache: ctx.cache });
                points.push({ ...point, title: commit.message.split('\n')[0] });
            }
            return { points };
        }));

        /** What restoring a safety point would change compared with the current commit. */
        router.post('/safety/preview', api.handle(async (ctx, request) => {
            const point = (await listSafetyPoints(ctx)).find(entry => entry.id === String(request.body?.id));
            if (!point) throw api.userError(404, '找不到这个安全存档');
            return { changes: await diffCommits(ctx, await headOid(ctx), point.oid) };
        }));

        /** Puts the data back to a safety point; the branch moves there too. */
        router.post('/safety/restore', api.handle(async (ctx, request) => {
            const point = (await listSafetyPoints(ctx)).find(entry => entry.id === String(request.body?.id));
            if (!point) throw api.userError(404, '找不到这个安全存档');
            const settings = readSettings(ctx);
            await createSafetyPoint(ctx, settings, '恢复安全存档之前', api.author(request, settings));
            await applyCommitToWorkTree(ctx, point.oid, { moveBranch: await currentBranch(ctx) });
            await api.afterWorkTreeChange(request);
            return { head: point.oid, reload: true };
        }));

        router.post('/safety/delete', api.handle(async (ctx, request) => {
            const point = (await listSafetyPoints(ctx)).find(entry => entry.id === String(request.body?.id));
            if (!point) throw api.userError(404, '找不到这个安全存档');
            await git.deleteRef({ fs, gitdir: ctx.gitdir, ref: point.ref });
            const file = path.join(ctx.root, 'safety-reasons.json');
            try {
                const reasons = JSON.parse(fs.readFileSync(file, 'utf8'));
                delete reasons[point.ref];
                fs.writeFileSync(file, JSON.stringify(reasons));
            } catch {
                // Nothing recorded
            }
            return { deleted: point.id };
        }));
    },
};
