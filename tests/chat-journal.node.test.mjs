/* eslint-disable playwright/expect-expect, playwright/no-conditional-in-test -- Node test runner uses assert and platform guards. */
/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { hashCanonicalJson, sha256 } from '../src/canonical-hash.js';
import {
    createDurableChatTransaction,
    ensureDurableChatRecovery,
    getChatJournalNamespace,
    recoverDurableChatTransactions,
    resetDurableChatRecoveryForTests,
} from '../src/chat-journal.js';
import { setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-chat-journal-'));
const dataRoot = path.join(testRoot, 'data');
const configPath = path.join(testRoot, 'config.yaml');
const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const childPath = fileURLToPath(new URL('./fixtures/chat-journal-crash-child.mjs', import.meta.url));
const conversionChildPath = fileURLToPath(new URL('./fixtures/chat-conversion-crash-child.mjs', import.meta.url));
const conversionConfigPath = path.join(testRoot, 'conversion-config.yaml');
const config = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
config.performance.chatChunkingEnabled = false;
fs.writeFileSync(configPath, stringifyYaml(config));
const conversionConfig = structuredClone(config);
conversionConfig.performance.chatChunkingEnabled = true;
conversionConfig.performance.chatChunkSize = 2;
fs.writeFileSync(conversionConfigPath, stringifyYaml(conversionConfig));
setConfigFilePath(configPath);
globalThis.DATA_ROOT = dataRoot;

function createUser(handle) {
    const root = path.join(dataRoot, handle);
    const directories = {
        root,
        groupChats: path.join(root, 'group chats'),
        backups: path.join(root, 'backups'),
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
    };
    for (const directory of Object.values(directories)) {
        fs.mkdirSync(directory, { recursive: true });
    }
    return { handle, directories };
}

const users = {
    a: createUser('journal-user-a'),
    b: createUser('journal-user-b'),
};

function writeFivePartChat(user, id, marker) {
    const filePath = path.join(user.directories.groupChats, `${id}.jsonl`);
    const header = {
        user_name: 'unused',
        character_name: 'unused',
        chat_metadata: { marker, message_count: 1 },
    };
    const message = { name: 'User', is_user: true, send_date: 1, mes: marker };
    const chunkDirectory = `${filePath}.chunks`;
    fs.mkdirSync(chunkDirectory, { recursive: true });
    const artifacts = [
        filePath,
        `${filePath}.metadata.json`,
        `${filePath}.index.json`,
        `${filePath}.revision.json`,
        path.join(chunkDirectory, '000000.jsonl'),
    ];
    fs.writeFileSync(filePath, `${JSON.stringify(header)}\n${JSON.stringify(message)}`);
    fs.writeFileSync(artifacts[1], JSON.stringify(header));
    fs.writeFileSync(artifacts[2], JSON.stringify({ version: 1, marker }));
    fs.writeFileSync(artifacts[3], JSON.stringify({ version: 1, revision: marker }));
    fs.writeFileSync(artifacts[4], JSON.stringify(message));
    return {
        id,
        filePath,
        header,
        message,
        artifacts,
        bytes: Object.fromEntries(artifacts.map(artifact => [artifact, fs.readFileSync(artifact)])),
    };
}

function runCrash(mode, user, fixture, replacement) {
    const result = spawnSync(process.execPath, [
        childPath,
        mode,
        user.directories.root,
        user.handle,
        fixture.filePath,
        JSON.stringify(fixture.artifacts),
        replacement,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
}

function resignManifest(manifestPath, mutate) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest.digest;
    mutate(manifest);
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, digest: hashCanonicalJson(manifest) }));
}

function injectPartialCleanupFailure(namespace) {
    const originalRmSync = fs.rmSync;
    let injected = false;
    fs.rmSync = function (targetPath, options) {
        const absolute = path.resolve(String(targetPath));
        if (!injected && path.dirname(absolute) === path.resolve(namespace)
            && /^cleanup-[a-f0-9]{32}$/.test(path.basename(absolute))) {
            injected = true;
            originalRmSync(path.join(absolute, 'manifest.json'), { force: true });
            originalRmSync(path.join(absolute, 'snapshot'), { recursive: true, force: true });
            throw Object.assign(new Error('injected partial cleanup failure'), { code: 'EIO' });
        }
        return originalRmSync.call(this, targetPath, options);
    };
    return () => { fs.rmSync = originalRmSync; };
}

