/* eslint-disable playwright/expect-expect, playwright/no-conditional-in-test -- Node tests use assert and controlled failure branches. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createExtensionsRouter, sanitizeExtensionUrlForLog } from '../src/endpoints/extensions.js';

test('extension URL logging keeps only a bounded origin', () => {
    const logged = sanitizeExtensionUrlForLog('https://user:secret@example.com:8443/private/repo.git?token=secret#fragment');
    assert.equal(logged, 'https://example.com:8443');
    assert.doesNotMatch(logged, /user|secret|private|repo|token|fragment/u);
    assert.ok(logged.length <= 256);
    assert.equal(sanitizeExtensionUrlForLog('not a URL'), '[invalid extension URL]');
});

async function createFixture() {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-extension-management-'));
    const userRoot = path.join(root, 'user');
    const localRoot = path.join(userRoot, 'extensions');
    const globalRoot = path.join(root, 'global');
    const builtinRoot = path.join(root, 'builtin');
    const stagingRoot = path.join(root, 'staging');
    await Promise.all([localRoot, globalRoot, builtinRoot, stagingRoot]
        .map(directory => fs.promises.mkdir(directory, { recursive: true })));
    return { root, userRoot, localRoot, globalRoot, builtinRoot, stagingRoot };
}

async function startManagementServer(fixture, { admin = true, ...dependencies } = {}) {
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = {
            profile: { handle: admin ? 'admin' : 'member', admin },
            directories: { root: fixture.userRoot, extensions: fixture.localRoot },
        };
        next();
    });
    app.use('/api/extensions', createExtensionsRouter({
        globalRoot: fixture.globalRoot,
        builtinRoot: fixture.builtinRoot,
        ...dependencies,
        enabled: dependencies.enabled ?? true,
        stagingRoot: dependencies.stagingRoot ?? fixture.stagingRoot,
        canConsumeStorage: dependencies.canConsumeStorage ?? (async () => ({ allowed: true })),
        dnsLookup: dependencies.dnsLookup ?? (async () => [{ address: '93.184.216.34', family: 4 }]),
    }));
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function post(baseUrl, endpoint, body) {
    return await fetch(`${baseUrl}/api/extensions/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function closeServer(server) {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function isInside(parentPath, childPath) {
    const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function listTransactionDirectories(stagingRoot) {
    if (!fs.existsSync(stagingRoot)) return [];
    const transactions = [];
    for (const namespace of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
        if (!namespace.isDirectory()) continue;
        const namespacePath = path.join(stagingRoot, namespace.name);
        for (const entry of fs.readdirSync(namespacePath, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name.startsWith('tx-')) {
                transactions.push(path.join(namespacePath, entry.name));
            }
        }
    }
    return transactions;
}

test('disabled extension routes consistently return not found without side effects', async () => {
    const fixture = await createFixture();
    let cloneCalls = 0;
    const createGit = () => ({
        async clone() { cloneCalls += 1; },
    });
    const { server, baseUrl } = await startManagementServer(fixture, { enabled: false, createGit });
    try {
        const discover = await fetch(`${baseUrl}/api/extensions/discover`);
        assert.equal(discover.status, 404);

        const managementRequests = [
            ['install', { url: 'https://example.com/private.git' }],
            ['update', { extensionName: 'private', global: false }],
            ['branches', { extensionName: 'private', global: false }],
            ['switch', { extensionName: 'private', branch: 'main', global: false }],
            ['move', { extensionName: 'private', source: 'local', destination: 'global' }],
            ['version', { extensionName: 'private', global: false }],
            ['delete', { extensionName: 'private', global: false }],
        ];
        for (const [endpoint, body] of managementRequests) {
            const response = await post(baseUrl, endpoint, body);
            assert.equal(response.status, 404, endpoint);
        }
        assert.equal(cloneCalls, 0);
    } finally {
        await closeServer(server);
        await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
});

test('install blocks literal and DNS-resolved private targets before clone', async () => {
    const fixture = await createFixture();
    let cloneCalls = 0;
    let cloneOptions;
    let gitOptions;
    const createGit = (options) => {
        gitOptions = options;
        return {
            async clone(_url, destination, options) {
                cloneCalls += 1;
                cloneOptions = options;
                await fs.promises.mkdir(destination, { recursive: true });
                await fs.promises.writeFile(path.join(destination, 'manifest.json'), '{}');
            },
        };
    };
    const dnsLookup = async (hostname) => {
        if (hostname === 'private.example') {
            return [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.20', family: 4 }];
        }
        return [{ address: '93.184.216.34', family: 4 }];
    };
    const { server, baseUrl } = await startManagementServer(fixture, { createGit, dnsLookup });
    try {
        const blockedUrls = [
            'http://localhost/extension.git',
            'http://127.0.0.1/extension.git',
            'http://10.0.0.1/extension.git',
            'http://172.16.0.1/extension.git',
            'http://192.168.0.1/extension.git',
            'http://169.254.169.254/extension.git',
            'http://[::1]/extension.git',
            'http://[fc00::1]/extension.git',
            'http://[fe80::1]/extension.git',
            'http://private.example/extension.git',
            'http://metadata.google.internal/extension.git',
        ];
        for (const url of blockedUrls) {
            const response = await post(baseUrl, 'install', { url });
            assert.equal(response.status, 400, url);
        }
        assert.equal(cloneCalls, 0);

        const publicInstall = await post(baseUrl, 'install', { url: 'https://public.example/public.git' });
        assert.equal(publicInstall.status, 200);
        assert.equal(cloneCalls, 1);
        assert.deepEqual(gitOptions.config, [
            'http.followRedirects=false',
            'http.curloptResolve=public.example:443:93.184.216.34',
        ]);
        assert.deepEqual(cloneOptions, { '--depth': 1 });
    } finally {
        await closeServer(server);
        await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
});

test('install pins one validated IPv6 address on the only clone path while preserving the HTTPS URL', async () => {
    const fixture = await createFixture();
    const gitFactoryCalls = [];
    const cloneCalls = [];
    const createGit = (options) => {
        gitFactoryCalls.push(options);
        return {
            async clone(url, destination, cloneOptions) {
                cloneCalls.push({ url, destination, cloneOptions });
                await fs.promises.mkdir(destination, { recursive: true });
                await fs.promises.writeFile(path.join(destination, 'manifest.json'), '{}');
            },
        };
    };
    const dnsLookup = async () => [
        { address: '2606:4700:4700::1111', family: 6 },
        { address: '93.184.216.34', family: 4 },
    ];
    const { server, baseUrl } = await startManagementServer(fixture, { createGit, dnsLookup });
    try {
        const repositoryUrl = 'https://git.example.:8443/owner/pinned.git';
        const response = await post(baseUrl, 'install', { url: repositoryUrl });
        assert.equal(response.status, 200);
        assert.equal(gitFactoryCalls.length, 1);
        assert.deepEqual(gitFactoryCalls[0].config, [
            'http.followRedirects=false',
            'http.curloptResolve=git.example.:8443:[2606:4700:4700::1111]',
        ]);
        assert.equal(cloneCalls.length, 1);
        assert.equal(cloneCalls[0].url, repositoryUrl);
        assert.deepEqual(cloneCalls[0].cloneOptions, { '--depth': 1 });
        assert.equal(cloneCalls[0].url.includes('2606:4700:4700::1111'), false);
    } finally {
        await closeServer(server);
        await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
});

test('management rejects built-ins, invalid names and sources, and non-admin global access', async () => {
    const fixture = await createFixture();
    await fs.promises.mkdir(path.join(fixture.builtinRoot, 'vectors'));
    await fs.promises.mkdir(path.join(fixture.globalRoot, 'shared'));
    const adminServer = await startManagementServer(fixture);
    try {
        const builtin = await post(adminServer.baseUrl, 'version', { extensionName: 'vectors', type: 'builtin' });
        assert.equal(builtin.status, 400);
        assert.match(await builtin.text(), /cannot be managed/iu);

        const traversalCases = [
            ['update', { extensionName: '../shared', global: false }],
            ['version', { extensionName: 'third-party/../shared', global: false }],
            ['branches', { extensionName: 'file://shared', global: false }],
            ['switch', { extensionName: 'shared\\nested', branch: 'main', global: false }],
            ['delete', { extensionName: '..', global: false }],
        ];
        for (const [endpoint, body] of traversalCases) {
            const response = await post(adminServer.baseUrl, endpoint, body);
            assert.equal(response.status, 400, endpoint);
        }

        const invalidSource = await post(adminServer.baseUrl, 'move', {
            extensionName: 'shared', source: 'builtin', destination: 'local',
        });
        assert.equal(invalidSource.status, 400);
        const protocolSource = await post(adminServer.baseUrl, 'install', { url: 'file:///tmp/extension.git' });
        assert.equal(protocolSource.status, 400);
    } finally {
        await closeServer(adminServer.server);
    }

    const memberServer = await startManagementServer(fixture, { admin: false });
    try {
        for (const endpoint of ['update', 'version', 'branches', 'switch', 'delete']) {
            const body = { extensionName: 'shared', global: true };
            if (endpoint === 'switch') body.branch = 'main';
            const response = await post(memberServer.baseUrl, endpoint, body);
            assert.equal(response.status, 403, endpoint);
        }
    } finally {
        await closeServer(memberServer.server);
        await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
});

test('legacy leading-slash extension names resolve through version and update routes', async () => {
    const fixture = await createFixture();
    const extensionPath = path.join(fixture.localRoot, 'foo');
    await fs.promises.mkdir(extensionPath);
    const commitHash = '1234567890abcdef';
    const createGit = () => ({
        async branch() { return { current: 'main' }; },
        async checkIsRepo() { return true; },
        async fetch() {},
        async getRemotes() { return []; },
        async log() { return { total: 0 }; },
        async pull() {},
        async revparse() { return commitHash; },
    });
    const { server, baseUrl } = await startManagementServer(fixture, { createGit });
    try {
        const version = await post(baseUrl, 'version', { extensionName: '/foo', global: false });
        assert.equal(version.status, 200);
        assert.equal((await version.json()).currentCommitHash, commitHash);

        const update = await post(baseUrl, 'update', { extensionName: '/foo', global: false });
        assert.equal(update.status, 200);
        const updateBody = await update.json();
        assert.equal(updateBody.shortCommitHash, commitHash.slice(0, 7));
        assert.equal(updateBody.extensionPath, path.resolve(extensionPath));
    } finally {
        await closeServer(server);
        await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
});

test('normalized install and move destination collisions are rejected before mutation', async () => {
    const fixture = await createFixture();
    const localExtension = path.join(fixture.localRoot, 'Café');
    const globalExtension = path.join(fixture.globalRoot, 'cafe');
    await fs.promises.mkdir(localExtension);
    await fs.promises.mkdir(globalExtension);
    let cloneCalls = 0;
    const createGit = () => ({
        async clone() { cloneCalls += 1; },
    });
    const { server, baseUrl } = await startManagementServer(fixture, { createGit });
    try {
        const install = await post(baseUrl, 'install', { url: 'https://example.com/cafe.git' });
        assert.equal(install.status, 409);
        assert.equal(cloneCalls, 0);

        const move = await post(baseUrl, 'move', {
            extensionName: '/cafe', source: 'local', destination: 'global',
        });
        assert.equal(move.status, 409);
        assert.equal(fs.existsSync(localExtension), true);
        assert.equal(fs.existsSync(globalExtension), true);
    } finally {
        await closeServer(server);
        await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
});

test('incomplete and invalid clones return failure and clean the target directory', async () => {
    const fixture = await createFixture();
    let cloneCalls = 0;
    const createGit = () => ({
        async clone(_url, destination) {
            cloneCalls += 1;
            await fs.promises.mkdir(destination, { recursive: true });
            if (cloneCalls === 1) {
                await fs.promises.writeFile(path.join(destination, 'partial.txt'), 'partial');
                throw new Error('injected clone failure');
            }
            await fs.promises.writeFile(path.join(destination, 'manifest.json'), '[]');
        },
    });
    const { server, baseUrl } = await startManagementServer(fixture, { createGit });
    try {
        const cloneFailure = await post(baseUrl, 'install', { url: 'https://example.com/partial.git' });
        assert.equal(cloneFailure.status, 500);
        assert.equal(fs.existsSync(path.join(fixture.localRoot, 'partial')), false);

        const invalidManifest = await post(baseUrl, 'install', { url: 'https://example.com/invalid.git' });
        assert.equal(invalidManifest.status, 500);
        assert.equal(fs.existsSync(path.join(fixture.localRoot, 'invalid')), false);
        assert.equal(cloneCalls, 2);

        const malformedUrl = await post(baseUrl, 'install', { url: 'not a URL' });
        assert.equal(malformedUrl.status, 400);
        assert.equal(cloneCalls, 2);
    } finally {
        await closeServer(server);
        await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
});

test('delete reports committed success when transaction cleanup is retried', async () => {
    const fixture = await createFixture();
    const extensionPath = path.join(fixture.localRoot, 'undeletable');
    await fs.promises.mkdir(extensionPath);
    await fs.promises.writeFile(path.join(extensionPath, 'manifest.json'), '{}');
    let cleanupCalls = 0;
    const removeDirectory = async (target, options) => {
        cleanupCalls += 1;
        if (cleanupCalls === 1) {
            throw Object.assign(new Error('injected cleanup failure'), { code: 'EACCES' });
        }
        await fs.promises.rm(target, options);
    };
    const { server, baseUrl } = await startManagementServer(fixture, { removeDirectory });
    try {
        const response = await post(baseUrl, 'delete', { extensionName: 'undeletable', global: false });
        assert.equal(response.status, 200);
        assert.equal(fs.existsSync(extensionPath), false);
        assert.equal(listTransactionDirectories(fixture.stagingRoot).length, 1);

        const recovery = await fetch(`${baseUrl}/api/extensions/discover`);
        assert.equal(recovery.status, 200);
        assert.equal(listTransactionDirectories(fixture.stagingRoot).length, 0);
    } finally {
        await closeServer(server);
        await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
});

test('move source publication failure rolls back the copied destination and returns failure', async () => {
    const fixture = await createFixture();
    const sourcePath = path.join(fixture.localRoot, 'moveme');
    const destinationPath = path.join(fixture.globalRoot, 'moveme');
    await fs.promises.mkdir(sourcePath);
    await fs.promises.writeFile(path.join(sourcePath, 'manifest.json'), '{}');
    const transactionHook = async (phase, transaction) => {
        if (phase === 'before-backup' && transaction.manifest.operation === 'move-source') {
            throw Object.assign(new Error('injected source publication failure'), { code: 'EACCES' });
        }
    };
    const { server, baseUrl } = await startManagementServer(fixture, { transactionHook });
    try {
        const response = await post(baseUrl, 'move', {
            extensionName: 'moveme', source: 'local', destination: 'global',
        });
        assert.equal(response.status, 500);
        assert.equal(fs.existsSync(sourcePath), true);
        assert.equal(fs.existsSync(destinationPath), false);
        assert.equal(listTransactionDirectories(fixture.stagingRoot).length, 0);
    } finally {
        await closeServer(server);
        await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
});
