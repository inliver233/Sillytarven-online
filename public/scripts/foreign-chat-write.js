/**
 * 扩展自己整份写聊天：fetch('/api/chats/save') 或 '/api/chats/group/save'，带上整个聊天（比如 Amily2 的
 * 表格系统每次回复后都这样存）。写的是当前打开的聊天时，会绕过页面的保存：服务器上的版本号变了，页面下一次
 * 保存被拒（409），聊天重新载入并弹「聊天已更新」；分页的聊天要是更早的记录没加载下来，页面手上只有最近一页，
 * 还会把服务器上的聊天写短。
 * 这里只认出这种请求、比较它要写的内容；内容和页面手上的一模一样时，由页面自己存（见 script.js）。
 */
import { splitGroupChatFile } from './group-chat-paging.js';

/** 页面自己整份写聊天时带的请求头，带着的不当成扩展的写入 */
export const OWN_CHAT_WRITE_HEADER = 'X-ST-Chat-Writer';

/** @type {Record<string, 'character'|'group'>} */
const WHOLE_CHAT_WRITES = {
    '/api/chats/save': 'character',
    '/api/chats/group/save': 'group',
};

/**
 * @param {Record<string, string>} headers
 * @returns {Record<string, string>}
 */
export function withOwnChatWriteHeader(headers) {
    return { ...headers, [OWN_CHAT_WRITE_HEADER]: 'page' };
}

/**
 * @param {HeadersInit|undefined} headers
 * @param {string} name
 */
function hasHeader(headers, name) {
    if (!headers) {
        return false;
    }
    if (typeof Headers === 'function' && headers instanceof Headers) {
        return headers.has(name);
    }
    const wanted = name.toLowerCase();
    if (Array.isArray(headers)) {
        return headers.some(entry => String(entry?.[0]).toLowerCase() === wanted);
    }
    return Object.keys(headers).some(key => key.toLowerCase() === wanted);
}

/**
 * @typedef {object} ForeignChatWrite
 * @property {'character'|'group'} kind
 * @property {any} body 要写的内容（请求体）
 */

/**
 * 这个请求是不是别人（扩展）整份写某个聊天；是的话读出它要写的内容。
 * 只认同源的 POST，请求体是 JSON 文本（或是 Request 对象里的）；页面自己的写入带着 OWN_CHAT_WRITE_HEADER。
 * @param {RequestInfo|URL} input fetch 的第一个参数
 * @param {RequestInit|undefined} init fetch 的第二个参数
 * @param {string} pageUrl 页面地址，相对地址按它解析
 * @returns {Promise<ForeignChatWrite|null>}
 */
export async function readForeignChatWrite(input, init, pageUrl) {
    const isRequest = typeof Request === 'function' && input instanceof Request;
    const method = String(init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
    if (method !== 'POST') {
        return null;
    }
    let url;
    try {
        url = new URL(isRequest ? input.url : String(input), pageUrl);
    } catch {
        return null;
    }
    const kind = url.origin === new URL(pageUrl).origin ? WHOLE_CHAT_WRITES[url.pathname] : undefined;
    if (!kind || hasHeader(init?.headers, OWN_CHAT_WRITE_HEADER) || (isRequest && hasHeader(input.headers, OWN_CHAT_WRITE_HEADER))) {
        return null;
    }
    let text = null;
    if (typeof init?.body === 'string') {
        text = init.body;
    } else if (init?.body === undefined && isRequest) {
        text = await input.clone().text().catch(() => null);
    }
    if (typeof text !== 'string') {
        return null;
    }
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        return null;
    }
    return body && typeof body === 'object' && Array.isArray(body.chat) ? { kind, body } : null;
}

/**
 * 要写的内容是不是就是页面手上的这个聊天：消息一条不差，聊天元数据一样。
 * 聊天文件头里的用户名、角色名不比（页面存的时候用自己的）；群聊的请求可以不带文件头。
 * @param {ForeignChatWrite} write
 * @param {{ messages: object[], metadata: object }} open 页面上打开的聊天
 * @returns {boolean}
 */
export function writesOpenChatAsHeld(write, { messages, metadata }) {
    const items = write.body.chat;
    const { header, messages: sent } = write.kind === 'group'
        ? splitGroupChatFile(items)
        : { header: items[0], messages: items.slice(1) };
    if (write.kind === 'character' && (!header || typeof header !== 'object')) {
        return false;
    }
    if (sent.length !== messages.length) {
        return false;
    }
    if (header && JSON.stringify(header.chat_metadata ?? {}) !== JSON.stringify(metadata ?? {})) {
        return false;
    }
    return JSON.stringify(sent) === JSON.stringify(messages);
}

/**
 * 给扩展的回应（由页面自己存了，或者没存）。
 * @param {number} status
 * @param {object} data
 * @returns {Response}
 */
export function chatWriteResponse(status, data) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
