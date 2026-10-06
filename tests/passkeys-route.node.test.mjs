import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import cookieSession from 'cookie-session';
import storage from 'node-persist';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { keyToEnv, setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-passkeys-'));
const configPath = path.join(testRoot, 'config.yaml');
const config = parseYaml(fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8'));
config.enableUserAccounts = true;
config.passkeys = { enabled: true, rpId: 'example.test', rpName: 'Test', origins: ['https://chat.example.test'] };
fs.writeFileSync(configPath, stringifyYaml(config));
setConfigFilePath(configPath);
globalThis.DATA_ROOT = path.join(testRoot, 'data');
fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });

const { initUserStorage, toKey } = await import('../src/users.js');
const { adminRouter, clearControllerPasskeysCache, publicRouter, router } = await import('../src/endpoints/passkeys.js');
const MAX_PASSKEYS = 10;
const { default: systemMonitor } = await import('../src/system-monitor.js');
await initUserStorage(globalThis.DATA_ROOT);

const app = express();
app.use(express.json());
app.use(cookieSession({ name: 'session', keys: ['test-secret'] }));
app.use((request, _response, next) => {
    const handle = request.get('x-test-user');
    if (handle) request.user = { profile: { handle, admin: request.get('x-test-admin') === '1' } };
    next();
});
app.use('/api/passkeys', publicRouter);
app.use('/api/passkeys/admin', adminRouter);
app.use('/api/passkeys', router);
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const baseUrl = `http://127.0.0.1:${server.address().port}/api/passkeys`;

after(async () => {
    await new Promise(resolve => server.close(resolve));
    systemMonitor.destroy();
    systemMonitor.saveDataToDisk = () => {};
    fs.rmSync(testRoot, { recursive: true, force: true });
});

async function call(route, { body, user, cookie, admin = false } = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}), ...(admin ? { 'x-test-admin': '1' } : {}), ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cookies = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    return { status: response.status, body: await response.json().catch(() => null), cookie: cookies || cookie };
}

test('config and sign-in options are public; a sign-in needs the challenge it was given', async () => {
    const configResponse = await call('/config');
    assert.equal(configResponse.body.enabled, true);
    assert.equal(configResponse.body.rpId, 'example.test');
    assert.equal(configResponse.body.max, MAX_PASSKEYS);
    assert.equal(configResponse.body.loginButtonText, '通行密钥登录');

    const options = await call('/login/options', { body: {} });
    assert.equal(options.status, 200);
    assert.equal(options.body.rpId, 'example.test');
    assert.ok(options.body.challenge);

    const withoutChallenge = await call('/login/verify', { body: { response: { id: 'x', response: { userHandle: 'eA' } } } });
    assert.equal(withoutChallenge.status, 400);
    assert.equal(withoutChallenge.body.code, 'challenge_expired');

    const unknown = await call('/login/verify', { body: { response: { id: 'x', response: { userHandle: Buffer.from('nobody').toString('base64url') } } }, cookie: options.cookie });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'unknown_credential');
});