function injectCleanupDeletionFailures(namespace, count, partial = false) {
    const originalRmSync = fs.rmSync;
    let failuresRemaining = count;
    fs.rmSync = function (targetPath, options) {
        const absolute = path.resolve(String(targetPath));
        if (failuresRemaining > 0 && path.dirname(absolute) === path.resolve(namespace)
            && /^cleanup-[a-f0-9]{32}$/.test(path.basename(absolute))) {
            if (partial && failuresRemaining === count) {
                originalRmSync(path.join(absolute, 'manifest.json'), { force: true });
                originalRmSync(path.join(absolute, 'snapshot'), { recursive: true, force: true });
            }
            failuresRemaining--;
            throw Object.assign(new Error('injected transient cleanup deletion failure'), { code: 'EIO' });
        }
        return originalRmSync.call(this, targetPath, options);
    };
    return () => { fs.rmSync = originalRmSync; };
}

function injectFsyncObserver(observer) {
    const originalOpenSync = fs.openSync;
    const originalFsyncSync = fs.fsyncSync;
    const descriptorPaths = new Map();
    fs.openSync = function (...args) {
        const descriptor = originalOpenSync.apply(this, args);
        descriptorPaths.set(descriptor, path.resolve(String(args[0])));
        return descriptor;
    };
    fs.fsyncSync = function (descriptor) {
        observer(descriptorPaths.get(descriptor));
        return originalFsyncSync.call(this, descriptor);
    };
    return () => {
        fs.openSync = originalOpenSync;
        fs.fsyncSync = originalFsyncSync;
    };
}

const { router: chatsRouter } = await import('../src/endpoints/chats.js');
const { default: systemMonitor } = await import('../src/system-monitor.js');
const app = express();
app.use(express.json());
app.use((request, _response, next) => {
    const user = request.get('x-test-user') === 'b' ? users.b : users.a;
    request.user = {
        profile: { handle: user.handle, name: user.handle, admin: true },
        directories: user.directories,
    };
    next();
});
app.use('/api/chats', chatsRouter);
const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
});
const address = server.address();
assert.ok(address && typeof address !== 'string');

async function getGroup(userKey, id) {
    return await fetch(`http://127.0.0.1:${address.port}/api/chats/group/get`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': userKey },
        body: JSON.stringify({ id }),
    });
}

after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    systemMonitor.destroy();
    systemMonitor.saveDataToDisk = () => {};
    fs.rmSync(testRoot, { recursive: true, force: true });
});

test('creation rejects targets and artifacts outside the exact user root', () => {
    const outside = path.join(testRoot, 'outside.jsonl');
    fs.writeFileSync(outside, 'outside');
    assert.throws(() => createDurableChatTransaction({
        filePath: outside,
        artifactPaths: [outside],
        userRoot: users.a.directories.root,
        handle: users.a.handle,
    }), /outside the exact user root/i);

    const inside = path.join(users.a.directories.groupChats, 'inside.jsonl');
    fs.writeFileSync(inside, 'inside');
    assert.throws(() => createDurableChatTransaction({
        filePath: inside,
        artifactPaths: [inside, outside],
        userRoot: users.a.directories.root,
        handle: users.a.handle,
    }), /outside the exact user root/i);
});

test('creation rejects chat paths traversing a symlink or junction', (t) => {
    const outsideDirectory = path.join(testRoot, 'symlink-target');
    const linkedDirectory = path.join(users.a.directories.root, 'linked-chats');
    fs.mkdirSync(outsideDirectory);
    fs.writeFileSync(path.join(outsideDirectory, 'linked.jsonl'), 'outside');
    try {
        fs.symlinkSync(outsideDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') {
            t.skip(`Symlinks are unavailable: ${error.code}`);
            return;
        }
        throw error;
    }
    assert.throws(() => createDurableChatTransaction({
        filePath: path.join(linkedDirectory, 'linked.jsonl'),
        artifactPaths: [path.join(linkedDirectory, 'linked.jsonl')],
        userRoot: users.a.directories.root,
        handle: users.a.handle,
    }), /symbolic links/i);
});

