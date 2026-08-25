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

function clearSharedSession() {
    for (const key of Object.keys(sharedSession)) delete sharedSession[key];
}

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
    assert.deepEqual(policy.methods.password, { enabled: true, invitation_required: false });
    assert.deepEqual(policy.methods.discord, {
        enabled: true,
        invitation_required: false,
        guild_membership: { enabled: false, guild_id: '', guild_name: '', minimum_days: 0 },
    });

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
    assert.equal((await conflictResponse.json()).code, 'handle_conflict');
});

test('actual adapter safely reclaims an unbound OAuth provisioning orphan', async () => {
    const policyResponse = await signedPost('/api/stcontrol/internal/registration-policy', {});
    assert.equal(policyResponse.status, 200);
    const policy = await policyResponse.json();
    const handle = 'oauth-orphan';
    const key = `user:${handle}`;
    const firstRequest = {
        operation_id: '51000000-0000-4000-8000-000000000001',
        registration_id: '51000000-0000-4000-8000-000000000002',
        policy_version: policy.version,
        handle,
        name: 'OAuth Orphan',
        oauth_provider: 'discord',
        oauth_subject: 'discord-subject-510',
    };
    try {
        const firstResponse = await signedPost('/api/stcontrol/internal/users/provision', firstRequest);
        assert.equal(firstResponse.status, 200, await firstResponse.text());

        const orphan = await storage.getItem(key);
        orphan.oauthIdentities = {};
        delete orphan.oauthProvider;
        delete orphan.oauthUserId;
        orphan.stcontrolAccountVersion = 2;
        orphan.stcontrolOAuthIdentityStates = {
            discord: { version: 4, subject: 'discord-subject-510', present: false },
            linuxdo: { version: 3, subject: 'retired-linuxdo-subject', present: false },
        };
        orphan.stcontrolPasswordVersion = 7;
        orphan.stcontrolPermissionVersion = 9;
        await storage.setItem(key, orphan);

        const reclaimedResponse = await signedPost('/api/stcontrol/internal/users/provision', {
            ...firstRequest,
            operation_id: '51000000-0000-4000-8000-000000000003',
            registration_id: '51000000-0000-4000-8000-000000000004',
            name: 'OAuth Reclaimed',
        });
        const reclaimed = await reclaimedResponse.json();
        assert.equal(reclaimedResponse.status, 200, JSON.stringify(reclaimed));
        assert.equal(reclaimed.reclaimed, true);

        const stored = await storage.getItem(key);
        assert.equal(stored.stcontrolRegistrationId, '51000000-0000-4000-8000-000000000004');
        assert.equal(stored.stcontrolAccountVersion, 1);
        assert.equal(stored.oauthIdentities.discord, 'discord-subject-510');
        assert.equal(stored.name, 'OAuth Reclaimed');
        assert.deepEqual(stored.stcontrolOAuthIdentityStates, {
            discord: { version: 1, subject: 'discord-subject-510', present: true },
        });
        assert.equal(stored.stcontrolPasswordVersion, undefined);
        assert.equal(stored.stcontrolPermissionVersion, 1);

        const oauthConvergenceResponse = await signedPost('/api/stcontrol/internal/users/oauth', {
            operation_id: '51000000-0000-4000-8000-000000000009',
            handle,
            provider: 'discord',
            subject: 'discord-subject-510',
            remove: false,
            version: 1,
        });
        assert.equal(oauthConvergenceResponse.status, 200, await oauthConvergenceResponse.text());

        const passwordConvergenceResponse = await signedPost('/api/stcontrol/internal/users/password', {
            operation_id: '51000000-0000-4000-8000-000000000010',
            handle,
            password_hash: 'replacement-password-hash',
            password_salt: 'replacement-password-salt',
            remove: false,
            version: 1,
        });
        assert.equal(passwordConvergenceResponse.status, 200, await passwordConvergenceResponse.text());

        stored.oauthIdentities = { github: 'different-subject' };
        stored.oauthProvider = 'github';
        stored.oauthUserId = 'different-subject';
        await storage.setItem(key, stored);
        const identityConflict = await signedPost('/api/stcontrol/internal/users/provision', {
            ...firstRequest,
            operation_id: '51000000-0000-4000-8000-000000000005',
            registration_id: '51000000-0000-4000-8000-000000000006',
        });
        assert.equal(identityConflict.status, 409);
        assert.equal((await identityConflict.json()).code, 'handle_conflict');

        stored.oauthIdentities = { discord: 'discord-subject-510' };
        stored.oauthProvider = 'discord';
        stored.oauthUserId = 'discord-subject-510';
        stored.stcontrolGlobalUserId = 99;
        await storage.setItem(key, stored);
        const boundConflict = await signedPost('/api/stcontrol/internal/users/provision', {
            ...firstRequest,
            operation_id: '51000000-0000-4000-8000-000000000007',
            registration_id: '51000000-0000-4000-8000-000000000008',
        });
        assert.equal(boundConflict.status, 409);
        assert.equal((await boundConflict.json()).code, 'handle_conflict');
    } finally {
        await storage.removeItem(key);
        fs.rmSync(path.join(testRoot, handle), { recursive: true, force: true });
    }
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
    const globalUserUuid = '44444444-4444-4444-8444-444444444444';
    const claimsByCode = new Map([
        [code, { user_uuid: globalUserUuid }],
        ['missing-user-uuid', { user_uuid: undefined }],
        ['typed-user-uuid', { user_uuid: 41 }],
        ['mismatched-user-uuid', { user_uuid: '66666666-6666-4666-8666-666666666666' }],
    ]);
    const consumed = new Set();
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
        if (!claimsByCode.has(request.body.code) || consumed.has(request.body.code)) return response.sendStatus(403);
        consumed.add(request.body.code);
        return response.json({
            ok: true,
            handle: 'alice',
            user_id: 41,
            ...claimsByCode.get(request.body.code),
            session_id: '55555555-5555-4555-8555-555555555555',
            activity_epoch: 8,
            controller_generation: 1,
            lease_confirmed_at: Date.now(),
            lease_expires_at: Date.now() + 15 * 60 * 1000,
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
        const boundUser = await storage.getItem('user:alice');
        assert.equal(boundUser.stcontrolGlobalUserId, 41);
        assert.equal(boundUser.stcontrolGlobalUserUuid, globalUserUuid);

        const replay = await fetch(`${baseUrl}/api/users/me?stcontrol_handoff=user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stcontrol_code: code }),
            redirect: 'manual',
        });
        assert.equal(replay.status, 403);

        for (const rejectedCode of ['missing-user-uuid', 'typed-user-uuid']) {
            const rejected = await fetch(`${baseUrl}/api/users/me?stcontrol_handoff=user`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stcontrol_code: rejectedCode }),
                redirect: 'manual',
            });
            assert.equal(rejected.status, 403);
        }
        const mismatched = await fetch(`${baseUrl}/api/users/me?stcontrol_handoff=user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stcontrol_code: 'mismatched-user-uuid' }),
            redirect: 'manual',
        });
        assert.equal(mismatched.status, 409);
        const stillBoundUser = await storage.getItem('user:alice');
        assert.equal(stillBoundUser.stcontrolGlobalUserId, 41);
        assert.equal(stillBoundUser.stcontrolGlobalUserUuid, globalUserUuid);

        const confirmation = {
            controller_generation: 1,
            confirmed_at: Date.now(),
            leases: [],
        };
        const unsignedConfirmation = await fetch(`${baseUrl}/api/stcontrol/internal/activity-leases/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(confirmation),
        });
        assert.equal(unsignedConfirmation.status, 401);
        const signedConfirmation = await signedPost('/api/stcontrol/internal/activity-leases/confirm', confirmation);
        assert.equal(signedConfirmation.status, 200, await signedConfirmation.text());
        assert.equal(adapter.getStcontrolState().leases.alice, undefined);
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

test('mixed admin/user handoffs clear the opposite marker and retire the prior managed session', async () => {
    const previousAgentUrl = process.env.SILLYTAVERN_STCONTROL_AGENTURL;
    clearSharedSession();
    const user = await storage.getItem('user:alice');
    user.admin = true;
    user.stcontrolPermissionVersion = 5;
    await storage.setItem('user:alice', user);
    const consumed = new Set();
    const agent = express();
    agent.use(express.json());
    agent.post('/agent/tickets/redeem', (request, response) => {
        const timestamp = request.get('X-Timestamp');
        const nonce = request.get('X-Nonce');
        const expected = adapter.signStcontrolRequest(
            'test-agent-psk', 'POST', '/agent/tickets/redeem', timestamp, nonce, request.body,
        );
        if (request.get('X-Signature') !== expected || consumed.has(request.body.code)) return response.sendStatus(403);
        consumed.add(request.body.code);
        return response.json({
            ok: true,
            handle: 'alice',
            user_id: 41,
            user_uuid: '44444444-4444-4444-8444-444444444444',
            session_id: request.body.code === 'handoff-user-1'
                ? '55555555-5555-4555-8555-555555555555'
                : '66666666-6666-4666-8666-666666666666',
            activity_epoch: request.body.code === 'handoff-user-1' ? 8 : 9,
            controller_generation: 1,
            lease_confirmed_at: Date.now(),
            lease_expires_at: Date.now() + 15 * 60 * 1000,
        });
    });
    agent.post('/agent/tickets/redeem-admin', (request, response) => {
        const timestamp = request.get('X-Timestamp');
        const nonce = request.get('X-Nonce');
        const expected = adapter.signStcontrolRequest(
            'test-agent-psk', 'POST', '/agent/tickets/redeem-admin', timestamp, nonce, request.body,
        );
        if (request.get('X-Signature') !== expected || request.body.code !== 'handoff-admin-1' || consumed.has(request.body.code)) {
            return response.sendStatus(403);
        }
        consumed.add(request.body.code);
        return response.json({
            ok: true,
            handle: 'alice',
            admin_id: 9,
            permission_version: 5,
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

        const firstUser = await fetch(`${baseUrl}/api/users/me?stcontrol_handoff=user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stcontrol_code: 'handoff-user-1' }),
            redirect: 'manual',
        });
        assert.equal(firstUser.status, 303);
        const firstSessionId = sharedSession.stcontrol.sessionId;

        const adminLogin = await fetch(`${baseUrl}/api/users/me?stcontrol_handoff=admin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stcontrol_code: 'handoff-admin-1' }),
            redirect: 'manual',
        });
        assert.equal(adminLogin.status, 303);
        assert.equal(sharedSession.stcontrol, undefined);
        assert.deepEqual(sharedSession.stcontrolAdmin, {
            adminId: 9,
            permissionVersion: 5,
            controllerGeneration: 1,
        });
        assert.equal(Boolean(adapter.getStcontrolState().sessions[firstSessionId].loggedOutAt), true);

        const secondUser = await fetch(`${baseUrl}/api/users/me?stcontrol_handoff=user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stcontrol_code: 'handoff-user-2' }),
            redirect: 'manual',
        });
        assert.equal(secondUser.status, 303);
        assert.equal(sharedSession.stcontrolAdmin, undefined);
        assert.deepEqual(sharedSession.stcontrol, {
            sessionId: '66666666-6666-4666-8666-666666666666',
            loginMode: 'managed',
            activityEpoch: 9,
            controllerGeneration: 1,
        });
    } finally {
        await new Promise((resolve, reject) => agentServer.close(error => error ? reject(error) : resolve()));
        if (previousAgentUrl === undefined) delete process.env.SILLYTAVERN_STCONTROL_AGENTURL;
        else process.env.SILLYTAVERN_STCONTROL_AGENTURL = previousAgentUrl;
    }
});

