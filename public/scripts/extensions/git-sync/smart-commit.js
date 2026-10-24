import { eventSource, event_types } from '../../../script.js';
import { getContext } from '../../extensions.js';
import { writeCommitMessage, isGenerating } from './ai-commit.js';
import { esc, flushPendingSaves, gitApi } from './shared.js';

/**
 * Smart auto-save: commits while the user plays. Every N new messages only the open chat is saved
 * (no scan of the rest of the data, silent); leaving a chat saves everything, one commit per kind
 * of data. Runs in the page, so it can wait for a reply to finish and use the user's model for
 * messages. 酒馆云 uploads are made by the server; other remotes are pushed from here.
 */

const ERROR_COOLDOWN_MS = 10 * 60 * 1000;
const DEBOUNCE_MS = 4000;

/** @type {{ onChatSwitch: boolean, everyMessages: number, push: boolean, remote: string, aiMessages: boolean }|null} */
let config = null;
let hasRemote = false;
/** 'light' (open chat only) or 'full' */
let pendingKind = 'full';
let messagesSinceCommit = 0;
let running = false;
let pending = null;
let timer = null;
let lastErrorAt = 0;

/** Reloads the settings from the server (also after the panel saves them). */
export async function reloadSmartCommit() {
    try {
        const state = await gitApi('/state');
        config = state.exists ? state.settings.smartCommit : null;
        // 酒馆云 is uploaded by the server after every save.
        const remote = config ? state.settings.remotes[config.remote] : null;
        hasRemote = Boolean(remote && remote.provider !== 'hosted');
    } catch {
        config = null;
    }
}

/**
 * Files of the open chat (the chat and its companions), relative to the user's folder.
 * @returns {string[]|null}
 */
function openChatPaths() {
    const context = getContext();
    const chatId = context.getCurrentChatId?.();
    if (!chatId) return null;
    let base;
    if (context.groupId) {
        base = `group chats/${chatId}.jsonl`;
    } else {
        const avatar = context.characters?.[context.characterId]?.avatar;
        if (!avatar) return null;
        base = `chats/${avatar.replace(/\.[^.]+$/, '')}/${chatId}.jsonl`;
    }
    return ['', '.chunks', '.index.json', '.metadata.json', '.revision.json'].map(suffix => base + suffix);
}

/**
 * @param {string} reason
 * @param {'light'|'full'} [kind]
 */
function schedule(reason, kind = 'full') {
    if (!config) return;
    console.debug('[git-sync] auto-save scheduled:', reason, kind);
    // A full save already pending covers a light one.
    if (!(pending && pendingKind === 'full')) pendingKind = kind;
    pending = reason;
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
}

async function run() {
    if (!pending || !config) return;
    if (running) return;
    if (isGenerating()) {
        // Try again after the reply ends (GENERATION_ENDED also reschedules).
        timer = setTimeout(run, DEBOUNCE_MS);
        return;
    }
    const reason = pending;
    const paths = pendingKind === 'light' ? openChatPaths() : null;
    const light = Boolean(paths);
    pending = null;
    pendingKind = 'full';
    running = true;
    try {
        await flushPendingSaves();
        let message = '';
        // Light saves happen every few messages; an AI-written message each time would cost too much.
        if (config.aiMessages && !light) {
            message = await writeCommitMessage().catch(() => '');
        }
        let result;
        try {
            console.debug('[git-sync] auto-save:', reason, light ? 'open chat' : 'everything');
            result = await gitApi('/commit', light ? { light: true, paths } : { split: true, message });
        } catch (error) {
            if (error.status === 409) {
                console.debug('[git-sync] auto-save skipped: nothing changed');
                return;
            }
            throw error;
        }
        messagesSinceCommit = 0;
        if (config.push && hasRemote) {
            await gitApi('/push', { remote: config.remote });
        }
        if (!light) {
            const title = (message || result.summary).split('\n')[0];
            toastr.info(esc(title), `已自动存档${config.push && hasRemote ? '并推送' : ''}`, { timeOut: 2500, escapeHtml: false });
        }
    } catch (error) {
        if (Date.now() - lastErrorAt > ERROR_COOLDOWN_MS) {
            lastErrorAt = Date.now();
            toastr.warning(esc(error?.message || String(error)), '酒馆 Git 自动存档失败', { escapeHtml: false });
        }
        console.warn('[git-sync] smart commit failed', error);
    } finally {
        running = false;
        if (pending) schedule(pending);
    }
}

export function startSmartCommit() {
    // GENERATION_STARTED also fires for dry runs (token counting) that never end, so the page's
    // own "generating" marker decides; these events only resume a waiting save promptly.
    const ended = () => {
        if (pending) schedule(pending);
    };
    eventSource.on(event_types.GENERATION_ENDED, ended);
    eventSource.on(event_types.GENERATION_STOPPED, ended);
    // Only leaving an open chat counts; the page opening its first chat does not. Chat file names
    // repeat across characters, so the character or group is part of the key.
    const chatKey = () => {
        const context = getContext();
        const chatId = context.getCurrentChatId?.();
        return chatId ? `${context.groupId ?? context.characterId ?? ''}|${chatId}` : null;
    };
    let previousChat = chatKey();
    eventSource.on(event_types.CHAT_CHANGED, () => {
        const current = chatKey();
        const left = previousChat && current !== previousChat;
        previousChat = current;
        if (left && config?.onChatSwitch) schedule('切换聊天');
    });
    const counted = () => {
        if (!config?.everyMessages) return;
        messagesSinceCommit++;
        if (messagesSinceCommit >= config.everyMessages) schedule(`${messagesSinceCommit} 条新消息`, 'light');
    };
    eventSource.on(event_types.MESSAGE_RECEIVED, counted);
    eventSource.on(event_types.MESSAGE_SENT, counted);
    void reloadSmartCommit();
}
