#!/usr/bin/env node
/**
 * Hot-reload keeper: runs server.js and reloads it on SIGHUP without refusing
 * a single connection.
 *
 *   node keeper.js [server.js arguments]      e.g. ExecReload=kill -HUP $MAINPID
 *
 * The keeper owns the listening sockets and lends them to the server process,
 * so while no server process is accepting, new connections wait in the
 * kernel's queue instead of being refused.
 *
 * A reload starts the new server while the old one keeps serving, then hands
 * over in an instant: the old server stops accepting and saves its state, the
 * new one reloads that state and starts accepting. The old server finishes the
 * requests it already had (such as a model reply that is still streaming) and
 * exits. If the new server fails to start, the old one simply keeps serving.
 *
 * When memory is short, the reload is done one after the other instead: the
 * old server finishes up and exits first, then the new one starts; requests
 * wait during the start rather than fail. Without the keeper, server.js runs
 * exactly as before.
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import util from 'node:util';

// ST_KEEPER_SERVER_SCRIPT is for tests only.
const serverScript = process.env.ST_KEEPER_SERVER_SCRIPT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.js');
const serverArgs = process.argv.slice(2);

/** A new server must start up within this time, or the reload is abandoned. */
const STARTUP_TIMEOUT_MS = 10 * 60 * 1000;
/** How long the old server gets to save its state when handing over. */
const HAND_OVER_TIMEOUT_MS = 20 * 1000;
/**
 * In a one-after-the-other reload, how long the old server may finish requests.
 * New requests wait meanwhile, so only quick ones (saves) are let finish.
 */
const SEQUENTIAL_DRAIN_MS = 3 * 1000;
/** Free memory kept in reserve when starting a second server next to the running one. */
const MEMORY_RESERVE_BYTES = 256 * 1024 * 1024;
/** A starting server is assumed to need at least this much memory. */
const MIN_STARTUP_BYTES = 512 * 1024 * 1024;
const STOP_TIMEOUT_MS = 15 * 1000;
/** Lower CPU priority for a server starting next to the running one. */
const STANDBY_NICE = 10;
/** 'auto' (default) decides by free memory; 'parallel' or 'sequential' force a mode. */
const RELOAD_MODE = ['parallel', 'sequential'].includes(process.env.ST_KEEPER_RELOAD_MODE) ? process.env.ST_KEEPER_RELOAD_MODE : 'auto';

/** @type {Map<string, object>} Listening sockets by address, kept for the keeper's lifetime. */
const handles = new Map();
/** @type {import('node:child_process').ChildProcess|null} The server that is accepting connections. */
let current = null;
/** @type {import('node:child_process').ChildProcess|null} A new server starting up. */
let pending = null;
/** @type {Set<import('node:child_process').ChildProcess>} Replaced servers finishing their last requests. */
const draining = new Set();
let stopping = false;
let crashCount = 0;

function log(message) {
    console.log(`[keeper ${new Date().toISOString()}] ${message}`);
}

/** Sends to a server process; a process that just exited is not an error. */
function sendTo(child, message, handle, options) {
    try {
        child.send(message, handle, options);
        return true;
    } catch (error) {
        log(`Could not reach server ${child.pid}: ${error.message}`);
        return false;
    }
}

function setNice(child, value) {
    try {
        os.setPriority(child.pid, value);
    } catch (error) {
        log(`Could not change the priority of process ${child.pid}: ${error.message}`);
    }
}

/** @returns {{available: number, serverRss: number}|null} Memory in bytes (Linux only). */
function readMemory() {
    try {
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
        const available = Number(/^MemAvailable:\s+(\d+) kB/m.exec(meminfo)?.[1]) * 1024;
        let serverRss = 0;
        if (current?.pid) {
            const status = fs.readFileSync(`/proc/${current.pid}/status`, 'utf8');
            serverRss = Number(/^VmRSS:\s+(\d+) kB/m.exec(status)?.[1]) * 1024 || 0;
        }
        return Number.isFinite(available) && available > 0 ? { available, serverRss } : null;
    } catch {
        return null;
    }
}

/** Whether a second server can start next to the running one without crowding the machine. */
function canStartAlongside() {
    if (RELOAD_MODE !== 'auto') return RELOAD_MODE === 'parallel';
    const memory = readMemory();
    if (!memory) return false;
    const needed = Math.max(MIN_STARTUP_BYTES, memory.serverRss) + MEMORY_RESERVE_BYTES;
    if (memory.available < needed) {
        log(`Only ${Math.round(memory.available / 1048576)} MB of memory available (${Math.round(needed / 1048576)} MB needed to start alongside); reloading one after the other.`);
        return false;
    }
    return true;
}

function getHandle(message) {
    const { key, host, port, ipVersion } = message;
    if (!handles.has(key)) {
        // Bound but never accepted on here: only server processes accept.
        const handle = net._createServerHandle(host, port, ipVersion === 6 ? 6 : 4, undefined, ipVersion === 6 ? 1 : 0);
        if (typeof handle === 'number') {
            return { error: util.getSystemErrorName(handle) };
        }
        handles.set(key, handle);
        log(`Listening on ${host}:${port}`);
    }
    return { handle: handles.get(key) };
}

/**
 * Starts a server process.
 * @param {{alongside: boolean}} options Whether another server is still running
 */