test('password sync accepts exact remove versions and rejects rollback or mixed payloads', async () => {
    const seeded = await storage.getItem('user:alice');
    seeded.password = 'seed-hash';
    seeded.salt = 'seed-salt';
    seeded.stcontrolPasswordVersion = 1;
    await storage.setItem('user:alice', seeded);

    const updated = await signedPost('/api/stcontrol/internal/users/password', {
        operation_id: '77777777-7777-4777-8777-777777777777',
        handle: 'alice',
        password_hash: 'updated-hash',
        password_salt: 'updated-salt',
        version: 2,
    });
    assert.equal(updated.status, 200, await updated.text());

    const removed = await signedPost('/api/stcontrol/internal/users/password', {
        operation_id: '88888888-8888-4888-8888-888888888888',
        handle: 'alice',
        remove: true,
        version: 3,
    });
    assert.equal(removed.status, 200, await removed.text());
    const cleared = await storage.getItem('user:alice');
    assert.equal(cleared.password, '');
    assert.equal(cleared.salt, '');
    assert.equal(cleared.stcontrolPasswordVersion, 3);

    const idempotentRemove = await signedPost('/api/stcontrol/internal/users/password', {
        operation_id: '89898989-8989-4898-8989-898989898989',
        handle: 'alice',
        remove: true,
        version: 3,
    });
    assert.equal(idempotentRemove.status, 200, await idempotentRemove.text());

    const invalidRemove = await signedPost('/api/stcontrol/internal/users/password', {
        operation_id: '99999999-9999-4999-8999-999999999999',
        handle: 'alice',
        remove: true,
        password_hash: 'unexpected',
        version: 4,
    });
    assert.equal(invalidRemove.status, 400);

    const rollback = await signedPost('/api/stcontrol/internal/users/password', {
        operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        handle: 'alice',
        password_hash: 'rollback-hash',
        password_salt: 'rollback-salt',
        version: 3,
    });
    assert.equal(rollback.status, 409);
    assert.equal((await rollback.json()).code, 'password_version_conflict');

    const staleRollback = await signedPost('/api/stcontrol/internal/users/password', {
        operation_id: 'abababab-abab-4bab-8bab-abababababab',
        handle: 'alice',
        password_hash: 'rollback-hash',
        password_salt: 'rollback-salt',
        version: 2,
    });
    assert.equal(staleRollback.status, 409);
    assert.equal((await staleRollback.json()).code, 'password_version_rollback');
});

