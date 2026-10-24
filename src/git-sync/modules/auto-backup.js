import fs from 'node:fs';
import path from 'node:path';
import storage from 'node-persist';
import { getUserDirectories, toKey } from '../../users.js';
import { canConsumeStorage } from '../../storage-quota.js';
import { authorOf, commitAll, currentBranch, getRepoContext, readSettings, repoExists, withRepoLock, writeSettings } from '../repo.js';
import { explainNetworkError, pushRemote } from '../remotes.js';
import { remoteAccessFor } from '../router.js';

const CHECK_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Commits (and optionally pushes) one user's data if the schedule says it is due.
 * @param {string} handle
 * @param {import('../router.js').ModuleApi} api
 * @param {boolean} [force] Run now regardless of the schedule
 */
async function runBackup(handle, api, force = false) {
    const directories = getUserDirectories(handle);
    if (!fs.existsSync(directories.root)) return null;
    const ctx = getRepoContext(handle, directories.root);
    if (!repoExists(ctx)) return null;
    return withRepoLock(ctx, async () => {
        const settings = readSettings(ctx);
        const schedule = settings.autoBackup;
        const due = Date.now() - (schedule.lastRunAt || 0) >= schedule.intervalHours * 3600_000;
        if (!force && (!schedule.enabled || !due)) return null;
        const result = { committed: null, pushed: false, error: '' };
        try {
            const user = await storage.getItem(toKey(handle));
            if (!user) return null;
            if (!(await canConsumeStorage(user, directories, 1)).allowed) {
                throw new Error('存储空间已满，自动备份已跳过');
            }
            result.committed = await commitAll(ctx, settings, { message: '自动备份', author: authorOf(settings, handle) });
            const remote = settings.remotes[schedule.remote];
            const branch = schedule.branch || await currentBranch(ctx);
            if (schedule.push && remote && branch) {
                const access = await remoteAccessFor(ctx, schedule.remote);
                await pushRemote(ctx, schedule.remote, access, api.policy(), { ref: branch });
                result.pushed = true;
            }
        } catch (error) {
            result.error = explainNetworkError(error);
        }
        const latest = readSettings(ctx);
        latest.autoBackup = { ...latest.autoBackup, lastRunAt: Date.now(), lastError: result.error };
        writeSettings(ctx, latest);
        return result;
    });
}

/**
 * Scheduled commits and pushes.
 * @type {import('../router.js').GitModule}
 */
export default {
    id: 'autoBackup',
    label: '自动备份',
    register(router, api) {
        router.post('/auto-backup/save', api.handle(async (ctx, request) => {
            const body = request.body ?? {};
            const settings = readSettings(ctx);
            const hours = Number(body.intervalHours);
            settings.autoBackup = {
                ...settings.autoBackup,
                enabled: Boolean(body.enabled),
                intervalHours: Number.isFinite(hours) ? Math.min(Math.max(Math.round(hours), 1), 24 * 30) : settings.autoBackup.intervalHours,
                push: Boolean(body.push),
                remote: String(body.remote || settings.autoBackup.remote || 'origin'),
                branch: String(body.branch ?? ''),
            };
            writeSettings(ctx, settings);
            return { autoBackup: settings.autoBackup };
        }));

        router.post('/auto-backup/run', async (request, response) => {
            try {
                const result = await runBackup(request.user.profile.handle, api, true);
                if (!result) return response.status(409).json({ error: '还没有创建酒馆 Git 仓库' });
                return response.json(result);
            } catch (error) {
                console.error('[git-sync] auto backup failed', error);
                return response.status(500).json({ error: error?.message || '自动备份失败' });
            }
        });
    },
    start(api) {
        const tick = async () => {
            const root = path.join(globalThis.DATA_ROOT, '_git');
            let handles = [];
            try {
                handles = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
            } catch {
                return;
            }
            for (const handle of handles) {
                try {
                    await runBackup(handle, api);
                } catch (error) {
                    console.warn(`[git-sync] auto backup for ${handle} failed`, error);
                }
            }
        };
        const timer = setInterval(tick, CHECK_INTERVAL_MS);
        timer.unref?.();
    },
};
