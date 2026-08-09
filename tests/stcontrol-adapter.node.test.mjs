import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    STCONTROL_CAPABILITIES,
    STCONTROL_MODES,
    applyStcontrolActivityLeaseConfirmations,
    applyStcontrolMode,
    encodeStcontrolRequestBody,
    getStcontrolActivityPolicy,
    getStcontrolSessionTelemetry,
    getStcontrolState,
	getStcontrolPendingSyncUsers,
	markUserSynchronized,
    noteStcontrolPageHeartbeat,
    resetStcontrolStateForTests,
    runIdempotentStcontrolOperation,
    setUserWriteGate,
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
            gates: {
                alice: {
                    workflowId: '01010101-0101-4101-8101-010101010101',
                    snapshotId: '02020202-0202-4202-8202-020202020202',
                    activityEpoch: 4,
                    freezeToken: 'legacy-freeze-token-with-sufficient-length',
                    createdAt: Date.now(),
                },
            },
            sessions: {},
            lastActiveOwners: {},
            pendingSyncUsers: {},
            leases: {},
        }));

        const migrated = getStcontrolState();
        assert.equal(migrated.modeGeneration, 5);
        assert.equal(migrated.gates.alice.kind, 'snapshot');
        assert.ok(migrated.gates.alice.expiresAt > migrated.gates.alice.createdAt);
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
            leaseExpiresAt: Date.now() + 120_000,
            confirmedAt: Date.now(),
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

