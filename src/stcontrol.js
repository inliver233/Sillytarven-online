import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getConfigValue } from './util.js';

export const STCONTROL_MODES = Object.freeze({
    MANAGED: 'managed',
    UNREACHABLE: 'controller-unreachable',
    INDEPENDENT: 'independent',
    DRAINING: 'independent-draining',
});

export const STCONTROL_CAPABILITIES = Object.freeze([
    'account_inventory_paging',
    'account_restore',
    'activity_leases',
    'control_mode',
    'independent_reconciliation',
    'login_handoff',
    'local_account_proof',
    'node_admin_handoff',
    'node_admin_verify',
    'password_update',
    'registration_policy',
    'snapshot_boundary',
    'user_data_fault_freeze',
    'user_provision',
    'write_gate',
]);

const STATE_VERSION = 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOCK_SKEW_SECONDS = 60;
const SESSION_IDLE_MS = 15 * 60 * 1000;
const MAX_NONCES = 2000;
const PROCESS_INSTANCE_ID = crypto.randomUUID();
const VALID_MODES = new Set(Object.values(STCONTROL_MODES));
const INTERNAL_PATH_PREFIX = '/api/stcontrol/internal';

let cachedState;
let cachedStatePath;
let stateQueue = Promise.resolve();
const operationQueues = new Map();

function getNodeId() {
    return Number(getConfigValue('stcontrol.nodeId', 0, 'number'));
}

function getAgentPsk() {
    return String(process.env.STCONTROL_AGENT_PSK || getConfigValue('stcontrol.agentPsk', '', 'string'));
}

// Returns a node-keyed revision fence without exposing a reusable digest of
// local account or OAuth subject facts to the Controller.
export function stcontrolInventoryRevision(material) {
    const psk = getAgentPsk();
    if (!psk) throw new Error('stcontrol agent credential is unavailable');
    return crypto.createHmac('sha256', psk)
        .update('stcontrol-account-inventory:v1\n')
        .update(material)
        .digest('hex');
}

export function isStcontrolEnabled() {
    return Boolean(getConfigValue('stcontrol.enabled', false, 'boolean'));
}

export function getStcontrolControllerUrl() {
    return String(getConfigValue('stcontrol.controllerUrl', '', 'string')).replace(/\/+$/, '');
}

function statePath() {
    const dataRoot = globalThis.DATA_ROOT || process.cwd();
    return path.join(dataRoot, '_stcontrol', 'adapter-state.json');
}

