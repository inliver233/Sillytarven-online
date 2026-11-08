// 实时通道：服务器通过 WebSocket 主动通知打开着的页面（刷新页面、显示消息……），协议见 src/live.js。
//
// 扩展用法：
//   import { onLive, sendLive } from './live.js';
//   onLive('my-type', (data, message) => { … });   // 服务器 live.send(target, 'my-type', data) 时调用
//   sendLive('my-type', data);                     // 服务器 live.on('my-type', …) 收到
// 不想 import 的话，每条消息也会以 eventSource 事件 'live:<类型>' 发出。
import { isChatSaving, isGenerating } from '../script.js';
import { eventSource, event_types } from './events.js';

const RECONNECT_MAX_MS = 60e3;
/** 一次都没连上过（比如反向代理不支持 WebSocket）就少试几次。 */
const RECONNECT_NEVER_OPENED_MAX_MS = 5 * 60e3;
const LOGGED_OUT_RETRY_MS = 5 * 60e3;
/** 服务器热重载后所有页面一起重连，分散到这段时间里。 */
const RESTART_SPREAD_MS = 10e3;

/** @type {Map<string, Set<(data: any, message: {t: string, d?: any, id?: string, late?: boolean}) => unknown>>} */
const handlers = new Map();
/** 已处理过的指令：页面重连后，服务器会再补发一次它当时可能没收到的指令。 */
const handled = new Set();

/** @type {WebSocket|null} */
let socket = null;
let connecting = false;
let started = false;
let disabled = false;
let opened = false;
let failures = 0;
let heartbeatMs = 30e3;
/** @type {ReturnType<typeof setTimeout>|null} */
let retryTimer = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let watchdog = null;

/**
 * 处理服务器发来的某类消息。
 * @param {string} type 消息类型
 * @param {(data: any, message: {t: string, d?: any, id?: string}) => unknown} handler 处理函数
 * @returns {() => void} 取消
 */
export function onLive(type, handler) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(handler);
    return () => handlers.get(type)?.delete(handler);
}

/**
 * 发一条消息给服务器（没连上就不发）。
 * @param {string} type 消息类型
 * @param {unknown} [data] 内容
 * @returns {boolean} 是否发出
 */
export function sendLive(type, data) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(data === undefined ? { t: type } : { t: type, d: data }));
    return true;
}

/** @returns {boolean} 现在是否连着 */
export function isLiveConnected() {
    return socket?.readyState === WebSocket.OPEN;
}

/**
 * @param {number} delay
 */
function retryIn(delay) {
    if (disabled || retryTimer) return;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
    }, delay);
}

function retryLater() {
    failures++;
    const max = opened ? RECONNECT_MAX_MS : RECONNECT_NEVER_OPENED_MAX_MS;
    retryIn(Math.min(max, 1000 * 2 ** Math.min(failures - 1, 9)) * (0.5 + Math.random() / 2));
}

function heard() {
    if (watchdog) clearTimeout(watchdog);
    // 太久没收到任何消息（含心跳）就当连接已断，换一条。
    watchdog = setTimeout(() => {
        watchdog = null;
        const stale = socket;
        socket = null;
        stale?.close();
        retryLater();
    }, heartbeatMs * 2.5);
}