test('router recovery is isolated by authenticated user and hashed sibling namespace', async () => {
    const fixtureA = writeFivePartChat(users.a, 'isolated-a', 'old-a');
    const fixtureB = writeFivePartChat(users.b, 'isolated-b', 'old-b');
    runCrash('mutating', users.a, fixtureA, 'partial-a');
    runCrash('mutating', users.b, fixtureB, 'partial-b');

    const namespaceA = getChatJournalNamespace(users.a.directories.root, users.a.handle);
    const namespaceB = getChatJournalNamespace(users.b.directories.root, users.b.handle);
    assert.equal(namespaceA, path.join(dataRoot, '.migration-journals', sha256(users.a.handle)));
    assert.notEqual(namespaceA, namespaceB);

    const responseA = await getGroup('a', fixtureA.id);
    assert.equal(responseA.status, 200);
    assert.deepEqual(await responseA.json(), [fixtureA.header, fixtureA.message]);
    for (const artifact of fixtureA.artifacts) {
        assert.deepEqual(fs.readFileSync(artifact), fixtureA.bytes[artifact]);
    }
    assert.deepEqual(fs.readdirSync(namespaceA), []);
    assert.equal(fs.readFileSync(fixtureB.filePath, 'utf8'), 'partial-b');
    assert.equal(fs.readdirSync(namespaceB).length, 1);

    const responseB = await getGroup('b', fixtureB.id);
    assert.equal(responseB.status, 200);
    assert.deepEqual(await responseB.json(), [fixtureB.header, fixtureB.message]);
    for (const artifact of fixtureB.artifacts) {
        assert.deepEqual(fs.readFileSync(artifact), fixtureB.bytes[artifact]);
    }
    assert.deepEqual(fs.readdirSync(namespaceB), []);
});

test('lazy group conversion recovers original bytes after a process crash in mutating state', async () => {
    const id = 'conversion-crash';
    const filePath = path.join(users.a.directories.groupChats, `${id}.jsonl`);
    const messages = [
        { name: 'User', is_user: true, send_date: 1, mes: 'first-headerless' },
        { name: 'Character', is_user: false, send_date: 2, mes: 'second-headerless' },
    ];
    const original = messages.map(message => JSON.stringify(message)).join('\n');
    fs.writeFileSync(filePath, original);
    const result = spawnSync(process.execPath, [
        conversionChildPath,
        users.a.directories.root,
        users.a.handle,
        id,
        conversionConfigPath,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(`${filePath}.chunks`), true);
    assert.equal(fs.readdirSync(getChatJournalNamespace(users.a.directories.root, users.a.handle)).length, 1);

    resetDurableChatRecoveryForTests();
    const recovered = await getGroup('a', id);
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), messages);
    assert.equal(fs.readFileSync(filePath, 'utf8'), original);
    assert.equal(fs.existsSync(`${filePath}.chunks`), false);
    assert.deepEqual(fs.readdirSync(getChatJournalNamespace(users.a.directories.root, users.a.handle)), []);
});

test('transient rollback failure retains a retryable journal and blocks the next write', async () => {
    const fixture = writeFivePartChat(users.a, 'transient-rollback', 'old-transient');
    const transaction = createDurableChatTransaction({
        filePath: fixture.filePath,
        artifactPaths: fixture.artifacts,
        userRoot: users.a.directories.root,
        handle: users.a.handle,
    });
    transaction.markMutating();
    fs.writeFileSync(fixture.filePath, 'partial-transient');

    const originalCopyFileSync = fs.copyFileSync;
    let failuresRemaining = 2;
    fs.copyFileSync = function (source, destination, ...args) {
        if (failuresRemaining > 0 && String(destination).includes('.recovery-')) {
            failuresRemaining--;
            throw Object.assign(new Error('injected transient restore failure'), { code: 'EIO' });
        }
        return originalCopyFileSync.call(this, source, destination, ...args);
    };
    try {
        assert.throws(() => transaction.rollback(), /injected transient restore failure/);
        const namespace = getChatJournalNamespace(users.a.directories.root, users.a.handle);
        assert.equal(fs.readdirSync(namespace).length, 1);

        const blockedWrite = await fetch(`http://127.0.0.1:${address.port}/api/chats/group/save`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                id: fixture.id,
                chat: [fixture.header, { ...fixture.message, mes: 'must-not-publish' }],
            }),
        });
        assert.equal(blockedWrite.status, 500);
        assert.deepEqual(await blockedWrite.json(), { error: 'chat_recovery_failed' });
        assert.equal(fs.readdirSync(namespace).length, 1);
    } finally {
        fs.copyFileSync = originalCopyFileSync;
    }

    const recovered = await getGroup('a', fixture.id);
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), [fixture.header, fixture.message]);
    for (const artifact of fixture.artifacts) {
        assert.deepEqual(fs.readFileSync(artifact), fixture.bytes[artifact]);
    }
    assert.deepEqual(fs.readdirSync(getChatJournalNamespace(users.a.directories.root, users.a.handle)), []);
});

