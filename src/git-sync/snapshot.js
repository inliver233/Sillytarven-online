import { getRepoContext, readSettings, repoExists, withRepoLock, authorOf, commitByCategory } from './repo.js';
import { MIRROR_SOON_MS, scheduleMirror } from './modules/hosted.js';
import { getPolicy, storageRoom, userError } from './router.js';

/**
 * Saves the user's data just before something is deleted, so a deleted character, chat or
 * lorebook can be brought back from the history. Waits at most a few seconds, then lets the
 * deletion go ahead either way. Off with `smartCommit.beforeDelete: false`.
 */

/** Deleting routes → what the save is called in the history */
const DELETES = {
    '/api/characters/delete': '删除角色卡',
    '/api/chats/delete': '删除聊天',
    '/api/chats/group/delete': '删除群聊记录',
    '/api/groups/delete': '删除群组',
    '/api/worldinfo/delete': '删除世界书',
    '/api/presets/delete': '删除预设',
    '/api/quick-replies/delete': '删除快速回复',
    '/api/themes/delete': '删除主题',
    '/api/backgrounds/delete': '删除背景图',
    '/api/avatars/delete': '删除用户人设头像',
};

const WAIT_MS = 4000;

/** @type {import('express').RequestHandler} */
export async function snapshotBeforeDelete(request, response, next) {
    const label = request.method === 'POST' ? DELETES[request.path] : undefined;
    const handle = request.user?.profile?.handle;
    if (!label || !handle) return next();
    try {
        const ctx = getRepoContext(handle, request.user.directories.root);
        if (repoExists(ctx) && readSettings(ctx).smartCommit.beforeDelete) {
            const work = withRepoLock(ctx, async () => {
                const roomBytes = await storageRoom(request.user.profile, request.user.directories);
                if (roomBytes <= 0) return null;
                const settings = readSettings(ctx);
                const author = authorOf(settings, request.user.profile.name || handle);
                return commitByCategory(ctx, settings, { message: `${label}前自动存档`, author, roomBytes });
            }).then(result => {
                if (result) scheduleMirror(ctx, userError, getPolicy(), MIRROR_SOON_MS);
            }).catch(error => {
                // Also after the wait below has given up: a rejection nobody handles would stop the server.
                // Without room the delete goes ahead unsaved, as it does when the quota is full.
                console.warn('[git-sync] save before delete skipped', error?.message);
            });
            await Promise.race([work, new Promise(resolve => setTimeout(resolve, WAIT_MS))]);
        }
    } catch (error) {
        console.warn('[git-sync] save before delete failed', error?.message);
    }
    return next();
}
