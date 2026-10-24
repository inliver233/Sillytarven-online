import fs from 'node:fs';
import git from 'isomorphic-git';
import { CATEGORIES, HARD_EXCLUDES, sanitizeTrackingRules } from '../tracking.js';
import { commitAll, commitByCategory, commitFiles, currentBranch, ensureRepo, getChangeDigest, getStatus, headOid, readSettings, repoExists, sanitizeSmartCommit, writeSettings } from '../repo.js';
import { PROVIDERS } from '../remotes.js';
import { getEnabledModuleIds, readCredentials } from '../router.js';
import { ensureCloud, hostedConfig, MIRROR_DELAY_MS, MIRROR_SOON_MS, readCloudStatus, scheduleMirror } from './hosted.js';

/**
 * Repository creation, overview, tracking scope, status and commits.
 * @type {import('../router.js').GitModule}
 */
export default {
    id: 'core',
    label: '仓库与提交',
    register(router, api) {
        /** Everything the panel needs to draw itself. */
        router.post('/state', api.handle(async (ctx, request) => {
            const exists = repoExists(ctx);
            if (exists) {
                // Repositories made before 酒馆云 was turned on get connected too.
                await ensureCloud(ctx, api.userError).catch(error => console.warn('[git-sync] 酒馆云 connect failed', error?.message));
            }
            const settings = readSettings(ctx);
            const credentials = readCredentials(ctx);
            const remotes = Object.fromEntries(Object.entries(settings.remotes).map(([name, remote]) => [name, { ...remote, ...(remote.provider === 'hosted' ? { url: '' } : {}), hasToken: Boolean(credentials[name]) }]));
            return {
                exists,
                branch: exists ? await currentBranch(ctx) : null,
                head: exists ? await headOid(ctx) : null,
                settings: { ...settings, remotes },
                defaultAuthor: api.author(request, { ...settings, author: { name: '', email: '' } }),
                categories: CATEGORIES.map(({ id, label, hint, defaultEnabled }) => ({ id, label, hint, defaultEnabled })),
                hardExcludes: HARD_EXCLUDES,
                providers: PROVIDERS,
                modules: getEnabledModuleIds(),
                hosted: hostedConfig() ? { label: hostedConfig().label, site: hostedConfig().site, status: exists ? readCloudStatus(ctx) : null } : null,
                policy: api.policy(),
            };
        }, { needsRepo: false }));

        router.post('/init', api.handle(async (ctx, request) => {
            const branch = String(request.body?.branch || 'main').trim();
            if (!/^[\w.\-/]{1,100}$/.test(branch)) throw api.userError(400, '分支名只能包含字母、数字、-、_、. 和 /');
            const created = await ensureRepo(ctx, branch);
            if (created && request.body?.rules) {
                const settings = readSettings(ctx);
                settings.rules = sanitizeTrackingRules(request.body.rules);
                writeSettings(ctx, settings);
            }
            // With 酒馆云 on there are no local-only repositories.
            const cloud = await ensureCloud(ctx, api.userError).then(() => '', error => error?.userMessage || '酒馆云暂时连不上，下次存档时再连');
            return { created, cloudError: cloud };
        }, { needsRepo: false }));

        router.post('/settings', api.handle(async (ctx, request) => {
            const settings = readSettings(ctx);
            const body = request.body ?? {};
            if (body.rules) settings.rules = sanitizeTrackingRules(body.rules);
            if (body.smartCommit && typeof body.smartCommit === 'object') settings.smartCommit = sanitizeSmartCommit(body.smartCommit);
            if (body.author && typeof body.author === 'object') {
                settings.author = { name: String(body.author.name ?? '').trim().slice(0, 100), email: String(body.author.email ?? '').trim().slice(0, 200) };
            }
            writeSettings(ctx, settings);
            return { settings: { ...settings, remotes: undefined } };
        }, { needsRepo: false }));

        router.post('/status', api.handle(async (ctx) => {
            const settings = readSettings(ctx);
            const { changes, skipped } = await getStatus(ctx, settings);
            return { branch: await currentBranch(ctx), head: await headOid(ctx), changes, skipped };
        }));

        /** What changed inside the files (new chat messages, changed fields), for AI-written messages. */
        router.post('/digest', api.handle(async (ctx, request) => {
            const settings = readSettings(ctx);
            const { changes } = await getStatus(ctx, settings);
            const paths = Array.isArray(request.body?.paths) ? new Set(request.body.paths.map(String)) : null;
            const selected = paths ? changes.filter(change => paths.has(change.path)) : changes;
            return { count: selected.length, items: await getChangeDigest(ctx, selected) };
        }));

        /**
         * Records changes. `light` + `paths`: only those files, no full scan (the open chat, every few
         * messages). `split`: one commit per kind of data. Otherwise one commit (of `paths` if given).
         * 酒馆云 gets the result in the background: light saves are gathered for a few minutes.
         */
        router.post('/commit', api.handle(async (ctx, request) => {
            await api.ensureQuota(request.user.profile, request.user.directories);
            const settings = readSettings(ctx);
            const paths = Array.isArray(request.body?.paths) ? request.body.paths.map(String) : undefined;
            const message = String(request.body?.message ?? '').slice(0, 5000);
            const author = api.author(request, settings);
            const light = Boolean(request.body?.light && paths?.length);
            const result = light ? await commitFiles(ctx, settings, { message, author, paths })
                : request.body?.split && !paths ? await commitByCategory(ctx, settings, { message, author })
                    : await commitAll(ctx, settings, { message, author, paths });
            if (!result) throw api.userError(409, '没有需要提交的改动');
            const scheduled = scheduleMirror(ctx, api.userError, api.policy(), light ? MIRROR_DELAY_MS : MIRROR_SOON_MS);
            return { ...result, cloud: { scheduled } };
        }));

        /** Removes the repository and its settings; the user's data is untouched. */
        router.post('/destroy', api.handle(async (ctx, request) => {
            if (request.body?.confirm !== ctx.handle) throw api.userError(400, '请输入用户名确认删除');
            fs.rmSync(ctx.root, { recursive: true, force: true });
            return { ok: true };
        }, { needsRepo: false }));

        /** Repository size, for the overview. */
        router.post('/size', api.handle(async (ctx) => {
            const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
                const full = `${dir}/${entry.name}`;
                return total + (entry.isDirectory() ? size(full) : fs.statSync(full).size);
            }, 0);
            const objects = await git.listFiles({ fs, gitdir: ctx.gitdir, ref: 'HEAD' }).then(list => list.length).catch(() => 0);
            return { bytes: size(ctx.root), trackedFiles: objects };
        }));
    },
};
