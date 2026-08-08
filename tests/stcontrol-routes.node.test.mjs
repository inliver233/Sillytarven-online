import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import storage from 'node-persist';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-stcontrol-routes-'));
globalThis.DATA_ROOT = testRoot;

let baseUrl;
let server;
let adapter;
let systemMonitor;
const sharedSession = {};

before(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(fileURLToPath(new URL('./fixtures/stcontrol-config.yaml', import.meta.url)));
    await storage.init({ dir: path.join(testRoot, '_storage'), ttl: false, expiredInterval: 0 });
    adapter = await import('../src/stcontrol.js');
    const endpoint = await import('../src/endpoints/stcontrol.js');
    systemMonitor = (await import('../src/system-monitor.js')).default;

    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.session = sharedSession;
        next();
    });
    app.post('/api/users/me', endpoint.stcontrolHandoffHandler);
    app.use(endpoint.router);
    server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    systemMonitor?.destroy();
    if (typeof storage.stop === 'function') storage.stop();
    process.once('exit', () => fs.rmSync(testRoot, { recursive: true, force: true }));
});

async function signedPost(route, body) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID().replaceAll('-', '');
    return fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Agent-Id': '7',
            'X-Timestamp': timestamp,
            'X-Nonce': nonce,
            'X-Signature': adapter.signStcontrolRequest('test-agent-psk', 'POST', route, timestamp, nonce, body),
        },
        body: adapter.encodeStcontrolRequestBody(body),
    });
}

