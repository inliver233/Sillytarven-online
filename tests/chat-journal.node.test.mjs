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
    getChatJournalNamespace,
    recoverDurableChatTransactions,
} from '../src/chat-journal.js';
import { setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-chat-journal-'));
const dataRoot = path.join(testRoot, 'data');
const configPath = path.join(testRoot, 'config.yaml');
const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const childPath = fileURLToPath(new URL('./fixtures/chat-journal-crash-child.mjs', import.meta.url));
const config = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
config.performance.chatChunkingEnabled = false;
fs.writeFileSync(configPath, stringifyYaml(config));
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
