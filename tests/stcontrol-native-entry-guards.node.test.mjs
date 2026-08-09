import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-stcontrol-native-guards-'));
globalThis.DATA_ROOT = root;

let adapter;
let users;
let routers;
let systemMonitor;

before(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(fileURLToPath(new URL('./fixtures/stcontrol-config.yaml', import.meta.url)));
    adapter = await import('../src/stcontrol.js');
    users = await import('../src/users.js');
    systemMonitor = (await import('../src/system-monitor.js')).default;
    const [publicUsers, privateUsers, adminUsers, oauth] = await Promise.all([
        import('../src/endpoints/users-public.js'),
        import('../src/endpoints/users-private.js'),
        import('../src/endpoints/users-admin.js'),
        import('../src/endpoints/oauth.js'),
    ]);
    routers = { publicUsers, privateUsers, adminUsers, oauth };
});

after(() => {
    adapter?.resetStcontrolStateForTests();
    systemMonitor?.destroy();
    process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
});

async function invokeGuard(guard, routePath, method = 'POST') {
    let nextCalled = false;
    let statusCode = 200;
    let payload;
    const request = { path: routePath, method };
    const response = {
        status(value) {
            statusCode = value;
            return this;
        },
        json(value) {
            payload = value;
            return this;
        },
    };
    await guard(request, response, () => {
        nextCalled = true;
    });
    return { nextCalled, statusCode, payload, request };
}

function actualRoutes(router) {
    return router.stack
        .filter(layer => layer.route)
        .flatMap(layer => Object.keys(layer.route.methods).map(method => ({
            path: layer.route.path,
            method: method.toUpperCase(),
        })));
}

test('every native account router installs its stcontrol guard before actual routes', () => {
    const matrix = [
        [routers.publicUsers.router, adapter.stcontrolPublicAccountGuard],
        [routers.privateUsers.router, adapter.stcontrolPrivateAccountGuard],
        [routers.adminUsers.router, adapter.stcontrolAdminAccountGuard],
        [routers.oauth.router, adapter.stcontrolOAuthGuard],
    ];
    for (const [router, guard] of matrix) {
        assert.equal(router.stack[0].handle, guard);
        assert.ok(actualRoutes(router).length > 0);
    }
});

test('managed mode classifies every actual native account route without an identity bypass', async () => {
    const safePublicPaths = new Set(['/list', '/logout', '/heartbeat', '/registration-config', '/me']);
    for (const route of actualRoutes(routers.publicUsers.router)) {
        const result = await invokeGuard(adapter.stcontrolPublicAccountGuard, route.path, route.method);
        const shouldPass = safePublicPaths.has(route.path);
        assert.equal(result.nextCalled, shouldPass, `public ${route.method} ${route.path}`);
        if (!shouldPass) assert.equal(result.statusCode, 423, `public ${route.method} ${route.path}`);
    }

    for (const route of actualRoutes(routers.oauth.router)) {
        const result = await invokeGuard(adapter.stcontrolOAuthGuard, route.path, route.method);
        assert.equal(result.nextCalled, route.path === '/config', `oauth ${route.method} ${route.path}`);
        if (route.path !== '/config') {
            assert.equal(result.statusCode, 423, `oauth ${route.method} ${route.path}`);
            assert.equal(result.payload.code, 'managed_oauth_required');
        }
    }

    for (const route of actualRoutes(routers.privateUsers.router)) {
        const result = await invokeGuard(adapter.stcontrolPrivateAccountGuard, route.path, route.method);
        const shouldPass = route.path === '/logout' || ['GET', 'HEAD', 'OPTIONS'].includes(route.method);
        assert.equal(result.nextCalled, shouldPass, `private ${route.method} ${route.path}`);
        if (!shouldPass) {
            assert.equal(result.statusCode, 423, `private ${route.method} ${route.path}`);
            assert.equal(result.payload.code, 'managed_account_mutation');
        }
    }

    const safeAdminPosts = new Set(['/get', '/storage-size', '/slugify']);
    for (const route of actualRoutes(routers.adminUsers.router)) {
        const result = await invokeGuard(adapter.stcontrolAdminAccountGuard, route.path, route.method);
        const shouldPass = ['GET', 'HEAD', 'OPTIONS'].includes(route.method) || safeAdminPosts.has(route.path);
        assert.equal(result.nextCalled, shouldPass, `admin ${route.method} ${route.path}`);
        if (!shouldPass) {
            assert.equal(result.statusCode, 423, `admin ${route.method} ${route.path}`);
            assert.equal(result.payload.code, 'managed_administrator_mutation');
        }
    }
});

