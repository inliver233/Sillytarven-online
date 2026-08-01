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
import {
    evaluateDiscordGuildMembership,
    fetchDiscordGuildMembershipEligibility,
    getDiscordGuildMembershipConfig,
} from '../src/discord-registration-policy.js';

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
        '    guildMembership:',
        '      enabled: true',
        '      guildId: "123456789012345678"',
        '      guildName: "类脑"',
        '      minimumDays: 14',
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
        '    enabled: true',
        '    clientId: discord-test-client',
        '    clientSecret: discord-test-secret',
        '    callbackUrl: http://localhost/api/oauth/discord/callback',
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

test('Discord guild membership uses joined_at and reports remaining days', () => {
    const config = {
        enabled: true,
        guildId: '123456789012345678',
        guildName: '类脑',
        minimumDays: 14,
    };
    const now = Date.parse('2026-08-01T00:00:00.000Z');
    const tooNew = evaluateDiscordGuildMembership(
        { joined_at: '2026-07-21T12:00:00.000Z' },
        config,
        now,
    );
    assert.equal(tooNew.eligible, false);
    assert.equal(tooNew.reason, 'membership_too_new');
    assert.equal(tooNew.membershipDays, 10);
    assert.equal(tooNew.remainingDays, 4);
    assert.match(tooNew.message, /类脑.*10 天.*4 天/);

    const eligible = evaluateDiscordGuildMembership(
        { joined_at: '2026-07-18T00:00:00.000Z' },
        config,
        now,
    );
    assert.equal(eligible.eligible, true);
    assert.equal(eligible.membershipDays, 14);
    assert.equal(eligible.remainingDays, 0);

    const unavailable = evaluateDiscordGuildMembership({ joined_at: null }, config, now);
    assert.equal(unavailable.reason, 'joined_at_unavailable');
});

test('Discord membership fetch handles membership and authorization errors without exposing tokens', async () => {
    const config = {
        enabled: true,
        guildId: '123456789012345678',
        guildName: '类脑',
        minimumDays: 14,
    };
    const now = Date.parse('2026-08-01T00:00:00.000Z');
    let requestedUrl;
    let authorization;
    const eligible = await fetchDiscordGuildMembershipEligibility('secret-token', config, async (url, options) => {
        requestedUrl = url;
        authorization = options.headers.Authorization;
        return {
            ok: true,
            status: 200,
            json: async () => ({ joined_at: '2026-01-01T00:00:00.000Z' }),
        };
    }, now);
    assert.equal(eligible.eligible, true);
    assert.match(requestedUrl, /\/users\/@me\/guilds\/123456789012345678\/member$/);
    assert.equal(authorization, 'Bearer secret-token');

    const notMember = await fetchDiscordGuildMembershipEligibility('token', config, async () => ({
        ok: false,
        status: 404,
    }), now);
    assert.equal(notMember.reason, 'not_a_member');
    assert.match(notMember.message, /先加入.*类脑.*14 天/);

    const unauthorized = await fetchDiscordGuildMembershipEligibility('token', config, async () => ({
        ok: false,
        status: 403,
    }), now);
    assert.equal(unauthorized.reason, 'authorization_failed');
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

test('Discord registration requests guild membership scope without changing normal login scope', async () => {
    assert.deepEqual(getDiscordGuildMembershipConfig(), {
        enabled: true,
        guildId: '123456789012345678',
        guildName: '类脑',
        minimumDays: 14,
    });

    const configResponse = await fetch(`${baseUrl}/api/oauth/config`);
    const discordConfig = (await configResponse.json()).discord;
    assert.deepEqual(discordConfig.guildMembership, {
        enabled: true,
        guildName: '类脑',
        minimumDays: 14,
    });

    const registrationResponse = await fetch(`${baseUrl}/api/oauth/discord?intent=register`, {
        redirect: 'manual',
    });
    const registrationLocation = new URL(registrationResponse.headers.get('location'));
    assert.equal(registrationResponse.status, 302);
    assert.match(registrationLocation.searchParams.get('scope'), /guilds\.members\.read/);

    const loginResponse = await fetch(`${baseUrl}/api/oauth/discord`, { redirect: 'manual' });
    const loginLocation = new URL(loginResponse.headers.get('location'));
    assert.equal(loginResponse.status, 302);
    assert.doesNotMatch(loginLocation.searchParams.get('scope'), /guilds\.members\.read/);
});

test('Discord guild rule blocks unverified new users but not already-bound logins', async () => {
    const newUserResponse = createRedirectResponse();
    await handleOAuthLogin(
        { session: {} },
        newUserResponse,
        'discord',
        { id: 88, username: 'too-new-discord-user' },
        'register',
        {
            discordGuildMembership: {
                eligible: false,
                reason: 'membership_too_new',
                message: '您加入 Discord 服务器“类脑”已 3 天，还需 11 天才能注册',
            },
        },
    );
    assert.match(decodeURIComponent(newUserResponse.location), /已 3 天.*还需 11 天/);
    assert.equal(await storage.getItem('user:too-new-discord-user'), undefined);

    await storage.setItem('user:bound-discord-user', {
        handle: 'bound-discord-user',
        name: 'Bound Discord User',
        created: Date.now(),
        enabled: true,
        password: null,
        salt: null,
        oauthProvider: 'discord',
        oauthUserId: 'discord_88',
    });
    const loginSession = {};
    const loginResponse = createRedirectResponse();
    await handleOAuthLogin(
        { session: loginSession },
        loginResponse,
        'discord',
        { id: 88, username: 'bound-discord-user' },
    );
    assert.equal(loginResponse.location, '/');
    assert.equal(loginSession.handle, 'bound-discord-user');
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
        {
            discordGuildMembership: {
                eligible: true,
                reason: 'eligible',
            },
        },
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