test('prepared state recovery restores the snapshot and removes the journal', () => {
    const fixture = writeFivePartChat(users.a, 'prepared-crash', 'old-prepared');
    runCrash('prepared', users.a, fixture, 'unused');
    fs.writeFileSync(fixture.filePath, 'uncommitted-after-prepare');
    const result = recoverDurableChatTransactions(users.a.directories.root, users.a.handle);
    assert.deepEqual(result, { restored: 1, cleaned: 0 });
    assert.deepEqual(fs.readFileSync(fixture.filePath), fixture.bytes[fixture.filePath]);
    assert.deepEqual(fs.readdirSync(getChatJournalNamespace(users.a.directories.root, users.a.handle)), []);
});

test('a real crash after the durable committed marker keeps new bytes and only cleans', () => {
    const fixture = writeFivePartChat(users.a, 'committed-crash', 'old-committed');
    const replacement = `${JSON.stringify(fixture.header)}\n${JSON.stringify({ ...fixture.message, mes: 'new-committed' })}`;
    runCrash('committed', users.a, fixture, replacement);
    const result = recoverDurableChatTransactions(users.a.directories.root, users.a.handle);
    assert.deepEqual(result, { restored: 0, cleaned: 1 });
    assert.equal(fs.readFileSync(fixture.filePath, 'utf8'), replacement);
    assert.deepEqual(fs.readdirSync(getChatJournalNamespace(users.a.directories.root, users.a.handle)), []);
});

test('recovery rejects a malicious relative target even with a recomputed manifest digest', () => {
    const fixture = writeFivePartChat(users.a, 'tampered-target', 'old-target');
    const victim = path.join(dataRoot, 'victim-target.jsonl');
    fs.writeFileSync(victim, 'do-not-touch');
    runCrash('mutating', users.a, fixture, 'partial-target');
    const namespace = getChatJournalNamespace(users.a.directories.root, users.a.handle);
    const transactionDirectory = path.join(namespace, fs.readdirSync(namespace)[0]);
    resignManifest(path.join(transactionDirectory, 'manifest.json'), manifest => {
        manifest.target = '../victim-target.jsonl';
    });
    assert.throws(
        () => recoverDurableChatTransactions(users.a.directories.root, users.a.handle),
        /invalid target|escapes the exact user root/i,
    );
    assert.equal(fs.readFileSync(victim, 'utf8'), 'do-not-touch');
    fs.rmSync(transactionDirectory, { recursive: true, force: true });
});