test('actual adapter route resumes provisioning after a lost idempotency receipt', async () => {
    const policyResponse = await signedPost('/api/stcontrol/internal/registration-policy', {});
    assert.equal(policyResponse.status, 200);
    const policy = await policyResponse.json();
    assert.equal(policy.mode, 'open');

    const request = {
        operation_id: '11111111-1111-4111-8111-111111111111',
        registration_id: '22222222-2222-4222-8222-222222222222',
        policy_version: policy.version,
        handle: 'alice',
        name: 'Alice',
        password_hash: 'durable-scrypt-hash',
        password_salt: 'durable-scrypt-salt',
    };
    const firstResponse = await signedPost('/api/stcontrol/internal/users/provision', request);
    const firstText = await firstResponse.text();
    assert.equal(firstResponse.status, 200, firstText);

    const statePath = path.join(testRoot, '_stcontrol', 'adapter-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.operations = {};
    fs.writeFileSync(statePath, JSON.stringify(state));
    adapter.resetStcontrolStateForTests();

    const replayResponse = await signedPost('/api/stcontrol/internal/users/provision', request);
    const replayText = await replayResponse.text();
    assert.equal(replayResponse.status, 200, replayText);
    assert.equal(JSON.parse(replayText).replayed, true);

    const conflictResponse = await signedPost('/api/stcontrol/internal/users/provision', {
        ...request,
        operation_id: '33333333-3333-4333-8333-333333333333',
        registration_id: '44444444-4444-4444-8444-444444444444',
    });
    assert.equal(conflictResponse.status, 409);
    assert.equal((await conflictResponse.json()).code, 'user_already_exists');
});

test('account inventory pages beyond 500 users without gaps and fences revision drift', async () => {
    const keys = Array.from({ length: 620 }, (_, index) => `user:inventory-${String(index).padStart(4, '0')}`);
    try {
        for (let offset = 0; offset < keys.length; offset += 100) {
            await Promise.all(keys.slice(offset, offset + 100).map(async (key, index) => {
                const ordinal = offset + index;
                const handle = key.slice('user:'.length);
                await storage.setItem(key, {
                    id: `local-${String(ordinal).padStart(4, '0')}`,
                    handle,
                    enabled: true,
                    password: 'hash',
                    salt: 'salt',
                });
            }));
        }

        let cursor = 0;
        let revision = '';
        let total = 0;
        const localUserIds = [];
        do {
            const response = await signedPost('/api/stcontrol/internal/users/scan', {
                cursor,
                inventory_revision: revision,
                limit: 250,
            });
            const page = await response.json();
            assert.equal(response.status, 200, JSON.stringify(page));
            assert.ok(page.users.length <= 250);
            if (!revision) revision = page.inventory_revision;
            assert.equal(page.inventory_revision, revision);
            total = page.total_users;
            localUserIds.push(...page.users.map(user => user.local_user_id));
            cursor = page.next_cursor;
            if (!page.has_more) break;
        } while (true);

        assert.ok(total > 500);
        assert.equal(localUserIds.length, total);
        assert.equal(new Set(localUserIds).size, total);
        assert.deepEqual(localUserIds, [...localUserIds].sort());

        const changed = await storage.getItem(keys[0]);
        changed.admin = true;
        await storage.setItem(keys[0], changed);
        const stale = await signedPost('/api/stcontrol/internal/users/scan', {
            cursor: 250,
            inventory_revision: revision,
            limit: 250,
        });
        assert.equal(stale.status, 409);
        assert.equal((await stale.json()).code, 'inventory_changed');

        const unboundContinuation = await signedPost('/api/stcontrol/internal/users/scan', {
            cursor: 250,
            limit: 250,
        });
        assert.equal(unboundContinuation.status, 400);
        assert.equal((await unboundContinuation.json()).code, 'invalid_inventory_page');
    } finally {
        for (let offset = 0; offset < keys.length; offset += 100) {
            await Promise.all(keys.slice(offset, offset + 100).map(key => storage.removeItem(key)));
        }
    }
});

test('browser handoff uses the local Agent proxy and establishes a fenced session', async () => {
    const previousAgentUrl = process.env.SILLYTAVERN_STCONTROL_AGENTURL;
    const code = 'opaque-one-use-browser-secret';
    let consumed = false;
    let agentRequest;
    const agent = express();
    agent.use(express.json());
    agent.post('/agent/tickets/redeem', (request, response) => {
        agentRequest = request;
        const timestamp = request.get('X-Timestamp');
        const nonce = request.get('X-Nonce');
        const expected = adapter.signStcontrolRequest(
            'test-agent-psk', 'POST', '/agent/tickets/redeem', timestamp, nonce, request.body,
        );
        if (request.get('X-Agent-Id') !== '7' || request.get('X-Signature') !== expected) {
            return response.sendStatus(401);
        }
        if (consumed || request.body.code !== code) return response.sendStatus(403);
        consumed = true;
        return response.json({
            ok: true,
            handle: 'alice',
            user_id: 41,
            session_id: '55555555-5555-4555-8555-555555555555',
            activity_epoch: 8,
            controller_generation: 1,
        });
    });
    const agentServer = await new Promise((resolve, reject) => {
        const listener = agent.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    try {
        const address = agentServer.address();
        assert.ok(address && typeof address !== 'string');
        process.env.SILLYTAVERN_STCONTROL_AGENTURL = `http://127.0.0.1:${address.port}`;
        const response = await fetch(`${baseUrl}/api/users/me?stcontrol_handoff=user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stcontrol_code: code }),
            redirect: 'manual',
        });
        assert.equal(response.status, 303);
        assert.equal(response.headers.get('location'), '/');
        assert.equal(sharedSession.handle, 'alice');
        assert.deepEqual(sharedSession.stcontrol, {
            sessionId: '55555555-5555-4555-8555-555555555555',
            loginMode: 'managed',
            activityEpoch: 8,
            controllerGeneration: 1,
        });
        assert.equal(agentRequest.originalUrl, '/agent/tickets/redeem');
        assert.equal(agentRequest.originalUrl.includes(code), false);

        const replay = await fetch(`${baseUrl}/api/users/me?stcontrol_handoff=user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stcontrol_code: code }),
            redirect: 'manual',
        });
        assert.equal(replay.status, 403);
    } finally {
        await new Promise((resolve, reject) => agentServer.close(error => error ? reject(error) : resolve()));
        if (previousAgentUrl === undefined) delete process.env.SILLYTAVERN_STCONTROL_AGENTURL;
        else process.env.SILLYTAVERN_STCONTROL_AGENTURL = previousAgentUrl;
    }
});