test('only independent mode exposes the explicit native login and all other identity entry points stay closed', async () => {
    let result = await invokeGuard(adapter.stcontrolPublicAccountGuard, '/login');
    assert.equal(result.nextCalled, false);
    assert.equal(result.payload.code, 'managed_login_required');

    await adapter.applyStcontrolMode({
        mode: adapter.STCONTROL_MODES.UNREACHABLE,
        mode_generation: 2,
        controller_generation: 1,
        reason_code: 'heartbeat_lost',
    });
    result = await invokeGuard(adapter.stcontrolPublicAccountGuard, '/login');
    assert.equal(result.nextCalled, false);
    assert.equal(result.payload.code, 'controller_unavailable');

    await adapter.applyStcontrolMode({
        mode: adapter.STCONTROL_MODES.INDEPENDENT,
        mode_generation: 3,
        controller_generation: 1,
        reason_code: 'outage_confirmed',
    });
    result = await invokeGuard(adapter.stcontrolPublicAccountGuard, '/login');
    assert.equal(result.nextCalled, true);
    assert.equal(result.request.stcontrolIndependentLogin, true);

    for (const [guard, routePath, method] of [
        [adapter.stcontrolPublicAccountGuard, '/register', 'GET'],
        [adapter.stcontrolPublicAccountGuard, '/register', 'POST'],
        [adapter.stcontrolPublicAccountGuard, '/recover-step1', 'POST'],
        [adapter.stcontrolOAuthGuard, '/github', 'GET'],
        [adapter.stcontrolOAuthGuard, '/linuxdo/callback', 'GET'],
        [adapter.stcontrolPrivateAccountGuard, '/change-password', 'POST'],
        [adapter.stcontrolPrivateAccountGuard, '/reset-step2', 'POST'],
        [adapter.stcontrolAdminAccountGuard, '/create', 'POST'],
        [adapter.stcontrolAdminAccountGuard, '/delete', 'POST'],
    ]) {
        const blocked = await invokeGuard(guard, routePath, method);
        assert.equal(blocked.nextCalled, false, `${method} ${routePath}`);
        assert.equal(blocked.statusCode, 423, `${method} ${routePath}`);
    }

    await adapter.applyStcontrolMode({
        mode: adapter.STCONTROL_MODES.DRAINING,
        mode_generation: 4,
        controller_generation: 2,
        reason_code: 'controller_recovered',
    });
    result = await invokeGuard(adapter.stcontrolPublicAccountGuard, '/login');
    assert.equal(result.nextCalled, false);
    assert.equal(result.payload.code, 'controller_unavailable');
});

test('stcontrol disables every implicit auto-login path even during an independently confirmed outage', async () => {
    const requests = [
        { session: {}, query: {}, headers: {}, get: () => undefined },
        {
            session: {},
            query: {},
            headers: { authorization: `Basic ${Buffer.from('alice:password').toString('base64')}` },
            get(name) { return this.headers[String(name).toLowerCase()]; },
        },
        {
            session: {},
            query: {},
            headers: { 'remote-user': 'alice', 'x-authentik-username': 'alice' },
            get(name) { return this.headers[String(name).toLowerCase()]; },
        },
    ];
    for (const request of requests) {
        assert.equal(await users.tryAutoLogin(request, true), false);
        assert.deepEqual(request.session, {});
    }
});

test('browser-facing login, register and LinuxDo compatibility callback use the same guards', () => {
    const source = fs.readFileSync(new URL('../src/server-main.js', import.meta.url), 'utf8');
    assert.match(source, /app\.get\('\/login', stcontrolPublicAccountGuard,/);
    assert.match(source, /app\.get\('\/register', stcontrolPublicAccountGuard,/);
    assert.match(source, /app\.get\('\/oauth', stcontrolOAuthGuard,/);
});