test('recovery rejects a malicious artifact path and cross-user root fingerprints', () => {
    const fixture = writeFivePartChat(users.a, 'tampered-artifact', 'old-artifact');
    const victim = path.join(dataRoot, 'victim-artifact.jsonl');
    fs.writeFileSync(victim, 'do-not-touch');
    runCrash('mutating', users.a, fixture, 'partial-artifact');
    const namespace = getChatJournalNamespace(users.a.directories.root, users.a.handle);
    const transactionDirectory = path.join(namespace, fs.readdirSync(namespace)[0]);
    const manifestPath = path.join(transactionDirectory, 'manifest.json');
    resignManifest(manifestPath, manifest => {
        manifest.artifacts[0].path = '../victim-artifact.jsonl';
    });
    assert.throws(
        () => recoverDurableChatTransactions(users.a.directories.root, users.a.handle),
        /invalid artifact|escapes the exact user root/i,
    );
    assert.equal(fs.readFileSync(victim, 'utf8'), 'do-not-touch');

    resignManifest(manifestPath, manifest => {
        manifest.artifacts[0].path = path.relative(users.a.directories.root, fixture.filePath).split(path.sep).join('/');
        manifest.userRootHash = sha256('wrong-user-root');
    });
    assert.throws(
        () => recoverDurableChatTransactions(users.a.directories.root, users.a.handle),
        /cross-user/i,
    );
    assert.equal(fs.readFileSync(victim, 'utf8'), 'do-not-touch');
    fs.rmSync(transactionDirectory, { recursive: true, force: true });
});

test('commit fsyncs target files and directories before the committed marker', () => {
    const user = createUser('journal-commit-fsync');
    const fixture = writeFivePartChat(user, 'commit-fsync', 'before-fsync');
    const transaction = createDurableChatTransaction({
        filePath: fixture.filePath,
        artifactPaths: fixture.artifacts,
        userRoot: user.directories.root,
        handle: user.handle,
    });
    transaction.markMutating();
    fs.writeFileSync(fixture.filePath, 'committed-fsync-bytes');
    const manifestPath = path.join(transaction.directory, 'manifest.json');
    const syncOrder = [];
    let committedAt = -1;
    const restoreFsync = injectFsyncObserver(syncedPath => {
        syncOrder.push(syncedPath);
        if (committedAt === -1 && fs.existsSync(manifestPath)
            && JSON.parse(fs.readFileSync(manifestPath, 'utf8')).state === 'committed') {
            committedAt = syncOrder.length - 1;
        }
    });
    try {
        transaction.commit();
    } finally {
        restoreFsync();
    }

    const expectedTargets = [
        ...fixture.artifacts,
        `${fixture.filePath}.chunks`,
        path.dirname(fixture.filePath),
    ].map(filePath => path.resolve(filePath));
    assert.ok(committedAt >= 0);
    for (const expected of expectedTargets) {
        const syncedAt = syncOrder.indexOf(expected);
        assert.ok(syncedAt >= 0, `missing fsync for ${expected}`);
        assert.ok(syncedAt < committedAt, `${expected} was fsynced after committed became visible`);
    }
});

test('rollback fsyncs restored files and storage roots before the signed rolled-back marker', () => {
    const user = createUser('journal-rollback-fsync');
    const fixture = writeFivePartChat(user, 'rollback-fsync', 'before-rollback-fsync');
    const transaction = createDurableChatTransaction({
        filePath: fixture.filePath,
        artifactPaths: fixture.artifacts,
        userRoot: user.directories.root,
        handle: user.handle,
    });
    transaction.markMutating();
    for (const artifact of fixture.artifacts) fs.writeFileSync(artifact, 'partial-rollback-fsync');

    const syncOrder = [];
    let rolledBackAt = -1;
    const restoreFsync = injectFsyncObserver(syncedPath => {
        syncOrder.push(syncedPath);
        if (path.basename(syncedPath ?? '') !== 'manifest.json' || !fs.existsSync(syncedPath)) return;
        const manifest = JSON.parse(fs.readFileSync(syncedPath, 'utf8'));
        if (manifest.state === 'rolled-back' && rolledBackAt === -1) rolledBackAt = syncOrder.length - 1;
    });
    try {
        transaction.rollback();
    } finally {
        restoreFsync();
    }

    const expectedBeforeTerminal = [
        ...fixture.artifacts,
        `${fixture.filePath}.chunks`,
        path.dirname(fixture.filePath),
        user.directories.root,
    ].map(filePath => path.resolve(filePath));
    assert.ok(rolledBackAt >= 0, 'the rolled-back manifest must become observable during fsync');
    for (const expectedPath of expectedBeforeTerminal) {
        const syncedAt = syncOrder.indexOf(expectedPath);
        assert.ok(syncedAt >= 0, `missing restored-state fsync for ${expectedPath}`);
        assert.ok(syncedAt < rolledBackAt, `${expectedPath} was fsynced after rolled-back became visible`);
    }
});