test('administrator handoff rechecks the permission version and creates an isolated admin session', async () => {
    const previousAgentUrl = process.env.SILLYTAVERN_STCONTROL_AGENTURL;
    const code = 'opaque-one-use-administrator-secret';
    const user = await storage.getItem('user:alice');
    user.admin = true;
    user.stcontrolPermissionVersion = 3;
    await storage.setItem('user:alice', user);
    const consumed = new Set();
    const acceptedCodes = new Set([code, 'new-code-with-stale-permission']);
    const agent = express();
    agent.use(express.json());
    agent.post('/agent/tickets/redeem-admin', (request, response) => {
        const timestamp = request.get('X-Timestamp');
        const nonce = request.get('X-Nonce');
        const expected = adapter.signStcontrolRequest(
            'test-agent-psk', 'POST', '/agent/tickets/redeem-admin', timestamp, nonce, request.body,
        );
        if (request.get('X-Signature') !== expected) return response.sendStatus(401);
        if (!acceptedCodes.has(request.body.code) || consumed.has(request.body.code)) return response.sendStatus(403);
        consumed.add(request.body.code);
        return response.json({
            ok: true,
            handle: 'alice',
            admin_id: 9,
            permission_version: 3,
            controller_generation: 1,
        });
    });
    const agentServer = await new Promise((resolve, reject) => {
        const listener = agent.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    try {
        const address = agentServer.address();
        assert.ok(address && typeof address !== 'string');
        process.env.SILLYTAVERN_STCONTROL_AGENTURL = `http://127.0.0.1:${address.port}`;
        const response = await fetch(`${baseUrl}/api/users/me?stcontrol_handoff=admin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stcontrol_code: code }),
            redirect: 'manual',
        });
        assert.equal(response.status, 303);
        assert.equal(response.headers.get('location'), '/?stcontrol_admin=1');
        assert.deepEqual(sharedSession.stcontrolAdmin, {
            adminId: 9,
            permissionVersion: 3,
            controllerGeneration: 1,
        });

        user.stcontrolPermissionVersion = 4;
        await storage.setItem('user:alice', user);
        const stalePermission = await fetch(`${baseUrl}/api/users/me?stcontrol_handoff=admin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stcontrol_code: 'new-code-with-stale-permission' }),
            redirect: 'manual',
        });
        assert.equal(stalePermission.status, 403);
    } finally {
        await new Promise((resolve, reject) => agentServer.close(error => error ? reject(error) : resolve()));
        if (previousAgentUrl === undefined) delete process.env.SILLYTAVERN_STCONTROL_AGENTURL;
        else process.env.SILLYTAVERN_STCONTROL_AGENTURL = previousAgentUrl;
    }
});

test('snapshot write gate drains one user and requires the exact release token', async () => {
    const request = {
        workflow_id: '66666666-6666-4666-8666-666666666666',
        snapshot_id: '77777777-7777-4777-8777-777777777777',
        handle: 'alice',
        activity_epoch: 8,
    };
    const quiesceResponse = await signedPost('/api/stcontrol/internal/snapshots/quiesce', request);
    const quiesce = await quiesceResponse.json();
    assert.equal(quiesceResponse.status, 200);
    assert.equal(quiesce.drained, true);
    assert.ok(typeof quiesce.freeze_token === 'string' && quiesce.freeze_token.length >= 32);

    const wrongRelease = await signedPost('/api/stcontrol/internal/snapshots/release', {
        ...request,
        freeze_token: 'wrong-release-token-that-is-long-enough',
    });
    assert.equal(wrongRelease.status, 409);
    assert.ok(adapter.getUserWriteGate('alice'));

    const releaseResponse = await signedPost('/api/stcontrol/internal/snapshots/release', {
        ...request,
        freeze_token: quiesce.freeze_token,
    });
    assert.equal(releaseResponse.status, 200);
    assert.equal(adapter.getUserWriteGate('alice'), null);
});

test('authoritative data fault gate is durable, scoped and idempotent', async () => {
    const request = {
        fault_id: '88888888-8888-4888-8888-888888888888',
        handle: 'alice',
        activity_epoch: 8,
    };
    const firstResponse = await signedPost('/api/stcontrol/internal/data-faults/freeze', request);
    assert.equal(firstResponse.status, 200, await firstResponse.text());
    assert.deepEqual(adapter.getUserWriteGate('alice'), {
        kind: 'data_fault',
        faultId: request.fault_id,
        activityEpoch: 8,
        createdAt: adapter.getUserWriteGate('alice').createdAt,
    });

    const replayResponse = await signedPost('/api/stcontrol/internal/data-faults/freeze', request);
    assert.equal(replayResponse.status, 200, await replayResponse.text());

    const mismatchResponse = await signedPost('/api/stcontrol/internal/data-faults/freeze', {
        ...request,
        activity_epoch: 9,
    });
    assert.equal(mismatchResponse.status, 409);
    assert.equal((await mismatchResponse.json()).code, 'data_fault_scope_mismatch');

    adapter.resetStcontrolStateForTests();
    assert.equal(adapter.getUserWriteGate('alice').faultId, request.fault_id);

    const snapshotConflict = await signedPost('/api/stcontrol/internal/snapshots/quiesce', {
        workflow_id: '99999999-9999-4999-8999-999999999999',
        snapshot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        handle: 'alice',
        activity_epoch: 8,
    });
    assert.equal(snapshotConflict.status, 409);
    assert.equal(adapter.getUserWriteGate('alice').kind, 'data_fault');
    await adapter.setUserWriteGate('alice', null);
});
