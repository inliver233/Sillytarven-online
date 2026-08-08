import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import storage from 'node-persist';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-disaster-login-'));
globalThis.DATA_ROOT = root;
const parentClaim = 'a'.repeat(64);
let adapter;
let baseUrl;
let appServer;
let agentServer;
let systemMonitor;
let agentResolveCalls = 0;
let agentTakeoverCalls = 0;
let takeoverCommitted = false;
const session = {};

before(async () => {
    agentServer = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const timestamp = request.headers['x-timestamp'];
        const nonce = request.headers['x-nonce'];
        const signature = request.headers['x-signature'];
        assert.equal(request.headers['x-agent-id'], '7');
        assert.equal(signature, adapter.signStcontrolRequest(
            'test-agent-psk', 'POST', request.url, timestamp, nonce, body,
        ));
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/agent/activity-ownership/v1/resolve') {
            agentResolveCalls += 1;
            response.end(JSON.stringify(takeoverCommitted ? {
                ok: true, decision: 'automatic', claim_id: 'b'.repeat(64), reason_code: 'last_active_owner',
            } : {
                ok: true, decision: 'takeover_required', claim_id: parentClaim, reason_code: 'last_active_owner_unavailable',
            }));
            return;
        }
        if (request.url === '/agent/activity-ownership/v1/takeover') {
            agentTakeoverCalls += 1;
            assert.equal(body.handle, 'alice');
            assert.equal(body.parent_claim_id, parentClaim);
            assert.match(body.operation_id, /^[0-9a-f-]{36}$/i);
            takeoverCommitted = true;
            response.end(JSON.stringify({
                ok: true, decision: 'takeover_committed', claim_id: 'b'.repeat(64),
                reason_code: 'user_confirmed_last_owner_failure',
            }));
            return;
        }
        response.statusCode = 404;
        response.end('{}');
    });
    await new Promise((resolve, reject) => {
        agentServer.listen(0, '127.0.0.1', resolve);
        agentServer.once('error', reject);
    });
    const agentAddress = agentServer.address();
    process.env.SILLYTAVERN_STCONTROL_AGENTURL = `http://127.0.0.1:${agentAddress.port}`;

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(fileURLToPath(new URL('./fixtures/stcontrol-config.yaml', import.meta.url)));
    await storage.init({ dir: path.join(root, '_storage'), ttl: false, expiredInterval: 0 });
    adapter = await import('../src/stcontrol.js');
    const { getPasswordHash, toKey } = await import('../src/users.js');
    const salt = 'disaster-login-salt';
    await storage.setItem(toKey('alice'), {
        id: 'alice', handle: 'alice', name: 'Alice', enabled: true, admin: false,
        salt, password: getPasswordHash('correct-password', salt),
        created: Date.now(),
    });
    await adapter.applyStcontrolMode({
        mode: adapter.STCONTROL_MODES.INDEPENDENT,
        mode_generation: 2,
        controller_generation: 1,
        reason_code: 'sustained_peer_confirmed_controller_loss',
    });

    const usersPublic = await import('../src/endpoints/users-public.js');
    systemMonitor = (await import('../src/system-monitor.js')).default;
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.session = session;
        next();
    });
    app.use('/api/users', usersPublic.router);
    appServer = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    const address = appServer.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    if (appServer) await new Promise((resolve, reject) => appServer.close(error => error ? reject(error) : resolve()));
    if (agentServer) await new Promise((resolve, reject) => agentServer.close(error => error ? reject(error) : resolve()));
    systemMonitor?.destroy();
    if (typeof storage.stop === 'function') storage.stop();
    delete process.env.SILLYTAVERN_STCONTROL_AGENTURL;
    process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
});

async function login(body) {
    const response = await fetch(`${baseUrl}/api/users/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: 'alice', ...body }),
    });
    return { response, body: await response.json() };
}

test('disaster takeover verifies password, requires explicit risk confirmation, and opens only after Agent quorum', async () => {
    const wrongPassword = await login({ password: 'wrong-password' });
    assert.equal(wrongPassword.response.status, 403);
    assert.equal(agentResolveCalls, 0, 'ownership was queried before identity verification');

    const first = await login({ password: 'correct-password' });
    assert.equal(first.response.status, 423);
    assert.equal(first.body.code, 'last_active_node_unavailable_confirmation_required');
    assert.match(first.body.takeover_challenge, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(agentResolveCalls, 1);
    assert.equal(agentTakeoverCalls, 0);
    const persisted = fs.readFileSync(path.join(root, '_stcontrol', 'adapter-state.json'), 'utf8');
    assert.equal(persisted.includes(first.body.takeover_challenge), false, 'plaintext takeover challenge was persisted');

    const invalid = await login({
        password: 'correct-password',
        stcontrol_takeover_confirm: true,
        stcontrol_takeover_challenge: 'invalid-confirmation-token-that-is-long-enough',
    });
    assert.equal(invalid.response.status, 423);
    assert.equal(invalid.body.code, 'takeover_challenge_invalid');
    assert.equal(agentTakeoverCalls, 0);

    const confirmed = await login({
        password: 'correct-password',
        stcontrol_takeover_confirm: true,
        stcontrol_takeover_challenge: first.body.takeover_challenge,
    });
    assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.handle, 'alice');
    assert.equal(agentTakeoverCalls, 1);
    assert.equal(takeoverCommitted, true);
    const state = adapter.getStcontrolState();
    assert.equal(Object.keys(state.takeoverChallenges).length, 0);
    assert.equal(Object.values(state.sessions).some(item => item.handle === 'alice' &&
        item.loginMode === adapter.STCONTROL_MODES.INDEPENDENT), true);

    takeoverCommitted = false;
    const replay = await login({
        password: 'correct-password',
        stcontrol_takeover_confirm: true,
        stcontrol_takeover_challenge: first.body.takeover_challenge,
    });
    assert.equal(replay.response.status, 423);
    assert.equal(replay.body.code, 'takeover_challenge_invalid');
    assert.equal(agentTakeoverCalls, 1, 'consumed challenge reached Agent takeover twice');
});