test('management needs a signed-in user and stops at the limit', async () => {
    assert.equal((await call('/list')).status, 403);
    assert.equal((await call('/register/options', { body: {} })).status, 403);

    await storage.setItem(toKey('alice'), { handle: 'alice', name: 'Alice', enabled: true, passkeys: [] });
    const options = await call('/register/options', { body: {}, user: 'alice' });
    assert.equal(options.status, 200);
    assert.equal(Buffer.from(options.body.user.id, 'base64url').toString(), 'alice');
    assert.equal(options.body.authenticatorSelection.residentKey, 'required');

    const full = Array.from({ length: MAX_PASSKEYS }, (_, i) => ({ id: `id-${i}`, publicKey: 'AA', name: `key ${i}`, createdAt: 1 }));
    await storage.setItem(toKey('alice'), { handle: 'alice', name: 'Alice', enabled: true, passkeys: full });
    const refused = await call('/register/options', { body: {}, user: 'alice' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'limit_reached');
    assert.deepEqual(options.body.excludeCredentials, []);

    const renamed = await call('/rename', { body: { id: 'id-3', name: '  我的手机\u0007 ' }, user: 'alice' });
    assert.equal(renamed.body.passkeys[3].name, '我的手机');
    const removed = await call('/delete', { body: { id: 'id-0' }, user: 'alice' });
    assert.equal(removed.body.passkeys.length, MAX_PASSKEYS - 1);
    assert.equal((await call('/delete', { body: { id: 'missing' }, user: 'alice' })).status, 404);
    assert.equal((await call('/list', { user: 'alice' })).body.passkeys.length, MAX_PASSKEYS - 1);
});

test('administrators tune passkeys and manage what users added', async () => {
    assert.equal((await call('/admin/overview', { user: 'alice' })).status, 403);

    const overview = await call('/admin/overview', { user: 'root', admin: true });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.status.enabled, true);
    assert.equal(overview.body.summary.users, 1);
    assert.equal(overview.body.users[0].handle, 'alice');
    // The failed sign-in from the first test is listed, without the account it merely claimed.
    const [attempt] = overview.body.recentLogins;
    assert.equal(attempt.ok, false);
    assert.equal(attempt.reason, 'unknown_credential');
    assert.equal(attempt.handle, undefined);
    assert.ok(Math.abs(attempt.at - Date.now()) < 60_000);

    const saved = await call('/admin/settings', { user: 'root', admin: true, body: { settings: { ...overview.body.settings, maxPerUser: 3, allowRegistration: false, loginButtonText: '  指纹登录  ', loginPrompt: 'weekly', userVerification: 'bogus' } } });
    assert.equal(saved.body.settings.maxPerUser, 3);
    assert.equal(saved.body.settings.loginButtonText, '指纹登录');
    assert.equal(saved.body.settings.userVerification, 'preferred');
    const publicConfig = (await call('/config')).body;
    assert.equal(publicConfig.max, 3);
    assert.equal(publicConfig.allowRegistration, false);
    assert.equal(publicConfig.loginPrompt, 'weekly');
    assert.equal((await call('/register/options', { body: {}, user: 'alice' })).body.code, 'registration_disabled');

    const removedOne = await call('/admin/delete', { user: 'root', admin: true, body: { handle: 'alice', id: 'id-5' } });
    assert.equal(removedOne.body.passkeys.length, MAX_PASSKEYS - 2);
    const cleared = await call('/admin/delete', { user: 'root', admin: true, body: { handle: 'alice', all: true } });
    assert.equal(cleared.body.passkeys.length, 0);
    assert.equal((await call('/admin/delete', { user: 'root', admin: true, body: { handle: 'alice', all: true } })).status, 404);

    // Switched off: the public side goes quiet, the admin side keeps working.
    await call('/admin/settings', { user: 'root', admin: true, body: { settings: { ...saved.body.settings, enabled: false } } });
    assert.deepEqual((await call('/config')).body, { enabled: false, rpId: null });
    assert.equal((await call('/login/options', { body: {} })).status, 404);
    assert.equal((await call('/list', { user: 'alice' })).status, 404);
    assert.equal((await call('/admin/overview', { user: 'root', admin: true })).body.status.enabled, false);
});

test('a node managed by the Controller sends passkey buttons to the Controller account page', async () => {
    const state = { enabled: true, fail: false, hits: 0 };
    const controller = http.createServer((request, response) => {
        state.hits++;
        if (state.fail || request.url !== '/api/auth/passkey/config') {
            response.writeHead(500).end();
            return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ enabled: state.enabled, login_enabled: state.enabled }));
    });
    await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
    const controllerUrl = `http://127.0.0.1:${controller.address().port}`;
    process.env[keyToEnv('stcontrol.enabled')] = 'true';
    process.env[keyToEnv('stcontrol.controllerUrl')] = `${controllerUrl}/`;
    clearControllerPasskeysCache();
    try {
        const managed = await call('/config');
        assert.deepEqual(managed.body, { enabled: false, rpId: null, managedBy: { enabled: true, url: `${controllerUrl}/account#passkeys` } });
        await call('/config');
        assert.equal(state.hits, 1, 'the Controller answer is cached');
        // The tavern's own passkey sign-in stays off on a managed node.
        assert.equal((await call('/login/options', { body: {} })).status, 404);

        state.enabled = false;
        clearControllerPasskeysCache();
        assert.deepEqual((await call('/config')).body, { enabled: false, rpId: null });

        state.fail = true;
        clearControllerPasskeysCache();
        assert.deepEqual((await call('/config')).body, { enabled: false, rpId: null }, 'an unreachable Controller hides the buttons');
    } finally {
        delete process.env[keyToEnv('stcontrol.enabled')];
        delete process.env[keyToEnv('stcontrol.controllerUrl')];
        clearControllerPasskeysCache();
        await new Promise(resolve => controller.close(resolve));
    }
});