function migrateLegacyStateFile() {
    const dataRoot = globalThis.DATA_ROOT || process.cwd();
    const legacyPath = path.join(dataRoot, '_storage', 'stcontrol-adapter-state.json');
    const currentPath = statePath();
    if (!fs.existsSync(legacyPath) || fs.existsSync(currentPath)) return;
    fs.mkdirSync(path.dirname(currentPath), { recursive: true, mode: 0o700 });
    try {
        fs.renameSync(legacyPath, currentPath);
    } catch (error) {
        if (error?.code !== 'EXDEV') throw error;
        fs.copyFileSync(legacyPath, currentPath, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(currentPath, 0o600);
        fs.unlinkSync(legacyPath);
    }
}

function initialState() {
    return {
        version: STATE_VERSION,
        mode: STCONTROL_MODES.MANAGED,
        modeGeneration: 1,
        controllerGeneration: Math.max(0, Number(getConfigValue('stcontrol.controllerGeneration', 0, 'number'))),
        reasonCode: 'initial',
        changedAt: new Date().toISOString(),
        runtimeInstanceId: PROCESS_INSTANCE_ID,
        nonces: [],
        operations: {},
        gates: {},
        sessions: {},
        lastActiveOwners: {},
        pendingSyncUsers: {},
        leases: {},
    };
}

function validateLoadedState(value) {
    if (value?.version === 1) {
        value.leases = {};
    }
    if (value?.version === 1 || value?.version === 2) {
        for (const [handle, fact] of Object.entries(value.pendingSyncUsers || {})) {
            value.pendingSyncUsers[handle] = {
                marker: crypto.randomUUID(),
                changedAt: Number(fact?.changedAt || Date.now()),
                reason: String(fact?.reason || 'legacy_pending_sync'),
            };
        }
        value.version = STATE_VERSION;
    }
    if (!value || value.version !== STATE_VERSION || !VALID_MODES.has(value.mode) ||
        !Number.isSafeInteger(value.modeGeneration) || value.modeGeneration < 1 ||
        !Number.isSafeInteger(value.controllerGeneration) || value.controllerGeneration < 0 ||
        value.runtimeInstanceId !== undefined && !UUID_PATTERN.test(value.runtimeInstanceId)) {
        throw new Error('Invalid persisted stcontrol adapter state');
    }
    for (const key of ['nonces', 'operations', 'gates', 'sessions', 'lastActiveOwners', 'pendingSyncUsers', 'leases']) {
        if (key === 'nonces' ? !Array.isArray(value[key]) : !value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) {
            throw new Error('Invalid persisted stcontrol adapter state');
        }
    }
    for (const [handle, fact] of Object.entries(value.pendingSyncUsers)) {
        if (!handle || handle.length > 128 || !UUID_PATTERN.test(fact?.marker || '') ||
            !Number.isSafeInteger(fact?.changedAt) || fact.changedAt < 0 ||
            typeof fact?.reason !== 'string' || fact.reason.length > 128) {
            throw new Error('Invalid persisted stcontrol pending synchronization state');
        }
    }
    return value;
}

function persistState(state) {
    const filePath = statePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileAtomicSync(filePath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function loadStateSync() {
    migrateLegacyStateFile();
    const filePath = statePath();
    if (cachedState && cachedStatePath === filePath) {
        return cachedState;
    }
    cachedStatePath = filePath;
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const migrated = parsed?.version !== STATE_VERSION;
        cachedState = validateLoadedState(parsed);
        const restarted = cachedState.runtimeInstanceId !== PROCESS_INSTANCE_ID;
        if (restarted) {
            for (const session of Object.values(cachedState.sessions)) {
                if (!session) continue;
                session.inFlightReads = 0;
                session.inFlightWrites = 0;
            }
            cachedState.runtimeInstanceId = PROCESS_INSTANCE_ID;
        }
        if (migrated || restarted) persistState(cachedState);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
        cachedState = initialState();
        persistState(cachedState);
    }
    return cachedState;
}

function newPendingSyncFact(reason) {
    return { marker: crypto.randomUUID(), changedAt: Date.now(), reason };
}

function clone(value) {
    return structuredClone(value);
}

async function mutateState(mutator) {
    const run = stateQueue.then(async () => {
        const state = loadStateSync();
        const result = await mutator(state);
        persistState(state);
        return result;
    });
    stateQueue = run.catch(() => undefined);
    return run;
}

export function getStcontrolState() {
    return clone(loadStateSync());
}

export function resetStcontrolStateForTests() {
    cachedState = undefined;
    cachedStatePath = undefined;
    stateQueue = Promise.resolve();
}

// Keep adapter durability data outside node-persist's record namespace. Move
// the early WIP location before node-persist can interpret it as an account.
if (globalThis.DATA_ROOT) migrateLegacyStateFile();

function isLoopbackAddress(address) {
    if (!address) return false;
    const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
    if (normalized === '::1' || normalized === 'localhost') return true;
    if (net.isIPv4(normalized)) return normalized.startsWith('127.');
    return false;
}

export function encodeStcontrolRequestBody(body) {
    // Match Go encoding/json's security escapes. Replacing only literal JSON
    // characters cannot alter an already escaped backslash sequence.
    return JSON.stringify(body ?? {})
        .replaceAll('&', '\\u0026')
        .replaceAll('<', '\\u003c')
        .replaceAll('>', '\\u003e')
        .replaceAll('\u2028', '\\u2028')
        .replaceAll('\u2029', '\\u2029');
}

function canonicalRequestBody(body) {
    return Buffer.from(encodeStcontrolRequestBody(body), 'utf8');
}

export function signStcontrolRequest(psk, method, requestPath, timestamp, nonce, body) {
    const bodyHash = crypto.createHash('sha256').update(canonicalRequestBody(body)).digest('hex');
    const canonical = `${method}\n${requestPath}\n${timestamp}\n${nonce}\n${bodyHash}`;
    return crypto.createHmac('sha256', psk).update(canonical).digest('hex');
}

function safeEqualHex(left, right) {
    if (!/^[a-f0-9]{64}$/i.test(left || '') || !/^[a-f0-9]{64}$/i.test(right || '')) return false;
    const leftBytes = Buffer.from(left, 'hex');
    const rightBytes = Buffer.from(right, 'hex');
    return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

async function consumeRequestNonce(nonce, timestamp) {
    const digest = crypto.createHash('sha256').update(nonce).digest('hex');
    return mutateState(state => {
        const cutoff = timestamp - CLOCK_SKEW_SECONDS;
        state.nonces = state.nonces.filter(item => Number(item.timestamp) >= cutoff);
        if (state.nonces.some(item => item.digest === digest)) return false;
        state.nonces.push({ digest, timestamp });
        if (state.nonces.length > MAX_NONCES) state.nonces.splice(0, state.nonces.length - MAX_NONCES);
        return true;
    });
}

/**
 * Authenticate an Agent-to-adapter request after the global JSON parser. The
 * Agent uses Go encoding/json. encodeStcontrolRequestBody reproduces those
 * security escapes from the globally parsed, bounded protocol object.
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @param {import('express').NextFunction} next
 */
export async function requireStcontrolAgent(request, response, next) {
    if (!isStcontrolEnabled()) return response.sendStatus(404);
    if (!isLoopbackAddress(request.socket?.remoteAddress)) return response.sendStatus(403);
    const psk = getAgentPsk();
    const configuredNodeId = getNodeId();
    const nodeId = Number(request.get('X-Agent-Id'));
    const timestampText = request.get('X-Timestamp') || '';
    const timestamp = Number(timestampText);
    const nonce = request.get('X-Nonce') || '';
    const signature = request.get('X-Signature') || '';
    const now = Math.floor(Date.now() / 1000);
    if (!psk || !Number.isSafeInteger(configuredNodeId) || configuredNodeId <= 0 || nodeId !== configuredNodeId ||
        !Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > CLOCK_SKEW_SECONDS ||
        !/^[a-f0-9]{32}$/i.test(nonce)) {
        return response.sendStatus(401);
    }
    // Express trims request.url/request.path while a router.use mount is being
    // dispatched. The Agent signs the original absolute path, so verify that
    // exact path rather than the router-relative suffix.
    const signedPath = String(request.originalUrl || request.path).split('?', 1)[0];
    const expected = signStcontrolRequest(psk, request.method, signedPath, timestampText, nonce, request.body);
    if (!safeEqualHex(expected, signature) || !await consumeRequestNonce(nonce, timestamp)) {
        return response.sendStatus(401);
    }
    return next();
}

function cleanExpiredSessions(state, now = Date.now()) {
    for (const [sessionId, session] of Object.entries(state.sessions)) {
        const inFlight = Number(session?.inFlightReads || 0) + Number(session?.inFlightWrites || 0);
        if (!session || (inFlight === 0 && now - Number(session.lastSeenAt || 0) > SESSION_IDLE_MS)) delete state.sessions[sessionId];
    }
}

export function getStcontrolModeStatus() {
    const state = loadStateSync();
    cleanExpiredSessions(state);
    const activeIndependentSessions = Object.values(state.sessions)
        .filter(session => session?.loginMode === STCONTROL_MODES.INDEPENDENT && !session.loggedOutAt).length;
    return {
        mode: state.mode,
        modeGeneration: state.modeGeneration,
        controllerGeneration: state.controllerGeneration,
        activeIndependentSessions,
        pendingUserSyncs: Object.keys(state.pendingSyncUsers).length,
    };
}

const ALLOWED_TRANSITIONS = Object.freeze({
    [STCONTROL_MODES.MANAGED]: new Set([STCONTROL_MODES.MANAGED, STCONTROL_MODES.UNREACHABLE, STCONTROL_MODES.INDEPENDENT]),
    [STCONTROL_MODES.UNREACHABLE]: new Set([STCONTROL_MODES.UNREACHABLE, STCONTROL_MODES.MANAGED, STCONTROL_MODES.INDEPENDENT]),
    [STCONTROL_MODES.INDEPENDENT]: new Set([STCONTROL_MODES.INDEPENDENT, STCONTROL_MODES.DRAINING]),
    [STCONTROL_MODES.DRAINING]: new Set([STCONTROL_MODES.DRAINING, STCONTROL_MODES.MANAGED]),
});

export async function applyStcontrolMode(input) {
    if (!input || !VALID_MODES.has(input.mode) || !Number.isSafeInteger(input.mode_generation) || input.mode_generation < 1 ||
        !Number.isSafeInteger(input.controller_generation) || input.controller_generation < 1 ||
        typeof input.reason_code !== 'string' || input.reason_code.length > 128) {
        throw new TypeError('Invalid control mode request');
    }
    return mutateState(state => {
        cleanExpiredSessions(state);
        if (input.controller_generation < state.controllerGeneration || input.mode_generation < state.modeGeneration) {
            throw new Error('Control mode generation rollback');
        }
        if (input.mode_generation === state.modeGeneration && input.mode !== state.mode) {
            throw new Error('Control mode generation reuse');
        }
        if (!ALLOWED_TRANSITIONS[state.mode]?.has(input.mode)) {
            throw new Error('Invalid control mode transition');
        }
        if (input.mode_generation > state.modeGeneration) {
            if (input.mode === STCONTROL_MODES.INDEPENDENT) {
                // A browser authenticated before the outage must not remain a
                // managed writer after its Controller lease can no longer be
                // renewed. Convert the durable adapter view immediately; the
                // request envelope is converted on its next request.
                for (const session of Object.values(state.sessions)) {
                    if (!session?.loggedOutAt) {
                        session.loginMode = STCONTROL_MODES.INDEPENDENT;
                        session.activityEpoch = 0;
                    }
                }
                state.leases = {};
            }
            if (input.mode === STCONTROL_MODES.DRAINING) {
                for (const session of Object.values(state.sessions)) {
                    if (session?.loginMode === STCONTROL_MODES.INDEPENDENT && session.handle) {
                        state.pendingSyncUsers[session.handle] ??= newPendingSyncFact('independent_session');
                    }
                }
            }
            state.mode = input.mode;
            state.modeGeneration = input.mode_generation;
            state.reasonCode = input.reason_code;
            state.changedAt = input.changed_at || new Date().toISOString();
        }
        state.controllerGeneration = Math.max(state.controllerGeneration, input.controller_generation);
        const status = getModeStatusFromState(state);
        return {
            ok: true,
            applied_mode: state.mode,
            mode_generation: state.modeGeneration,
            active_independent_sessions: status.activeIndependentSessions,
            pending_user_syncs: status.pendingUserSyncs,
        };
    });
}

function getModeStatusFromState(state) {
    cleanExpiredSessions(state);
    return {
        activeIndependentSessions: Object.values(state.sessions)
            .filter(session => session?.loginMode === STCONTROL_MODES.INDEPENDENT && !session.loggedOutAt).length,
        pendingUserSyncs: Object.keys(state.pendingSyncUsers).length,
    };
}

export async function canUseNativeLogin(handle) {
    if (!isStcontrolEnabled()) return { allowed: true };
    const state = loadStateSync();
    if (state.mode !== STCONTROL_MODES.INDEPENDENT) {
        return { allowed: false, code: state.mode === STCONTROL_MODES.MANAGED ? 'managed_login_required' : 'controller_unavailable' };
    }
    const owner = Number(state.lastActiveOwners[handle]);
    if (owner !== getNodeId()) return { allowed: false, code: 'not_last_active_node' };
    return { allowed: true, independent: true };
}

function writeAccessError(response, code = 'managed_account_control') {
    return response.status(423).json({ error: '此节点的账号入口由统一总控管理', code });
}

export async function stcontrolPublicAccountGuard(request, response, next) {
    if (!isStcontrolEnabled()) return next();
    const routePath = request.path;
    if (routePath === '/login') {
        const handle = String(request.body?.handle || '').trim().toLowerCase();
        const decision = await canUseNativeLogin(handle);
        if (!decision.allowed) return writeAccessError(response, decision.code);
        request.stcontrolIndependentLogin = true;
        return next();
    }
    const allowed = new Set(['/list', '/logout', '/heartbeat', '/registration-config', '/me']);
    if (allowed.has(routePath)) return next();
    return writeAccessError(response);
}

export function stcontrolOAuthGuard(request, response, next) {
    if (!isStcontrolEnabled() || request.path === '/config') return next();
    return writeAccessError(response, 'managed_oauth_required');
}

export function stcontrolPrivateAccountGuard(request, response, next) {
    if (!isStcontrolEnabled()) return next();
    if (request.path === '/logout' || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
    return writeAccessError(response, 'managed_account_mutation');
}

export function stcontrolAdminAccountGuard(request, response, next) {
    if (!isStcontrolEnabled() || ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ||
        ['/get', '/storage-size', '/slugify'].includes(request.path)) return next();
    return writeAccessError(response, 'managed_administrator_mutation');
}

function ensureSessionEnvelope(request, loginMode) {
    if (!request.session) return null;
    const current = request.session.stcontrol;
    if (current?.sessionId) return current;
    const envelope = {
        sessionId: crypto.randomUUID(),
        loginMode,
        activityEpoch: 0,
        controllerGeneration: loadStateSync().controllerGeneration,
    };
    request.session.stcontrol = envelope;
    return envelope;
}

export async function registerStcontrolSession(request, claims, loginMode = STCONTROL_MODES.MANAGED) {
    if (!request.session || !claims?.handle) throw new Error('Session unavailable');
    const sessionId = claims.session_id || crypto.randomUUID();
    request.session.stcontrol = {
        sessionId,
        loginMode,
        activityEpoch: Number(claims.activity_epoch || 0),
        controllerGeneration: Number(claims.controller_generation || 0),
    };
    await mutateState(state => {
        const now = Date.now();
        state.sessions[sessionId] = {
            handle: claims.handle,
            loginMode,
            activityEpoch: Number(claims.activity_epoch || 0),
            controllerGeneration: Number(claims.controller_generation || 0),
            lastSeenAt: now,
            lastPageAt: now,
            lastRequestAt: now,
            inFlightReads: 0,
            inFlightWrites: 0,
        };
        state.controllerGeneration = Math.max(state.controllerGeneration, Number(claims.controller_generation || 0));
        if (loginMode === STCONTROL_MODES.MANAGED) {
            state.leases[claims.handle] = {
                sessionId,
                activityEpoch: Number(claims.activity_epoch || 0),
                controllerGeneration: Number(claims.controller_generation || 0),
            };
        }
        state.lastActiveOwners[claims.handle] = getNodeId();
    });
}

export async function registerIndependentSession(request, handle) {
    return registerStcontrolSession(request, { handle }, STCONTROL_MODES.INDEPENDENT);
}

export async function noteStcontrolLogout(request) {
    const sessionId = request.session?.stcontrol?.sessionId;
    if (!sessionId || !isStcontrolEnabled()) return;
    await mutateState(state => {
        const session = state.sessions[sessionId];
        if (!session) return;
        session.loggedOutAt = Date.now();
        session.lastSeenAt = Date.now();
        session.inFlightReads = 0;
        session.inFlightWrites = 0;
        if (state.leases[session.handle]?.sessionId === sessionId) delete state.leases[session.handle];
    });
}

export async function noteStcontrolPageHeartbeat(request) {
    const sessionId = request.session?.stcontrol?.sessionId;
    if (!sessionId || !isStcontrolEnabled()) return;
    await mutateState(state => {
        const session = state.sessions[sessionId];
        if (!session || session.loggedOutAt) return;
        const now = Date.now();
        session.lastPageAt = now;
        session.lastRequestAt = now;
        session.lastSeenAt = now;
    });
}

export async function stcontrolRequestTracker(request, response, next) {
    if (!isStcontrolEnabled() || !request.user?.profile?.handle) return next();
    if (request.session?.stcontrolAdmin) return next();
    const handle = request.user.profile.handle;
    const state = loadStateSync();
    const envelope = ensureSessionEnvelope(request, state.mode === STCONTROL_MODES.INDEPENDENT ? STCONTROL_MODES.INDEPENDENT : STCONTROL_MODES.MANAGED);
    if (!envelope) return response.sendStatus(500);
    if (state.mode === STCONTROL_MODES.INDEPENDENT && envelope.loginMode !== STCONTROL_MODES.INDEPENDENT) {
        if (Number(state.lastActiveOwners[handle]) !== getNodeId()) {
            return response.status(423).json({ error: '此节点不是该用户最后活动节点', code: 'not_last_active_node' });
        }
        envelope.loginMode = STCONTROL_MODES.INDEPENDENT;
        envelope.activityEpoch = 0;
        envelope.controllerGeneration = state.controllerGeneration;
    }
    if (state.mode === STCONTROL_MODES.DRAINING && envelope.loginMode !== STCONTROL_MODES.INDEPENDENT) {
        const durableSession = state.sessions[envelope.sessionId];
        if (durableSession?.loginMode === STCONTROL_MODES.INDEPENDENT && !durableSession.loggedOutAt) {
            envelope.loginMode = STCONTROL_MODES.INDEPENDENT;
            envelope.activityEpoch = 0;
            envelope.controllerGeneration = state.controllerGeneration;
        } else {
            return response.status(423).json({ error: '独立模式数据正在对账，请重新登录', code: 'independent_reconciliation_required' });
        }
    }
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const gate = state.gates[handle];
    if (gate && isWrite && !request.path.startsWith(INTERNAL_PATH_PREFIX)) {
        response.set('Retry-After', '2');
        if (gate.kind === 'data_fault') {
            return response.status(423).json({ error: '检测到用户数据异常，写入已冻结，请从控制面板恢复', code: 'user_data_frozen' });
        }
        return response.status(423).json({ error: '用户数据正在生成一致性快照，请稍后重试', code: 'user_quiescing' });
    }
    const knownSession = state.sessions[envelope.sessionId];
    const lease = state.leases[handle];
    if (knownSession?.loggedOutAt ||
        (isWrite && envelope.loginMode === STCONTROL_MODES.MANAGED && (!lease || lease.sessionId !== envelope.sessionId ||
            lease.activityEpoch !== envelope.activityEpoch || lease.controllerGeneration !== envelope.controllerGeneration))) {
        return response.status(409).json({ error: '当前页面的写入租约已失效，请重新登录', code: 'stale_writer_session' });
    }
    await mutateState(current => {
        const now = Date.now();
        const session = current.sessions[envelope.sessionId] ?? {
            handle,
            loginMode: envelope.loginMode,
            activityEpoch: envelope.activityEpoch,
            controllerGeneration: envelope.controllerGeneration,
            lastPageAt: now,
            inFlightReads: 0,
            inFlightWrites: 0,
        };
        session.lastSeenAt = now;
        session.lastRequestAt = now;
        if (request.path === '/api/users/heartbeat') session.lastPageAt = now;
        if (isWrite) session.inFlightWrites += 1;
        else session.inFlightReads += 1;
        current.sessions[envelope.sessionId] = session;
        current.lastActiveOwners[handle] = getNodeId();
        if (isWrite && session.loginMode === STCONTROL_MODES.INDEPENDENT) {
            current.pendingSyncUsers[handle] = { marker: crypto.randomUUID(), changedAt: now, reason: 'independent_write' };
        }
    });
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        void mutateState(current => {
            const session = current.sessions[envelope.sessionId];
            if (!session) return;
            if (isWrite) session.inFlightWrites = Math.max(0, Number(session.inFlightWrites) - 1);
            else session.inFlightReads = Math.max(0, Number(session.inFlightReads) - 1);
            session.lastSeenAt = Date.now();
        });
    };
    response.once('finish', finish);
    response.once('close', finish);
    return next();
}

export function getStcontrolSessionTelemetry() {
    const state = loadStateSync();
    const now = Date.now();
    cleanExpiredSessions(state, now);
    const users = [];
    for (const [sessionId, session] of Object.entries(state.sessions)) {
        if (!session?.handle) continue;
        const hasPage = now - Number(session.lastPageAt || 0) <= SESSION_IDLE_MS;
        const hasRequest = now - Number(session.lastRequestAt || 0) <= SESSION_IDLE_MS;
        const inFlightReads = Number(session.inFlightReads || 0);
        const inFlightWrites = Number(session.inFlightWrites || 0);
        users.push({
            handle: session.handle,
            session_id: sessionId,
            activity_epoch: Number(session.activityEpoch || 0),
            controller_generation: Number(session.controllerGeneration || 0),
            login_mode: session.loginMode,
            ended: Boolean(session.loggedOutAt),
            is_online: !session.loggedOutAt && (hasPage || hasRequest || inFlightReads > 0 || inFlightWrites > 0),
            last_activity: Number(session.lastSeenAt || 0),
            last_page_heartbeat: Number(session.lastPageAt || 0),
            last_request: Number(session.lastRequestAt || 0),
            in_flight_reads: inFlightReads,
            in_flight_writes: inFlightWrites,
        });
    }
    return users;
}

export function getStcontrolPendingSyncUsers() {
    const state = loadStateSync();
    return Object.entries(state.pendingSyncUsers)
        .map(([handle, fact]) => ({
            handle,
            marker: fact.marker,
            changed_at: fact.changedAt,
            reason: fact.reason,
        }))
        .sort((left, right) => left.handle.localeCompare(right.handle));
}

export async function setUserWriteGate(handle, gate) {
    return mutateState(state => {
        if (gate) state.gates[handle] = gate;
        else delete state.gates[handle];
    });
}

/** Establish a snapshot gate without racing a concurrent data-fault freeze. */
export async function establishSnapshotWriteGate(handle, workflowId, snapshotId, activityEpoch) {
    return mutateState(state => {
        const current = state.gates[handle];
        if (current) {
            const snapshotGate = current.kind === undefined || current.kind === 'snapshot';
            if (snapshotGate && current.workflowId === workflowId && current.snapshotId === snapshotId &&
                current.activityEpoch === activityEpoch) {
                return { status: 'existing', gate: clone(current) };
            }
            return { status: 'write_gate_conflict' };
        }
        const gate = {
            kind: 'snapshot',
            workflowId,
            snapshotId,
            activityEpoch,
            freezeToken: crypto.randomBytes(32).toString('base64url'),
            createdAt: Date.now(),
        };
        state.gates[handle] = gate;
        return { status: 'created', gate: clone(gate) };
    });
}

/**
 * Atomically establish the non-releasable local half of an authoritative
 * data-fault freeze. A fault id is globally bound to one handle and activity
 * epoch so a retried signed Agent command cannot silently change its scope.
 */
export async function establishUserDataFaultGate(handle, faultId, activityEpoch) {
    return mutateState(state => {
        for (const [boundHandle, gate] of Object.entries(state.gates)) {
            if (gate?.kind !== 'data_fault' || gate.faultId !== faultId) continue;
            if (boundHandle !== handle || gate.activityEpoch !== activityEpoch) {
                return { status: 'fault_id_conflict' };
            }
            return { status: 'existing', gate: clone(gate) };
        }

        const current = state.gates[handle];
        if (current) return { status: 'write_gate_conflict' };
        const gate = {
            kind: 'data_fault',
            faultId,
            activityEpoch,
            createdAt: Date.now(),
        };
        state.gates[handle] = gate;
        return { status: 'created', gate: clone(gate) };
    });
}

export function getUserWriteGate(handle) {
    return clone(loadStateSync().gates[handle] || null);
}

export async function markUserSynchronized(handle, marker) {
    return mutateState(state => {
        if (state.mode !== STCONTROL_MODES.DRAINING) throw new Error('Node is not draining independent sessions');
        const pending = state.pendingSyncUsers[handle];
        if (!pending || !UUID_PATTERN.test(marker || '') || pending.marker !== marker) {
            throw new Error('Pending synchronization marker changed');
        }
        const active = Object.values(state.sessions).some(session => session?.handle === handle &&
            session.loginMode === STCONTROL_MODES.INDEPENDENT && !session.loggedOutAt);
        if (active || state.gates[handle]) throw new Error('Independent user is still active or quiesced');
        delete state.pendingSyncUsers[handle];
        return { ok: true, handle, marker };
    });
}

export async function runIdempotentStcontrolOperation(kind, operationId, input, action) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId || '')) {
        throw new TypeError('Invalid operation id');
    }
    const key = `${kind}:${operationId}`;
    const digest = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const previous = operationQueues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
        const existing = loadStateSync().operations[key];
        if (existing) {
            if (existing.digest !== digest) throw new Error('Operation id payload conflict');
            return clone(existing.result);
        }
        const result = await action();
        await mutateState(state => {
            const replay = state.operations[key];
            if (replay && replay.digest !== digest) throw new Error('Operation id payload conflict');
            state.operations[key] = { digest, result: clone(result), completedAt: new Date().toISOString() };
            const keys = Object.keys(state.operations);
            if (keys.length > 5000) {
                keys.sort((left, right) => String(state.operations[left].completedAt).localeCompare(String(state.operations[right].completedAt)));
                for (const oldKey of keys.slice(0, keys.length - 5000)) delete state.operations[oldKey];
            }
        });
        return result;
    });
    operationQueues.set(key, run);
    try {
        return await run;
    } finally {
        if (operationQueues.get(key) === run) operationQueues.delete(key);
    }
}
