import { activateProcess, drainProcess, getProcessPhase, isKeeperWorker } from './process-lifecycle.js';

/**
 * Server-process side of the hot-reload keeper (keeper.js). The keeper owns
 * the listening sockets; this process borrows them, and hands over to its
 * successor without a moment where connections are refused.
 */

/** Requests that stream for a long time and never write shared state (model replies, downloads). */
const LONG_REQUEST_PREFIXES = [
    '/api/backends/', '/api/openai/', '/api/google/', '/api/anthropic/', '/api/openrouter/', '/api/azure/',
    '/api/minimax/', '/api/novelai/', '/api/horde/', '/api/sd/', '/api/speech/', '/api/translate/', '/api/search/',
    '/api/extra/', '/api/users/backup/download/', '/api/chats/export-bundle', '/api/chats/restore-upload/',
];
/** How long a handover waits for in-progress writes before letting the successor in. */
const WRITE_SETTLE_MS = 5000;
/** The longest a replaced process keeps finishing requests (e.g. a slow model reply), unless the keeper asks for less. */
const MAX_DRAIN_MS = 10 * 60 * 1000;

/** @type {Set<import('node:http').Server>} */
const servers = new Set();
/** Connections accepted whose first request has not been read yet. */
const unreadConnections = new Set();
/** @type {Set<Promise<unknown>>} */
const backgroundWork = new Set();
let pendingWrites = 0;
/** @type {((exitCode?: number) => Promise<void>)|null} */
let exitHandler = null;

if (isKeeperWorker) {
    process.on('disconnect', () => {
        // The keeper is gone (stopped or killed): never keep its socket on our own.
        const phase = getProcessPhase();
        if (phase === 'standby' || !exitHandler) {
            process.exit(0);
        } else if (phase === 'active') {
            void exitHandler(0);
        }
        // A draining process exits by itself once its last requests are done.
    });
}

function log(message, level = 'log') {
    console[level](`[keeper ${new Date().toISOString()}] ${message}`);
}

function send(message) {
    try {
        process.send?.(message);
    } catch {
        // The keeper is gone; the disconnect handler deals with it.
    }
}

/**
 * Counts requests that may write user data, so a handover can let them finish first.
 * @type {import('express').RequestHandler}
 */
export function trackPendingWrites(request, response, next) {
    if (!isKeeperWorker || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        return next();
    }
    const pathname = request.path ?? String(request.url ?? '').split('?')[0];
    if (LONG_REQUEST_PREFIXES.some(prefix => pathname.startsWith(prefix))) {
        return next();
    }
    pendingWrites++;
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        pendingWrites--;
    };
    response.once('finish', finish);
    response.once('close', finish);
    return next();
}

/**
 * Keeps a replaced process alive until background work (e.g. a restore) is done.
 * @param {Promise<unknown>} work Work
 */
export function trackBackgroundWork(work) {
    if (!isKeeperWorker) return;
    const tracked = Promise.resolve(work).catch(() => undefined).finally(() => backgroundWork.delete(tracked));
    backgroundWork.add(tracked);
}

/**
 * Gets a listening socket for the address from the keeper.
 * @param {string} host Host
 * @param {number} port Port
 * @param {4|6} ipVersion IP version
 * @returns {Promise<object>} Server handle, to pass to server.listen()
 */
export function requestListenHandle(host, port, ipVersion) {
    const key = `${ipVersion}:${host}:${port}`;
    return new Promise((resolve, reject) => {
        const onMessage = (message, handle) => {
            if (message?.type !== 'keeper:handle' || message.key !== key) return;
            process.off('message', onMessage);
            if (message.error || !handle) {
                reject(new Error(`The keeper could not listen on ${host}:${port}: ${message.error ?? 'no handle'}`));
            } else {
                resolve(handle);
            }
        };
        process.on('message', onMessage);
        send({ type: 'keeper:listen', key, host, port, ipVersion });
    });
}

/**
 * Registers a server listening on a keeper socket, so a handover can close it.
 * @param {import('node:http').Server} server Server
 */
export function registerKeeperServer(server) {
    servers.add(server);
    server.on('connection', socket => {
        unreadConnections.add(socket);
        socket.once('close', () => unreadConnections.delete(socket));
    });
    server.on('request', (request, response) => {
        unreadConnections.delete(request.socket);
        // Responses on connections that stay open after a handover must not invite more requests.
        if (getProcessPhase() === 'draining') response.shouldKeepAlive = false;
    });
}

/**
 * Waits in standby until the keeper lets this process take over, then
 * reloads shared state. Startup is complete when this is called.
 * @returns {Promise<void>}
 */
export async function waitForActivation() {
    if (!isKeeperWorker) return;
    await new Promise(resolve => {
        const onMessage = message => {
            if (message?.type !== 'keeper:activate') return;
            process.off('message', onMessage);
            resolve();
        };
        process.on('message', onMessage);
        send({ type: 'keeper:standby' });
        log('Started up; waiting to take over from the running server...');
    });
    await activateProcess();
}

/** Tells the keeper this process is serving. */
export function notifyServing() {
    if (isKeeperWorker) send({ type: 'keeper:serving' });
}

/**
 * Waits until no write is running and every accepted connection has sent its
 * request (a connection accepted just before the handover may still be on its way).
 * @param {number} timeoutMs Longest wait
 * @returns {Promise<boolean>} Whether everything settled in time
 */
async function waitForWrites(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (pendingWrites > 0 || unreadConnections.size > 0) {
        if (Date.now() >= deadline) return false;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return true;
}

/**
 * Hands over to the successor: stop accepting, let writes in progress finish,
 * save shared state, tell the keeper, then finish remaining requests and exit.
 * @param {() => Promise<void>} exit Final cleanup and exit
 * @param {number} maxDrainMs How long to keep finishing requests
 */
async function handOver(exit, maxDrainMs) {
    if (getProcessPhase() !== 'active') return;
    log('Handing over to the new server...');
    const closed = Promise.all([...servers].map(server => new Promise(resolve => server.close(() => resolve()))));
    for (const server of servers) {
        // Keep-alive connections would otherwise keep bringing new requests here.
        server.closeIdleConnections?.();
    }
    const settled = await waitForWrites(WRITE_SETTLE_MS);
    if (!settled) {
        log(`${pendingWrites} write request(s) and ${unreadConnections.size} new connection(s) still pending after ${WRITE_SETTLE_MS} ms; handing over anyway.`, 'warn');
    }
    await drainProcess();
    send({ type: 'keeper:handed-over' });

    const deadline = new Promise(resolve => setTimeout(resolve, maxDrainMs));
    const finished = (async () => {
        await closed;
        while (backgroundWork.size > 0) {
            await Promise.all([...backgroundWork]);
        }
    })();
    await Promise.race([finished, deadline]);
    log('Replaced server finished its last requests; exiting.');
    await exit();
}

/**
 * Wires the keeper's commands into this process.
 * @param {(exitCode?: number) => Promise<void>} exitProcess Normal shutdown
 */
export function setupKeeperWorker(exitProcess) {
    if (!isKeeperWorker) return;
    exitHandler = exitProcess;
    process.on('message', message => {
        if (message?.type === 'keeper:hand-over') {
            const maxDrainMs = Number.isSafeInteger(message.maxDrainMs) && message.maxDrainMs >= 0 ? Math.min(message.maxDrainMs, MAX_DRAIN_MS) : MAX_DRAIN_MS;
            void handOver(() => exitProcess(0), maxDrainMs);
        }
    });
}