test('OAuth identity sync upgrades legacy records and fences per-provider drift and rollback', async () => {
    const seeded = await storage.getItem('user:alice');
    seeded.oauthProvider = 'discord';
    seeded.oauthUserId = 'discord-alice';
    delete seeded.oauthIdentities;
    delete seeded.stcontrolOAuthIdentityStates;
    await storage.setItem('user:alice', seeded);

    const addLinuxdo = await signedPost('/api/stcontrol/internal/users/oauth', {
        operation_id: '20202020-2020-4020-8020-202020202020',
        handle: 'alice',
        provider: 'linuxdo',
        subject: 'linuxdo-alice',
        remove: false,
        version: 1,
    });
    assert.equal(addLinuxdo.status, 200, await addLinuxdo.text());
    let updated = await storage.getItem('user:alice');
    assert.deepEqual(updated.oauthIdentities, { discord: 'discord-alice', linuxdo: 'linuxdo-alice' });
    assert.equal(updated.oauthProvider, 'discord', 'the compatible legacy projection remains stable');

    const drift = await signedPost('/api/stcontrol/internal/users/oauth', {
        operation_id: '21212121-2121-4121-8121-212121212121',
        handle: 'alice',
        provider: 'linuxdo',
        subject: 'different-linuxdo-subject',
        remove: false,
        version: 2,
    });
    assert.equal(drift.status, 409);
    assert.equal((await drift.json()).code, 'oauth_identity_subject_conflict');

    const advanceLinuxdo = await signedPost('/api/stcontrol/internal/users/oauth', {
        operation_id: '25252525-2525-4525-8525-252525252525',
        handle: 'alice',
        provider: 'linuxdo',
        subject: 'linuxdo-alice',
        remove: false,
        version: 2,
    });
    assert.equal(advanceLinuxdo.status, 200, await advanceLinuxdo.text());

    const removeDiscordRequest = {
        operation_id: '22222222-2222-4222-8222-222222222222',
        handle: 'alice',
        provider: 'discord',
        subject: 'discord-alice',
        remove: true,
        version: 1,
    };
    const removeDiscord = await signedPost('/api/stcontrol/internal/users/oauth', removeDiscordRequest);
    assert.equal(removeDiscord.status, 200, await removeDiscord.text());
    const repeatRemove = await signedPost('/api/stcontrol/internal/users/oauth', {
        ...removeDiscordRequest,
        operation_id: '23232323-2323-4323-8323-232323232323',
    });
    assert.equal(repeatRemove.status, 200, await repeatRemove.text());
    updated = await storage.getItem('user:alice');
    assert.deepEqual(updated.oauthIdentities, { linuxdo: 'linuxdo-alice' });
    assert.equal(updated.oauthProvider, 'linuxdo');
    assert.equal(updated.oauthUserId, 'linuxdo-alice');

    const staleAdd = await signedPost('/api/stcontrol/internal/users/oauth', {
        operation_id: '24242424-2424-4424-8424-242424242424',
        handle: 'alice',
        provider: 'linuxdo',
        subject: 'linuxdo-alice',
        remove: false,
        version: 1,
    });
    assert.equal(staleAdd.status, 409);
    assert.equal((await staleAdd.json()).code, 'oauth_identity_version_rollback');

    const inventory = await signedPost('/api/stcontrol/internal/users/scan', { cursor: 0, limit: 250 });
    const inventoryText = await inventory.text();
    assert.equal(inventory.status, 200, inventoryText);
    const inventoryUser = JSON.parse(inventoryText).users.find(user => user.handle === 'alice');
    assert.deepEqual(inventoryUser.oauth_identities, [{ provider: 'linuxdo', subject: 'linuxdo-alice' }]);
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
    assert.ok(Number.isSafeInteger(quiesce.expires_at) && quiesce.expires_at > Date.now());

    const wrongRenew = await signedPost('/api/stcontrol/internal/snapshots/renew', {
        ...request,
        freeze_token: 'wrong-renew-token-that-is-long-enough',
    });
    assert.equal(wrongRenew.status, 409);
    assert.equal((await wrongRenew.json()).code, 'snapshot_gate_mismatch');

    const renewResponse = await signedPost('/api/stcontrol/internal/snapshots/renew', {
        ...request,
        freeze_token: quiesce.freeze_token,
    });
    const renewed = await renewResponse.json();
    assert.equal(renewResponse.status, 200);
    assert.ok(renewed.expires_at >= quiesce.expires_at);

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

test('snapshot quiesce timeout releases only its own gate and stale release tokens cannot delete replacements', async () => {
    const previousTimeout = process.env.SILLYTAVERN_STCONTROL_WRITE_DRAIN_TIMEOUT_MS;
    process.env.SILLYTAVERN_STCONTROL_WRITE_DRAIN_TIMEOUT_MS = '120';
    try {
        const statePath = path.join(testRoot, '_stcontrol', 'adapter-state.json');
        const seeded = adapter.getStcontrolState();
        seeded.sessions['abababab-abab-4bab-8bab-abababababab'] = {
            handle: 'alice',
            loginMode: 'managed',
            activityEpoch: 8,
            controllerGeneration: 1,
            lastSeenAt: Date.now(),
            lastPageAt: Date.now(),
            lastRequestAt: Date.now(),
            lastCheckpointAt: Date.now(),
            inFlightReads: 0,
            inFlightWrites: 1,
        };
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(seeded));
        adapter.resetStcontrolStateForTests();

        const request = {
            workflow_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            snapshot_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            handle: 'alice',
            activity_epoch: 8,
        };
        const quiescePromise = signedPost('/api/stcontrol/internal/snapshots/quiesce', request);
        let staleToken = '';
        for (let attempt = 0; attempt < 10 && !staleToken; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 20));
            staleToken = adapter.getUserWriteGate('alice')?.freezeToken || '';
        }
        assert.ok(staleToken.length >= 32);

        const timeoutResponse = await quiescePromise;
        assert.equal(timeoutResponse.status, 409);
        assert.equal((await timeoutResponse.json()).code, 'write_drain_timeout');
        assert.equal(adapter.getUserWriteGate('alice'), null);

        await adapter.setUserWriteGate('alice', {
            kind: 'snapshot',
            workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            snapshotId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            activityEpoch: 8,
            freezeToken: 'replacement-snapshot-freeze-token-with-sufficient-length',
            createdAt: Date.now(),
            expiresAt: Date.now() + 30_000,
        });
        const staleSnapshotRelease = await signedPost('/api/stcontrol/internal/snapshots/release', {
            ...request,
            freeze_token: staleToken,
        });
        assert.equal(staleSnapshotRelease.status, 409);
        assert.deepEqual(adapter.getUserWriteGate('alice'), {
            kind: 'snapshot',
            workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            snapshotId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            activityEpoch: 8,
            freezeToken: 'replacement-snapshot-freeze-token-with-sufficient-length',
            createdAt: adapter.getUserWriteGate('alice').createdAt,
            expiresAt: adapter.getUserWriteGate('alice').expiresAt,
        });

        await adapter.setUserWriteGate('alice', {
            kind: 'data_fault',
            faultId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            globalUserId: 41,
            activityEpoch: 8,
            createdAt: Date.now(),
        });
        const staleAgainstFault = await signedPost('/api/stcontrol/internal/snapshots/release', {
            ...request,
            freeze_token: staleToken,
        });
        assert.equal(staleAgainstFault.status, 409);
        assert.deepEqual(adapter.getUserWriteGate('alice'), {
            kind: 'data_fault',
            faultId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            globalUserId: 41,
            activityEpoch: 8,
            createdAt: adapter.getUserWriteGate('alice').createdAt,
        });
        await adapter.setUserWriteGate('alice', null);
    } finally {
        if (previousTimeout === undefined) delete process.env.SILLYTAVERN_STCONTROL_WRITE_DRAIN_TIMEOUT_MS;
        else process.env.SILLYTAVERN_STCONTROL_WRITE_DRAIN_TIMEOUT_MS = previousTimeout;
    }
});

