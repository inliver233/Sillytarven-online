import fs from 'node:fs';
import git from 'isomorphic-git';
import { headOid, readSettings } from '../repo.js';
import { resolveTarget } from './branches.js';

const TAG_NAME = /^(?!.*\.\.)(?!\/)(?!.*\/$)[\w.\-/一-龥]{1,100}$/;

/**
 * Tags, shown as named save points ("存档点").
 * @type {import('../router.js').GitModule}
 */
export default {
    id: 'tags',
    label: '存档点（标签）',
    register(router, api) {
        router.post('/tags', api.handle(async (ctx) => {
            const tags = [];
            for (const name of await git.listTags({ fs, gitdir: ctx.gitdir })) {
                const oid = await git.resolveRef({ fs, gitdir: ctx.gitdir, ref: `refs/tags/${name}` });
                const annotated = await git.readTag({ fs, gitdir: ctx.gitdir, oid }).catch(() => null);
                const target = annotated?.tag.object ?? oid;
                const { commit } = await git.readCommit({ fs, gitdir: ctx.gitdir, oid: target, cache: ctx.cache });
                tags.push({ name, oid: target, note: annotated?.tag.message?.trim() ?? '', timestamp: annotated?.tag.tagger.timestamp ?? commit.author.timestamp, title: commit.message.split('\n')[0] });
            }
            return { tags: tags.sort((a, b) => b.timestamp - a.timestamp) };
        }));

        router.post('/tag/create', api.handle(async (ctx, request) => {
            const name = String(request.body?.name ?? '').trim();
            if (!TAG_NAME.test(name)) throw api.userError(400, '存档点名称只能包含中英文、数字、-、_、. 和 /');
            const oid = request.body?.oid ? await resolveTarget(ctx, request.body.oid) : await headOid(ctx);
            if (!oid) throw api.userError(409, '请先提交一次，再创建存档点');
            const settings = readSettings(ctx);
            await git.annotatedTag({
                fs, gitdir: ctx.gitdir, ref: name, object: oid,
                message: String(request.body?.note ?? '').slice(0, 2000) || name,
                tagger: api.author(request, settings),
            }).catch((error) => {
                if (error?.code === 'AlreadyExistsError') throw api.userError(409, `存档点 ${name} 已存在`);
                throw error;
            });
            return { name, oid };
        }));

        router.post('/tag/delete', api.handle(async (ctx, request) => {
            const name = String(request.body?.name ?? '');
            await git.deleteTag({ fs, gitdir: ctx.gitdir, ref: name });
            return { deleted: name };
        }));
    },
};
