import { getRequestHeaders, saveChatConditional, saveSettings } from '../../../script.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../popup.js';

/**
 * Calls the built-in git API.
 * @param {string} route e.g. '/status'
 * @param {object} [body]
 */
export async function gitApi(route, body = {}) {
    const response = await fetch(`/api/git-sync${route}`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw Object.assign(new Error(data.error || `请求失败（${response.status}）`), { status: response.status, data });
    }
    return data;
}

/** Escapes text for HTML. Commit messages, file and branch names may come from other people's repositories. */
export function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[char]);
}

/** @param {number} seconds Unix time in seconds */
export function timeAgo(seconds) {
    const diff = Date.now() / 1000 - seconds;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
    return new Date(seconds * 1000).toLocaleDateString();
}

/** @param {number} seconds */
export function fullTime(seconds) {
    return new Date(seconds * 1000).toLocaleString();
}

/** @param {number} bytes */
export function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export const CATEGORY_ICONS = {
    chats: 'fa-comments', groupChats: 'fa-users', characters: 'fa-address-card', worlds: 'fa-book-atlas', presets: 'fa-sliders',
    settings: 'fa-gear', personas: 'fa-user-pen', quickReplies: 'fa-bolt', themes: 'fa-palette', backgrounds: 'fa-image',
    userFiles: 'fa-folder-open', extensions: 'fa-puzzle-piece', other: 'fa-file',
};

export const KIND_LABELS = { added: '新增', modified: '修改', deleted: '删除', untracked: '停止同步' };

/**
 * @param {string} html Message (HTML allowed; escape inserted values)
 * @param {{ okButton?: string, danger?: boolean }} [options]
 */
export async function confirmAction(html, { okButton = '确定', danger = false } = {}) {
    const result = await callGenericPopup(`<div class="git-sync-confirm${danger ? ' danger' : ''}">${html}</div>`, POPUP_TYPE.CONFIRM, '', { okButton, cancelButton: '取消' });
    return result === POPUP_RESULT.AFFIRMATIVE;
}

/**
 * @param {string} html
 * @param {string} [value]
 */
export async function promptText(html, value = '') {
    const result = await callGenericPopup(html, POPUP_TYPE.INPUT, value, { okButton: '确定', cancelButton: '取消' });
    return typeof result === 'string' ? result.trim() : null;
}

/** Writes pending settings and chat edits to disk so git sees them. */
export async function flushPendingSaves() {
    try {
        await saveSettings();
    } catch (error) {
        console.warn('[git-sync] settings save before git failed', error);
    }
    try {
        await saveChatConditional();
    } catch (error) {
        console.warn('[git-sync] chat save before git failed', error);
    }
}

/**
 * After an operation replaced files, the page's in-memory copy is stale: reload it.
 * @param {{ reload?: boolean }} result
 * @param {string} message
 */
export function finishWorkTreeChange(result, message) {
    if (!result?.reload) {
        toastr.success(message);
        return false;
    }
    toastr.success(`${message}，正在重新加载酒馆…`, '', { timeOut: 2500 });
    setTimeout(() => location.reload(), 1200);
    return true;
}

/** Shows an error from gitApi. */
export function showError(error, title = '操作失败') {
    console.error('[git-sync]', error);
    toastr.error(esc(error?.message || String(error)), title, { escapeHtml: false });
}