test('authoritative data fault gate is durable, scoped and idempotent', async () => {
    const statePath = path.join(testRoot, '_stcontrol', 'adapter-state.json');
    const cleanState = adapter.getStcontrolState();
    cleanState.controllerGeneration = 3;
    cleanState.sessions = {};
    cleanState.gates = {
        alice: {
            kind: 'snapshot',
            workflowId: '61616161-6161-4616-8616-616161616161',
            snapshotId: '62626262-6262-4626-8626-626262626262',
            activityEpoch: 8,
            freezeToken: 'expired-snapshot-gate-token-with-sufficient-length',
            createdAt: Date.now() - 60_000,
            expiresAt: Date.now() - 30_000,
        },
    };
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(cleanState));
    adapter.resetStcontrolStateForTests();

    const boundUser = await storage.getItem('user:alice');
    boundUser.stcontrolGlobalUserId = 41;
    await storage.setItem('user:alice', boundUser);
    const request = {
        operation_id: '77777777-7777-4777-8777-777777777777',
        controller_generation: 3,
        fault_id: '88888888-8888-4888-8888-888888888888',
        global_user_id: 41,
        handle: 'alice',
        activity_epoch: 8,
    };
    const staleFreeze = await signedPost('/api/stcontrol/internal/data-faults/freeze', {
        ...request,
        operation_id: '66666666-6666-4666-8666-666666666666',
        controller_generation: 2,
    });
    assert.equal(staleFreeze.status, 409);
    assert.equal((await staleFreeze.json()).code, 'controller_generation_mismatch');

    const firstResponse = await signedPost('/api/stcontrol/internal/data-faults/freeze', request);
    const firstBody = await firstResponse.json();
    assert.equal(firstResponse.status, 200, JSON.stringify(firstBody));
    assert.deepEqual(firstBody, {
        ok: true,
        operation_id: request.operation_id,
        controller_generation: request.controller_generation,
        fault_id: request.fault_id,
        global_user_id: request.global_user_id,
        handle: request.handle,
        activity_epoch: request.activity_epoch,
        frozen: true,
        drained: true,
    });
    assert.deepEqual(adapter.getUserWriteGate('alice'), {
        kind: 'data_fault',
        faultId: request.fault_id,
        globalUserId: 41,
        activityEpoch: 8,
        createdAt: adapter.getUserWriteGate('alice').createdAt,
    });

    const replayResponse = await signedPost('/api/stcontrol/internal/data-faults/freeze', request);
    assert.equal(replayResponse.status, 200, await replayResponse.text());

    const mismatchResponse = await signedPost('/api/stcontrol/internal/data-faults/freeze', {
        ...request,
        operation_id: '99999999-7777-4777-8777-777777777777',
        global_user_id: 42,
    });
    assert.equal(mismatchResponse.status, 409);
    assert.equal((await mismatchResponse.json()).code, 'data_fault_scope_mismatch');

    const epochMismatchResponse = await signedPost('/api/stcontrol/internal/data-faults/freeze', {
        ...request,
        operation_id: 'aaaaaaaa-7777-4777-8777-777777777777',
        activity_epoch: 9,
    });
    assert.equal(epochMismatchResponse.status, 409);
    assert.equal((await epochMismatchResponse.json()).code, 'data_fault_scope_mismatch');

    adapter.resetStcontrolStateForTests();
    assert.equal(adapter.getUserWriteGate('alice').faultId, request.fault_id);
    assert.equal(adapter.getUserWriteGate('alice').globalUserId, 41);

    const snapshotConflict = await signedPost('/api/stcontrol/internal/snapshots/quiesce', {
        workflow_id: '99999999-9999-4999-8999-999999999999',
        snapshot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        handle: 'alice',
        activity_epoch: 8,
    });
    assert.equal(snapshotConflict.status, 409);
    assert.equal(adapter.getUserWriteGate('alice').kind, 'data_fault');

    const releaseRequest = {
        operation_id: '12121212-3434-4567-8abc-121212121212',
        fault_id: request.fault_id,
        global_user_id: 41,
        handle: 'alice',
        activity_epoch: 8,
        controller_generation: 3,
    };
    const staleGeneration = await signedPost('/api/stcontrol/internal/data-faults/release', {
        ...releaseRequest,
        operation_id: '11111111-3434-4567-8abc-121212121212',
        controller_generation: 2,
    });
    assert.equal(staleGeneration.status, 409);
    assert.equal((await staleGeneration.json()).code, 'controller_generation_mismatch');

    const futureGeneration = await signedPost('/api/stcontrol/internal/data-faults/release', {
        ...releaseRequest,
        operation_id: '22222222-3434-4567-8abc-121212121212',
        controller_generation: 4,
    });
    assert.equal(futureGeneration.status, 409);
    assert.equal((await futureGeneration.json()).code, 'controller_generation_mismatch');

    const releaseResponse = await signedPost('/api/stcontrol/internal/data-faults/release', releaseRequest);
    const releasedBody = await releaseResponse.json();
    assert.equal(releaseResponse.status, 200, JSON.stringify(releasedBody));
    assert.deepEqual(releasedBody, {
        ok: true,
        released: true,
        operation_id: releaseRequest.operation_id,
        fault_id: releaseRequest.fault_id,
        global_user_id: releaseRequest.global_user_id,
        handle: releaseRequest.handle,
        activity_epoch: releaseRequest.activity_epoch,
        controller_generation: releaseRequest.controller_generation,
    });
    assert.equal(adapter.getUserWriteGate('alice'), null);

    // A release may race the adapter applying a newer Controller generation.
    // The initial mismatch must not poison the stable operation id: once the
    // exact generation and gate are present, the same request is executable.
    const refreezeResponse = await signedPost('/api/stcontrol/internal/data-faults/freeze', {
        ...request,
        operation_id: 'bbbbbbbb-7777-4777-8777-777777777777',
    });
    assert.equal(refreezeResponse.status, 200, await refreezeResponse.text());
    const currentMode = adapter.getStcontrolState();
    await adapter.applyStcontrolMode({
        mode: currentMode.mode,
        mode_generation: currentMode.modeGeneration,
        controller_generation: 4,
        reason_code: 'test_generation_advance',
    });
    const retriedFutureRelease = await signedPost('/api/stcontrol/internal/data-faults/release', {
        ...releaseRequest,
        operation_id: '22222222-3434-4567-8abc-121212121212',
        controller_generation: 4,
    });
    assert.equal(retriedFutureRelease.status, 200, await retriedFutureRelease.text());
    assert.equal(adapter.getUserWriteGate('alice'), null);

    // General operation replay entries are deliberately bounded; the exact
    // release tombstone must survive their eviction for generation recovery.
    const withoutReleaseOperations = adapter.getStcontrolState();
    assert.equal(withoutReleaseOperations.releasedDataFaults[request.fault_id].globalUserId, 41);
    for (const operationKey of Object.keys(withoutReleaseOperations.operations)) {
        if (operationKey.startsWith('data-fault-release:')) delete withoutReleaseOperations.operations[operationKey];
    }
    fs.writeFileSync(statePath, JSON.stringify(withoutReleaseOperations));
    adapter.resetStcontrolStateForTests();

    const generationFourMode = adapter.getStcontrolState();
    await adapter.applyStcontrolMode({
        mode: generationFourMode.mode,
        mode_generation: generationFourMode.modeGeneration,
        controller_generation: 5,
        reason_code: 'test_release_completion_rollover',
    });
    const recoveredRequest = {
        ...releaseRequest,
        operation_id: '23232323-2323-4323-8323-232323232323',
        controller_generation: 5,
    };
    const recoveredCompletion = await signedPost('/api/stcontrol/internal/data-faults/release', recoveredRequest);
    const recoveredBody = await recoveredCompletion.json();
    assert.equal(recoveredCompletion.status, 200, JSON.stringify(recoveredBody));
    assert.equal(recoveredBody.operation_id, '23232323-2323-4323-8323-232323232323');
    assert.equal(recoveredBody.controller_generation, 5);

    await adapter.setUserWriteGate('alice', {
        kind: 'snapshot',
        workflowId: '13131313-1313-4313-8313-131313131313',
        snapshotId: '14141414-1414-4414-8414-141414141414',
        activityEpoch: 8,
        freezeToken: 'post-release-snapshot-token-with-sufficient-length',
        createdAt: Date.now(),
        expiresAt: Date.now() + 30_000,
    });
    const replayRelease = await signedPost('/api/stcontrol/internal/data-faults/release', recoveredRequest);
    const replayBody = await replayRelease.json();
    assert.equal(replayRelease.status, 200, JSON.stringify(replayBody));
    assert.deepEqual(replayBody, {
        ok: true,
        released: true,
        operation_id: recoveredRequest.operation_id,
        fault_id: recoveredRequest.fault_id,
        global_user_id: recoveredRequest.global_user_id,
        handle: recoveredRequest.handle,
        activity_epoch: recoveredRequest.activity_epoch,
        controller_generation: recoveredRequest.controller_generation,
    });
    assert.equal(adapter.getUserWriteGate('alice').kind, 'snapshot');

    const staleRelease = await signedPost('/api/stcontrol/internal/data-faults/release', {
        ...releaseRequest,
        operation_id: '15151515-1515-4515-8515-151515151515',
        controller_generation: 5,
    });
    assert.equal(staleRelease.status, 409);
    assert.equal((await staleRelease.json()).code, 'data_fault_scope_mismatch');
    assert.equal(adapter.getUserWriteGate('alice').kind, 'snapshot');
    await adapter.setUserWriteGate('alice', null);
});