test('rollback partial cleanup leaves a safe manifestless tombstone', () => {
    const user = createUser('journal-rollback-partial-cleanup');
    const fixture = writeFivePartChat(user, 'rollback-partial-cleanup', 'before-rollback-cleanup');
    const transaction = createDurableChatTransaction({
        filePath: fixture.filePath,
        artifactPaths: fixture.artifacts,
        userRoot: user.directories.root,
        handle: user.handle,
    });
    transaction.markMutating();
    fs.writeFileSync(fixture.filePath, 'partial-rollback-cleanup');
    const namespace = getChatJournalNamespace(user.directories.root, user.handle);
    const restoreRmSync = injectPartialCleanupFailure(namespace);
    try {
        assert.doesNotThrow(() => transaction.rollback());
    } finally {
        restoreRmSync();
    }

    const [entry] = fs.readdirSync(namespace);
    assert.match(entry, /^cleanup-[a-f0-9]{32}$/);
    const tombstone = path.join(namespace, entry);
    assert.equal(fs.existsSync(path.join(tombstone, 'manifest.json')), false);
    assert.equal(fs.existsSync(path.join(tombstone, 'snapshot')), false);
    for (const artifact of fixture.artifacts) assert.deepEqual(fs.readFileSync(artifact), fixture.bytes[artifact]);
    assert.deepEqual(ensureDurableChatRecovery(user.directories.root, user.handle), { restored: 0, cleaned: 1 });
    assert.deepEqual(fs.readdirSync(namespace), []);
});

test('cleanup deletion retries in-process before allowing a later chat write', () => {
    const user = createUser('journal-cleanup-retry');
    const fixture = writeFivePartChat(user, 'cleanup-retry', 'before-cleanup-retry');
    const transaction = createDurableChatTransaction({
        filePath: fixture.filePath,
        artifactPaths: fixture.artifacts,
        userRoot: user.directories.root,
        handle: user.handle,
    });
    transaction.markMutating();
    fs.writeFileSync(fixture.filePath, 'partial-cleanup-retry');
    const namespace = getChatJournalNamespace(user.directories.root, user.handle);
    const restoreRmSync = injectCleanupDeletionFailures(namespace, 2, true);
    try {
        transaction.rollback();
        let writeStarted = false;
        assert.throws(() => {
            ensureDurableChatRecovery(user.directories.root, user.handle);
            writeStarted = true;
            fs.writeFileSync(fixture.filePath, 'must-not-intervene');
        }, /injected transient cleanup deletion failure/);
        assert.equal(writeStarted, false);
        for (const artifact of fixture.artifacts) assert.deepEqual(fs.readFileSync(artifact), fixture.bytes[artifact]);
        assert.equal(fs.readdirSync(namespace).length, 1);
    } finally {
        restoreRmSync();
    }

    assert.deepEqual(ensureDurableChatRecovery(user.directories.root, user.handle), { restored: 0, cleaned: 1 });
    assert.deepEqual(fs.readdirSync(namespace), []);
});

test('committed partial cleanup retries from a manifestless canonical tombstone', () => {
    const user = createUser('journal-partial-cleanup');
    const fixture = writeFivePartChat(user, 'partial-cleanup', 'before-cleanup');
    const transaction = createDurableChatTransaction({
        filePath: fixture.filePath,
        artifactPaths: fixture.artifacts,
        userRoot: user.directories.root,
        handle: user.handle,
    });
    transaction.markMutating();
    fs.writeFileSync(fixture.filePath, 'committed-cleanup-bytes');
    const namespace = getChatJournalNamespace(user.directories.root, user.handle);
    const restoreRmSync = injectPartialCleanupFailure(namespace);
    try {
        assert.doesNotThrow(() => transaction.commit());
    } finally {
        restoreRmSync();
    }

    const entries = fs.readdirSync(namespace);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^cleanup-[a-f0-9]{32}$/);
    const tombstone = path.join(namespace, entries[0]);
    assert.equal(fs.existsSync(path.join(tombstone, 'manifest.json')), false);
    assert.equal(fs.existsSync(path.join(tombstone, 'snapshot')), false);
    assert.deepEqual(recoverDurableChatTransactions(user.directories.root, user.handle), { restored: 0, cleaned: 1 });
    assert.equal(fs.readFileSync(fixture.filePath, 'utf8'), 'committed-cleanup-bytes');
    assert.deepEqual(fs.readdirSync(namespace), []);
});

