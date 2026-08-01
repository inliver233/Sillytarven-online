import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import express from 'express';
import storage from 'node-persist';

import {
    getRegistrationConfig,
    getRegistrationMethodConfig,
    isInvitationCodeSystemEnabled,
    resolveRegistrationConfig,
} from '../src/registration-policy.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-registration-policy-'));
const configPath = path.join(testRoot, 'config.yaml');
globalThis.DATA_ROOT = testRoot;

let baseUrl;
let server;
let systemMonitor;
let handleOAuthLogin;
let invitationCodes;
const sharedSession = {};

async function clearStorage() {
    const keys = await storage.keys();
    await Promise.all(keys.map(key => storage.removeItem(key)));
    for (const key of Object.keys(sharedSession)) {
        delete sharedSession[key];
    }
}

function createRedirectResponse() {
    return {
        location: null,
        redirect(location) {
            this.location = location;
            return location;
        },
    };
}

before(async () => {
    fs.writeFileSync(configPath, [
        'enableUserAccounts: true',
        'enableInvitationCodes: false',
        'registration:',
        '  password:',
        '    enabled: false',
        '    requireInvitationCode: false',
        '  github:',
        '    enabled: false',
        '    requireInvitationCode: null',
        '  discord:',
        '    enabled: true',
        '    requireInvitationCode: true',
        '  linuxdo:',
        '    enabled: true',
        '    requireInvitationCode: false',
        'oauth:',
        '  github:',
        '    enabled: true',
        '    clientId: test-client',
        '    clientSecret: test-secret',
        '    callbackUrl: http://localhost/api/oauth/github/callback',
        '  discord:',
        '    enabled: false',
        '  linuxdo:',
        '    enabled: false',
        'email:',
        '  enabled: false',
        'userStorage:',
        '  enabled: false',
        '',
    ].join('\n'));

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(configPath);
    await storage.init({
        dir: path.join(testRoot, '_storage'),
        ttl: false,
        expiredInterval: 0,
    });

    const [usersPublic, oauth, invitationModule, monitorModule] = await Promise.all([
        import('../src/endpoints/users-public.js'),
        import('../src/endpoints/oauth.js'),
        import('../src/invitation-codes.js'),
        import('../src/system-monitor.js'),
    ]);
    handleOAuthLogin = oauth.handleOAuthLogin;
    invitationCodes = invitationModule;
    systemMonitor = monitorModule.default;

    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.session = sharedSession;
        next();
    });
    app.use('/api/users', usersPublic.router);
    app.use('/api/oauth', oauth.router);
    server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(clearStorage);

after(async () => {
    if (server) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    systemMonitor?.destroy();
    if (typeof storage.stop === 'function') {
        storage.stop();
    }
    process.once('exit', () => fs.rmSync(testRoot, { recursive: true, force: true }));
});

test('missing registration settings preserve legacy defaults', () => {
    const disabledGlobal = resolveRegistrationConfig({}, false);
    const enabledGlobal = resolveRegistrationConfig({}, true);

    for (const method of ['password', 'github', 'discord', 'linuxdo']) {
        assert.deepEqual(disabledGlobal[method], {
            enabled: true,
            requireInvitationCode: false,
        });
        assert.deepEqual(enabledGlobal[method], {
            enabled: true,
            requireInvitationCode: true,
        });
    }
});

test('method settings independently override enabled and invitation requirements', () => {
    const config = resolveRegistrationConfig({
        password: { enabled: false, requireInvitationCode: false },
        github: { enabled: 'false', requireInvitationCode: 'true' },
        discord: { requireInvitationCode: null },
        linuxdo: { enabled: 'invalid', requireInvitationCode: 'invalid' },
    }, true);

    assert.deepEqual(config.password, { enabled: false, requireInvitationCode: false });
    assert.deepEqual(config.github, { enabled: false, requireInvitationCode: true });
    assert.deepEqual(config.discord, { enabled: true, requireInvitationCode: true });
    assert.deepEqual(config.linuxdo, { enabled: true, requireInvitationCode: true });
    assert.deepEqual(getRegistrationMethodConfig('github', config), config.github);
    assert.throws(() => getRegistrationMethodConfig('unknown', config), /Unsupported registration method/);
});

