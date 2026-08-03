/* eslint-disable playwright/expect-expect, playwright/no-conditional-in-test -- Node test runner uses assert and platform-dependent symlink support. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { hashCanonicalJson, sha256 } from '../src/canonical-hash.js';
import {
    createCharacterChatTransaction,
    ensureCharacterChatRecovery,
    getCharacterChatJournalNamespace,
} from '../src/character-chat-transaction.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-character-chat-transaction-'));
const childPath = fileURLToPath(new URL('./fixtures/character-chat-crash-child.mjs', import.meta.url));
let userSequence = 0;

after(() => fs.rmSync(testRoot, { recursive: true, force: true }));

function createUser(label) {
    const handle = `${label}-${userSequence++}`;
    const root = path.join(testRoot, 'users', handle);
    const directories = {
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
    };
    fs.mkdirSync(directories.characters, { recursive: true });
    fs.mkdirSync(directories.chats, { recursive: true });
    return { root, handle, directories };
}

function createRenameFixture(label, withDestination = false) {
    const user = createUser(label);
    const oldCardPath = path.join(user.directories.characters, 'Old.png');
    const newCardPath = path.join(user.directories.characters, 'New.png');
    const oldChatsPath = path.join(user.directories.chats, 'Old');
    const newChatsPath = path.join(user.directories.chats, 'New');
    fs.writeFileSync(oldCardPath, 'old-card-bytes');
    fs.mkdirSync(path.join(oldChatsPath, 'empty', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(oldChatsPath, 'filled'), { recursive: true });
    fs.writeFileSync(path.join(oldChatsPath, 'chat.jsonl'), 'old-chat');
    fs.writeFileSync(path.join(oldChatsPath, 'filled', 'second.jsonl'), 'second-chat');
    if (withDestination) {
        fs.writeFileSync(newCardPath, 'preexisting-new-card');
        fs.mkdirSync(path.join(newChatsPath, 'destination-empty'), { recursive: true });
        fs.writeFileSync(path.join(newChatsPath, 'existing.jsonl'), 'preexisting-new-chat');
    }
    return {
        user,
        options: {
            root: user.root,
            handle: user.handle,
            directories: user.directories,
            operation: 'rename',
            oldCardPath,
            newCardPath,
            oldChatsPath,
            newChatsPath,
        },
    };
}

function createDeleteFixture(label, withChats = true) {
    const user = createUser(label);
    const oldCardPath = path.join(user.directories.characters, 'Delete.png');
    const oldChatsPath = path.join(user.directories.chats, 'Delete');
    fs.writeFileSync(oldCardPath, 'delete-card');
    if (withChats) {
        fs.mkdirSync(path.join(oldChatsPath, 'empty'), { recursive: true });
        fs.writeFileSync(path.join(oldChatsPath, 'chat.jsonl'), 'delete-chat');
    }
    return {
        user,
        options: {
            root: user.root,
            handle: user.handle,
            directories: user.directories,
            operation: 'delete',
            oldCardPath,
            newCardPath: null,
            oldChatsPath: withChats ? oldChatsPath : null,
            newChatsPath: null,
        },
    };
}

function snapshotTree(root) {
    const result = { directories: [], files: {} };
    const visit = (directory, relativeDirectory) => {
        const entries = fs.readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                result.directories.push(relative);
                visit(entryPath, relative);
            } else {
                result.files[relative] = fs.readFileSync(entryPath).toString('base64');
            }
        }
    };
    visit(root, '');
    return result;
}

function crash(options, state) {
    const result = spawnSync(process.execPath, [childPath, JSON.stringify(options), state], {
        encoding: 'utf8',
        timeout: 30_000,
    });
    assert.equal(result.status, 86, result.stderr || result.stdout || `signal=${result.signal}`);
}

function retainedTransaction(user) {
    const namespace = getCharacterChatJournalNamespace(user.root, user.handle, user.directories);
    const entries = fs.readdirSync(namespace);
    assert.equal(entries.length, 1);
    return { namespace, directory: path.join(namespace, entries[0]) };
}

function resignManifest(manifestPath, mutate) {
    const signed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const manifest = { ...signed };
    delete manifest.digest;
    mutate(manifest);
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, digest: hashCanonicalJson(manifest) }));
}

function injectPartialCleanupFailure(namespace) {
    const originalRmSync = fs.rmSync;
    let injected = false;
    fs.rmSync = function (targetPath, options) {
        const absolute = path.resolve(String(targetPath));
        if (!injected
            && path.dirname(absolute) === path.resolve(namespace)
            && /^cleanup-[a-f0-9]{32}$/.test(path.basename(absolute))) {
            injected = true;
            originalRmSync(path.join(absolute, 'manifest.json'), { force: true });
            originalRmSync(path.join(absolute, 'snapshot'), { recursive: true, force: true });
            const error = new Error('simulated partial terminal cleanup failure');
            error.code = 'EIO';
            throw error;
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

test('rename rollback restores old card/chat trees and removes partial destinations', () => {
    const fixture = createRenameFixture('partial-copy');
    const before = snapshotTree(fixture.user.root);
    const transaction = createCharacterChatTransaction(fixture.options);
    transaction.markMutating();

    assert.throws(() => {
        fs.rmSync(fixture.options.newChatsPath, { recursive: true, force: true });
        fs.cpSync(fixture.options.oldChatsPath, fixture.options.newChatsPath, { recursive: true });
        fs.writeFileSync(fixture.options.newCardPath, 'partially-written-card');
        throw new Error('simulated cp failure');
    }, /simulated cp failure/);
    transaction.rollback();

    assert.deepEqual(snapshotTree(fixture.user.root), before);
    assert.deepEqual(fs.readdirSync(getCharacterChatJournalNamespace(
        fixture.user.root,
        fixture.user.handle,
        fixture.user.directories,
    )), []);
});

test('delete rollback restores the card, files, and empty chat directories after partial removal', () => {
    const fixture = createDeleteFixture('partial-remove');
    const before = snapshotTree(fixture.user.root);
    const transaction = createCharacterChatTransaction(fixture.options);
    transaction.markMutating();
    fs.rmSync(fixture.options.oldCardPath, { force: true });
    fs.rmSync(path.join(fixture.options.oldChatsPath, 'chat.jsonl'), { force: true });
    transaction.rollback();
    assert.deepEqual(snapshotTree(fixture.user.root), before);
});

test('rollback partial cleanup leaves a recoverable tombstone without manifest or snapshots', () => {
    const fixture = createDeleteFixture('partial-rollback-cleanup');
    const before = snapshotTree(fixture.user.root);
    const transaction = createCharacterChatTransaction(fixture.options);
    transaction.markMutating();
    fs.rmSync(fixture.options.oldCardPath, { force: true });
    fs.rmSync(fixture.options.oldChatsPath, { recursive: true, force: true });
    const namespace = getCharacterChatJournalNamespace(
        fixture.user.root,
        fixture.user.handle,
        fixture.user.directories,
    );
    const restoreRmSync = injectPartialCleanupFailure(namespace);
    try {
        assert.doesNotThrow(() => transaction.rollback());
    } finally {
        restoreRmSync();
    }

    const retained = retainedTransaction(fixture.user);
    assert.match(path.basename(retained.directory), /^cleanup-[a-f0-9]{32}$/);
    assert.equal(fs.existsSync(path.join(retained.directory, 'manifest.json')), false);
    assert.equal(fs.existsSync(path.join(retained.directory, 'snapshot')), false);
    assert.deepEqual(snapshotTree(fixture.user.root), before);
    assert.deepEqual(ensureCharacterChatRecovery(
        fixture.user.root,
        fixture.user.handle,
        fixture.user.directories,
    ), { restored: 0, cleaned: 1 });
    assert.deepEqual(snapshotTree(fixture.user.root), before);
});

test('rollback failure retains a quarantined snapshot and automatic recovery retries successfully', () => {
    const fixture = createRenameFixture('rollback-retry');
    const before = snapshotTree(fixture.user.root);
    const transaction = createCharacterChatTransaction(fixture.options);
    transaction.markMutating();
    fs.writeFileSync(fixture.options.newCardPath, 'partial');
    fs.rmSync(fixture.options.oldCardPath, { force: true });

    const originalCopyFileSync = fs.copyFileSync;
    let injected = false;
    fs.copyFileSync = function (source, destination, flags) {
        if (!injected && String(destination).includes('.character-chat-recovery-')) {
            injected = true;
            const error = new Error('transient recovery copy failure');
            error.code = 'EIO';
            throw error;
        }
        return originalCopyFileSync.call(this, source, destination, flags);
    };
    try {
        assert.throws(() => transaction.rollback(), /transient recovery copy failure/);
    } finally {
        fs.copyFileSync = originalCopyFileSync;
    }

    const retained = retainedTransaction(fixture.user);
    assert.match(path.basename(retained.directory), /^failed-/);
    assert.notDeepEqual(snapshotTree(fixture.user.root), before);
    assert.deepEqual(ensureCharacterChatRecovery(
        fixture.user.root,
        fixture.user.handle,
        fixture.user.directories,
    ), { restored: 1, cleaned: 0 });
    assert.deepEqual(snapshotTree(fixture.user.root), before);
    assert.deepEqual(fs.readdirSync(retained.namespace), []);
});

for (const state of ['prepared', 'mutating']) {
    test(`process restart restores the exact before-state after a ${state} crash`, () => {
        const fixture = createRenameFixture(`crash-${state}`);
        const before = snapshotTree(fixture.user.root);
        crash(fixture.options, state);
        const retained = retainedTransaction(fixture.user);
        const manifest = JSON.parse(fs.readFileSync(path.join(retained.directory, 'manifest.json'), 'utf8'));
        assert.equal(manifest.state, state);
        assert.deepEqual(ensureCharacterChatRecovery(
            fixture.user.root,
            fixture.user.handle,
            fixture.user.directories,
        ), { restored: 1, cleaned: 0 });
        assert.deepEqual(snapshotTree(fixture.user.root), before);
        assert.deepEqual(fs.readdirSync(retained.namespace), []);
    });
}

test('commit flushes every post-mutation target before the committed transition', () => {
    const fixture = createRenameFixture('commit-sync-order');
    const transaction = createCharacterChatTransaction(fixture.options);
    transaction.markMutating();
    fs.renameSync(fixture.options.oldCardPath, fixture.options.newCardPath);
    fs.renameSync(fixture.options.oldChatsPath, fixture.options.newChatsPath);

    const manifestPath = path.join(transaction.directory, 'manifest.json');
    const syncOrder = [];
    let firstCommittedObservation = -1;
    const restoreFsync = injectFsyncObserver(syncedPath => {
        syncOrder.push(syncedPath);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.state === 'committed' && firstCommittedObservation === -1) {
            firstCommittedObservation = syncOrder.length - 1;
        }
    });
    try {
        transaction.markCommitted();
    } finally {
        restoreFsync();
    }

    const expectedBeforeCommit = [
        fixture.options.newCardPath,
        path.join(fixture.options.newChatsPath, 'chat.jsonl'),
        path.join(fixture.options.newChatsPath, 'filled', 'second.jsonl'),
        path.join(fixture.options.newChatsPath, 'empty', 'nested'),
        path.join(fixture.options.newChatsPath, 'empty'),
        path.join(fixture.options.newChatsPath, 'filled'),
        fixture.options.newChatsPath,
        fixture.user.directories.characters,
        fixture.user.directories.chats,
    ].map(item => path.resolve(item));
    assert.ok(firstCommittedObservation >= 0, 'the committed manifest must become observable during fsync');
    for (const expectedPath of expectedBeforeCommit) {
        const syncIndex = syncOrder.indexOf(expectedPath);
        assert.ok(syncIndex >= 0, `missing fsync for ${expectedPath}`);
        assert.ok(syncIndex < firstCommittedObservation, `${expectedPath} was synced after committed became observable`);
    }
    assert.ok(syncOrder.indexOf(path.join(fixture.options.newChatsPath, 'filled', 'second.jsonl'))
        < syncOrder.indexOf(path.join(fixture.options.newChatsPath, 'filled')));
    assert.ok(syncOrder.indexOf(path.join(fixture.options.newChatsPath, 'empty', 'nested'))
        < syncOrder.indexOf(path.join(fixture.options.newChatsPath, 'empty')));
    assert.ok(syncOrder.indexOf(path.join(fixture.options.newChatsPath, 'empty'))
        < syncOrder.indexOf(fixture.options.newChatsPath));
    assert.ok(syncOrder.indexOf(fixture.options.newChatsPath)
        < syncOrder.indexOf(fixture.user.directories.chats));
    transaction.cleanup();
});

test('target fsync failure leaves mutating snapshots available for rollback', () => {
    const fixture = createRenameFixture('commit-sync-failure');
    const before = snapshotTree(fixture.user.root);
    const transaction = createCharacterChatTransaction(fixture.options);
    transaction.markMutating();
    fs.renameSync(fixture.options.oldCardPath, fixture.options.newCardPath);
    fs.renameSync(fixture.options.oldChatsPath, fixture.options.newChatsPath);

    const failedPath = path.resolve(fixture.options.newCardPath);
    let injected = false;
    const restoreFsync = injectFsyncObserver(syncedPath => {
        if (injected || syncedPath !== failedPath) return;
        injected = true;
        const error = new Error('simulated target fsync failure');
        error.code = 'EIO';
        throw error;
    });
    try {
        assert.throws(() => transaction.markCommitted(), /simulated target fsync failure/);
    } finally {
        restoreFsync();
    }

    assert.equal(injected, true);
    const manifest = JSON.parse(fs.readFileSync(path.join(transaction.directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.state, 'mutating');
    assert.ok(fs.readdirSync(path.join(transaction.directory, 'snapshot')).length > 0);
    transaction.rollback();
    assert.deepEqual(snapshotTree(fixture.user.root), before);
});

test('process restart after the committed marker preserves mutation and cleans only the journal', () => {
    const fixture = createRenameFixture('crash-committed');
    crash(fixture.options, 'committed');
    const committed = snapshotTree(fixture.user.root);
    const retained = retainedTransaction(fixture.user);
    const manifest = JSON.parse(fs.readFileSync(path.join(retained.directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.state, 'committed');
    assert.deepEqual(ensureCharacterChatRecovery(
        fixture.user.root,
        fixture.user.handle,
        fixture.user.directories,
    ), { restored: 0, cleaned: 1 });
    assert.deepEqual(snapshotTree(fixture.user.root), committed);
    assert.equal(fs.existsSync(fixture.options.oldCardPath), false);
    assert.equal(fs.readFileSync(fixture.options.newCardPath, 'utf8'), 'committed-new-card');
});

test('committed partial cleanup leaves a recoverable tombstone without manifest or snapshots', () => {
    const fixture = createDeleteFixture('partial-committed-cleanup');
    const transaction = createCharacterChatTransaction(fixture.options);
    transaction.markMutating();
    fs.rmSync(fixture.options.oldCardPath, { force: true });
    fs.rmSync(fixture.options.oldChatsPath, { recursive: true, force: true });
    const committed = snapshotTree(fixture.user.root);
    const namespace = getCharacterChatJournalNamespace(
        fixture.user.root,
        fixture.user.handle,
        fixture.user.directories,
    );
    const restoreRmSync = injectPartialCleanupFailure(namespace);
    try {
        assert.doesNotThrow(() => transaction.commit());
    } finally {
        restoreRmSync();
    }

    const retained = retainedTransaction(fixture.user);
    assert.match(path.basename(retained.directory), /^cleanup-[a-f0-9]{32}$/);
    assert.equal(fs.existsSync(path.join(retained.directory, 'manifest.json')), false);
    assert.equal(fs.existsSync(path.join(retained.directory, 'snapshot')), false);
    assert.deepEqual(ensureCharacterChatRecovery(
        fixture.user.root,
        fixture.user.handle,
        fixture.user.directories,
    ), { restored: 0, cleaned: 1 });
    assert.deepEqual(snapshotTree(fixture.user.root), committed);
    assert.equal(fs.existsSync(fixture.options.oldCardPath), false);
});

test('commit cleanup failure after the durable marker does not report a failed operation', () => {
    const fixture = createDeleteFixture('commit-cleanup-failure', false);
    const transaction = createCharacterChatTransaction(fixture.options);
    transaction.markMutating();
    fs.rmSync(fixture.options.oldCardPath);

    const originalRmSync = fs.rmSync;
    fs.rmSync = function (targetPath, options) {
        if (path.resolve(String(targetPath)) === path.resolve(transaction.directory)) {
            const error = new Error('simulated committed cleanup failure');
            error.code = 'EIO';
            throw error;
        }
        return originalRmSync.call(this, targetPath, options);
    };
    try {
        assert.doesNotThrow(() => transaction.commit());
    } finally {
        fs.rmSync = originalRmSync;
    }

    const retained = retainedTransaction(fixture.user);
    assert.match(path.basename(retained.directory), /^cleanup-[a-f0-9]{32}$/);
    const manifest = JSON.parse(fs.readFileSync(path.join(retained.directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.state, 'committed');
    assert.deepEqual(ensureCharacterChatRecovery(
        fixture.user.root,
        fixture.user.handle,
        fixture.user.directories,
    ), { restored: 0, cleaned: 1 });
});

test('journal namespace is outside quota and keyed by handle NUL normalized root', () => {
    const user = createUser('namespace');
    const namespace = getCharacterChatJournalNamespace(user.root, user.handle, user.directories);
    const normalizedRoot = process.platform === 'win32'
        ? path.normalize(path.resolve(user.root)).toLowerCase()
        : path.normalize(path.resolve(user.root));
    assert.equal(namespace, path.join(
        path.dirname(path.resolve(user.root)),
        '.character-chat-journals',
        sha256(`${user.handle}\0${normalizedRoot}`),
    ));
    assert.equal(path.relative(user.root, namespace).startsWith('..'), true);
});

test('regular-file snapshots use same-filesystem hard links without duplicate bytes', () => {
    const fixture = createDeleteFixture('hard-link-snapshot');
    const transaction = createCharacterChatTransaction(fixture.options);
    const manifest = JSON.parse(fs.readFileSync(path.join(transaction.directory, 'manifest.json'), 'utf8'));
    const oldCard = manifest.targets.find(target => target.role === 'oldCard');
    const snapshotPath = path.join(transaction.directory, ...oldCard.files[0].snapshot.split('/'));
    const sourceStats = fs.statSync(fixture.options.oldCardPath);
    const snapshotStats = fs.statSync(snapshotPath);
    assert.equal(snapshotStats.dev, sourceStats.dev);
    assert.equal(snapshotStats.ino, sourceStats.ino);
    assert.ok(snapshotStats.nlink >= 2);
    transaction.rollback();
});

test('hard-link fallback checks filesystem free space before copying', () => {
    const fixture = createDeleteFixture('copy-fallback');
    const originalLinkSync = fs.linkSync;
    const originalStatfsSync = fs.statfsSync;
    let freeSpaceChecks = 0;
    fs.linkSync = function () {
        const error = new Error('simulated cross-device link');
        error.code = 'EXDEV';
        throw error;
    };
    fs.statfsSync = function () {
        freeSpaceChecks++;
        return { bavail: 1024n * 1024n, bsize: 4096n };
    };
    let transaction;
    try {
        transaction = createCharacterChatTransaction(fixture.options);
    } finally {
        fs.linkSync = originalLinkSync;
        fs.statfsSync = originalStatfsSync;
    }
    assert.ok(freeSpaceChecks > 0);
    const manifest = JSON.parse(fs.readFileSync(path.join(transaction.directory, 'manifest.json'), 'utf8'));
    const oldCard = manifest.targets.find(target => target.role === 'oldCard');
    const snapshotPath = path.join(transaction.directory, ...oldCard.files[0].snapshot.split('/'));
    assert.notEqual(fs.statSync(snapshotPath).ino, fs.statSync(fixture.options.oldCardPath).ino);
    transaction.rollback();
});

test('hard-link fallback refuses copying when statfs reports insufficient space', () => {
    const fixture = createDeleteFixture('copy-no-space', false);
    const originalLinkSync = fs.linkSync;
    const originalStatfsSync = fs.statfsSync;
    const originalCopyFileSync = fs.copyFileSync;
    let copied = false;
    fs.linkSync = function () {
        const error = new Error('simulated cross-device link');
        error.code = 'EXDEV';
        throw error;
    };
    fs.statfsSync = () => ({ bavail: 0n, bsize: 4096n });
    fs.copyFileSync = function (...args) {
        copied = true;
        return originalCopyFileSync.apply(this, args);
    };
    try {
        assert.throws(() => createCharacterChatTransaction(fixture.options), /insufficient free space/i);
    } finally {
        fs.linkSync = originalLinkSync;
        fs.statfsSync = originalStatfsSync;
        fs.copyFileSync = originalCopyFileSync;
    }
    assert.equal(copied, false);
    assert.equal(fs.readFileSync(fixture.options.oldCardPath, 'utf8'), 'delete-card');
});

test('creation caps the number of snapshotted filesystem entries', () => {
    const fixture = createDeleteFixture('entry-cap');
    const originalReaddirSync = fs.readdirSync;
    const fakeEntries = Array.from({ length: 10_001 }, (_, index) => ({
        name: String(index).padStart(5, '0'),
    }));
    fs.readdirSync = function (directoryPath, options) {
        if (path.resolve(String(directoryPath)) === path.resolve(fixture.options.oldChatsPath)) return fakeEntries;
        return originalReaddirSync.call(this, directoryPath, options);
    };
    try {
        assert.throws(() => createCharacterChatTransaction(fixture.options), /too many filesystem entries/i);
    } finally {
        fs.readdirSync = originalReaddirSync;
    }
});

test('rename creation rejects existing card or chat destinations', () => {
    const cardCollision = createRenameFixture('card-collision', true);
    assert.throws(() => createCharacterChatTransaction(cardCollision.options), /destination paths must be absent/i);

    const chatCollision = createRenameFixture('chat-collision');
    fs.mkdirSync(chatCollision.options.newChatsPath);
    assert.throws(() => createCharacterChatTransaction(chatCollision.options), /destination paths must be absent/i);
});

test('creation rejects traversal, mismatched authenticated roots, and recursive symlinks', (t) => {
    const fixture = createRenameFixture('unsafe-create');
    const victim = path.join(fixture.user.root, 'victim.png');
    fs.writeFileSync(victim, 'victim');
    assert.throws(() => createCharacterChatTransaction({
        ...fixture.options,
        oldCardPath: path.join(fixture.user.directories.characters, '..', 'victim.png'),
    }), /direct child|authenticated storage root/i);
    assert.throws(() => createCharacterChatTransaction({
        ...fixture.options,
        directories: { ...fixture.user.directories, characters: fixture.user.directories.chats },
    }), /card|directory|storage root/i);

    const outside = path.join(testRoot, 'symlink-target');
    fs.mkdirSync(outside, { recursive: true });
    const link = path.join(fixture.options.oldChatsPath, 'linked');
    try {
        fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (['EPERM', 'EACCES'].includes(error.code)) {
            t.diagnostic(`Symlink assertion skipped: ${error.code}`);
            return;
        }
        throw error;
    }
    assert.throws(() => createCharacterChatTransaction(fixture.options), /symbolic link/i);
});

test('recovery rejects nonterminal manifest digest tampering and retains the snapshot', () => {
    const fixture = createDeleteFixture('digest-tamper');
    crash(fixture.options, 'mutating');
    const retained = retainedTransaction(fixture.user);
    const manifestPath = path.join(retained.directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.operation = 'rename';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => ensureCharacterChatRecovery(
        fixture.user.root,
        fixture.user.handle,
        fixture.user.directories,
    ), /tampered|manifest/i);
    assert.match(path.basename(retained.directory), /^tx-/);
    assert.equal(fs.existsSync(retained.directory), true);
});

for (const state of ['prepared', 'mutating']) {
    test(`manifestless ${state} transactions are rejected and retained`, () => {
        const fixture = createDeleteFixture(`manifestless-${state}`);
        crash(fixture.options, state);
        const retained = retainedTransaction(fixture.user);
        fs.rmSync(path.join(retained.directory, 'manifest.json'));

        assert.throws(() => ensureCharacterChatRecovery(
            fixture.user.root,
            fixture.user.handle,
            fixture.user.directories,
        ), /transaction manifest is missing/i);
        assert.match(path.basename(retained.directory), /^tx-/);
        assert.equal(fs.existsSync(retained.directory), true);
    });
}

test('failed transactions without a manifest remain rejected', () => {
    const fixture = createDeleteFixture('failed-missing-manifest');
    crash(fixture.options, 'mutating');
    const retained = retainedTransaction(fixture.user);
    const failedDirectory = path.join(retained.namespace, `failed-${path.basename(retained.directory).slice(3)}`);
    fs.renameSync(retained.directory, failedDirectory);
    fs.rmSync(path.join(failedDirectory, 'manifest.json'));

    assert.throws(() => ensureCharacterChatRecovery(
        fixture.user.root,
        fixture.user.handle,
        fixture.user.directories,
    ), /failed transaction manifest is missing/i);
    assert.equal(fs.existsSync(failedDirectory), true);
});

test('recovery rejects noncanonical cleanup names', () => {
    const user = createUser('invalid-cleanup-name');
    const namespace = getCharacterChatJournalNamespace(user.root, user.handle, user.directories);
    fs.mkdirSync(path.join(namespace, 'cleanup-not-canonical'), { recursive: true });

    assert.throws(() => ensureCharacterChatRecovery(
        user.root,
        user.handle,
        user.directories,
    ), /unsafe|unknown/i);
    assert.equal(fs.existsSync(path.join(namespace, 'cleanup-not-canonical')), true);
});

test('recovery rejects forged canonical cleanup tombstones with nonterminal manifests', () => {
    const fixture = createDeleteFixture('forged-cleanup-nonterminal');
    crash(fixture.options, 'mutating');
    const retained = retainedTransaction(fixture.user);
    const forgedDirectory = path.join(retained.namespace, `cleanup-${'a'.repeat(32)}`);
    fs.renameSync(retained.directory, forgedDirectory);

    assert.throws(() => ensureCharacterChatRecovery(
        fixture.user.root,
        fixture.user.handle,
        fixture.user.directories,
    ), /forged|nonterminal/i);
    assert.equal(fs.existsSync(forgedDirectory), true);
});

test('recovery rejects forged canonical cleanup tombstones with unknown artifacts', () => {
    const user = createUser('forged-cleanup-artifact');
    const namespace = getCharacterChatJournalNamespace(user.root, user.handle, user.directories);
    const forgedDirectory = path.join(namespace, `cleanup-${'b'.repeat(32)}`);
    fs.mkdirSync(forgedDirectory, { recursive: true });
    fs.writeFileSync(path.join(forgedDirectory, 'unknown'), 'forged');

    assert.throws(() => ensureCharacterChatRecovery(
        user.root,
        user.handle,
        user.directories,
    ), /unknown.*artifact/i);
    assert.equal(fs.existsSync(forgedDirectory), true);
});

test('recovery rejects forged cleanup tombstones containing symbolic links', (t) => {
    const user = createUser('forged-cleanup-symlink');
    const namespace = getCharacterChatJournalNamespace(user.root, user.handle, user.directories);
    const forgedDirectory = path.join(namespace, `cleanup-${'c'.repeat(32)}`);
    const outside = path.join(testRoot, 'forged-cleanup-symlink-target');
    fs.mkdirSync(forgedDirectory, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    try {
        fs.symlinkSync(outside, path.join(forgedDirectory, 'snapshot'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (['EPERM', 'EACCES'].includes(error.code)) {
            t.diagnostic(`Symlink assertion skipped: ${error.code}`);
            return;
        }
        throw error;
    }

    assert.throws(() => ensureCharacterChatRecovery(
        user.root,
        user.handle,
        user.directories,
    ), /unsafe.*artifact|symbolic link/i);
    assert.equal(fs.existsSync(forgedDirectory), true);
});

test('recovery rejects a tampered genuinely committed manifest before terminal cleanup', () => {
    const fixture = createRenameFixture('committed-manifest-tamper');
    crash(fixture.options, 'committed');
    const retained = retainedTransaction(fixture.user);
    const manifestPath = path.join(retained.directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.storageHash = sha256('tampered-storage-identity');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    assert.throws(() => ensureCharacterChatRecovery(
        fixture.user.root,
        fixture.user.handle,
        fixture.user.directories,
    ), /tampered|cross-user|manifest/i);
    assert.equal(fs.existsSync(retained.directory), true);
    assert.equal(fs.existsSync(fixture.options.oldCardPath), false);
});

test('recovery rejects traversal and cross-user identity even with a recomputed digest', () => {
    const traversal = createDeleteFixture('path-tamper');
    crash(traversal.options, 'mutating');
    const retainedTraversal = retainedTransaction(traversal.user);
    const traversalManifest = path.join(retainedTraversal.directory, 'manifest.json');
    resignManifest(traversalManifest, manifest => {
        manifest.paths.oldCard = '../victim.png';
        manifest.targets[0].path = '../victim.png';
    });
    assert.throws(() => ensureCharacterChatRecovery(
        traversal.user.root,
        traversal.user.handle,
        traversal.user.directories,
    ), /invalid oldCard|escapes/i);

    const identity = createDeleteFixture('identity-tamper');
    crash(identity.options, 'mutating');
    const retainedIdentity = retainedTransaction(identity.user);
    resignManifest(path.join(retainedIdentity.directory, 'manifest.json'), manifest => {
        manifest.handleHash = sha256('another-authenticated-user');
    });
    assert.throws(() => ensureCharacterChatRecovery(
        identity.user.root,
        identity.user.handle,
        identity.user.directories,
    ), /cross-user|invalid|tampered/i);
});

test('recovery rejects a modified snapshot and unknown artifacts but accepts atomic manifest temps', () => {
    const checksum = createDeleteFixture('snapshot-tamper');
    crash(checksum.options, 'mutating');
    const retainedChecksum = retainedTransaction(checksum.user);
    const snapshotPath = path.join(retainedChecksum.directory, 'snapshot', fs.readdirSync(
        path.join(retainedChecksum.directory, 'snapshot'),
    )[0]);
    fs.writeFileSync(snapshotPath, 'modified snapshot bytes');
    assert.throws(() => ensureCharacterChatRecovery(
        checksum.user.root,
        checksum.user.handle,
        checksum.user.directories,
    ), /checksum/i);

    const unknown = createDeleteFixture('unknown-artifact');
    crash(unknown.options, 'mutating');
    const retainedUnknown = retainedTransaction(unknown.user);
    fs.writeFileSync(path.join(retainedUnknown.directory, 'unexpected'), 'unsafe');
    assert.throws(() => ensureCharacterChatRecovery(
        unknown.user.root,
        unknown.user.handle,
        unknown.user.directories,
    ), /unknown.*artifact/i);

    const temporary = createDeleteFixture('atomic-temp');
    const before = snapshotTree(temporary.user.root);
    crash(temporary.options, 'prepared');
    const retainedTemporary = retainedTransaction(temporary.user);
    fs.writeFileSync(path.join(retainedTemporary.directory, 'manifest.json.12345'), 'interrupted temp');
    assert.deepEqual(ensureCharacterChatRecovery(
        temporary.user.root,
        temporary.user.handle,
        temporary.user.directories,
    ), { restored: 1, cleaned: 0 });
    assert.deepEqual(snapshotTree(temporary.user.root), before);
});