async function connect() {
    if (disabled || socket || connecting) return;
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    connecting = true;
    let ticket = '';
    try {
        // 票据走普通请求，登录、IP 白名单等检查和其他接口一样。
        const response = await fetch('/api/live/ticket', { cache: 'no-store' });
        if (response.status === 404) {
            disabled = true; // 本站没开
            return;
        }
        if (response.status === 401 || response.status === 403) {
            retryIn(LOGGED_OUT_RETRY_MS);
            return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        ticket = String((await response.json())?.ticket ?? '');
    } catch {
        retryLater();
        return;
    } finally {
        connecting = false;
    }
    if (!ticket || socket) return;

    const age = Math.max(0, Math.round(Date.now() - performance.timeOrigin));
    const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/live?ticket=${encodeURIComponent(ticket)}&age=${age}`;
    const ws = new WebSocket(url);
    socket = ws;
    ws.addEventListener('open', () => {
        if (socket !== ws) return;
        opened = true;
        failures = 0;
        heard();
    });
    ws.addEventListener('message', event => {
        if (socket !== ws) return;
        heard();
        receive(event.data);
    });
    ws.addEventListener('close', event => {
        if (socket !== ws) return;
        socket = null;
        if (watchdog) clearTimeout(watchdog);
        watchdog = null;
        // 1012：服务器在热重载，马上就好。4008：同一账号开的页面太多，这个最早的让位，等用户回到这个页面再连。
        if (event.code === 1012) retryIn(500 + Math.random() * RESTART_SPREAD_MS);
        else if (event.code !== 4008) retryLater();
    });
}

/**
 * @param {unknown} raw
 */
function receive(raw) {
    let message;
    try {
        message = JSON.parse(String(raw));
    } catch {
        return;
    }
    if (!message || typeof message.t !== 'string') return;
    if (message.t === 'ping') {
        sendLive('pong');
        return;
    }
    if (message.t === 'hello') {
        heartbeatMs = Number(message.d?.heartbeat) || heartbeatMs;
        heard();
        sendPendingSeen();
    }
    if (message.id) {
        if (handled.has(message.id)) return;
        handled.add(message.id);
    }
    for (const handler of handlers.get(message.t) ?? []) {
        try {
            const result = handler(message.d, message);
            if (result instanceof Promise) result.catch(error => console.error(`[live] ${message.t}:`, error));
        } catch (error) {
            console.error(`[live] ${message.t}:`, error);
        }
    }
    void eventSource.emit(`live:${message.t}`, message.d, message);
}

// ---- 内置：刷新页面 ----

let lastInputAt = 0;
let reloading = false;

/** @returns {string} 现在不适合刷新的原因；空 = 可以刷新 */
function busyReason() {
    if (isGenerating()) return '正在生成回复，结束后刷新';
    if (isChatSaving) return '正在保存聊天，保存完后刷新';
    if (document.getElementById('curEditTextarea') || document.querySelector('.reasoning_edit_textarea')) return '正在编辑消息，编辑完后刷新';
    if (document.querySelector('dialog.popup[open]')) return '有窗口开着，关闭后刷新';
    if (Date.now() - lastInputAt < 5000) return '正在输入，停下后刷新';
    return '';
}

/**
 * @param {{delay?: number, message?: string, wait?: boolean}} [data]
 */
async function reloadPage({ delay = 5, message = '', wait = true } = {}) {
    if (reloading) return;
    reloading = true;
    const startedAt = Date.now();
    // 一直忙也最多再等十分钟。
    const waitUntil = startedAt + delay * 1000 + 10 * 60e3;
    let now = false;
    const toast = toastr.warning(' ', '页面即将刷新', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: false,
        escapeHtml: true,
        onclick: () => {
            now = true;
        },
    });
    const body = toast.find('.toast-message')[0];
    const status = document.createElement('div');
    const hint = document.createElement('small');
    hint.textContent = '点此立即刷新';
    body?.replaceChildren(...(message ? [Object.assign(document.createElement('div'), { textContent: message })] : []), status, hint);

    let idleSince = 0;
    while (!now) {
        const left = Math.ceil((startedAt + delay * 1000 - Date.now()) / 1000);
        const reason = wait && Date.now() < waitUntil ? busyReason() : '';
        if (left > 0) {
            status.textContent = `${left} 秒后刷新`;
        } else if (reason) {
            status.textContent = reason;
            idleSince = 0;
        } else {
            // 刚空闲下来时再等一会儿，让还没发出或正在发的保存完成。
            idleSince ||= Date.now();
            if (!wait || Date.now() - idleSince >= 1500) break;
            status.textContent = '正在刷新…';
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    status.textContent = '正在刷新…';
    location.reload();
}

onLive('reload', data => reloadPage(data));

// ---- 内置：显示消息 ----
// 「上线后补发」的消息（带 late）：等页面在前台才显示，关掉才算这个账号看到了，告诉服务器（'seen'），
// 之后再打开网页不会再收到；这个账号别的页面上还显示着的，服务器会让它们一起收起来。

/** 显示着的补发消息：id → 提示 @type {Map<string, JQuery<HTMLElement>>} */
const lateNotices = new Map();
/** 这个账号已经看过的补发消息（可能是在别的页面上） */
const seenLate = new Set();
/** 关掉了、还没能告诉服务器的（当时正好断线） */
const pendingSeen = new Set();

function sendPendingSeen() {
    for (const id of pendingSeen) {
        if (sendLive('seen', { id })) pendingSeen.delete(id);
    }
}

function whenVisible() {
    if (!document.hidden) return Promise.resolve();
    return new Promise(resolve => {
        const check = () => {
            if (document.hidden) return;
            document.removeEventListener('visibilitychange', check);
            resolve();
        };
        document.addEventListener('visibilitychange', check);
    });
}

onLive('notice', async ({ text = '', title = '', level = 'info', timeout = 15 } = {}, message) => {
    const late = message?.late === true && typeof message.id === 'string';
    if (late) {
        await whenVisible();
        if (seenLate.has(message.id)) return;
    }
    const show = toastr[level] ?? toastr.info;
    const ms = Math.max(0, Number(timeout) || 0) * 1000;
    const toast = show(text, title, {
        timeOut: ms,
        extendedTimeOut: ms ? 5000 : 0,
        tapToDismiss: ms > 0,
        closeButton: true,
        escapeHtml: true,
        messageClass: 'toast-message live-notice-message',
        onHidden: late ? () => {
            lateNotices.delete(message.id);
            if (seenLate.has(message.id)) return;
            seenLate.add(message.id);
            pendingSeen.add(message.id);
            sendPendingSeen();
        } : undefined,
    });
    if (late) lateNotices.set(message.id, toast);
});

onLive('seen', ({ id } = {}) => {
    if (typeof id !== 'string') return;
    seenLate.add(id);
    pendingSeen.delete(id);
    const toast = lateNotices.get(id);
    if (toast) toastr.clear(toast, { force: true });
});

// ---- 启动 ----

function start() {
    if (started) return;
    started = true;
    document.addEventListener('keydown', () => {
        lastInputAt = Date.now();
    }, { capture: true, passive: true });
    document.addEventListener('input', () => {
        lastInputAt = Date.now();
    }, { capture: true, passive: true });
    // 回到页面或网络恢复时立刻重连，不等退避。
    const reconnectNow = () => {
        if (disabled || socket || document.visibilityState === 'hidden') return;
        failures = 0;
        void connect();
    };
    document.addEventListener('visibilitychange', reconnectNow);
    window.addEventListener('online', reconnectNow);
    void connect();
}

eventSource.makeFirst(event_types.APP_READY, start);
