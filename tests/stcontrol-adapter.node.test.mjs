import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    STCONTROL_MODES,
    applyStcontrolMode,
    encodeStcontrolRequestBody,
    getStcontrolState,
	getStcontrolPendingSyncUsers,
	markUserSynchronized,
    resetStcontrolStateForTests,
    runIdempotentStcontrolOperation,
    stcontrolRequestTracker,
} from '../src/stcontrol.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(path.resolve('config.yaml'));

test('stcontrol adapter persists fenced modes and serializes duplicate operations', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-stcontrol-'));
    globalThis.DATA_ROOT = dataRoot;
    resetStcontrolStateForTests();
    try {
        assert.equal(getStcontrolState().mode, STCONTROL_MODES.MANAGED);
        await applyStcontrolMode({
            mode: STCONTROL_MODES.UNREACHABLE,
            mode_generation: 2,
            controller_generation: 1,
            reason_code: 'heartbeat_failed',
        });
        await applyStcontrolMode({
            mode: STCONTROL_MODES.INDEPENDENT,
            mode_generation: 3,
            controller_generation: 1,
            reason_code: 'sustained_outage',
        });
        await applyStcontrolMode({
            mode: STCONTROL_MODES.DRAINING,
            mode_generation: 4,
            controller_generation: 2,
            reason_code: 'controller_recovered',
        });
        await applyStcontrolMode({
            mode: STCONTROL_MODES.MANAGED,
            mode_generation: 5,
            controller_generation: 2,
            reason_code: 'drain_complete',
        });
        await assert.rejects(() => applyStcontrolMode({
            mode: STCONTROL_MODES.UNREACHABLE,
            mode_generation: 4,
            controller_generation: 2,
            reason_code: 'rollback',
        }), /rollback/);

        let calls = 0;
        const operationId = '11111111-1111-4111-8111-111111111111';
        const action = async () => {
            calls++;
            await new Promise(resolve => setTimeout(resolve, 20));
            return { ok: true };
        };
        const [first, second] = await Promise.all([
            runIdempotentStcontrolOperation('test', operationId, { handle: 'alice' }, action),
            runIdempotentStcontrolOperation('test', operationId, { handle: 'alice' }, action),
        ]);
        assert.deepEqual(first, { ok: true });
        assert.deepEqual(second, { ok: true });
        assert.equal(calls, 1);
        await assert.rejects(
            () => runIdempotentStcontrolOperation('test', operationId, { handle: 'bob' }, action),
            /payload conflict/,
        );
    } finally {
        resetStcontrolStateForTests();
        globalThis.DATA_ROOT = previousDataRoot;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('stcontrol request encoding matches Go security escaping without corrupting literal escapes', () => {
    const encoded = encodeStcontrolRequestBody({ value: '<tag>&\u2028', literal: '\\u2028' });
    assert.equal(encoded, '{"value":"\\u003ctag\\u003e\\u0026\\u2028","literal":"\\\\u2028"}');
});

test('legacy adapter state migrates out of the node-persist namespace', () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-stcontrol-migrate-'));
    globalThis.DATA_ROOT = dataRoot;
    resetStcontrolStateForTests();
    try {
        const legacyDirectory = path.join(dataRoot, '_storage');
        fs.mkdirSync(legacyDirectory, { recursive: true });
        fs.writeFileSync(path.join(legacyDirectory, 'stcontrol-adapter-state.json'), JSON.stringify({
            version: 3,
            mode: STCONTROL_MODES.MANAGED,
            modeGeneration: 5,
            controllerGeneration: 2,
            reasonCode: 'legacy',
            changedAt: new Date().toISOString(),
            nonces: [],
            operations: {},
            gates: {},
            sessions: {},
            lastActiveOwners: {},
            pendingSyncUsers: {},
            leases: {},
        }));

        assert.equal(getStcontrolState().modeGeneration, 5);
        assert.equal(fs.existsSync(path.join(legacyDirectory, 'stcontrol-adapter-state.json')), false);
        assert.equal(fs.existsSync(path.join(dataRoot, '_stcontrol', 'adapter-state.json')), true);
    } finally {
        resetStcontrolStateForTests();
        globalThis.DATA_ROOT = previousDataRoot;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('process restart clears orphaned in-flight counters without discarding session fences', () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-stcontrol-restart-'));
    globalThis.DATA_ROOT = dataRoot;
    resetStcontrolStateForTests();
    try {
        const state = getStcontrolState();
        state.runtimeInstanceId = '88888888-8888-4888-8888-888888888888';
        state.sessions['99999999-9999-4999-8999-999999999999'] = {
            handle: 'alice',
            loginMode: STCONTROL_MODES.MANAGED,
            activityEpoch: 11,
            controllerGeneration: 4,
            lastSeenAt: Date.now(),
            inFlightReads: 2,
            inFlightWrites: 3,
        };
        state.leases.alice = {
            sessionId: '99999999-9999-4999-8999-999999999999',
            activityEpoch: 11,
            controllerGeneration: 4,
        };
        fs.mkdirSync(path.join(dataRoot, '_stcontrol'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, '_stcontrol', 'adapter-state.json'), JSON.stringify(state));
        resetStcontrolStateForTests();

        const recovered = getStcontrolState();
        const session = recovered.sessions['99999999-9999-4999-8999-999999999999'];
        assert.equal(session.inFlightReads, 0);
        assert.equal(session.inFlightWrites, 0);
        assert.equal(session.activityEpoch, 11);
        assert.equal(recovered.leases.alice.sessionId, '99999999-9999-4999-8999-999999999999');
    } finally {
        resetStcontrolStateForTests();
        globalThis.DATA_ROOT = previousDataRoot;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('a stale managed page remains readable but cannot write', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const previousEnabled = process.env.SILLYTAVERN_STCONTROL_ENABLED;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-stcontrol-stale-'));
    globalThis.DATA_ROOT = dataRoot;
    process.env.SILLYTAVERN_STCONTROL_ENABLED = 'true';
    resetStcontrolStateForTests();
    try {
        const state = getStcontrolState();
        state.sessions['11111111-1111-4111-8111-111111111111'] = {
            handle: 'alice',
            loginMode: STCONTROL_MODES.MANAGED,
            activityEpoch: 6,
            controllerGeneration: 2,
            lastSeenAt: Date.now(),
            lastPageAt: Date.now(),
            lastRequestAt: Date.now(),
            inFlightReads: 0,
            inFlightWrites: 0,
        };
        state.leases.alice = {
            sessionId: '22222222-2222-4222-8222-222222222222',
            activityEpoch: 7,
            controllerGeneration: 2,
        };
        fs.mkdirSync(path.join(dataRoot, '_stcontrol'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, '_stcontrol', 'adapter-state.json'), JSON.stringify(state));
        resetStcontrolStateForTests();

        const makeRequest = method => ({
            method,
            path: '/api/chats/get',
            user: { profile: { handle: 'alice' } },
            session: { stcontrol: {
                sessionId: '11111111-1111-4111-8111-111111111111',
                loginMode: STCONTROL_MODES.MANAGED,
                activityEpoch: 6,
                controllerGeneration: 2,
            } },
        });
        const response = new EventEmitter();
        response.status = status => { response.statusCode = status; return response; };
        response.json = body => { response.body = body; return response; };
        let reads = 0;
        await stcontrolRequestTracker(makeRequest('GET'), response, () => reads++);
        assert.equal(reads, 1);
        response.emit('finish');

        const writeResponse = new EventEmitter();
        writeResponse.status = status => { writeResponse.statusCode = status; return writeResponse; };
        writeResponse.json = body => { writeResponse.body = body; return writeResponse; };
        let writes = 0;
        await stcontrolRequestTracker(makeRequest('POST'), writeResponse, () => writes++);
        assert.equal(writes, 0);
        assert.equal(writeResponse.statusCode, 409);
        assert.equal(writeResponse.body.code, 'stale_writer_session');
    } finally {
        await new Promise(resolve => setTimeout(resolve, 20));
        resetStcontrolStateForTests();
        globalThis.DATA_ROOT = previousDataRoot;
        if (previousEnabled === undefined) delete process.env.SILLYTAVERN_STCONTROL_ENABLED;
        else process.env.SILLYTAVERN_STCONTROL_ENABLED = previousEnabled;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('independent reconciliation requires the exact durable marker and a drained session', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-stcontrol-sync-'));
    globalThis.DATA_ROOT = dataRoot;
    resetStcontrolStateForTests();
    try {
        await applyStcontrolMode({
            mode: STCONTROL_MODES.INDEPENDENT,
            mode_generation: 2,
            controller_generation: 1,
            reason_code: 'sustained_outage',
        });
        const state = getStcontrolState();
        state.pendingSyncUsers.alice = {
            marker: '11111111-1111-4111-8111-111111111111',
            changedAt: Date.now(),
            reason: 'independent_write',
        };
        fs.mkdirSync(path.join(dataRoot, '_stcontrol'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, '_stcontrol', 'adapter-state.json'), JSON.stringify(state));
        resetStcontrolStateForTests();
        await applyStcontrolMode({
            mode: STCONTROL_MODES.DRAINING,
            mode_generation: 3,
            controller_generation: 2,
            reason_code: 'controller_recovered',
        });
        assert.deepEqual(getStcontrolPendingSyncUsers().map(item => item.handle), ['alice']);
        await assert.rejects(
            () => markUserSynchronized('alice', '22222222-2222-4222-8222-222222222222'),
            /marker changed/,
        );
        await markUserSynchronized('alice', '11111111-1111-4111-8111-111111111111');
        assert.deepEqual(getStcontrolPendingSyncUsers(), []);
    } finally {
        resetStcontrolStateForTests();
        globalThis.DATA_ROOT = previousDataRoot;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('outage conversion prevents an existing managed browser from becoming an untracked writer', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-stcontrol-outage-'));
    globalThis.DATA_ROOT = dataRoot;
    resetStcontrolStateForTests();
    try {
        const state = getStcontrolState();
        state.sessions['11111111-1111-4111-8111-111111111111'] = {
            handle: 'alice',
            loginMode: STCONTROL_MODES.MANAGED,
            activityEpoch: 7,
            controllerGeneration: 1,
            lastSeenAt: Date.now(),
            inFlightReads: 0,
            inFlightWrites: 0,
        };
        state.leases.alice = {
            sessionId: '11111111-1111-4111-8111-111111111111',
            activityEpoch: 7,
            controllerGeneration: 1,
        };
        fs.mkdirSync(path.join(dataRoot, '_stcontrol'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, '_stcontrol', 'adapter-state.json'), JSON.stringify(state));
        resetStcontrolStateForTests();

        await applyStcontrolMode({
            mode: STCONTROL_MODES.INDEPENDENT,
            mode_generation: 2,
            controller_generation: 1,
            reason_code: 'sustained_outage',
        });
        const converted = getStcontrolState();
        assert.equal(converted.sessions['11111111-1111-4111-8111-111111111111'].loginMode, STCONTROL_MODES.INDEPENDENT);
        assert.equal(converted.sessions['11111111-1111-4111-8111-111111111111'].activityEpoch, 0);
        assert.deepEqual(converted.leases, {});
    } finally {
        resetStcontrolStateForTests();
        globalThis.DATA_ROOT = previousDataRoot;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('stcontrol adapter is wired through authenticated, CSRF-safe integration points', () => {
    const endpoint = fs.readFileSync(new URL('../src/endpoints/stcontrol.js', import.meta.url), 'utf8');
    const startup = fs.readFileSync(new URL('../src/server-startup.js', import.meta.url), 'utf8');
    const publicUsers = fs.readFileSync(new URL('../src/endpoints/users-public.js', import.meta.url), 'utf8');
    const loginBoundary = fs.readFileSync(new URL('../src/users.js', import.meta.url), 'utf8');

    for (const route of [
        '/api/stcontrol/internal/health',
        '/api/stcontrol/internal/control-mode',
        '/api/stcontrol/internal/sessions',
		'/api/stcontrol/internal/control/sync-complete',
        '/api/stcontrol/internal/users/provision',
        '/api/stcontrol/internal/users/restore',
        '/api/stcontrol/internal/users/password',
        '/api/stcontrol/internal/users/verify',
        '/api/stcontrol/internal/users/scan',
        '/api/stcontrol/internal/admin/verify',
        '/api/stcontrol/internal/admin/check',
        '/api/stcontrol/internal/snapshots/quiesce',
        '/api/stcontrol/internal/snapshots/release',
    ]) {
        assert.match(endpoint, new RegExp(route.replaceAll('/', '\\/')));
    }
    assert.match(startup, /app\.use\(stcontrolRouter\)/);
    assert.match(startup, /app\.use\(stcontrolRequestTracker\)/);
    assert.match(publicUsers, /router\.post\('\/me', stcontrolHandoffHandler\)/);
    assert.match(loginBoundary, /request\.path\.startsWith\('\/api\/stcontrol\/internal\/'\)/);
    assert.match(endpoint, /stcontrol_handoff/);
    assert.doesNotMatch(endpoint, /request\.query\.(?:ticket|code)/);
});
