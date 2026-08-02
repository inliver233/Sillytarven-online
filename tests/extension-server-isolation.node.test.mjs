/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
    createExtensionResourceRouteHandler,
    EXTENSION_TYPES,
    ExtensionResolutionError,
    getCanonicalExtensionIdentity,
    isThirdPartyExtensionPath,
    resolveExtensionResource,
    resolveTypedExtension,
} from '../src/endpoints/extensions.js';

async function createFixture() {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-extension-isolation-'));
    const publicRoot = path.join(root, 'public');
    const globalRoot = path.join(publicRoot, 'scripts', 'extensions', 'third-party');
    const userARoot = path.join(root, 'user-a');
    const userBRoot = path.join(root, 'user-b');
    const builtinRoot = path.join(root, 'builtin');
    await Promise.all([globalRoot, userARoot, userBRoot, builtinRoot]
        .map(directory => fs.promises.mkdir(directory, { recursive: true })));
    return { root, publicRoot, globalRoot, userARoot, userBRoot, builtinRoot };
}

async function startResourceServer(fixture, { enabled = true } = {}) {
    const app = express();
    app.use((request, _response, next) => {
        const isUserA = request.headers.cookie?.includes('user=A');
        request.user = { directories: { extensions: isUserA ? fixture.userARoot : fixture.userBRoot } };
        next();
    });
    app.use('/scripts/extensions/third-party/*', createExtensionResourceRouteHandler(
        request => request.user.directories.extensions,
        () => fixture.globalRoot,
        { enabled },
    ));
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function startProductionResourceServer(fixture, { enabled = true } = {}) {
    const app = express();
    app.use((request, _response, next) => {
        if (request.headers.authorization === 'Bearer authenticated') {
            request.user = { directories: { extensions: fixture.userARoot } };
        }
        next();
    });

    const publicStaticMiddleware = express.static(fixture.publicRoot);
    app.use((request, response, next) => {
        if (isThirdPartyExtensionPath(request.path)) {
            return next();
        }
        return publicStaticMiddleware(request, response, next);
    });
    app.use((request, response, next) => request.user ? next() : response.sendStatus(401));
    app.use('/scripts/extensions/third-party/*', createExtensionResourceRouteHandler(
        request => request.user.directories.extensions,
        () => fixture.globalRoot,
        { enabled },
    ));

    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server) {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('production static ordering cannot bypass auth or extension enablement and preserves local shadowing', async () => {
    const fixture = await createFixture();
    const globalExtension = path.join(fixture.globalRoot, 'shared');
    const localExtension = path.join(fixture.userARoot, 'shared');
    await fs.promises.mkdir(globalExtension, { recursive: true });
    await fs.promises.mkdir(localExtension, { recursive: true });
    await fs.promises.writeFile(path.join(globalExtension, 'index.js'), 'global-secret');
    await fs.promises.writeFile(path.join(localExtension, 'index.js'), 'local-shadow');

    assert.equal(isThirdPartyExtensionPath('/scripts/extensions/third-party/shared/index.js'), true);
    assert.equal(isThirdPartyExtensionPath('/scripts/extensions/%74hird-party/shared/index.js'), true);
    assert.equal(isThirdPartyExtensionPath('/scripts/extensions/public/../third-party/shared/index.js'), true);
    assert.equal(isThirdPartyExtensionPath('/scripts/extensions/third-party/bad%'), true);
    assert.equal(isThirdPartyExtensionPath('/scripts/extensions/builtin/index.js'), false);

    const enabledServer = await startProductionResourceServer(fixture);
    try {
        const resourceUrl = `${enabledServer.baseUrl}/scripts/extensions/third-party/shared/index.js`;
        for (const unauthenticatedPath of [
            '/scripts/extensions/third-party/shared/index.js',
            '/scripts/extensions/%74hird-party/shared/index.js',
        ]) {
            const unauthenticated = await fetch(`${enabledServer.baseUrl}${unauthenticatedPath}`);
            assert.equal(unauthenticated.status, 401, unauthenticatedPath);
            assert.doesNotMatch(await unauthenticated.text(), /global-secret/u);
        }

        const authenticated = await fetch(resourceUrl, {
            headers: { authorization: 'Bearer authenticated' },
        });
        assert.equal(authenticated.status, 200);
        assert.equal(await authenticated.text(), 'local-shadow');
    } finally {
        await closeServer(enabledServer.server);
    }

    const disabledServer = await startProductionResourceServer(fixture, { enabled: false });
    try {
        const disabled = await fetch(`${disabledServer.baseUrl}/scripts/extensions/third-party/shared/index.js`, {
            headers: { authorization: 'Bearer authenticated' },
        });
        assert.equal(disabled.status, 404);
        assert.doesNotMatch(await disabled.text(), /global-secret|local-shadow/u);
    } finally {
        await closeServer(disabledServer.server);
        await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }

    const serverMainSource = fs.readFileSync(new URL('../src/server-main.js', import.meta.url), 'utf8');
    const staticBypass = serverMainSource.indexOf('if (isThirdPartyExtensionPath(request.path))');
    const staticDispatch = serverMainSource.indexOf('return publicStaticMiddleware(request, response, next);', staticBypass);
    const loginGuard = serverMainSource.indexOf('app.use(requireLoginMiddleware);');
    const privateRoutes = serverMainSource.indexOf('setupPrivateEndpoints(app);');
    assert.ok(staticBypass >= 0 && staticBypass < staticDispatch);
    assert.ok(staticDispatch < loginGuard && loginGuard < privateRoutes);
    assert.doesNotMatch(serverMainSource, /app\.use\(express\.static\(publicDirectory/u);
});

test('disabled third-party resource route cannot serve executable extension code', async () => {
    const fixture = await createFixture();
    const extensionRoot = path.join(fixture.userARoot, 'disabled');
    await fs.promises.mkdir(extensionRoot);
    await fs.promises.writeFile(path.join(extensionRoot, 'index.js'), 'globalThis.extensionExecuted = true;');
    const { server, baseUrl } = await startResourceServer(fixture, { enabled: false });
    try {
        const response = await fetch(`${baseUrl}/scripts/extensions/third-party/disabled/index.js`, {
            headers: { cookie: 'user=A' },
        });
        assert.equal(response.status, 404);
        assert.doesNotMatch(await response.text(), /extensionExecuted/u);
    } finally {
        await closeServer(server);
        await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
});

test('canonical identities and typed resolution preserve exact local/global ownership', async () => {
    const fixture = await createFixture();
    try {
        await fs.promises.mkdir(path.join(fixture.userARoot, 'shared'));
        await fs.promises.mkdir(path.join(fixture.userARoot, 'Café'));
        await fs.promises.mkdir(path.join(fixture.globalRoot, 'shared'));
        await fs.promises.mkdir(path.join(fixture.builtinRoot, 'vectors'));

        assert.deepEqual(getCanonicalExtensionIdentity('shared', EXTENSION_TYPES.LOCAL), {
            canonicalName: 'third-party/shared', shortName: 'shared', type: 'local',
        });
        assert.deepEqual(getCanonicalExtensionIdentity('third-party/shared', EXTENSION_TYPES.GLOBAL), {
            canonicalName: 'third-party/shared', shortName: 'shared', type: 'global',
        });
        assert.deepEqual(getCanonicalExtensionIdentity('/shared', EXTENSION_TYPES.LOCAL), {
            canonicalName: 'third-party/shared', shortName: 'shared', type: 'local',
        });
        assert.deepEqual(getCanonicalExtensionIdentity('vectors', EXTENSION_TYPES.BUILTIN), {
            canonicalName: 'vectors', shortName: 'vectors', type: 'builtin',
        });

        const local = resolveTypedExtension({
            extensionName: 'third-party/shared', type: 'local', localRoot: fixture.userARoot,
            globalRoot: fixture.globalRoot, builtinRoot: fixture.builtinRoot,
        });
        const global = resolveTypedExtension({
            extensionName: 'shared', type: 'global', localRoot: fixture.userARoot,
            globalRoot: fixture.globalRoot, builtinRoot: fixture.builtinRoot,
        });
        assert.equal(local.extensionPath, path.resolve(fixture.userARoot, 'shared'));
        assert.equal(global.extensionPath, path.resolve(fixture.globalRoot, 'shared'));
        const accentEquivalent = resolveTypedExtension({
            extensionName: 'cafe', type: 'local', localRoot: fixture.userARoot,
            globalRoot: fixture.globalRoot, builtinRoot: fixture.builtinRoot,
        });
        assert.equal(accentEquivalent.canonicalName, 'third-party/Café');
        assert.equal(accentEquivalent.extensionPath, path.resolve(fixture.userARoot, 'Café'));

        await fs.promises.mkdir(path.join(fixture.globalRoot, 'global-only'));
        assert.throws(() => resolveTypedExtension({
            extensionName: 'global-only', type: 'local', localRoot: fixture.userARoot,
            globalRoot: fixture.globalRoot, builtinRoot: fixture.builtinRoot,
        }), error => error instanceof ExtensionResolutionError && error.status === 404);

        assert.throws(() => getCanonicalExtensionIdentity('/vectors', EXTENSION_TYPES.BUILTIN), ExtensionResolutionError);
        for (const invalidName of ['../shared', 'third-party/../shared', 'file://shared', 'shared\\nested', ' shared', '//shared']) {
            assert.throws(() => getCanonicalExtensionIdentity(invalidName, EXTENSION_TYPES.LOCAL), ExtensionResolutionError);
        }
    } finally {
        await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
});

test('per-user resource routes isolate the same URL and never fall through after local root selection', async () => {
    const fixture = await createFixture();
    await fs.promises.mkdir(path.join(fixture.userARoot, 'Shared'), { recursive: true });
    await fs.promises.mkdir(path.join(fixture.userARoot, 'Café'), { recursive: true });
    await fs.promises.mkdir(path.join(fixture.globalRoot, 'shared'), { recursive: true });
    await fs.promises.mkdir(path.join(fixture.globalRoot, 'cafe'), { recursive: true });
    await fs.promises.writeFile(path.join(fixture.userARoot, 'Shared', 'index.js'), 'local-a');
    await fs.promises.writeFile(path.join(fixture.userARoot, 'Café', 'accent.js'), 'local-accent');
    await fs.promises.writeFile(path.join(fixture.globalRoot, 'shared', 'index.js'), 'global');
    await fs.promises.writeFile(path.join(fixture.globalRoot, 'cafe', 'accent.js'), 'global-accent');
    await fs.promises.writeFile(path.join(fixture.globalRoot, 'shared', 'global-only.js'), 'must-not-fallback');
    const { server, baseUrl } = await startResourceServer(fixture);
    try {
        const url = `${baseUrl}/scripts/extensions/third-party/shared/index.js`;
        const userA = await fetch(url, { headers: { cookie: 'user=A' } });
        const userB = await fetch(url, { headers: { cookie: 'user=B' } });
        assert.equal(userA.status, 200);
        assert.equal(await userA.text(), 'local-a');
        assert.equal(userB.status, 200);
        assert.equal(await userB.text(), 'global');

        for (const response of [userA, userB]) {
            assert.equal(response.headers.get('vary'), 'Cookie');
            assert.equal(response.headers.get('cache-control'), 'private, no-cache, must-revalidate');
            assert.match(response.headers.get('content-type'), /javascript/iu);
        }

        const accentUrl = `${baseUrl}/scripts/extensions/third-party/cafe/accent.js`;
        const accentForA = await fetch(accentUrl, { headers: { cookie: 'user=A' } });
        const accentForB = await fetch(accentUrl, { headers: { cookie: 'user=B' } });
        assert.equal(accentForA.status, 200);
        assert.equal(await accentForA.text(), 'local-accent');
        assert.equal(accentForB.status, 200);
        assert.equal(await accentForB.text(), 'global-accent');

        const missingLocal = await fetch(`${baseUrl}/scripts/extensions/third-party/shared/global-only.js`, {
            headers: { cookie: 'user=A' },
        });
        assert.equal(missingLocal.status, 404);
        assert.equal(missingLocal.headers.get('vary'), 'Cookie');
        assert.equal(missingLocal.headers.get('cache-control'), 'private, no-cache, must-revalidate');

        const globalForB = await fetch(`${baseUrl}/scripts/extensions/third-party/shared/global-only.js`, {
            headers: { cookie: 'user=B' },
        });
        assert.equal(globalForB.status, 200);
        assert.equal(await globalForB.text(), 'must-not-fallback');

        const malformedEncoding = await fetch(`${baseUrl}/scripts/extensions/third-party/shared/bad%25`, {
            headers: { cookie: 'user=A' },
        });
        assert.equal(malformedEncoding.status, 400);
        assert.equal(malformedEncoding.headers.get('vary'), 'Cookie');
        assert.equal(malformedEncoding.headers.get('cache-control'), 'private, no-cache, must-revalidate');

        const preloadHead = await fetch(url, { method: 'HEAD', headers: { cookie: 'user=A' } });
        assert.equal(preloadHead.status, 200);
        assert.equal(await preloadHead.text(), '');
        assert.equal(preloadHead.headers.get('cache-control'), 'private, no-cache, must-revalidate');
    } finally {
        await closeServer(server);
        await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
});

test('resource resolution rejects traversal and symlinked files without global fallback', async () => {
    const fixture = await createFixture();
    try {
        const localExtension = path.join(fixture.userARoot, 'secure');
        const globalExtension = path.join(fixture.globalRoot, 'secure');
        await fs.promises.mkdir(localExtension);
        await fs.promises.mkdir(globalExtension);
        await fs.promises.writeFile(path.join(fixture.root, 'outside.js'), 'outside');
        await fs.promises.writeFile(path.join(globalExtension, 'linked.js'), 'global-fallback');
        await fs.promises.symlink(path.join(fixture.root, 'outside.js'), path.join(localExtension, 'linked.js'), 'file');

        assert.throws(() => resolveExtensionResource({
            localRoot: fixture.userARoot,
            globalRoot: fixture.globalRoot,
            resourcePath: 'secure/../outside.js',
        }), error => error instanceof ExtensionResolutionError && error.status === 403);
        assert.throws(() => resolveExtensionResource({
            localRoot: fixture.userARoot,
            globalRoot: fixture.globalRoot,
            resourcePath: 'secure/linked.js',
        }), error => error instanceof ExtensionResolutionError && error.status === 403);

        const { server, baseUrl } = await startResourceServer(fixture);
        try {
            const response = await fetch(`${baseUrl}/scripts/extensions/third-party/secure/linked.js`, {
                headers: { cookie: 'user=A' },
            });
            assert.equal(response.status, 403);
            assert.equal(response.headers.get('cache-control'), 'private, no-cache, must-revalidate');
        } finally {
            await closeServer(server);
        }
    } finally {
        await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
});