function startServer({ alongside }) {
    const child = fork(serverScript, serverArgs, {
        env: { ...process.env, ST_KEEPER_WORKER: '1' },
        execArgv: process.execArgv,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    if (alongside) {
        // Starting up must not slow down the server that is serving users.
        setNice(child, STANDBY_NICE);
    }
    const startupTimer = setTimeout(() => {
        if (child === pending) {
            log(`New server ${child.pid} did not start within ${STARTUP_TIMEOUT_MS / 60000} minutes; stopping it.`);
            child.kill('SIGKILL');
        }
    }, STARTUP_TIMEOUT_MS);

    child.on('message', (message, handle) => {
        try {
            onServerMessage(child, message, handle);
        } catch (error) {
            log(`Error handling a message from ${child.pid}: ${error.stack ?? error}`);
        }
    });
    child.on('exit', (code, signal) => {
        clearTimeout(startupTimer);
        onServerExit(child, code, signal);
    });
    return child;
}

function onServerMessage(child, message) {
    switch (message?.type) {
        case 'keeper:listen': {
            const { handle, error } = getHandle(message);
            sendTo(child, { type: 'keeper:handle', key: message.key, error }, handle, { keepOpen: true });
            break;
        }
        case 'keeper:standby':
            if (child !== pending) break;
            if (current) {
                handOver(current, child);
            } else {
                activate(child);
            }
            break;
        case 'keeper:serving':
            if (child === current) {
                crashCount = 0;
                log(`Server ${child.pid} is serving.`);
            }
            break;
        default:
            break;
    }
}

function activate(child) {
    pending = null;
    current = child;
    setNice(child, 0);
    sendTo(child, { type: 'keeper:activate' });
}

/**
 * Makes the running server step aside and lets the new one in.
 * @param {import('node:child_process').ChildProcess} oldServer Running server
 * @param {import('node:child_process').ChildProcess} newServer Server in standby
 */
function handOver(oldServer, newServer) {
    log(`Handing over from ${oldServer.pid} to ${newServer.pid}...`);
    let done = false;
    const proceed = reason => {
        if (done) return;
        done = true;
        oldServer.off('message', onMessage);
        clearTimeout(timer);
        if (reason) log(reason);
        if (current === oldServer) {
            draining.add(oldServer);
        }
        activate(newServer);
    };
    const onMessage = message => {
        if (message?.type === 'keeper:handed-over') proceed();
    };
    const timer = setTimeout(() => proceed(`Server ${oldServer.pid} did not hand over in time; letting the new server in anyway.`), HAND_OVER_TIMEOUT_MS);
    oldServer.on('message', onMessage);
    oldServer.once('exit', () => proceed());
    if (!sendTo(oldServer, { type: 'keeper:hand-over' })) {
        proceed();
    }
}

function reload() {
    if (stopping) return;
    if (pending) {
        log('A reload is already in progress.');
        return;
    }
    if (!current) {
        log('No server is running; starting one.');
        pending = startServer({ alongside: false });
        return;
    }
    if (canStartAlongside()) {
        log('Reloading: starting the new server next to the running one...');
        pending = startServer({ alongside: true });
        return;
    }
    // One after the other: the old server finishes up and exits, then the new one starts.
    const oldServer = current;
    log(`Reloading one after the other: server ${oldServer.pid} finishes up first...`);
    if (!sendTo(oldServer, { type: 'keeper:hand-over', maxDrainMs: SEQUENTIAL_DRAIN_MS })) {
        oldServer.kill('SIGTERM');
    }
    draining.add(oldServer);
    current = null;
    const startNext = () => {
        if (!stopping && !current && !pending) {
            pending = startServer({ alongside: false });
        }
    };
    oldServer.once('exit', startNext);
}

function onServerExit(child, code, signal) {
    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (draining.delete(child)) {
        log(`Replaced server ${child.pid} exited (${how}).`);
        return;
    }
    if (stopping) return;
    if (child === pending) {
        pending = null;
        if (current) {
            log(`New server ${child.pid} failed to start (${how}); the running server keeps serving.`);
            return;
        }
        log(`Server ${child.pid} failed to start (${how}).`);
    } else if (child === current) {
        current = null;
        log(`Server ${child.pid} stopped unexpectedly (${how}).`);
    } else {
        return;
    }
    // Nothing is serving: start again, backing off if it keeps failing.
    crashCount++;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(crashCount - 1, 5));
    log(`Starting a new server in ${delay / 1000} s...`);
    setTimeout(() => {
        if (!stopping && !current && !pending) {
            pending = startServer({ alongside: false });
        }
    }, delay);
}

function stop(signal) {
    if (stopping) return;
    stopping = true;
    const servers = [current, pending, ...draining].filter(Boolean);
    log(`${signal} received; stopping ${servers.length} server process(es)...`);
    const exited = servers.map(child => child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise(resolve => {
            child.once('exit', resolve);
            child.kill('SIGTERM');
        }));
    const timer = setTimeout(() => {
        log('Servers did not stop in time; killing them.');
        servers.forEach(child => child.kill('SIGKILL'));
        process.exit(0);
    }, STOP_TIMEOUT_MS);
    void Promise.all(exited).then(() => {
        clearTimeout(timer);
        process.exit(0);
    });
}

process.on('SIGHUP', reload);
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('uncaughtException', error => log(`Unexpected error: ${error.stack ?? error}`));

log(`Keeper ${process.pid} starting the server (reload with: kill -HUP ${process.pid})`);
pending = startServer({ alongside: false });
