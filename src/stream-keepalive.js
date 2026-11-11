/**
 * 流式生成时，上游（AI 服务、中转站）迟迟不开始回：长思考的模型、等思考完才回的中转。浏览器和酒馆之间的
 * Cloudflare 等了约 100 秒什么都没收到就掐断连接（524），酒馆以为客户端走了，把上游请求也取消了。
 *
 * 还没写出任何内容时，每隔一会儿先回响应头（200、SSE，不压缩、不让 nginx 缓冲），再写一行 SSE 注释，连接就一直有动静；
 * 页面解析时会跳过注释。内容一开始写就不再插注释，免得插进半截事件里。
 * 保活发出响应头以后，各路代码再回错误（status(...).send(...)）就改成流里的一条 data: {"error": ...}，
 * 页面照常弹出错误；再设响应头就忽略（已经发出去了）。
 */

const DEFAULT_IDLE_MS = 15_000;
const KEEPALIVE_LINE = ': keepalive\n\n';

/**
 * @typedef {object} StreamKeepalive
 * @property {boolean} committed Headers were sent by the keepalive
 * @property {boolean} dataStarted Something other than a keepalive was written
 * @property {() => void} stop Stops sending keepalives
 */

/**
 * @param {any} body What a route tried to send
 * @param {number} status Status it set
 * @returns {string} One SSE event
 */
function toStreamEvent(body, status) {
    let payload = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch {
            payload = payload.trim() ? { error: { message: payload.slice(0, 2000) } } : null;
        }
    }
    if (!payload || typeof payload !== 'object') {
        payload = {};
    }
    if (status < 400 && !payload.error) {
        // Not an error: pass it on as it is
        return `data: ${JSON.stringify(payload)}\n\n`;
    }
    const error = payload.error && typeof payload.error === 'object' ? payload.error : {};
    const message = error.message || payload.message || `生成失败（${status >= 400 ? status : 502}）`;
    return `data: ${JSON.stringify({ ...payload, error: { ...error, message } })}\n\n`;
}

/**
 * Keeps a streaming response alive until its content starts.
 * @param {import('express').Response} response Response of a streaming request
 * @param {object} [options]
 * @param {number} [options.idleMs] Quiet time before a keepalive
 * @param {() => number} [options.now] Clock (tests)
 * @returns {StreamKeepalive}
 */
export function keepStreamAlive(response, { idleMs = DEFAULT_IDLE_MS, now = Date.now } = {}) {
    const write = response.write.bind(response);
    const send = response.send.bind(response);
    const setHeader = response.setHeader.bind(response);
    let lastActivity = now();
    /** @type {ReturnType<typeof setInterval>|null} */
    let timer = null;

    /** @type {StreamKeepalive} */
    const state = {
        committed: false,
        dataStarted: false,
        stop: () => {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        },
    };

    // @ts-ignore Same signature as the original
    response.write = function (...args) {
        state.dataStarted = true;
        state.stop();
        return write(...args);
    };
    // @ts-ignore Same signature as the original
    response.setHeader = function (name, value) {
        return state.committed ? response : setHeader(name, value);
    };
    response.send = function (body) {
        if (!state.committed || state.dataStarted) {
            return send(body);
        }
        state.stop();
        const status = response.statusCode;
        if (status < 400 && body && typeof body === 'object' && !Buffer.isBuffer(body) && body.error) {
            // A failure sent with status 200: not worth metering
            response.statusCode = 502;
        }
        write(toStreamEvent(body, status));
        response.end();
        return response;
    };

    const tick = () => {
        if (state.dataStarted || response.writableEnded || response.destroyed) {
            state.stop();
            return;
        }
        if (now() - lastActivity < idleMs) {
            return;
        }
        if (!response.headersSent) {
            response.statusCode = 200;
            setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            // no-transform: the compression middleware would hold the keepalives in its gzip buffer
            setHeader('Cache-Control', 'no-cache, no-transform');
            setHeader('X-Accel-Buffering', 'no');
            state.committed = true;
        }
        if (!state.committed) {
            // Headers were sent by the route itself: its content is on its way
            state.stop();
            return;
        }
        write(KEEPALIVE_LINE);
        // @ts-ignore Added by the compression middleware when it handles the response
        response.flush?.();
        lastActivity = now();
    };
    timer = setInterval(tick, Math.max(10, Math.min(idleMs, 5_000)));
    timer.unref?.();
    response.once('close', state.stop);
    response.once('finish', state.stop);
    response.locals.streamKeepalive = state;
    return state;
}

/**
 * Whether the keepalive sent the headers and nothing else was written yet: an error must go into the stream.
 * @param {import('express').Response} response
 * @returns {boolean}
 */
export function isAwaitingStreamContent(response) {
    const state = /** @type {StreamKeepalive|undefined} */ (response.locals?.streamKeepalive);
    return Boolean(state?.committed && !state.dataStarted);
}
