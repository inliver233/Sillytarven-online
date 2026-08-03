/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { write } from '../src/character-card-parser.js';
import { setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-character-chat-lock-'));
const configPath = path.join(testRoot, 'config.yaml');
const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const config = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
config.userStorage.enabled = false;
config.performance.useDiskCache = false;
fs.writeFileSync(configPath, stringifyYaml(config));
setConfigFilePath(configPath);
globalThis.DATA_ROOT = path.join(testRoot, 'data');
fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });

const {
    getChatBranchJournalNamespace,
    getChatBranchUserLockPath,
    resetChatBranchRecoveryForTests,
} = await import('../src/chat-branch.js');
const {
    ensureCharacterChatRecovery,
    getCharacterChatJournalNamespace,
} = await import('../src/character-chat-transaction.js');
const {
    runWithChatStorageLocks,
} = await import('../src/endpoints/chats.js');
const {
    diskCache,
    router: charactersRouter,
} = await import('../src/endpoints/characters.js');
const { default: systemMonitor } = await import('../src/system-monitor.js');

const basePng = fs.readFileSync(new URL('../default/content/user-default.png', import.meta.url));

function createUser(handle) {
    const root = path.join(testRoot, 'users', handle);
    const directories = {
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groupChats: path.join(root, 'group-chats'),
        groups: path.join(root, 'groups'),
        backups: path.join(root, 'backups'),
        thumbnails: path.join(root, 'thumbnails'),
        thumbnailsBg: path.join(root, 'thumbnails', 'bg'),
        thumbnailsAvatar: path.join(root, 'thumbnails', 'avatar'),
        thumbnailsPersona: path.join(root, 'thumbnails', 'persona'),
        worlds: path.join(root, 'worlds'),
        userImages: path.join(root, 'user', 'images'),
        backgrounds: path.join(root, 'backgrounds'),
    };
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    return { profile: { handle, name: handle, admin: true }, directories };
}

const users = {
    a: createUser('character-lock-a'),
    b: createUser('character-lock-b'),
};

