/**
 * 同一浏览器里本站的几个标签页互相打招呼（BroadcastChannel，消息不出这个浏览器）：
 * - 一个标签页存了某个聊天：开着同一个聊天、手上没事的标签页马上重新载入它，不会拿着旧内容再去覆盖；
 *   手上有事的（正在生成、有没存的改动）等它自己保存时由服务器拦下（409），同样换成最新内容。
 * - 一个标签页改了设置：其他标签页在后台就悄悄刷新（刷新后回到原来的聊天），在前台就提示刷新，
 *   免得拿着旧设置一保存，把那边的改动盖掉。选中的角色、界面开关这类随手变的不算改了设置。
 */
import {
    characters,
    eventSource,
    event_types,
    getCurrentChatId,
    getCurrentChatKey,
    getSettingsPayload,
    hasPendingChatSave,
    isChatLoading,
    isGenerating,
    reloadChatChangedElsewhere,
    this_chid,
} from '../script.js';
import { selected_group } from './group-chats.js';
import { getCurrentUserHandle } from './user.js';
import { uuidv4 } from './utils.js';
import { openChatByIdentity } from './welcome-screen.js';

const TAB_ID = uuidv4();
/** 刷新前记下要回到的聊天（只在这个标签页里有效） */
const REOPEN_KEY = 'tabSyncReopenChat';
/** 上一次因为别处改了设置而自动刷新的时间：一分钟内不再自动刷新，改为提示 */
const RELOADED_AT_KEY = 'tabSyncReloadedAt';
/** 别处改了设置以后等这么久再处理（连着改好几项只刷新一次） */
const SETTINGS_SETTLE_MS = 4000;
/** 这些随手就变，不算改了设置 */
const VOLATILE_SETTINGS = ['firstRun', 'accountStorage', 'currentVersion', 'active_character', 'active_group'];

/** @type {BroadcastChannel|null} */
let channel = null;
/** 别的标签页改过设置，这里的还是旧的 */
let settingsChangedElsewhere = false;
/** @type {ReturnType<typeof setTimeout>|null} */
let settingsTimer = null;
/** @type {JQuery<HTMLElement>|null} */
let settingsToast = null;
/** 上一次存（或启动时载入）的设置，去掉随手变的部分 @type {string|null} */
let settingsDigest = null;

/**
 * @param {string} type
 * @param {object} [detail]
 */
export function tellOtherTabs(type, detail = {}) {
    try {
        channel?.postMessage({ ...detail, type, tab: TAB_ID });
    } catch {
        // Channel closed (page unloading): nothing to tell.
    }
}

/** @param {object} payload Settings as saveSettings sends them */
function digestSettings(payload) {
    const meaningful = { ...payload };
    for (const key of VOLATILE_SETTINGS) {
        delete meaningful[key];
    }
    return JSON.stringify(meaningful);
}

/**
 * 设置存好了：和上一次比有实质改动，就告诉其他标签页。
 * @param {object} payload Settings as saveSettings sends them
 */
export function noteSettingsSaved(payload) {
    const digest = digestSettings(payload);
    const changed = settingsDigest !== null && digest !== settingsDigest;
    settingsDigest = digest;
    // 这一页自己存过，就是最新的了
    settingsChangedElsewhere = false;
    if (changed) {
        tellOtherTabs('settings-saved');
    }
}

/** 手上没事：没在生成、没在载入、没有还没存的聊天改动、没在编辑消息 */
function isIdle() {
    return !isGenerating() && !isChatLoading() && !hasPendingChatSave() && !document.getElementById('curEditTextarea');
}

/** 刷新这个标签页，刷新后回到现在开着的聊天（输入框里没发的字由草稿功能带回来） */
export function reloadPageKeepingChat() {
    try {
        const chatId = getCurrentChatId();
        let target = null;
        if (chatId && selected_group) {
            target = { groupId: String(selected_group), chatId };
        } else if (chatId && this_chid !== undefined && characters[this_chid]) {
            target = { avatar: characters[this_chid].avatar, chatId };
        }
        if (target) {
            sessionStorage.setItem(REOPEN_KEY, JSON.stringify(target));
        }
        sessionStorage.setItem(RELOADED_AT_KEY, String(Date.now()));
    } catch {
        // Storage blocked: the page still reloads, on the welcome screen.
    }
    window.location.reload();
}

async function reopenChatAfterReload() {
    let target = null;
    try {
        target = JSON.parse(sessionStorage.getItem(REOPEN_KEY) || 'null');
        sessionStorage.removeItem(REOPEN_KEY);
    } catch {
        return;
    }
    if (target?.chatId) {
        await openChatByIdentity(target);
    }
}

function reloadedRecently() {
    try {
        return Date.now() - Number(sessionStorage.getItem(RELOADED_AT_KEY) || 0) < 60_000;
    } catch {
        return false;
    }
}

/** @param {{ chat?: string }} data */
function onChatSaved({ chat }) {
    if (!chat || chat !== getCurrentChatKey() || !isIdle()) {
        return;
    }
    void reloadChatChangedElsewhere({ fromOtherTab: true });
}

function onSettingsSaved() {
    settingsChangedElsewhere = true;
    if (settingsTimer) {
        clearTimeout(settingsTimer);
    }
    settingsTimer = setTimeout(handleSettingsChangedElsewhere, SETTINGS_SETTLE_MS);
}

function handleSettingsChangedElsewhere() {
    settingsTimer = null;
    if (!settingsChangedElsewhere) {
        return;
    }
    if (!document.hidden) {
        showSettingsToast();
    } else if (isIdle() && !reloadedRecently()) {
        reloadPageKeepingChat();
    }
    // 在后台但手上有事：回到前台时再提示
}

function showSettingsToast() {
    if (settingsToast?.is(':visible')) {
        return;
    }
    settingsToast = toastr.warning(
        '另一个标签页改了设置，这个页面还是旧的。点这里刷新本页（会回到现在这个聊天）；不刷新的话，在这里存设置会盖掉那边的改动。',
        '设置已在别处更改',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            closeButton: true,
            tapToDismiss: false,
            onclick: () => reloadPageKeepingChat(),
            onHidden: () => { settingsToast = null; },
        },
    );
}

export function initTabSync() {
    if (channel || typeof BroadcastChannel !== 'function') {
        return;
    }
    channel = new BroadcastChannel(`sillytavern-tabs:${getCurrentUserHandle() || 'default-user'}`);
    channel.addEventListener('message', ({ data }) => {
        if (!data || data.tab === TAB_ID) {
            return;
        }
        if (data.type === 'chat-saved') {
            onChatSaved(data);
        } else if (data.type === 'settings-saved') {
            onSettingsSaved();
        }
    });
    document.addEventListener('visibilitychange', () => {
        if (!settingsChangedElsewhere || settingsTimer) {
            return;
        }
        if (!document.hidden) {
            showSettingsToast();
        } else if (isIdle() && !reloadedRecently()) {
            reloadPageKeepingChat();
        }
    });
    eventSource.on(event_types.APP_READY, () => {
        settingsDigest = digestSettings(getSettingsPayload());
        void reopenChatAfterReload();
    });
}
