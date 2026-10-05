import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import cookieSession from 'cookie-session';
import storage from 'node-persist';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { setConfigFilePath } from '../src/util.js';

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
const { publicRouter, router, MAX_PASSKEYS } = await import('../src/endpoints/passkeys.js');
const { default: systemMonitor } = await import('../src/system-monitor.js');
await initUserStorage(globalThis.DATA_ROOT);

const app = express();
app.use(express.json());
app.use(cookieSession({ name: 'session', keys: ['test-secret'] }));
app.use((request, _response, next) => {
    const handle = request.get('x-test-user');
    if (handle) request.user = { profile: { handle } };
    next();
});
app.use('/api/passkeys', publicRouter);
app.use('/api/passkeys', router);
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const baseUrl = `http://127.0.0.1:${server.address().port}/api/passkeys`;

after(async () => {
    await new Promise(resolve => server.close(resolve));
    systemMonitor.destroy();
    systemMonitor.saveDataToDisk = () => {};
    fs.rmSync(testRoot, { recursive: true, force: true });
});

async function call(route, { body, user, cookie } = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}), ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cookies = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    return { status: response.status, body: await response.json().catch(() => null), cookie: cookies || cookie };
}

test('config and sign-in options are public; a sign-in needs the challenge it was given', async () => {
    const configResponse = await call('/config');
    assert.deepEqual(configResponse.body, { enabled: true, rpId: 'example.test', max: MAX_PASSKEYS });

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
