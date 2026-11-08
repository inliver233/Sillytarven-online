/**
 * 保存遇到连接断开、服务器一时不可用时自动重试（等 1 秒、再等 3 秒），仍不行才交给调用方报错，
 * 免得网络抖一下就弹「无法保存」。只重试换个时候再来就可能成的：请求没发出去或半路断了、
 * 502/503/504、Cloudflare 的 52x/530、总控正在做快照（423 user_quiescing）。其余回应原样返回。
 *
 * 聊天保存每次带上自己定的新版本号（nextRevision）：第一次其实存上了、只是回应丢了时，重试会被
 * 当成版本冲突（409），而服务器上的当前版本正是这次带去的——调用方据此认出是自己存的。
 */
export const SAVE_RETRY_DELAYS_MS = Object.freeze([1000, 3000]);
const TRANSIENT_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

/**
 * @param {Response} response
 * @returns {Promise<boolean>}
 */
async function isTransient(response) {
    if (TRANSIENT_STATUSES.has(response.status)) {
        return true;
    }
    if (response.status === 423) {
        const data = await response.clone().json().catch(() => null);
        return data?.code === 'user_quiescing';
    }
    return false;
}

/**
 * @param {() => Promise<Response>} send Sends the request once (called again for each retry)
 * @param {{ delays?: readonly number[], wait?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<Response>} The last answer; throws the last error when it never got through
 */
export async function sendWithRetry(send, { delays = SAVE_RETRY_DELAYS_MS, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    for (let attempt = 0; ; attempt++) {
        let response;
        try {
            response = await send();
        } catch (error) {
            if (attempt >= delays.length || error?.name === 'AbortError') {
                throw error;
            }
            await wait(delays[attempt]);
            continue;
        }
        if (attempt >= delays.length || !await isTransient(response)) {
            return response;
        }
        await wait(delays[attempt]);
    }
}

/**
 * A refused save whose stored revision is the one this save proposed: it went through (on an earlier try).
 * @param {Response} response
 * @param {any} errorData Parsed body of the refusal
 * @param {string} nextRevision Revision this save proposed
 */
export function isOwnRevisionConflict(response, errorData, nextRevision) {
    return response.status === 409 && errorData?.error === 'revision_conflict' && typeof nextRevision === 'string' && errorData.currentRevision === nextRevision;
}