test('invitation storage stays enabled for any method-specific requirement', () => {
    const noRequirements = resolveRegistrationConfig({
        password: { requireInvitationCode: false },
        github: { requireInvitationCode: false },
        discord: { requireInvitationCode: false },
        linuxdo: { requireInvitationCode: false },
    }, false);
    const oneRequirement = {
        ...noRequirements,
        discord: { ...noRequirements.discord, requireInvitationCode: true },
    };

    assert.equal(isInvitationCodeSystemEnabled(noRequirements, false), false);
    assert.equal(isInvitationCodeSystemEnabled(oneRequirement, false), true);
    assert.equal(isInvitationCodeSystemEnabled(noRequirements, true), true);
});

test('public config exposes effective policies and password registration is rejected server-side', async () => {
    assert.deepEqual(getRegistrationConfig(), {
        password: { enabled: false, requireInvitationCode: false },
        github: { enabled: false, requireInvitationCode: false },
        discord: { enabled: true, requireInvitationCode: true },
        linuxdo: { enabled: true, requireInvitationCode: false },
    });

    const configResponse = await fetch(`${baseUrl}/api/users/registration-config`);
    assert.equal(configResponse.status, 200);
    assert.deepEqual(await configResponse.json(), getRegistrationConfig());

    const registerResponse = await fetch(`${baseUrl}/api/users/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
    });
    assert.equal(registerResponse.status, 403);
    assert.match((await registerResponse.json()).error, /未开放/);
    assert.equal((await storage.keys()).some(key => key.startsWith('user:')), false);
});

test('OAuth registration intent is blocked while the login entry remains available', async () => {
    const oauthConfigResponse = await fetch(`${baseUrl}/api/oauth/config`);
    const oauthConfig = await oauthConfigResponse.json();
    assert.deepEqual(oauthConfig.github, {
        enabled: true,
        registrationEnabled: false,
        requireInvitationCode: false,
    });

    const registrationResponse = await fetch(`${baseUrl}/api/oauth/github?intent=register`, {
        redirect: 'manual',
    });
    assert.equal(registrationResponse.status, 403);

    const loginResponse = await fetch(`${baseUrl}/api/oauth/github`, {
        redirect: 'manual',
    });
    assert.equal(loginResponse.status, 302);
    assert.match(loginResponse.headers.get('location') || '', /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
});

test('disabled OAuth registration rejects new identities but still logs in bound users', async () => {
    const newSession = {};
    const rejectedResponse = createRedirectResponse();
    await handleOAuthLogin(
        { session: newSession },
        rejectedResponse,
        'github',
        { id: 42, login: 'new-github-user' },
    );
    assert.match(decodeURIComponent(rejectedResponse.location), /新用户注册当前未开放/);
    assert.equal(await storage.getItem('user:new-github-user'), undefined);
    assert.equal(newSession.authenticated, undefined);

    await storage.setItem('user:bound-github-user', {
        handle: 'bound-github-user',
        name: 'Bound User',
        created: Date.now(),
        enabled: true,
        password: null,
        salt: null,
        oauthProvider: 'github',
        oauthUserId: 'github_42',
    });
    const loginSession = {};
    const loginResponse = createRedirectResponse();
    await handleOAuthLogin(
        { session: loginSession },
        loginResponse,
        'github',
        { id: 42, login: 'renamed-at-provider' },
    );
    assert.equal(loginResponse.location, '/');
    assert.equal(loginSession.handle, 'bound-github-user');
    assert.equal(loginSession.authenticated, true);
});

test('a method-specific invitation requirement works while the legacy global switch is off', async () => {
    assert.equal(invitationCodes.isInvitationCodesEnabled(), true);
    assert.deepEqual(await invitationCodes.validateInvitationCode('', { required: false }), { valid: true });
    const invitation = await invitationCodes.createInvitationCode('admin', 'permanent');

    const oauthSession = {};
    const oauthResponse = createRedirectResponse();
    await handleOAuthLogin(
        { session: oauthSession },
        oauthResponse,
        'discord',
        { id: 7, username: 'discord-new-user' },
        'register',
    );
    assert.equal(oauthResponse.location, '/login?oauth_pending=true');
    assert.equal(oauthSession.oauthPendingUser.provider, 'discord');
    assert.equal(await storage.getItem('user:discord-new-user'), undefined);

    Object.assign(sharedSession, oauthSession);
    const completionResponse = await fetch(`${baseUrl}/api/oauth/verify-invitation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ invitationCode: invitation.code }),
    });
    assert.equal(completionResponse.status, 200);
    assert.equal((await completionResponse.json()).handle, 'discord-new-user');
    assert.equal((await storage.getItem('user:discord-new-user')).oauthProvider, 'discord');
    assert.equal((await storage.getItem(`invitation:${invitation.code}`)).used, true);
});