test('recovery rejects manifestless ordinary transactions and forged cleanup state', () => {
    const user = createUser('journal-forged-cleanup');
    const fixture = writeFivePartChat(user, 'forged-cleanup', 'before-forgery');
    runCrash('mutating', user, fixture, 'partial-forgery');
    const namespace = getChatJournalNamespace(user.directories.root, user.handle);
    const transactionName = fs.readdirSync(namespace)[0];
    const transactionDirectory = path.join(namespace, transactionName);
    const manifestPath = path.join(transactionDirectory, 'manifest.json');
    const manifestBytes = fs.readFileSync(manifestPath);
    fs.rmSync(manifestPath);
    assert.throws(
        () => recoverDurableChatTransactions(user.directories.root, user.handle),
        /transaction manifest is missing/i,
    );
    fs.writeFileSync(manifestPath, manifestBytes);
    const cleanupDirectory = path.join(namespace, `cleanup-${'a'.repeat(32)}`);
    fs.renameSync(transactionDirectory, cleanupDirectory);
    assert.throws(
        () => recoverDurableChatTransactions(user.directories.root, user.handle),
        /forged|nonterminal/i,
    );
    assert.equal(fs.existsSync(cleanupDirectory), true);
    fs.rmSync(cleanupDirectory, { recursive: true, force: true });
});

test('cleanup recovery rejects unknown artifacts, symbolic links, and committed manifest tampering', (t) => {
    const user = createUser('journal-cleanup-structure');
    const namespace = path.join(path.dirname(user.directories.root), '.migration-journals', sha256(user.handle));
    fs.mkdirSync(namespace, { recursive: true });
    const unknownCleanup = path.join(namespace, `cleanup-${'b'.repeat(32)}`);
    fs.mkdirSync(unknownCleanup);
    fs.writeFileSync(path.join(unknownCleanup, 'unknown.bin'), 'forged');
    assert.throws(
        () => recoverDurableChatTransactions(user.directories.root, user.handle),
        /unknown chat journal artifact/i,
    );
    fs.rmSync(unknownCleanup, { recursive: true, force: true });

    const symlinkCleanup = path.join(namespace, `cleanup-${'c'.repeat(32)}`);
    fs.mkdirSync(symlinkCleanup);
    const outside = path.join(testRoot, 'journal-cleanup-symlink-target');
    fs.mkdirSync(outside, { recursive: true });
    let symlinkCreated = true;
    try {
        fs.symlinkSync(outside, path.join(symlinkCleanup, 'snapshot'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (['EPERM', 'EACCES'].includes(error.code)) {
            t.diagnostic(`Symlink assertion skipped: ${error.code}`);
            symlinkCreated = false;
        } else {
            throw error;
        }
    }
    if (symlinkCreated) {
        assert.throws(
            () => recoverDurableChatTransactions(user.directories.root, user.handle),
            /unsafe chat journal artifact/i,
        );
    }
    fs.rmSync(symlinkCleanup, { recursive: true, force: true });

    const fixture = writeFivePartChat(user, 'committed-tamper', 'before-tamper');
    runCrash('committed', user, fixture, 'committed-tamper-bytes');
    const committedDirectory = path.join(namespace, fs.readdirSync(namespace)[0]);
    const committedManifestPath = path.join(committedDirectory, 'manifest.json');
    const committedManifest = JSON.parse(fs.readFileSync(committedManifestPath, 'utf8'));
    committedManifest.handleHash = sha256('forged-user');
    fs.writeFileSync(committedManifestPath, JSON.stringify(committedManifest));
    assert.throws(
        () => recoverDurableChatTransactions(user.directories.root, user.handle),
        /cross-user|checksum|manifest/i,
    );
    assert.equal(fs.existsSync(committedDirectory), true);
    fs.rmSync(committedDirectory, { recursive: true, force: true });
});