test('legacy v6 data fault gates only release when the bound global user id matches exactly', async () => {
    const user = await storage.getItem('user:alice');
    user.stcontrolGlobalUserId = 41;
    await storage.setItem('user:alice', user);
    const statePath = path.join(testRoot, '_stcontrol', 'adapter-state.json');
    const seeded = adapter.getStcontrolState();
    seeded.version = 6;
    seeded.controllerGeneration = 5;
    seeded.gates.alice = {
        kind: 'data_fault',
        faultId: '16161616-1616-4616-8616-161616161616',
        activityEpoch: 8,
        createdAt: Date.now(),
    };
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(seeded));
    adapter.resetStcontrolStateForTests();

    assert.equal(adapter.getUserWriteGate('alice').legacyGlobalUserIdMissing, true);

    const wrongRelease = await signedPost('/api/stcontrol/internal/data-faults/release', {
        operation_id: '17171717-1717-4717-8717-171717171717',
        fault_id: '16161616-1616-4616-8616-161616161616',
        global_user_id: 42,
        handle: 'alice',
        activity_epoch: 8,
        controller_generation: 5,
    });
    assert.equal(wrongRelease.status, 409);
    assert.equal((await wrongRelease.json()).code, 'data_fault_scope_mismatch');
    assert.equal(adapter.getUserWriteGate('alice').legacyGlobalUserIdMissing, true);

    const legacyRelease = await signedPost('/api/stcontrol/internal/data-faults/release', {
        operation_id: '18181818-1818-4818-8818-181818181818',
        fault_id: '16161616-1616-4616-8616-161616161616',
        global_user_id: 41,
        handle: 'alice',
        activity_epoch: 8,
        controller_generation: 5,
    });
    const legacyBody = await legacyRelease.json();
    assert.equal(legacyRelease.status, 200, JSON.stringify(legacyBody));
    assert.deepEqual(legacyBody, {
        ok: true,
        released: true,
        operation_id: '18181818-1818-4818-8818-181818181818',
        fault_id: '16161616-1616-4616-8616-161616161616',
        global_user_id: 41,
        handle: 'alice',
        activity_epoch: 8,
        controller_generation: 5,
    });
    assert.equal(adapter.getUserWriteGate('alice'), null);
});