test('managed activity timing is configurable and heartbeat intervals stay safely below the idle window', () => {
    const previous = {
        idle: process.env.SILLYTAVERN_STCONTROL_SESSIONIDLEMS,
        foreground: process.env.SILLYTAVERN_STCONTROL_FOREGROUNDHEARTBEATMS,
        background: process.env.SILLYTAVERN_STCONTROL_BACKGROUNDHEARTBEATMS,
    };
    try {
        process.env.SILLYTAVERN_STCONTROL_SESSIONIDLEMS = '60000';
        process.env.SILLYTAVERN_STCONTROL_FOREGROUNDHEARTBEATMS = '20000';
        process.env.SILLYTAVERN_STCONTROL_BACKGROUNDHEARTBEATMS = '50000';
        assert.deepEqual(getStcontrolActivityPolicy(), {
            sessionIdleMs: 60000,
            foregroundHeartbeatMs: 20000,
            backgroundHeartbeatMs: 30000,
        });
    } finally {
        for (const [key, value] of Object.entries({
            SILLYTAVERN_STCONTROL_SESSIONIDLEMS: previous.idle,
            SILLYTAVERN_STCONTROL_FOREGROUNDHEARTBEATMS: previous.foreground,
            SILLYTAVERN_STCONTROL_BACKGROUNDHEARTBEATMS: previous.background,
        })) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('idle sessions become durable tombstones, revoke only their exact lease, and cannot wake without login', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const previousEnabled = process.env.SILLYTAVERN_STCONTROL_ENABLED;
    const previousIdle = process.env.SILLYTAVERN_STCONTROL_SESSIONIDLEMS;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-stcontrol-idle-'));
    const now = Date.now();
    const aliceSession = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const bobSession = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const carolSession = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const replacementSession = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    globalThis.DATA_ROOT = dataRoot;
    process.env.SILLYTAVERN_STCONTROL_ENABLED = 'true';
    process.env.SILLYTAVERN_STCONTROL_SESSIONIDLEMS = '60000';
    resetStcontrolStateForTests();
    try {
        const state = getStcontrolState();
        const session = (handle, lastSeenAt, inFlightWrites = 0) => ({
            handle,
            loginMode: STCONTROL_MODES.MANAGED,
            activityEpoch: 9,
            controllerGeneration: 3,
            lastSeenAt,
            lastPageAt: lastSeenAt,
            lastRequestAt: lastSeenAt,
            inFlightReads: 0,
            inFlightWrites,
        });
        state.sessions[aliceSession] = session('alice', now - 60001);
        state.sessions[bobSession] = session('bob', now - 60001, 1);
        state.sessions[carolSession] = session('carol', now - 60001);
        state.sessions['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'] = {
            ...session('erin', now - 59900),
        };
        state.sessions['ffffffff-ffff-4fff-8fff-ffffffffffff'] = {
            ...session('frank', now - 120001),
            loggedOutAt: now - 60001,
        };
        state.leases.alice = { sessionId: aliceSession, activityEpoch: 9, controllerGeneration: 3, leaseExpiresAt: now + 120_000, confirmedAt: now };
        state.leases.bob = { sessionId: bobSession, activityEpoch: 9, controllerGeneration: 3, leaseExpiresAt: now + 120_000, confirmedAt: now };
        // Carol's newer lease must survive cleanup of her older session.
        state.leases.carol = { sessionId: replacementSession, activityEpoch: 10, controllerGeneration: 3, leaseExpiresAt: now + 120_000, confirmedAt: now };
        fs.mkdirSync(path.join(dataRoot, '_stcontrol'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, '_stcontrol', 'adapter-state.json'), JSON.stringify(state));
        resetStcontrolStateForTests();

        const telemetry = getStcontrolSessionTelemetry();
        const byHandle = Object.fromEntries(telemetry.map(fact => [fact.handle, fact]));
        assert.equal(byHandle.alice.ended, true);
        assert.equal(byHandle.alice.is_online, false);
        assert.equal(byHandle.bob.ended, false);
        assert.equal(byHandle.bob.is_online, true, 'an in-flight write must prevent idle expiry');
        assert.equal(byHandle.erin.is_online, true, 'a session just inside the idle window must remain online');
        assert.equal(byHandle.frank, undefined, 'an observed tombstone is eventually collected');

        const persisted = JSON.parse(fs.readFileSync(path.join(dataRoot, '_stcontrol', 'adapter-state.json'), 'utf8'));
        assert.equal(Boolean(persisted.sessions[aliceSession].loggedOutAt), true);
        assert.equal(persisted.leases.alice, undefined);
        assert.equal(persisted.leases.bob.sessionId, bobSession);
        assert.equal(persisted.leases.carol.sessionId, replacementSession);

        const renewed = await noteStcontrolPageHeartbeat({ session: { stcontrol: { sessionId: aliceSession } } });
        assert.equal(renewed, false, 'the public heartbeat route could revive an expired session');

        const request = {
            method: 'GET',
            path: '/api/chats/get',
            user: { profile: { handle: 'alice' } },
            session: { stcontrol: {
                sessionId: aliceSession,
                loginMode: STCONTROL_MODES.MANAGED,
                activityEpoch: 9,
                controllerGeneration: 3,
            } },
        };
        const response = new EventEmitter();
        response.status = status => { response.statusCode = status; return response; };
        response.json = body => { response.body = body; return response; };
        let continued = 0;
        await stcontrolRequestTracker(request, response, () => continued++);
        assert.equal(continued, 0);
        assert.equal(response.statusCode, 409);
        assert.equal(response.body.code, 'stale_writer_session');

        // Even after the tombstone retention window, the old cookie cannot
        // recreate a durable session without a fresh login handoff.
        persisted.sessions[aliceSession].loggedOutAt = Date.now() - 60001;
        fs.writeFileSync(path.join(dataRoot, '_stcontrol', 'adapter-state.json'), JSON.stringify(persisted));
        resetStcontrolStateForTests();
        getStcontrolSessionTelemetry();
        const afterCollection = new EventEmitter();
        afterCollection.status = status => { afterCollection.statusCode = status; return afterCollection; };
        afterCollection.json = body => { afterCollection.body = body; return afterCollection; };
        await stcontrolRequestTracker(request, afterCollection, () => continued++);
        assert.equal(continued, 0);
        assert.equal(afterCollection.statusCode, 409);
    } finally {
        resetStcontrolStateForTests();
        globalThis.DATA_ROOT = previousDataRoot;
        if (previousEnabled === undefined) delete process.env.SILLYTAVERN_STCONTROL_ENABLED;
        else process.env.SILLYTAVERN_STCONTROL_ENABLED = previousEnabled;
        if (previousIdle === undefined) delete process.env.SILLYTAVERN_STCONTROL_SESSIONIDLEMS;
        else process.env.SILLYTAVERN_STCONTROL_SESSIONIDLEMS = previousIdle;
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
            leaseExpiresAt: Date.now() + 120_000,
            confirmedAt: Date.now(),
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

test('Controller-confirmed lease snapshots revoke omissions and fence writes at the exact deadline', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const previousEnabled = process.env.SILLYTAVERN_STCONTROL_ENABLED;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-stcontrol-lease-confirm-'));
    const aliceSession = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const bobSession = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
    globalThis.DATA_ROOT = dataRoot;
    process.env.SILLYTAVERN_STCONTROL_ENABLED = 'true';
    resetStcontrolStateForTests();
    try {
        const now = Date.now();
        const state = getStcontrolState();
        const addSession = (handle, sessionId) => {
            state.sessions[sessionId] = {
                handle, loginMode: STCONTROL_MODES.MANAGED,
                activityEpoch: 8, controllerGeneration: 3,
                lastSeenAt: now, lastPageAt: now, lastRequestAt: now,
                inFlightReads: 0, inFlightWrites: 0,
            };
            state.leases[handle] = {
                sessionId, activityEpoch: 8, controllerGeneration: 3,
                leaseExpiresAt: now + 120_000, confirmedAt: now,
            };
        };
        addSession('alice', aliceSession);
        addSession('bob', bobSession);
        fs.mkdirSync(path.join(dataRoot, '_stcontrol'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, '_stcontrol', 'adapter-state.json'), JSON.stringify(state));
        resetStcontrolStateForTests();

        const preserved = await applyStcontrolActivityLeaseConfirmations({
            controller_generation: 3,
            confirmed_at: now - 1,
            leases: [],
        });
        assert.deepEqual(preserved, { ok: true, confirmed_at: now - 1, applied_leases: 0 });
        assert.equal(Object.keys(getStcontrolState().leases).length, 2,
            'a heartbeat observed before handoff revoked the newly issued local leases');

        const confirmedAt = Date.now();
        const expiresAt = confirmedAt + 60_080;
        const applied = await applyStcontrolActivityLeaseConfirmations({
            controller_generation: 3,
            confirmed_at: confirmedAt,
            leases: [{
                handle: 'alice', session_id: aliceSession, activity_epoch: 8,
                controller_generation: 3, lease_expires_at: expiresAt,
            }],
        });
        assert.deepEqual(applied, { ok: true, confirmed_at: confirmedAt, applied_leases: 1 });
        assert.equal(getStcontrolState().leases.bob, undefined, 'an omitted lease remained writable');

        const makeRequest = () => ({
            method: 'POST', path: '/api/chats/save', user: { profile: { handle: 'alice' } },
            session: { stcontrol: {
                sessionId: aliceSession, loginMode: STCONTROL_MODES.MANAGED,
                activityEpoch: 8, controllerGeneration: 3,
            } },
        });
        const makeResponse = () => {
            const response = new EventEmitter();
            response.status = status => { response.statusCode = status; return response; };
            response.json = body => { response.body = body; return response; };
            return response;
        };
        const beforeExpiry = makeResponse();
        let writes = 0;
        await stcontrolRequestTracker(makeRequest(), beforeExpiry, () => writes++);
        assert.equal(writes, 1);
        beforeExpiry.emit('finish');

        await new Promise(resolve => setTimeout(resolve, 100));
        const afterExpiry = makeResponse();
        await stcontrolRequestTracker(makeRequest(), afterExpiry, () => writes++);
        assert.equal(writes, 1);
        assert.equal(afterExpiry.statusCode, 409);
        assert.equal(afterExpiry.body.code, 'stale_writer_session');

        await assert.rejects(() => applyStcontrolActivityLeaseConfirmations({
            controller_generation: 3,
            confirmed_at: confirmedAt - 1,
            leases: [{
                handle: 'alice', session_id: aliceSession, activity_epoch: 8,
                controller_generation: 3, lease_expires_at: confirmedAt + 120_000,
            }],
        }), /rollback/);
        resetStcontrolStateForTests();
        assert.equal(getStcontrolState().leases.alice.leaseExpiresAt, expiresAt, 'confirmed deadline was not durable');
    } finally {
        await new Promise(resolve => setTimeout(resolve, 20));
        resetStcontrolStateForTests();
        globalThis.DATA_ROOT = previousDataRoot;
        if (previousEnabled === undefined) delete process.env.SILLYTAVERN_STCONTROL_ENABLED;
        else process.env.SILLYTAVERN_STCONTROL_ENABLED = previousEnabled;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('multiple tabs sharing one fenced session keep exact concurrent request counters', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const previousEnabled = process.env.SILLYTAVERN_STCONTROL_ENABLED;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-stcontrol-tabs-'));
    const sessionId = 'abababab-abab-4bab-8bab-abababababab';
    globalThis.DATA_ROOT = dataRoot;
    process.env.SILLYTAVERN_STCONTROL_ENABLED = 'true';
    resetStcontrolStateForTests();
    try {
        const now = Date.now();
        const state = getStcontrolState();
        state.sessions[sessionId] = {
            handle: 'alice', loginMode: STCONTROL_MODES.MANAGED,
            activityEpoch: 12, controllerGeneration: 4,
            lastSeenAt: now, lastPageAt: now, lastRequestAt: now,
            inFlightReads: 0, inFlightWrites: 0,
        };
        state.leases.alice = { sessionId, activityEpoch: 12, controllerGeneration: 4, leaseExpiresAt: now + 120_000, confirmedAt: now };
        fs.mkdirSync(path.join(dataRoot, '_stcontrol'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, '_stcontrol', 'adapter-state.json'), JSON.stringify(state));
        resetStcontrolStateForTests();

        const envelope = { sessionId, loginMode: STCONTROL_MODES.MANAGED, activityEpoch: 12, controllerGeneration: 4 };
        const request = method => ({
            method, path: '/api/chats/save', user: { profile: { handle: 'alice' } },
            session: { stcontrol: { ...envelope } },
        });
        const response = () => {
            const value = new EventEmitter();
            value.status = status => { value.statusCode = status; return value; };
            value.json = body => { value.body = body; return value; };
            return value;
        };
        const firstTab = response();
        const secondTab = response();
        let continued = 0;
        await stcontrolRequestTracker(request('GET'), firstTab, () => continued++);
        await stcontrolRequestTracker(request('POST'), secondTab, () => continued++);
        assert.equal(continued, 2);
        let fact = getStcontrolSessionTelemetry().find(item => item.session_id === sessionId);
        assert.equal(fact.in_flight_reads, 1);
        assert.equal(fact.in_flight_writes, 1);
        assert.equal(fact.is_online, true);

        firstTab.emit('finish');
        await new Promise(resolve => setTimeout(resolve, 20));
        fact = getStcontrolSessionTelemetry().find(item => item.session_id === sessionId);
        assert.equal(fact.in_flight_reads, 0);
        assert.equal(fact.in_flight_writes, 1);
        assert.equal(fact.is_online, true);

        secondTab.emit('close');
        await new Promise(resolve => setTimeout(resolve, 20));
        fact = getStcontrolSessionTelemetry().find(item => item.session_id === sessionId);
        assert.equal(fact.in_flight_reads, 0);
        assert.equal(fact.in_flight_writes, 0);
        assert.equal(fact.is_online, true, 'request completion must refresh last activity');
    } finally {
        resetStcontrolStateForTests();
        globalThis.DATA_ROOT = previousDataRoot;
        if (previousEnabled === undefined) delete process.env.SILLYTAVERN_STCONTROL_ENABLED;
        else process.env.SILLYTAVERN_STCONTROL_ENABLED = previousEnabled;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('snapshot gate leases expire safely and cover extension requests for only one user', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const previousEnabled = process.env.SILLYTAVERN_STCONTROL_ENABLED;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-stcontrol-gate-lease-'));
    globalThis.DATA_ROOT = dataRoot;
    process.env.SILLYTAVERN_STCONTROL_ENABLED = 'true';
    resetStcontrolStateForTests();
    try {
        const now = Date.now();
        const aliceSession = '12121212-1212-4121-8121-121212121212';
        const bobSession = '34343434-3434-4343-8343-343434343434';
        const state = getStcontrolState();
        for (const [handle, sessionId, epoch] of [
            ['alice', aliceSession, 21],
            ['bob', bobSession, 22],
        ]) {
            state.sessions[sessionId] = {
                handle, loginMode: STCONTROL_MODES.MANAGED,
                activityEpoch: epoch, controllerGeneration: 7,
                lastSeenAt: now, lastPageAt: now, lastRequestAt: now,
                inFlightReads: 0, inFlightWrites: 0,
            };
            state.leases[handle] = {
                sessionId, activityEpoch: epoch, controllerGeneration: 7,
                leaseExpiresAt: now + 120_000, confirmedAt: now,
            };
        }
        fs.mkdirSync(path.join(dataRoot, '_stcontrol'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, '_stcontrol', 'adapter-state.json'), JSON.stringify(state));
        resetStcontrolStateForTests();

        const gate = expiresAt => ({
            kind: 'snapshot',
            workflowId: '56565656-5656-4565-8565-565656565656',
            snapshotId: '78787878-7878-4787-8787-787878787878',
            activityEpoch: 21,
            freezeToken: 'exact-snapshot-gate-token-with-enough-entropy',
            createdAt: now - 30_001,
            expiresAt,
        });
        const request = (handle, sessionId, epoch, method) => ({
            method,
            path: '/api/extensions/example/private-state',
            user: { profile: { handle } },
            session: { stcontrol: {
                sessionId, loginMode: STCONTROL_MODES.MANAGED,
                activityEpoch: epoch, controllerGeneration: 7,
            } },
        });
        const response = () => {
            const value = new EventEmitter();
            value.status = status => { value.statusCode = status; return value; };
            value.set = (name, data) => { value.headers = { ...value.headers, [name]: data }; return value; };
            value.json = body => { value.body = body; return value; };
            return value;
        };

        await setUserWriteGate('alice', gate(now - 1));
        const recoveredWrite = response();
        let continued = 0;
        await stcontrolRequestTracker(request('alice', aliceSession, 21, 'POST'), recoveredWrite, () => continued++);
        assert.equal(continued, 1, 'an expired orphan gate kept the user frozen');
        recoveredWrite.emit('finish');
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(getStcontrolState().gates.alice, undefined);

        await setUserWriteGate('alice', gate(Date.now() + 30_000));
        const aliceRead = response();
        await stcontrolRequestTracker(request('alice', aliceSession, 21, 'GET'), aliceRead, () => continued++);
        const aliceWrite = response();
        await stcontrolRequestTracker(request('alice', aliceSession, 21, 'POST'), aliceWrite, () => continued++);
        assert.equal(aliceWrite.statusCode, 423);
        assert.equal(aliceWrite.body.code, 'user_quiescing');

        const bobWrite = response();
        await stcontrolRequestTracker(request('bob', bobSession, 22, 'POST'), bobWrite, () => continued++);
        assert.equal(continued, 3, 'one user gate blocked another user or failed to count extension traffic');
        const facts = Object.fromEntries(getStcontrolSessionTelemetry().map(item => [item.handle, item]));
        assert.equal(facts.alice.in_flight_reads, 1);
        assert.equal(facts.alice.in_flight_writes, 0);
        assert.equal(facts.bob.in_flight_writes, 1);

        aliceRead.emit('close');
        bobWrite.emit('finish');
        await new Promise(resolve => setTimeout(resolve, 20));
    } finally {
        resetStcontrolStateForTests();
        globalThis.DATA_ROOT = previousDataRoot;
        if (previousEnabled === undefined) delete process.env.SILLYTAVERN_STCONTROL_ENABLED;
        else process.env.SILLYTAVERN_STCONTROL_ENABLED = previousEnabled;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('a durable data fault gate blocks only writes with a machine-readable reason', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const previousEnabled = process.env.SILLYTAVERN_STCONTROL_ENABLED;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-stcontrol-data-fault-'));
    globalThis.DATA_ROOT = dataRoot;
    process.env.SILLYTAVERN_STCONTROL_ENABLED = 'true';
    resetStcontrolStateForTests();
    try {
        const state = getStcontrolState();
        state.gates.alice = {
            kind: 'data_fault',
            faultId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            activityEpoch: 7,
            createdAt: Date.now(),
        };
        state.sessions['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] = {
            handle: 'alice',
            loginMode: STCONTROL_MODES.MANAGED,
            activityEpoch: 7,
            controllerGeneration: 1,
            lastSeenAt: Date.now(),
            lastPageAt: Date.now(),
            lastRequestAt: Date.now(),
            inFlightReads: 0,
            inFlightWrites: 0,
        };
        state.leases.alice = {
            sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            activityEpoch: 7,
            controllerGeneration: 1,
            leaseExpiresAt: Date.now() + 120_000,
            confirmedAt: Date.now(),
        };
        fs.mkdirSync(path.join(dataRoot, '_stcontrol'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, '_stcontrol', 'adapter-state.json'), JSON.stringify(state));
        resetStcontrolStateForTests();

        const makeRequest = method => ({
            method,
            path: '/api/chats/save',
            user: { profile: { handle: 'alice' } },
            session: { stcontrol: {
                sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                loginMode: STCONTROL_MODES.MANAGED,
                activityEpoch: 7,
                controllerGeneration: 1,
            } },
        });
        const makeResponse = () => {
            const response = new EventEmitter();
            response.status = status => { response.statusCode = status; return response; };
            response.set = (name, value) => { response.headers = { ...response.headers, [name]: value }; return response; };
            response.json = body => { response.body = body; return response; };
            return response;
        };

        const readResponse = makeResponse();
        let reads = 0;
        await stcontrolRequestTracker(makeRequest('GET'), readResponse, () => reads++);
        assert.equal(reads, 1);
        readResponse.emit('finish');

        const writeResponse = makeResponse();
        let writes = 0;
        await stcontrolRequestTracker(makeRequest('POST'), writeResponse, () => writes++);
        assert.equal(writes, 0);
        assert.equal(writeResponse.statusCode, 423);
        assert.equal(writeResponse.body.code, 'user_data_frozen');
        assert.equal(writeResponse.headers['Retry-After'], '2');
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

test('outage clears managed leases but requires cross-node ownership before session conversion', async () => {
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
            leaseExpiresAt: Date.now() + 120_000,
            confirmedAt: Date.now(),
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
        assert.equal(converted.sessions['11111111-1111-4111-8111-111111111111'].loginMode, STCONTROL_MODES.MANAGED);
        assert.equal(converted.sessions['11111111-1111-4111-8111-111111111111'].activityEpoch, 7);
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
        '/api/stcontrol/internal/snapshots/renew',
        '/api/stcontrol/internal/snapshots/release',
        '/api/stcontrol/internal/data-faults/freeze',
    ]) {
        assert.match(endpoint, new RegExp(route.replaceAll('/', '\\/')));
    }
    assert.match(startup, /app\.use\(stcontrolRouter\)/);
    assert.match(startup, /app\.use\(stcontrolRequestTracker\)/);
    assert.match(publicUsers, /router\.post\('\/me', stcontrolHandoffHandler\)/);
    assert.match(loginBoundary, /request\.path\.startsWith\('\/api\/stcontrol\/internal\/'\)/);
    assert.match(endpoint, /stcontrol_handoff/);
    assert.doesNotMatch(endpoint, /request\.query\.(?:ticket|code)/);
	assert.ok(STCONTROL_CAPABILITIES.includes('user_data_fault_freeze'));
});