const app = express();
app.use(express.json());
app.use((request, response, next) => {
    const user = users[request.get('x-test-user')];
    if (!user) return response.sendStatus(401);
    request.user = user;
    next();
});
app.use('/api/characters', charactersRouter);
const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
});
const address = server.address();
assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}/api/characters`;

after(async () => {
    resetChatBranchRecoveryForTests();
    diskCache.dispose();
    systemMonitor.destroy();
    systemMonitor.saveDataToDisk = () => {};
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(testRoot, { recursive: true, force: true });
});

function writeCharacterFixture(user, name, chatMarker = name) {
    const card = {
        name,
        description: `${name} description`,
        personality: '',
        first_mes: 'Hello',
        mes_example: '',
        scenario: '',
    };
    const avatarPath = path.join(user.directories.characters, `${name}.png`);
    fs.writeFileSync(avatarPath, write(basePng, JSON.stringify(card)));
    const chatPath = path.join(user.directories.chats, name);
    fs.mkdirSync(chatPath, { recursive: true });
    fs.writeFileSync(path.join(chatPath, 'chat.jsonl'), JSON.stringify({ chat_metadata: { chatMarker } }));
    return { avatarPath, chatPath };
}

async function post(userKey, route, body) {
    const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-test-user': userKey,
        },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let data = text;
    try {
        data = JSON.parse(text);
    } catch {
        // Status-only responses are expected in failure cases.
    }
    return { response, data };
}

function holdRootLock(user) {
    let release;
    let signalEntered;
    const entered = new Promise(resolve => { signalEntered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const request = { user };
    const held = runWithChatStorageLocks(
        request,
        [getChatBranchUserLockPath(user.directories.root)],
        async () => {
            signalEntered();
            await gate;
        },
    );
    return { entered, held, release };
}

async function assertStillPending(promise, label) {
    const state = await Promise.race([
        promise.then(() => 'settled', () => 'settled'),
        new Promise(resolve => setTimeout(() => resolve('pending'), 50)),
    ]);
    assert.equal(state, 'pending', label);
}

function snapshotTree(directory) {
    const snapshot = {};
    const visit = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const entryPath = path.join(current, entry.name);
            const relative = path.relative(directory, entryPath).split(path.sep).join('/');
            if (entry.isDirectory()) {
                visit(entryPath);
            } else {
                snapshot[relative] = fs.readFileSync(entryPath).toString('base64');
            }
        }
    };
    visit(directory);
    return snapshot;
}

function injectJournalCleanupFailure(namespace) {
    const originalRmSync = fs.rmSync;
    fs.rmSync = function (targetPath, options) {
        if (String(targetPath).startsWith(namespace)
            && /^cleanup-[a-f0-9]{32}$/.test(path.basename(String(targetPath)))) {
            const error = new Error('simulated route journal cleanup failure');
            error.code = 'EIO';
            throw error;
        }
        return originalRmSync.call(this, targetPath, options);
    };
    return () => { fs.rmSync = originalRmSync; };
}

function injectTargetFsyncFailure(targetPath, onFailure) {
    const expectedPath = path.resolve(targetPath);
    const originalOpenSync = fs.openSync;
    const originalFsyncSync = fs.fsyncSync;
    const descriptorPaths = new Map();
    let injected = false;
    fs.openSync = function (...args) {
        const descriptor = originalOpenSync.apply(this, args);
        descriptorPaths.set(descriptor, path.resolve(String(args[0])));
        return descriptor;
    };
    fs.fsyncSync = function (descriptor) {
        if (!injected && descriptorPaths.get(descriptor) === expectedPath) {
            injected = true;
            onFailure();
            const error = new Error('simulated route target fsync failure');
            error.code = 'EIO';
            throw error;
        }
        return originalFsyncSync.call(this, descriptor);
    };
    return {
        get injected() { return injected; },
        restore() {
            fs.openSync = originalOpenSync;
            fs.fsyncSync = originalFsyncSync;
        },
    };
}

test('the Stage4 user root lock blocks character rename while another user proceeds', async () => {
    const renameFixture = writeCharacterFixture(users.a, 'Locked Rename');
    const deleteFixture = writeCharacterFixture(users.b, 'Independent Delete');
    const lock = holdRootLock(users.a);
    await lock.entered;

    const renamePromise = post('a', '/rename', {
        avatar_url: 'Locked Rename.png',
        new_name: 'Renamed After Lock',
    });
    try {
        await assertStillPending(renamePromise, 'rename must wait for the in-flight Stage4 root lock');

        const otherUserDelete = await post('b', '/delete', {
            avatar_url: 'Independent Delete.png',
            delete_chats: true,
        });
        assert.equal(otherUserDelete.response.status, 200);
        assert.equal(fs.existsSync(deleteFixture.avatarPath), false);
        assert.equal(fs.existsSync(deleteFixture.chatPath), false);
        assert.equal(fs.existsSync(renameFixture.avatarPath), true);
    } finally {
        lock.release();
        await lock.held;
    }

    const renamed = await renamePromise;
    assert.equal(renamed.response.status, 200);
    assert.equal(renamed.data.avatar, 'Renamed After Lock.png');
    assert.equal(fs.existsSync(renameFixture.avatarPath), false);
    assert.equal(fs.existsSync(renameFixture.chatPath), false);
    assert.equal(fs.existsSync(path.join(users.a.directories.characters, 'Renamed After Lock.png')), true);
    assert.equal(fs.existsSync(path.join(users.a.directories.chats, 'Renamed After Lock')), true);
});

test('the Stage4 user root lock blocks character delete including chat removal', async () => {
    const fixture = writeCharacterFixture(users.a, 'Locked Delete');
    const lock = holdRootLock(users.a);
    await lock.entered;

    const deletionPromise = post('a', '/delete', {
        avatar_url: 'Locked Delete.png',
        delete_chats: true,
    });
    try {
        await assertStillPending(deletionPromise, 'delete must wait for the in-flight Stage4 root lock');
        assert.equal(fs.existsSync(fixture.avatarPath), true);
        assert.equal(fs.existsSync(fixture.chatPath), true);
    } finally {
        lock.release();
        await lock.held;
    }

    const deleted = await deletionPromise;
    assert.equal(deleted.response.status, 200);
    assert.equal(fs.existsSync(fixture.avatarPath), false);
    assert.equal(fs.existsSync(fixture.chatPath), false);
});

test('rename route succeeds after the commit marker when journal cleanup fails', async () => {
    const fixture = writeCharacterFixture(users.b, 'Cleanup Failure Route');
    const namespace = getCharacterChatJournalNamespace(
        users.b.directories.root,
        users.b.profile.handle,
        users.b.directories,
    );
    const restoreRmSync = injectJournalCleanupFailure(namespace);
    let renamed;
    try {
        renamed = await post('b', '/rename', {
            avatar_url: 'Cleanup Failure Route.png',
            new_name: 'Cleanup Failure Route Renamed',
        });
    } finally {
        restoreRmSync();
    }

    assert.equal(renamed.response.status, 200);
    assert.equal(fs.existsSync(fixture.avatarPath), false);
    assert.equal(fs.existsSync(fixture.chatPath), false);
    assert.equal(fs.existsSync(path.join(
        users.b.directories.characters,
        'Cleanup Failure Route Renamed.png',
    )), true);
    const [retainedName] = fs.readdirSync(namespace);
    assert.match(retainedName, /^cleanup-[a-f0-9]{32}$/);
    const retainedManifest = JSON.parse(fs.readFileSync(path.join(namespace, retainedName, 'manifest.json'), 'utf8'));
    assert.equal(retainedManifest.state, 'committed');
    assert.deepEqual(ensureCharacterChatRecovery(
        users.b.directories.root,
        users.b.profile.handle,
        users.b.directories,
    ), { restored: 0, cleaned: 1 });
});

test('target fsync failure rolls back the route while mutating snapshots remain available', async () => {
    const fixture = writeCharacterFixture(users.a, 'Durability Failure Route');
    const renamedCard = path.join(users.a.directories.characters, 'Durability Failure Route Renamed.png');
    const renamedChats = path.join(users.a.directories.chats, 'Durability Failure Route Renamed');
    const namespace = getCharacterChatJournalNamespace(
        users.a.directories.root,
        users.a.profile.handle,
        users.a.directories,
    );
    let retainedSnapshotsObserved = false;
    const fault = injectTargetFsyncFailure(renamedCard, () => {
        const [transactionName] = fs.readdirSync(namespace);
        const transactionDirectory = path.join(namespace, transactionName);
        const manifest = JSON.parse(fs.readFileSync(path.join(transactionDirectory, 'manifest.json'), 'utf8'));
        retainedSnapshotsObserved = manifest.state === 'mutating'
            && fs.readdirSync(path.join(transactionDirectory, 'snapshot')).length > 0;
    });
    let response;
    try {
        response = await post('a', '/rename', {
            avatar_url: 'Durability Failure Route.png',
            new_name: 'Durability Failure Route Renamed',
        });
    } finally {
        fault.restore();
    }

    assert.equal(response.response.status, 500);
    assert.equal(fault.injected, true);
    assert.equal(retainedSnapshotsObserved, true);
    assert.equal(fs.existsSync(fixture.avatarPath), true);
    assert.equal(fs.existsSync(fixture.chatPath), true);
    assert.equal(fs.existsSync(renamedCard), false);
    assert.equal(fs.existsSync(renamedChats), false);
    assert.deepEqual(fs.readdirSync(namespace), []);
});

test('rename recovery failure precedes mutation and a transient retry succeeds', async () => {
    const fixture = writeCharacterFixture(users.a, 'Recovery Rename');
    const before = snapshotTree(users.a.directories.root);
    const namespace = getChatBranchJournalNamespace(users.a.directories.root, users.a.profile.handle);
    const faultPath = path.join(namespace, 'transient-recovery-fault');
    fs.writeFileSync(faultPath, 'invalid journal artifact');
    resetChatBranchRecoveryForTests();

    const failed = await post('a', '/rename', {
        avatar_url: 'Recovery Rename.png',
        new_name: 'Recovered Rename',
    });
    assert.equal(failed.response.status, 500);
    assert.deepEqual(snapshotTree(users.a.directories.root), before);
    assert.equal(fs.existsSync(fixture.avatarPath), true);
    assert.equal(fs.existsSync(fixture.chatPath), true);

    fs.rmSync(faultPath);
    const retried = await post('a', '/rename', {
        avatar_url: 'Recovery Rename.png',
        new_name: 'Recovered Rename',
    });
    assert.equal(retried.response.status, 200);
    assert.equal(fs.existsSync(path.join(users.a.directories.characters, 'Recovered Rename.png')), true);
    assert.equal(fs.existsSync(path.join(users.a.directories.chats, 'Recovered Rename')), true);
});

test('character/chat recovery failure prevents delete mutation before a successful retry', async () => {
    const fixture = writeCharacterFixture(users.a, 'Recovery Delete');
    const before = snapshotTree(users.a.directories.root);
    const namespace = getCharacterChatJournalNamespace(
        users.a.directories.root,
        users.a.profile.handle,
        users.a.directories,
    );
    fs.mkdirSync(namespace, { recursive: true });
    const faultPath = path.join(namespace, 'transient-delete-recovery-fault');
    fs.writeFileSync(faultPath, 'invalid journal artifact');
    resetChatBranchRecoveryForTests();

    const failed = await post('a', '/delete', {
        avatar_url: 'Recovery Delete.png',
        delete_chats: true,
    });
    assert.equal(failed.response.status, 500);
    assert.deepEqual(snapshotTree(users.a.directories.root), before);
    assert.equal(fs.existsSync(fixture.avatarPath), true);
    assert.equal(fs.existsSync(fixture.chatPath), true);

    fs.rmSync(faultPath);
    const retried = await post('a', '/delete', {
        avatar_url: 'Recovery Delete.png',
        delete_chats: true,
    });
    assert.equal(retried.response.status, 200);
    assert.equal(fs.existsSync(fixture.avatarPath), false);
    assert.equal(fs.existsSync(fixture.chatPath), false);
});

test('character mutation routes reject paths outside user storage', async () => {
    const outsidePath = path.join(users.a.directories.root, 'outside.png');
    fs.writeFileSync(outsidePath, 'outside');

    const renamed = await post('a', '/rename', { avatar_url: '../outside.png', new_name: 'Unsafe Rename' });
    const deleted = await post('a', '/delete', { avatar_url: '../outside.png', delete_chats: true });
    assert.equal(renamed.response.status, 400);
    assert.equal(deleted.response.status, 400);
    assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'outside');
});
