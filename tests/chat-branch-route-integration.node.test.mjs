/* eslint-disable playwright/expect-expect -- Node test runner uses assert. */
/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { humanizedDateTime, setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-branch-route-'));
const configPath = path.join(testRoot, 'config.yaml');
const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const config = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
config.userStorage.enabled = true;
config.performance.chatChunkingEnabled = true;
config.performance.chatChunkSize = 200;
config.performance.chatPaging = { enabled: true };
fs.writeFileSync(configPath, stringifyYaml(config));
setConfigFilePath(configPath);
globalThis.DATA_ROOT = path.join(testRoot, 'data');
fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });

const {
    createDurableChatFamilyTransaction,
    createDurableGroupDeleteTransaction,
    getChatBranchJournalNamespace,
    getChatContentHash,
    recoverChatBranchTransactions,
    removeChatBranchFamily,
    renameChatBranchFamily,
    resetChatBranchRecoveryForTests,
    setChatBranchFaultInjectorForTests,
    updateChatBranchGroupMetadata,
} = await import('../src/chat-branch.js');
const { router: chatsRouter } = await import('../src/endpoints/chats.js');
const { router: groupsRouter } = await import('../src/endpoints/groups.js');
const { default: systemMonitor } = await import('../src/system-monitor.js');

const root = path.join(testRoot, 'authenticated-user');
const directories = {
    root,
    chats: path.join(root, 'chats'),
    groupChats: path.join(root, 'group-chats'),
    groups: path.join(root, 'groups'),
    backups: path.join(root, 'backups'),
    characters: path.join(root, 'characters'),
};
for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
const user = { profile: { handle: 'route-user', name: 'Route User', admin: true }, directories };

const app = express();
app.use(express.json({ limit: '20mb' }));
const authenticate = (request, response, next) => {
    if (request.get('authorization') !== 'Bearer stage4-test') return response.sendStatus(401);
    request.user = user;
    const uploadPath = request.get('x-test-upload-path');
    if (uploadPath) {
        request.file = { destination: path.dirname(uploadPath), filename: path.basename(uploadPath) };
    }
    next();
};
app.use('/api/chats', authenticate, chatsRouter);
app.use('/api/groups', authenticate, groupsRouter);
const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
});
const address = server.address();
assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}/api/chats`;
const groupsBaseUrl = `http://127.0.0.1:${address.port}/api/groups`;

after(async () => {
    setChatBranchFaultInjectorForTests(null);
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    systemMonitor.destroy();
    systemMonitor.saveDataToDisk = () => {};
    fs.rmSync(testRoot, { recursive: true, force: true });
});

async function post(route, body, authenticated = true, extraHeaders = {}) {
    const headers = { 'content-type': 'application/json', ...extraHeaders };
    if (authenticated) headers.authorization = 'Bearer stage4-test';
    const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let data = text;
    try {
        data = JSON.parse(text);
    } catch {
        // Status-only responses are valid in these route tests.
    }
    return { response, data };
}

async function postGroup(route, body) {
    const response = await fetch(`${groupsBaseUrl}${route}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: 'Bearer stage4-test',
        },
        body: JSON.stringify(body),
    });
    return { response, data: await response.json() };
}

function makeHeader(marker) {
    return {
        user_name: 'User',
        character_name: 'Character',
        create_date: 'test',
        chat_metadata: { marker, message_count: 6 },
    };
}

function makeMessages(marker, count = 6, payloadSize = 0) {
    const payload = 'x'.repeat(payloadSize);
    return Array.from({ length: count }, (_, index) => ({
        name: index % 2 ? 'Character' : 'User',
        is_user: index % 2 === 0,
        send_date: 1_700_000_000_000 + index,
        mes: `${marker}-${index}-active${payload}`,
        swipes: [`${marker}-${index}-zero${payload}`, `${marker}-${index}-one${payload}`],
        swipe_id: 0,
        extra: { marker, index },
    }));
}

function writeRevision(filePath, revision) {
    fs.writeFileSync(`${filePath}.revision.json`, JSON.stringify({ version: 1, revision }));
}

function writeChatFixture({ family, layout, id, marker, payloadSize = 0, mutateMessages = null }) {
    const group = family === 'group';
    const avatar = `${marker}-avatar`;
    const groupId = `${marker}-group`;
    const directory = group ? directories.groupChats : path.join(directories.chats, avatar);
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, `${id}.jsonl`);
    const header = makeHeader(marker);
    const messages = makeMessages(marker, 6, payloadSize);
    mutateMessages?.(messages);
    const revision = `${marker}-revision`;
    if (layout === 'legacy') {
        fs.writeFileSync(filePath, [header, ...messages].map(value => JSON.stringify(value)).join('\n'));
        fs.writeFileSync(`${filePath}.metadata.json`, JSON.stringify(header));
    } else {
        const chunkDirectory = `${filePath}.chunks`;
        fs.mkdirSync(chunkDirectory);
        const shards = [];
        let totalBytes = 0;
        for (let offset = 0, shardIndex = 0; offset < messages.length; offset += 2, shardIndex++) {
            const values = messages.slice(offset, offset + 2);
            const name = `${String(shardIndex).padStart(6, '0')}.jsonl`;
            const shardPath = path.join(chunkDirectory, name);
            fs.writeFileSync(shardPath, values.map(value => JSON.stringify(value)).join('\n'));
            const size = fs.statSync(shardPath).size;
            totalBytes += size;
            shards.push({
                file: name,
                count: values.length,
                size,
                last_mes: values.at(-1).send_date,
                last_message: values.at(-1).mes,
            });
        }
        fs.writeFileSync(filePath, JSON.stringify(header));
        fs.writeFileSync(`${filePath}.metadata.json`, JSON.stringify(header));
        fs.writeFileSync(`${filePath}.index.json`, JSON.stringify({
            version: 1,
            chunk_size: 2,
            message_count: messages.length,
            last_mes: messages.at(-1).send_date,
            last_message: messages.at(-1).mes,
            total_bytes: totalBytes,
            shards,
        }));
    }
    writeRevision(filePath, revision);
    if (group) {
        fs.writeFileSync(path.join(directories.groups, `${groupId}.json`), JSON.stringify({
            id: groupId,
            name: groupId,
            chat_id: id,
            chats: [id],
        }, null, 4));
    }
    return { family, layout, id, marker, avatar, groupId, filePath, header, messages, revision };
}

function branchBody(fixture, key) {
    return {
        source: fixture.family === 'group'
            ? { type: 'group', groupId: fixture.groupId, chatId: fixture.id }
            : { type: 'solo', avatarUrl: `${fixture.avatar}.png`, chatId: fixture.id },
        absoluteMessageIndex: 3,
        swipeId: 1,
        expectedRevision: fixture.revision,
        expectedContentHash: getChatContentHash(fixture.header, fixture.messages),
        idempotencyKey: key,
    };
}

function readStoredMessages(filePath) {
    if (fs.existsSync(`${filePath}.index.json`)) {
        const index = JSON.parse(fs.readFileSync(`${filePath}.index.json`, 'utf8'));
        return index.shards.flatMap(shard => fs.readFileSync(path.join(`${filePath}.chunks`, shard.file), 'utf8')
            .split('\n').filter(Boolean).map(line => JSON.parse(line)));
    }
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).slice(1).map(line => JSON.parse(line));
}

function directorySize(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
        const filePath = path.join(directory, entry.name);
        return total + (entry.isDirectory() ? directorySize(filePath) : fs.statSync(filePath).size);
    }, 0);
}

function snapshotTree(directory) {
    const result = {};
    const visit = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            const relative = path.relative(directory, fullPath).split(path.sep).join('/');
            if (entry.isDirectory()) {
                result[`${relative}/`] = 'directory';
                visit(fullPath);
            } else {
                result[relative] = fs.readFileSync(fullPath).toString('base64');
            }
        }
    };
    visit(directory);
    return result;
}

function addEmptyChunkChatToGroup(fixture, suffix) {
    const chatId = `${fixture.id}-${suffix}`;
    const filePath = path.join(directories.groupChats, `${chatId}.jsonl`);
    fs.writeFileSync(filePath, JSON.stringify(makeHeader(`${fixture.marker}-${suffix}`)));
    fs.mkdirSync(`${filePath}.chunks`);
    const groupPath = path.join(directories.groups, `${fixture.groupId}.json`);
    const group = JSON.parse(fs.readFileSync(groupPath, 'utf8'));
    group.chats.push(chatId);
    fs.writeFileSync(groupPath, JSON.stringify(group, null, 4));
    return filePath;
}

function assertChatFamilyRemoved(filePath) {
    for (const suffix of ['', '.metadata.json', '.index.json', '.revision.json', '.chunks']) {
        assert.equal(fs.existsSync(`${filePath}${suffix}`), false, `${filePath}${suffix} still exists`);
    }
}

function injectPartialBranchCleanupFailure(namespace) {
    const originalRmSync = fs.rmSync;
    let injected = false;
    fs.rmSync = function (targetPath, options) {
        const absolute = path.resolve(String(targetPath));
        if (!injected && path.dirname(absolute) === path.resolve(namespace)
            && /^cleanup-[a-f0-9]{32}$/.test(path.basename(absolute))) {
            injected = true;
            originalRmSync(path.join(absolute, 'manifest.json'), { force: true });
            originalRmSync(path.join(absolute, 'snapshot'), { recursive: true, force: true });
            throw Object.assign(new Error('injected partial branch cleanup failure'), { code: 'EIO' });
        }
        return originalRmSync.call(this, targetPath, options);
    };
    return () => { fs.rmSync = originalRmSync; };
}

function injectBranchCleanupDeletionFailures(namespace, count, partial = false) {
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
            throw Object.assign(new Error('injected transient branch cleanup deletion failure'), { code: 'EIO' });
        }
        return originalRmSync.call(this, targetPath, options);
    };
    return () => { fs.rmSync = originalRmSync; };
}

function injectBranchFsyncObserver(observer) {
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

function assertAndRecoverPartialCleanup(namespace) {
    const entries = fs.readdirSync(namespace);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^cleanup-[a-f0-9]{32}$/);
    const cleanupDirectory = path.join(namespace, entries[0]);
    assert.equal(fs.existsSync(path.join(cleanupDirectory, 'manifest.json')), false);
    assert.equal(fs.existsSync(path.join(cleanupDirectory, 'snapshot')), false);
    resetChatBranchRecoveryForTests();
    assert.deepEqual(
        recoverChatBranchTransactions(root, user.profile.handle, directories),
        { restored: 0, cleaned: 1 },
    );
    assert.deepEqual(fs.readdirSync(namespace), []);
}

test('authenticated Express branch route enforces 428/409 and returns durable 201/200 idempotency responses', async () => {
    assert.equal((await post('/branch', {}, false)).response.status, 401);
    const fixture = writeChatFixture({ family: 'solo', layout: 'legacy', id: 'route-status-source', marker: 'route-status' });
    const body = branchBody(fixture, 'route-status-key');
    const missingHash = structuredClone(body);
    delete missingHash.expectedContentHash;
    const required = await post('/branch', missingHash);
    assert.equal(required.response.status, 428);
    assert.equal(required.data.error, 'precondition_required');
    assert.deepEqual(required.data.missing, ['expectedContentHash']);

    const conflict = await post('/branch', { ...body, expectedRevision: 'stale' });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.data.error, 'revision_conflict');

    const created = await post('/branch', body);
    assert.equal(created.response.status, 201);
    assert.equal(created.data.ok, true);
    const replay = await post('/branch', body);
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.data, created.data);
});

test('real solo branch route accepts the journal null group participant', async () => {
    const fixture = writeChatFixture({
        family: 'solo',
        layout: 'legacy',
        id: 'route-solo-journal-source',
        marker: 'route-solo-journal',
    });
    let journalGroupPath;
    setChatBranchFaultInjectorForTests(point => {
        if (point !== 'after-journal-mutating') return;
        const namespace = getChatBranchJournalNamespace(directories.root, user.profile.handle, false);
        const transactionName = fs.readdirSync(namespace).find(name => name.startsWith('tx-'));
        assert.ok(transactionName);
        const manifest = JSON.parse(fs.readFileSync(path.join(namespace, transactionName, 'manifest.json'), 'utf8'));
        journalGroupPath = manifest.paths.group;
    });

    try {
        const created = await post('/branch', branchBody(fixture, 'route-solo-journal-key'));
        assert.equal(created.response.status, 201);
        assert.equal(created.data.ok, true);
        assert.equal(journalGroupPath, null);
    } finally {
        setChatBranchFaultInjectorForTests(null);
    }
});

for (const family of ['solo', 'group']) {
    for (const layout of ['legacy', 'chunked']) {
        test(`${layout} ${family} branches through Express preserve the selected swipe and metadata`, async () => {
            const marker = `${layout}-${family}`;
            const fixture = writeChatFixture({ family, layout, id: `${marker}-source`, marker });
            const created = await post('/branch', branchBody(fixture, `${marker}-key`));
            assert.equal(created.response.status, 201);
            const destinationPath = path.join(
                family === 'group' ? directories.groupChats : path.dirname(fixture.filePath),
                `${created.data.chatId}.jsonl`,
            );
            assert.equal(fs.existsSync(destinationPath), true);
            assert.equal(fs.existsSync(`${destinationPath}.index.json`), layout === 'chunked');
            const destination = readStoredMessages(destinationPath);
            assert.equal(destination.length, 4);
            assert.equal(destination.at(-1).mes, `${marker}-3-one`);
            assert.equal(destination.at(-1).swipe_id, 1);
            const source = readStoredMessages(fixture.filePath);
            assert.deepEqual(source[3].extra.branches, [created.data.chatId]);
            const destinationHeader = JSON.parse(fs.readFileSync(`${destinationPath}.metadata.json`, 'utf8'));
            assert.equal(destinationHeader.chat_metadata.main_chat, fixture.id);
            assert.equal(destinationHeader.chat_metadata.message_count, 4);
            assert.equal(created.data.contentHash, getChatContentHash(destinationHeader, destination));
            // eslint-disable-next-line playwright/no-conditional-in-test -- The table-driven fixture validates both chat families.
            if (family === 'group') {
                const group = JSON.parse(fs.readFileSync(path.join(directories.groups, `${fixture.groupId}.json`), 'utf8'));
                assert.equal(group.chat_id, fixture.id);
                assert.deepEqual(group.chats, [fixture.id, created.data.chatId]);
            }
        });
    }
}

for (const [layout, numericChatId] of [['legacy', 910001], ['chunked', 910002]]) {
    test(`${layout} numeric group chat ID branches through the real API and replays idempotently`, async () => {
        const marker = `numeric-${layout}-group`;
        const fixture = writeChatFixture({ family: 'group', layout, id: numericChatId, marker });
        const groupPath = path.join(directories.groups, `${fixture.groupId}.json`);
        const initialGroup = JSON.parse(fs.readFileSync(groupPath, 'utf8'));
        initialGroup.chats.push(920000 + numericChatId, 'preserved-chat-id');
        fs.writeFileSync(groupPath, JSON.stringify(initialGroup, null, 4));

        const body = branchBody(fixture, `${marker}-key`);
        body.source.chatId = String(numericChatId);
        const created = await post('/branch', body);
        assert.equal(created.response.status, 201);
        assert.equal(created.data.ok, true);

        const source = readStoredMessages(fixture.filePath);
        assert.deepEqual(source[3].extra.branches, [created.data.chatId]);
        assert.equal(source[3].mes, `${marker}-3-active`);
        assert.equal(created.data.sourceContentHash, getChatContentHash(fixture.header, source));
        assert.equal(
            JSON.parse(fs.readFileSync(`${fixture.filePath}.revision.json`, 'utf8')).revision,
            created.data.sourceRevision,
        );

        const destinationPath = path.join(directories.groupChats, `${created.data.chatId}.jsonl`);
        assert.equal(fs.existsSync(destinationPath), true);
        assert.equal(fs.existsSync(`${destinationPath}.index.json`), layout === 'chunked');
        const destination = readStoredMessages(destinationPath);
        assert.equal(destination.length, 4);
        assert.equal(destination.at(-1).mes, `${marker}-3-one`);
        assert.equal(destination.at(-1).swipe_id, 1);
        const destinationHeader = JSON.parse(fs.readFileSync(`${destinationPath}.metadata.json`, 'utf8'));
        assert.equal(destinationHeader.chat_metadata.main_chat, String(numericChatId));
        assert.equal(created.data.contentHash, getChatContentHash(destinationHeader, destination));
        assert.equal(
            JSON.parse(fs.readFileSync(`${destinationPath}.revision.json`, 'utf8')).revision,
            created.data.revision,
        );

        const storedGroup = JSON.parse(fs.readFileSync(groupPath, 'utf8'));
        assert.equal(storedGroup.chat_id, numericChatId);
        assert.equal(typeof storedGroup.chat_id, 'number');
        assert.deepEqual(storedGroup.chats, [
            numericChatId,
            920000 + numericChatId,
            'preserved-chat-id',
            created.data.chatId,
        ]);

        const committedTree = snapshotTree(root);
        const replay = await post('/branch', body);
        assert.equal(replay.response.status, 200);
        assert.deepEqual(replay.data, created.data);
        assert.deepEqual(snapshotTree(root), committedTree);
    });
}

test('solo branch route preserves an exact destination name and canonicalizes its alias for idempotency', async () => {
    const fixture = writeChatFixture({
        family: 'solo',
        layout: 'legacy',
        id: 'named-solo-source',
        marker: 'named-solo',
    });
    const body = { ...branchBody(fixture, 'named-solo-key'), destinationName: 'Exact Solo Checkpoint' };
    const created = await post('/branch', body);
    assert.equal(created.response.status, 201);
    assert.equal(created.data.chatId, 'Exact Solo Checkpoint');
    assert.equal(fs.existsSync(path.join(path.dirname(fixture.filePath), 'Exact Solo Checkpoint.jsonl')), true);

    const { destinationName, ...aliasReplayBody } = body;
    const replay = await post('/branch', { ...aliasReplayBody, preferredName: destinationName });
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.data, created.data);

    const mismatch = await post('/branch', { ...body, destinationName: 'Changed Solo Checkpoint' });
    assert.equal(mismatch.response.status, 409);
    assert.equal(mismatch.data.error, 'idempotency_mismatch');
});

test('group branch route applies official deterministic suffixes for every artifact-family collision', async () => {
    const collisions = [
        { label: 'chat', suffix: '', directory: false },
        { label: 'metadata', suffix: '.metadata.json', directory: false },
        { label: 'index', suffix: '.index.json', directory: false },
        { label: 'revision', suffix: '.revision.json', directory: false },
        { label: 'chunks', suffix: '.chunks', directory: true },
    ];
    for (const collision of collisions) {
        const marker = `named-group-${collision.label}`;
        const fixture = writeChatFixture({ family: 'group', layout: 'legacy', id: `${marker}-source`, marker });
        const requestedName = `Exact Group ${collision.label}`;
        const artifactPath = path.join(directories.groupChats, `${requestedName}.jsonl${collision.suffix}`);
        // eslint-disable-next-line playwright/no-conditional-in-test -- Each collision fixture requires its artifact's actual type.
        if (collision.directory) fs.mkdirSync(artifactPath);
        else fs.writeFileSync(artifactPath, 'occupied');

        const created = await post('/branch', {
            ...branchBody(fixture, `${marker}-key`),
            preferredName: requestedName,
        });
        assert.equal(created.response.status, 201, collision.label);
        assert.equal(created.data.chatId, `${requestedName} (1)`, collision.label);
        assert.equal(fs.existsSync(path.join(directories.groupChats, `${requestedName} (1).jsonl`)), true);
    }
});

test('branch route rejects invalid destination filename identities', async () => {
    const fixture = writeChatFixture({
        family: 'solo',
        layout: 'legacy',
        id: 'invalid-name-source',
        marker: 'invalid-name',
    });
    const invalidNames = [
        '',
        null,
        42,
        '.',
        '..',
        '../escape',
        'escape\\child',
        'control\u0001name',
        'sanitize:mismatch',
        'trailing.',
        'x'.repeat(201),
    ];
    for (const [index, destinationName] of invalidNames.entries()) {
        const rejected = await post('/branch', {
            ...branchBody(fixture, `invalid-name-key-${index}`),
            destinationName,
        });
        assert.equal(rejected.response.status, 400, String(destinationName));
        assert.equal(rejected.data.error, 'invalid_destination_name', String(destinationName));
    }

    const conflictingAliases = await post('/branch', {
        ...branchBody(fixture, 'invalid-name-conflicting-aliases'),
        destinationName: 'First name',
        preferredName: 'Second name',
    });
    assert.equal(conflictingAliases.response.status, 400);
    assert.equal(conflictingAliases.data.error, 'invalid_destination_name');
});

test('messages with an implicit sole swipe preserve attachments, reasoning, and metadata', async () => {
    const fixture = writeChatFixture({
        family: 'solo',
        layout: 'legacy',
        id: 'imported-swipe-source',
        marker: 'imported-swipe',
        mutateMessages(messages) {
            Object.assign(messages[3], {
                attachments: [{ name: 'evidence.txt', url: 'user/files/evidence.txt' }],
                reasoning: 'Imported chain of thought metadata',
                gen_started: 'started-before-import',
                gen_finished: 'finished-before-import',
                extra: { marker: 'imported-swipe', index: 3, model: 'legacy-model' },
            });
            delete messages[3].swipes;
            delete messages[3].swipe_id;
            delete messages[3].swipe_info;
        },
    });
    const created = await post('/branch', {
        ...branchBody(fixture, 'imported-swipe-key'),
        swipeId: 0,
        destinationName: 'Imported Swipe Branch',
    });
    assert.equal(created.response.status, 201);
    const destination = readStoredMessages(path.join(path.dirname(fixture.filePath), 'Imported Swipe Branch.jsonl'));
    const expected = structuredClone(fixture.messages[3]);
    expected.swipes = [expected.mes];
    expected.swipe_id = 0;
    assert.deepEqual(destination[3], expected);
});

test('partial swipe_info replaces selected metadata and missing entries honor current-swipe compatibility', async () => {
    const selectedFixture = writeChatFixture({
        family: 'solo',
        layout: 'legacy',
        id: 'partial-selected-source',
        marker: 'partial-selected',
        mutateMessages(messages) {
            Object.assign(messages[3], {
                gen_started: 'keep-started',
                gen_finished: 'replace-finished',
                attachments: [{ name: 'selected.txt' }],
                reasoning: 'keep-selected-reasoning',
                extra: { marker: 'partial-selected', index: 3, keep: true, replace: 'old' },
                swipe_info: [{
                    send_date: 1_800_000_000_000,
                    gen_finished: null,
                    extra: { replace: 'new', added: true },
                }],
            });
        },
    });
    const selectedBody = {
        ...branchBody(selectedFixture, 'partial-selected-key'),
        swipeId: 0,
        preferredName: 'Partial Selected Branch',
    };
    const selectedCreated = await post('/branch', selectedBody);
    assert.equal(selectedCreated.response.status, 201);
    const selectedDestination = readStoredMessages(path.join(path.dirname(selectedFixture.filePath), 'Partial Selected Branch.jsonl'))[3];
    assert.equal(selectedDestination.send_date, 1_800_000_000_000);
    assert.equal(Object.hasOwn(selectedDestination, 'gen_started'), false);
    assert.equal(selectedDestination.gen_finished, null);
    assert.deepEqual(selectedDestination.attachments, [{ name: 'selected.txt' }]);
    assert.equal(selectedDestination.reasoning, 'keep-selected-reasoning');
    assert.deepEqual(selectedDestination.extra, { replace: 'new', added: true });

    const absentFixture = writeChatFixture({
        family: 'solo',
        layout: 'legacy',
        id: 'partial-absent-source',
        marker: 'partial-absent',
        mutateMessages(messages) {
            Object.assign(messages[3], {
                gen_started: 'clear-absent-started',
                gen_finished: 'clear-absent-finished',
                extra: {
                    attachments: [{ name: 'absent.txt' }],
                    reasoning: 'clear-absent-reasoning',
                    marker: 'partial-absent',
                    index: 3,
                },
                swipe_info: [{ send_date: 1_900_000_000_000, extra: { ignored: true } }],
            });
        },
    });
    const absentCreated = await post('/branch', {
        ...branchBody(absentFixture, 'partial-absent-key'),
        destinationName: 'Partial Absent Branch',
    });
    assert.equal(absentCreated.response.status, 201);
    const absentDestination = readStoredMessages(path.join(path.dirname(absentFixture.filePath), 'Partial Absent Branch.jsonl'))[3];
    assert.equal(absentDestination.mes, absentFixture.messages[3].swipes[1]);
    assert.equal(absentDestination.send_date, absentFixture.messages[3].send_date);
    assert.equal(Object.hasOwn(absentDestination, 'gen_started'), false);
    assert.equal(Object.hasOwn(absentDestination, 'gen_finished'), false);
    assert.deepEqual(absentDestination.extra, {});

    const currentFixture = writeChatFixture({
        family: 'solo',
        layout: 'legacy',
        id: 'current-info-absent-source',
        marker: 'current-info-absent',
        mutateMessages(messages) {
            Object.assign(messages[3], {
                gen_started: 'keep-current-started',
                gen_finished: 'keep-current-finished',
                extra: { attachments: [{ name: 'current.txt' }], reasoning: 'keep current reasoning' },
            });
            delete messages[3].swipe_info;
        },
    });
    const currentCreated = await post('/branch', {
        ...branchBody(currentFixture, 'current-info-absent-key'),
        swipeId: 0,
        destinationName: 'Current Info Absent Branch',
    });
    assert.equal(currentCreated.response.status, 201);
    const currentDestination = readStoredMessages(path.join(path.dirname(currentFixture.filePath), 'Current Info Absent Branch.jsonl'))[3];
    const currentExpected = structuredClone(currentFixture.messages[3]);
    currentExpected.mes = currentExpected.swipes[0];
    assert.deepEqual(currentDestination, currentExpected);
});

test('concurrent branches from different chats reserve quota in one per-user lock domain', async () => {
    const firstFixture = writeChatFixture({
        family: 'solo',
        layout: 'legacy',
        id: 'quota-race-source-a',
        marker: 'quota-race-a',
        payloadSize: 20_000,
    });
    const secondFixture = writeChatFixture({
        family: 'solo',
        layout: 'legacy',
        id: 'quota-race-source-b',
        marker: 'quota-race-b',
        payloadSize: 20_000,
    });
    const destinationHeader = structuredClone(firstFixture.header);
    const destinationMessages = firstFixture.messages.slice(0, 3).map(message => structuredClone(message));
    const selected = structuredClone(firstFixture.messages[3]);
    selected.swipe_id = 1;
    selected.mes = selected.swipes[1];
    destinationMessages.push(selected);
    destinationHeader.chat_metadata.main_chat = firstFixture.id;
    destinationHeader.chat_metadata.message_count = destinationMessages.length;
    destinationHeader.chat_metadata.last_mes = selected.send_date;
    destinationHeader.chat_metadata.last_message = selected.mes;
    const serializedBytes = Buffer.byteLength([destinationHeader, ...destinationMessages]
        .map(value => JSON.stringify(value)).join('\n'), 'utf8');
    const usedBytes = directorySize(directories.root);
    user.profile.storageLimitMiB = (usedBytes + serializedBytes * 2 + 10_000) / (1024 * 1024);

    let releaseFirst;
    let signalFirstEntered;
    let journalEntries = 0;
    const firstEntered = new Promise(resolve => { signalFirstEntered = resolve; });
    const release = new Promise(resolve => { releaseFirst = resolve; });
    setChatBranchFaultInjectorForTests(async point => {
        if (point !== 'after-journal-mutating') return;
        journalEntries++;
        if (journalEntries === 1) {
            signalFirstEntered();
            await release;
        }
    });

    const firstPromise = post('/branch', branchBody(firstFixture, 'quota-race-key-a'));
    await firstEntered;
    const secondPromise = post('/branch', branchBody(secondFixture, 'quota-race-key-b'));
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(journalEntries, 1);
    releaseFirst();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    setChatBranchFaultInjectorForTests(null);
    user.profile.storageLimitMiB = 50;

    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 403);
    assert.equal(second.data.error, 'storage_limit');
    assert.equal(journalEntries, 1);
});

test('live rollback partial cleanup is safe for branch, chat-family rename, and group-delete journals', async () => {
    const namespace = getChatBranchJournalNamespace(root, user.profile.handle);

    const branchFixture = writeChatFixture({
        family: 'solo',
        layout: 'chunked',
        id: 'rollback-cleanup-branch-source',
        marker: 'rollback-cleanup-branch',
    });
    let before = snapshotTree(root);
    let restoreRmSync = injectBranchCleanupDeletionFailures(namespace, 1, true);
    setChatBranchFaultInjectorForTests(point => {
        if (point === 'after-destination-publish') throw new Error('injected branch rollback cleanup fault');
    });
    let branchResult;
    try {
        branchResult = await post('/branch', branchBody(branchFixture, 'rollback-cleanup-branch-key'));
    } finally {
        setChatBranchFaultInjectorForTests(null);
        restoreRmSync();
    }
    assert.equal(branchResult.response.status, 500);
    assert.deepEqual(snapshotTree(root), before);
    assertAndRecoverPartialCleanup(namespace);

    const renameFixture = writeChatFixture({
        family: 'solo',
        layout: 'chunked',
        id: 'rollback-cleanup-rename-source',
        marker: 'rollback-cleanup-rename',
    });
    const renameDestination = path.join(path.dirname(renameFixture.filePath), 'rollback-cleanup-rename-destination.jsonl');
    before = snapshotTree(root);
    const renameTransaction = createDurableChatFamilyTransaction({
        root,
        handle: user.profile.handle,
        directories,
        operation: 'rename',
        sourcePath: renameFixture.filePath,
        destinationPath: renameDestination,
    });
    renameTransaction.markMutating();
    await renameChatBranchFamily(root, renameFixture.filePath, renameDestination);
    restoreRmSync = injectBranchCleanupDeletionFailures(namespace, 1, true);
    try {
        assert.doesNotThrow(() => renameTransaction.rollback());
    } finally {
        restoreRmSync();
    }
    assert.deepEqual(snapshotTree(root), before);
    assertAndRecoverPartialCleanup(namespace);

    const deleteFixture = writeChatFixture({
        family: 'group',
        layout: 'chunked',
        id: 'rollback-cleanup-delete-source',
        marker: 'rollback-cleanup-delete',
    });
    const groupPath = path.join(directories.groups, `${deleteFixture.groupId}.json`);
    before = snapshotTree(root);
    const deleteTransaction = createDurableGroupDeleteTransaction({
        root,
        handle: user.profile.handle,
        directories,
        groupId: deleteFixture.groupId,
        groupPath,
        chatPaths: [deleteFixture.filePath],
    });
    deleteTransaction.markMutating();
    removeChatBranchFamily(root, deleteFixture.filePath);
    fs.rmSync(groupPath);
    restoreRmSync = injectBranchCleanupDeletionFailures(namespace, 1, true);
    try {
        assert.doesNotThrow(() => deleteTransaction.rollback());
    } finally {
        restoreRmSync();
    }
    assert.deepEqual(snapshotTree(root), before);
    assertAndRecoverPartialCleanup(namespace);
});

test('group-delete rollback fsyncs restored participants and storage roots before rolled-back', () => {
    const fixture = writeChatFixture({
        family: 'group',
        layout: 'chunked',
        id: 'rollback-fsync-delete-source',
        marker: 'rollback-fsync-delete',
    });
    const groupPath = path.join(directories.groups, `${fixture.groupId}.json`);
    const chunkDirectory = `${fixture.filePath}.chunks`;
    const expectedFiles = [
        fixture.filePath,
        `${fixture.filePath}.metadata.json`,
        `${fixture.filePath}.index.json`,
        `${fixture.filePath}.revision.json`,
        ...fs.readdirSync(chunkDirectory).map(name => path.join(chunkDirectory, name)),
        groupPath,
    ];
    const transaction = createDurableGroupDeleteTransaction({
        root,
        handle: user.profile.handle,
        directories,
        groupId: fixture.groupId,
        groupPath,
        chatPaths: [fixture.filePath],
    });
    transaction.markMutating();
    removeChatBranchFamily(root, fixture.filePath);
    fs.rmSync(groupPath);

    const syncOrder = [];
    let rolledBackAt = -1;
    const restoreFsync = injectBranchFsyncObserver(syncedPath => {
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
        ...expectedFiles,
        chunkDirectory,
        directories.chats,
        directories.groupChats,
        directories.groups,
        root,
    ].map(filePath => path.resolve(filePath));
    assert.ok(rolledBackAt >= 0, 'the rolled-back branch manifest must become observable during fsync');
    for (const expectedPath of expectedBeforeTerminal) {
        const syncedAt = syncOrder.indexOf(expectedPath);
        assert.ok(syncedAt >= 0, `missing restored branch-state fsync for ${expectedPath}`);
        assert.ok(syncedAt < rolledBackAt, `${expectedPath} was fsynced after rolled-back became visible`);
    }
});

test('retained branch cleanup retries in-process before any later branch writes', async () => {
    const namespace = getChatBranchJournalNamespace(root, user.profile.handle);
    const committedFixture = writeChatFixture({
        family: 'solo',
        layout: 'legacy',
        id: 'cleanup-retry-committed-source',
        marker: 'cleanup-retry-committed',
    });
    const restoreRmSync = injectBranchCleanupDeletionFailures(namespace, 2);
    let committed;
    try {
        committed = await post('/branch', branchBody(committedFixture, 'cleanup-retry-committed-key'));
        assert.equal(committed.response.status, 201);

        const blockedFixture = writeChatFixture({
            family: 'solo',
            layout: 'legacy',
            id: 'cleanup-retry-blocked-source',
            marker: 'cleanup-retry-blocked',
        });
        const blockedBefore = snapshotTree(root);
        const blockedBody = branchBody(blockedFixture, 'cleanup-retry-blocked-key');
        const blocked = await post('/branch', blockedBody);
        assert.equal(blocked.response.status, 500);
        assert.deepEqual(snapshotTree(root), blockedBefore);
        assert.equal(fs.readdirSync(namespace).length, 1);

        restoreRmSync();
        const retried = await post('/branch', blockedBody);
        assert.equal(retried.response.status, 201);
        assert.deepEqual(fs.readdirSync(namespace), []);
        return;
    } finally {
        restoreRmSync();
    }
});

test('committed partial cleanup retries safely for branch, chat-family rename, and group-delete journals', async () => {
    const namespace = getChatBranchJournalNamespace(root, user.profile.handle);

    const branchFixture = writeChatFixture({
        family: 'solo',
        layout: 'legacy',
        id: 'partial-cleanup-branch-source',
        marker: 'partial-cleanup-branch',
    });
    let restoreRmSync = injectPartialBranchCleanupFailure(namespace);
    let branch;
    try {
        branch = await post('/branch', branchBody(branchFixture, 'partial-cleanup-branch-key'));
    } finally {
        restoreRmSync();
    }
    assert.equal(branch.response.status, 201);
    const branchDestination = path.join(path.dirname(branchFixture.filePath), `${branch.data.chatId}.jsonl`);
    assert.equal(fs.existsSync(branchDestination), true);
    assertAndRecoverPartialCleanup(namespace);
    assert.equal(fs.existsSync(branchDestination), true);

    const renameFixture = writeChatFixture({
        family: 'solo',
        layout: 'chunked',
        id: 'partial-cleanup-rename-source',
        marker: 'partial-cleanup-rename',
    });
    const renameDestinationId = 'partial-cleanup-rename-destination';
    restoreRmSync = injectPartialBranchCleanupFailure(namespace);
    let renamed;
    try {
        renamed = await post('/rename', {
            avatar_url: `${renameFixture.avatar}.png`,
            original_file: `${renameFixture.id}.jsonl`,
            renamed_file: `${renameDestinationId}.jsonl`,
            is_group: false,
        });
    } finally {
        restoreRmSync();
    }
    assert.equal(renamed.response.status, 200);
    const renameDestination = path.join(path.dirname(renameFixture.filePath), `${renameDestinationId}.jsonl`);
    assert.equal(fs.existsSync(renameFixture.filePath), false);
    assert.equal(fs.existsSync(renameDestination), true);
    assertAndRecoverPartialCleanup(namespace);
    assert.equal(fs.existsSync(renameDestination), true);

    const deleteFixture = writeChatFixture({
        family: 'group',
        layout: 'chunked',
        id: 'partial-cleanup-delete-source',
        marker: 'partial-cleanup-delete',
    });
    restoreRmSync = injectPartialBranchCleanupFailure(namespace);
    let deleted;
    try {
        deleted = await postGroup('/delete', { id: deleteFixture.groupId });
    } finally {
        restoreRmSync();
    }
    assert.equal(deleted.response.status, 200);
    assertChatFamilyRemoved(deleteFixture.filePath);
    assert.equal(fs.existsSync(path.join(directories.groups, `${deleteFixture.groupId}.json`)), false);
    assertAndRecoverPartialCleanup(namespace);
    assertChatFamilyRemoved(deleteFixture.filePath);
});

test('group deletion waits for branch commit and removes complete source and branch families', async () => {
    const fixture = writeChatFixture({ family: 'group', layout: 'chunked', id: 'delete-race-source', marker: 'delete-race' });
    let releaseBranch;
    let signalPublished;
    const published = new Promise(resolve => { signalPublished = resolve; });
    const release = new Promise(resolve => { releaseBranch = resolve; });
    setChatBranchFaultInjectorForTests(async point => {
        if (point !== 'after-destination-publish') return;
        signalPublished();
        await release;
    });

    const branchPromise = post('/branch', branchBody(fixture, 'delete-race-key'));
    await published;
    let deletionSettled = false;
    const deletionPromise = postGroup('/delete', { id: fixture.groupId }).finally(() => { deletionSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(deletionSettled, false);
    releaseBranch();
    const [branch, deletion] = await Promise.all([branchPromise, deletionPromise]);
    setChatBranchFaultInjectorForTests(null);

    assert.equal(branch.response.status, 201);
    assert.equal(deletion.response.status, 200);
    assert.deepEqual(deletion.data, { ok: true });
    const destinationPath = path.join(directories.groupChats, `${branch.data.chatId}.jsonl`);
    assertChatFamilyRemoved(fixture.filePath);
    assertChatFamilyRemoved(destinationPath);
    assert.equal(fs.existsSync(path.join(directories.groups, `${fixture.groupId}.json`)), false);
});

test('group deletion rolls back every participant after injected partial I/O', async () => {
    const fixture = writeChatFixture({ family: 'group', layout: 'chunked', id: 'delete-fault-source', marker: 'delete-fault' });
    const before = snapshotTree(directories.root);
    setChatBranchFaultInjectorForTests(point => {
        if (point === 'after-group-delete-metadata-removal') throw new Error('injected group delete failure');
    });
    const deletion = await postGroup('/delete', { id: fixture.groupId });
    setChatBranchFaultInjectorForTests(null);

    assert.equal(deletion.response.status, 500);
    assert.equal(deletion.data.error, 'group_delete_failed');
    assert.deepEqual(snapshotTree(directories.root), before);
});

test('group deletion fault and restart recovery restore empty chunk directories exactly', async () => {
    const fixture = writeChatFixture({
        family: 'group',
        layout: 'legacy',
        id: 'delete-empty-chunks-source',
        marker: 'delete-empty-chunks',
    });
    const emptyChunkChatPath = addEmptyChunkChatToGroup(fixture, 'empty');
    const groupPath = path.join(directories.groups, `${fixture.groupId}.json`);
    const chatPaths = [fixture.filePath, emptyChunkChatPath];
    const before = snapshotTree(directories.root);

    setChatBranchFaultInjectorForTests(point => {
        if (point === 'after-group-delete-metadata-removal') throw new Error('injected empty chunk delete failure');
    });
    const deletion = await postGroup('/delete', { id: fixture.groupId });
    setChatBranchFaultInjectorForTests(null);
    assert.equal(deletion.response.status, 500);
    assert.deepEqual(snapshotTree(directories.root), before);
    assert.deepEqual(fs.readdirSync(`${emptyChunkChatPath}.chunks`), []);

    const transaction = createDurableGroupDeleteTransaction({
        root: directories.root,
        handle: user.profile.handle,
        directories,
        groupId: fixture.groupId,
        groupPath,
        chatPaths,
    });
    transaction.markMutating();
    for (const chatPath of chatPaths) removeChatBranchFamily(directories.root, chatPath);
    fs.rmSync(groupPath);

    resetChatBranchRecoveryForTests();
    assert.deepEqual(
        recoverChatBranchTransactions(directories.root, user.profile.handle, directories),
        { restored: 1, cleaned: 0 },
    );
    assert.deepEqual(snapshotTree(directories.root), before);
    assert.deepEqual(fs.readdirSync(`${emptyChunkChatPath}.chunks`), []);
});

test('incomplete group deletion is recovered after a simulated process restart', () => {
    const fixture = writeChatFixture({ family: 'group', layout: 'chunked', id: 'delete-restart-source', marker: 'delete-restart' });
    const groupPath = path.join(directories.groups, `${fixture.groupId}.json`);
    const before = snapshotTree(directories.root);
    const transaction = createDurableGroupDeleteTransaction({
        root: directories.root,
        handle: user.profile.handle,
        directories,
        groupId: fixture.groupId,
        groupPath,
        chatPaths: [fixture.filePath],
    });
    transaction.markMutating();
    removeChatBranchFamily(directories.root, fixture.filePath);
    fs.rmSync(groupPath);

    resetChatBranchRecoveryForTests();
    assert.deepEqual(
        recoverChatBranchTransactions(directories.root, user.profile.handle, directories),
        { restored: 1, cleaned: 0 },
    );
    assert.deepEqual(snapshotTree(directories.root), before);
});

test('exact quota boundary includes source, destination, group, revisions, and idempotency bytes', async () => {
    user.profile.storageLimitMiB = 50;
    const first = writeChatFixture({ family: 'group', layout: 'legacy', id: 'quota-exact-a-source', marker: 'quota-exact-a' });
    const firstBefore = directorySize(directories.root);
    const firstBranch = await post('/branch', branchBody(first, 'quota-exact-key-a'));
    assert.equal(firstBranch.response.status, 201);
    const exactGrowth = directorySize(directories.root) - firstBefore;
    assert.ok(exactGrowth > 0);

    const second = writeChatFixture({ family: 'group', layout: 'legacy', id: 'quota-exact-b-source', marker: 'quota-exact-b' });
    const secondBefore = directorySize(directories.root);
    user.profile.storageLimitMiB = (secondBefore + exactGrowth - 1) / (1024 * 1024);
    const rejected = await post('/branch', branchBody(second, 'quota-exact-key-b'));
    assert.equal(rejected.response.status, 403);
    assert.equal(rejected.data.error, 'storage_limit');
    assert.equal(directorySize(directories.root), secondBefore);

    user.profile.storageLimitMiB = (secondBefore + exactGrowth) / (1024 * 1024);
    const accepted = await post('/branch', branchBody(second, 'quota-exact-key-b'));
    user.profile.storageLimitMiB = 50;
    assert.equal(accepted.response.status, 201);
    assert.equal(directorySize(directories.root) - secondBefore, exactGrowth);
});

test('branch and save-tail serialize in the shared chat storage mutex domain', async () => {
    const fixture = writeChatFixture({ family: 'solo', layout: 'chunked', id: 'mutex-source', marker: 'mutex' });
    const body = branchBody(fixture, 'mutex-key');
    let releaseBranch;
    let signalEntered;
    const entered = new Promise(resolve => { signalEntered = resolve; });
    const release = new Promise(resolve => { releaseBranch = resolve; });
    setChatBranchFaultInjectorForTests(async point => {
        if (point !== 'after-destination-publish') return;
        signalEntered();
        await release;
    });

    const branchPromise = post('/branch', body);
    await entered;
    const tailPromise = post('/save-tail', {
        avatar_url: `${fixture.avatar}.png`,
        ch_name: 'Character',
        file_name: fixture.id,
        header: fixture.header,
        messages: fixture.messages.slice(2),
        before: 2,
        expectedRevision: fixture.revision,
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    releaseBranch();
    const [branch, tail] = await Promise.all([branchPromise, tailPromise]);
    setChatBranchFaultInjectorForTests(null);

    assert.equal(branch.response.status, 201);
    assert.equal(tail.response.status, 409);
    assert.equal(tail.data.error, 'revision_conflict');
    const source = readStoredMessages(fixture.filePath);
    assert.equal(source.length, fixture.messages.length);
    assert.deepEqual(source[3].extra.branches, [branch.data.chatId]);
});

test('full saves preserve committed branch links and reject an explicit stale revision', async () => {
    const compatible = writeChatFixture({
        family: 'solo',
        layout: 'chunked',
        id: 'full-save-branch-compatible',
        marker: 'full-save-branch-compatible',
    });
    const staleChat = [structuredClone(compatible.header), ...structuredClone(compatible.messages)];
    const branched = await post('/branch', branchBody(compatible, 'full-save-compatible-key'));
    assert.equal(branched.response.status, 201);

    const legacySave = await post('/save', {
        avatar_url: `${compatible.avatar}.png`,
        ch_name: 'Character',
        file_name: compatible.id,
        chat: staleChat,
    });
    assert.equal(legacySave.response.status, 200);
    assert.deepEqual(readStoredMessages(compatible.filePath)[3].extra.branches, [branched.data.chatId]);

    const guarded = writeChatFixture({
        family: 'solo',
        layout: 'chunked',
        id: 'full-save-branch-guarded',
        marker: 'full-save-branch-guarded',
    });
    const guardedStaleChat = [structuredClone(guarded.header), ...structuredClone(guarded.messages)];
    const guardedBranch = await post('/branch', branchBody(guarded, 'full-save-guarded-key'));
    assert.equal(guardedBranch.response.status, 201);
    const afterBranch = snapshotTree(path.dirname(guarded.filePath));
    const rejected = await post('/save', {
        avatar_url: `${guarded.avatar}.png`,
        ch_name: 'Character',
        file_name: guarded.id,
        chat: guardedStaleChat,
        expectedRevision: guarded.revision,
    });
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.data.error, 'revision_conflict');
    assert.deepEqual(snapshotTree(path.dirname(guarded.filePath)), afterBranch);
    assert.deepEqual(readStoredMessages(guarded.filePath)[3].extra.branches, [guardedBranch.data.chatId]);
});

test('branch transactions serialize with rename, delete, and legacy conversion routes', async () => {
    const cases = [
        {
            name: 'rename',
            start: fixture => post('/rename', {
                avatar_url: `${fixture.avatar}.png`,
                original_file: `${fixture.id}.jsonl`,
                renamed_file: `${fixture.id}-renamed.jsonl`,
                is_group: false,
            }),
            verify: (fixture, result) => {
                assert.equal(result.response.status, 200);
                const renamedPath = path.join(path.dirname(fixture.filePath), `${fixture.id}-renamed.jsonl`);
                assert.equal(fs.existsSync(fixture.filePath), false);
                assert.deepEqual(readStoredMessages(renamedPath)[3].extra.branches.length, 1);
            },
        },
        {
            name: 'delete',
            start: fixture => post('/delete', {
                avatar_url: `${fixture.avatar}.png`,
                chatfile: `${fixture.id}.jsonl`,
            }),
            verify: (fixture, result) => {
                assert.equal(result.response.status, 200);
                assertChatFamilyRemoved(fixture.filePath);
            },
        },
        {
            name: 'conversion',
            start: fixture => post('/get', {
                avatar_url: `${fixture.avatar}.png`,
                file_name: fixture.id,
            }),
            verify: (fixture, result) => {
                assert.equal(result.response.status, 200);
                assert.equal(fs.existsSync(`${fixture.filePath}.index.json`), true);
                assert.deepEqual(result.data[4].extra.branches.length, 1);
            },
        },
    ];

    for (const operation of cases) {
        const fixture = writeChatFixture({
            family: 'solo',
            layout: 'legacy',
            id: `branch-${operation.name}-source`,
            marker: `branch-${operation.name}`,
        });
        let releaseBranch;
        let signalEntered;
        const entered = new Promise(resolve => { signalEntered = resolve; });
        const release = new Promise(resolve => { releaseBranch = resolve; });
        setChatBranchFaultInjectorForTests(async point => {
            if (point !== 'after-destination-publish') return;
            signalEntered();
            await release;
        });

        const branchPromise = post('/branch', branchBody(fixture, `branch-${operation.name}-key`));
        await entered;
        let operationSettled = false;
        const operationPromise = operation.start(fixture).finally(() => { operationSettled = true; });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(operationSettled, false, operation.name);
        releaseBranch();
        const [branch, operationResult] = await Promise.all([branchPromise, operationPromise]);
        setChatBranchFaultInjectorForTests(null);
        assert.equal(branch.response.status, 201, operation.name);
        operation.verify(fixture, operationResult);
    }
});

test('durable rename preserves empty chunk directories, rejects family collisions, and rolls back faults', async () => {
    const empty = writeChatFixture({
        family: 'solo',
        layout: 'legacy',
        id: 'rename-empty-source',
        marker: 'rename-empty',
    });
    fs.mkdirSync(`${empty.filePath}.chunks`);
    const emptyDestination = path.join(path.dirname(empty.filePath), 'rename-empty-destination.jsonl');
    const renamed = await post('/rename', {
        avatar_url: `${empty.avatar}.png`,
        original_file: path.basename(empty.filePath),
        renamed_file: path.basename(emptyDestination),
        is_group: false,
    });
    assert.equal(renamed.response.status, 200);
    assert.equal(fs.existsSync(`${empty.filePath}.chunks`), false);
    assert.deepEqual(fs.readdirSync(`${emptyDestination}.chunks`), []);

    const collision = writeChatFixture({
        family: 'solo',
        layout: 'legacy',
        id: 'rename-collision-source',
        marker: 'rename-collision',
    });
    const collisionDestination = path.join(path.dirname(collision.filePath), 'rename-collision-destination.jsonl');
    fs.mkdirSync(`${collisionDestination}.chunks`);
    const rejected = await post('/rename', {
        avatar_url: `${collision.avatar}.png`,
        original_file: path.basename(collision.filePath),
        renamed_file: path.basename(collisionDestination),
        is_group: false,
    });
    assert.equal(rejected.response.status, 400);
    assert.equal(fs.existsSync(collision.filePath), true);
    assert.deepEqual(fs.readdirSync(`${collisionDestination}.chunks`), []);

    const faulted = writeChatFixture({
        family: 'solo',
        layout: 'chunked',
        id: 'rename-fault-source',
        marker: 'rename-fault',
    });
    const faultDestination = path.join(path.dirname(faulted.filePath), 'rename-fault-destination.jsonl');
    const before = snapshotTree(path.dirname(faulted.filePath));
    setChatBranchFaultInjectorForTests(async point => {
        if (point === 'after-chat-family-rename-artifact') throw new Error('rename fault');
    });
    const failed = await post('/rename', {
        avatar_url: `${faulted.avatar}.png`,
        original_file: path.basename(faulted.filePath),
        renamed_file: path.basename(faultDestination),
        is_group: false,
    });
    setChatBranchFaultInjectorForTests(null);
    assert.equal(failed.response.status, 500);
    assert.deepEqual(snapshotTree(path.dirname(faulted.filePath)), before);
    assert.equal(fs.existsSync(faultDestination), false);
});

test('group chat rename commits active and inactive history metadata with the chat family', async () => {
    const fixture = writeChatFixture({
        family: 'group',
        layout: 'chunked',
        id: 'rename-group-active-source',
        marker: 'rename-group-active',
    });
    const groupPath = path.join(directories.groups, `${fixture.groupId}.json`);
    const activeDestination = 'rename-group-active-destination';
    const activeResult = await post('/rename', {
        is_group: true,
        group_id: fixture.groupId,
        original_file: `${fixture.id}.jsonl`,
        renamed_file: `${activeDestination}.jsonl`,
    });
    assert.equal(activeResult.response.status, 200);
    assert.deepEqual(activeResult.data.group, JSON.parse(fs.readFileSync(groupPath, 'utf8')));
    assert.equal(activeResult.data.group.chat_id, activeDestination);
    assert.deepEqual(activeResult.data.group.chats, [activeDestination]);
    assert.equal(fs.existsSync(path.join(directories.groupChats, `${activeDestination}.jsonl.chunks`)), true);

    const inactiveId = 'rename-group-inactive-source';
    const inactivePath = path.join(directories.groupChats, `${inactiveId}.jsonl`);
    fs.writeFileSync(inactivePath, JSON.stringify(makeHeader('rename-group-inactive')));
    fs.mkdirSync(`${inactivePath}.chunks`);
    const beforeInactive = JSON.parse(fs.readFileSync(groupPath, 'utf8'));
    beforeInactive.chats.push(inactiveId);
    fs.writeFileSync(groupPath, JSON.stringify(beforeInactive, null, 4));

    const inactiveDestination = 'rename-group-inactive-destination';
    const inactiveResult = await post('/rename', {
        is_group: true,
        group_id: fixture.groupId,
        original_file: `${inactiveId}.jsonl`,
        renamed_file: `${inactiveDestination}.jsonl`,
    });
    assert.equal(inactiveResult.response.status, 200);
    const storedInactiveGroup = JSON.parse(fs.readFileSync(groupPath, 'utf8'));
    assert.deepEqual(inactiveResult.data.group, storedInactiveGroup);
    assert.equal(storedInactiveGroup.chat_id, activeDestination);
    assert.deepEqual(storedInactiveGroup.chats, [activeDestination, inactiveDestination]);
    assert.equal(fs.existsSync(`${inactivePath}.chunks`), false);
    assert.deepEqual(fs.readdirSync(path.join(directories.groupChats, `${inactiveDestination}.jsonl.chunks`)), []);
});

test('group chat rename canonicalizes numeric IDs and preserves an inactive pointer type', async () => {
    const activeFixture = writeChatFixture({
        family: 'group',
        layout: 'chunked',
        id: 123,
        marker: 'rename-group-numeric-active',
    });
    const activeGroupPath = path.join(directories.groups, `${activeFixture.groupId}.json`);
    const numericGroup = JSON.parse(fs.readFileSync(activeGroupPath, 'utf8'));
    assert.deepEqual(numericGroup.chats, [123]);
    assert.equal(numericGroup.chat_id, 123);

    const activeDestination = 'numeric-active-renamed';
    const activeResult = await post('/rename', {
        is_group: true,
        group_id: activeFixture.groupId,
        original_file: '123.jsonl',
        renamed_file: `${activeDestination}.jsonl`,
    });
    assert.equal(activeResult.response.status, 200);
    assert.deepEqual(activeResult.data.group.chats, [activeDestination]);
    assert.equal(activeResult.data.group.chat_id, activeDestination);
    assert.equal(fs.existsSync(path.join(directories.groupChats, '123.jsonl')), false);
    assert.equal(fs.existsSync(path.join(directories.groupChats, `${activeDestination}.jsonl`)), true);

    const inactiveFixture = writeChatFixture({
        family: 'group',
        layout: 'legacy',
        id: 456,
        marker: 'rename-group-mixed-inactive',
    });
    const inactiveGroupPath = path.join(directories.groups, `${inactiveFixture.groupId}.json`);
    const mixedGroup = JSON.parse(fs.readFileSync(inactiveGroupPath, 'utf8'));
    mixedGroup.chat_id = 789;
    mixedGroup.chats = [789, 'other-chat', 456];
    fs.writeFileSync(inactiveGroupPath, JSON.stringify(mixedGroup, null, 4));

    const inactiveDestination = 'mixed-inactive-renamed';
    const inactiveResult = await post('/rename', {
        is_group: true,
        group_id: inactiveFixture.groupId,
        original_file: '456.jsonl',
        renamed_file: `${inactiveDestination}.jsonl`,
    });
    assert.equal(inactiveResult.response.status, 200);
    assert.deepEqual(inactiveResult.data.group.chats, [789, 'other-chat', inactiveDestination]);
    assert.equal(inactiveResult.data.group.chat_id, 789);
    assert.equal(typeof inactiveResult.data.group.chat_id, 'number');
    assert.deepEqual(inactiveResult.data.group, JSON.parse(fs.readFileSync(inactiveGroupPath, 'utf8')));
});

test('group chat rename rolls back every artifact and group write fault, while committed marker remains visible', async () => {
    const faultPoints = [
        'after-chat-family-rename-artifact',
        'after-chat-family-rename-chunk-directory',
        'after-chat-family-rename-group-write',
    ];
    for (const [index, faultPoint] of faultPoints.entries()) {
        const fixture = writeChatFixture({
            family: 'group',
            layout: 'chunked',
            id: `rename-group-fault-source-${index}`,
            marker: `rename-group-fault-${index}`,
        });
        const groupPath = path.join(directories.groups, `${fixture.groupId}.json`);
        const before = snapshotTree(root);
        setChatBranchFaultInjectorForTests(async point => {
            if (point === faultPoint) throw new Error(`rename fault: ${faultPoint}`);
        });
        const result = await post('/rename', {
            is_group: true,
            group_id: fixture.groupId,
            original_file: `${fixture.id}.jsonl`,
            renamed_file: `${fixture.id}-destination.jsonl`,
        });
        setChatBranchFaultInjectorForTests(null);
        assert.equal(result.response.status, 500);
        assert.deepEqual(snapshotTree(root), before, faultPoint);
        assert.deepEqual(JSON.parse(fs.readFileSync(groupPath, 'utf8')).chats, [fixture.id]);
    }

    const committed = writeChatFixture({
        family: 'group',
        layout: 'legacy',
        id: 'rename-group-committed-source',
        marker: 'rename-group-committed',
    });
    const committedDestination = 'rename-group-committed-destination';
    setChatBranchFaultInjectorForTests(async point => {
        if (point === 'after-chat-family-rename-commit-marker') throw new Error('committed marker fault');
    });
    const committedResult = await post('/rename', {
        is_group: true,
        group_id: committed.groupId,
        original_file: `${committed.id}.jsonl`,
        renamed_file: `${committedDestination}.jsonl`,
    });
    setChatBranchFaultInjectorForTests(null);
    assert.equal(committedResult.response.status, 500);
    assert.equal(fs.existsSync(path.join(directories.groupChats, `${committedDestination}.jsonl`)), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directories.groups, `${committed.groupId}.json`), 'utf8')).chats, [committedDestination]);
});

test('restart recovery restores group metadata and an empty chunk directory after an interrupted rename', async () => {
    const fixture = writeChatFixture({
        family: 'group',
        layout: 'legacy',
        id: 'rename-group-restart-source',
        marker: 'rename-group-restart',
    });
    fs.mkdirSync(`${fixture.filePath}.chunks`);
    const groupPath = path.join(directories.groups, `${fixture.groupId}.json`);
    const destinationId = 'rename-group-restart-destination';
    const destinationPath = path.join(directories.groupChats, `${destinationId}.jsonl`);
    const before = snapshotTree(root);
    const transaction = createDurableChatFamilyTransaction({
        root,
        handle: user.profile.handle,
        directories,
        operation: 'rename',
        sourcePath: fixture.filePath,
        destinationPath,
        groupPath,
    });
    transaction.markMutating();
    await renameChatBranchFamily(root, fixture.filePath, destinationPath);
    await updateChatBranchGroupMetadata(
        groupPath,
        JSON.parse(fs.readFileSync(groupPath, 'utf8')),
        fixture.id,
        destinationId,
    );
    resetChatBranchRecoveryForTests();
    assert.deepEqual(recoverChatBranchTransactions(root, user.profile.handle, directories), { restored: 1, cleaned: 0 });
    assert.deepEqual(snapshotTree(root), before);
    assert.deepEqual(fs.readdirSync(`${fixture.filePath}.chunks`), []);
});

test('restart recovery keeps group metadata and family after the rename commit marker', async () => {
    const fixture = writeChatFixture({
        family: 'group',
        layout: 'legacy',
        id: 'rename-group-committed-restart-source',
        marker: 'rename-group-committed-restart',
    });
    const groupPath = path.join(directories.groups, `${fixture.groupId}.json`);
    const destinationId = 'rename-group-committed-restart-destination';
    const destinationPath = path.join(directories.groupChats, `${destinationId}.jsonl`);
    const transaction = createDurableChatFamilyTransaction({
        root,
        handle: user.profile.handle,
        directories,
        operation: 'rename',
        sourcePath: fixture.filePath,
        destinationPath,
        groupPath,
    });
    transaction.markMutating();
    await renameChatBranchFamily(root, fixture.filePath, destinationPath);
    await updateChatBranchGroupMetadata(
        groupPath,
        JSON.parse(fs.readFileSync(groupPath, 'utf8')),
        fixture.id,
        destinationId,
    );
    transaction.markCommitted();
    resetChatBranchRecoveryForTests();
    assert.deepEqual(recoverChatBranchTransactions(root, user.profile.handle, directories), { restored: 0, cleaned: 1 });
    assert.equal(fs.existsSync(fixture.filePath), false);
    assert.equal(fs.existsSync(destinationPath), true);
    const storedGroup = JSON.parse(fs.readFileSync(groupPath, 'utf8'));
    assert.equal(storedGroup.chat_id, destinationId);
    assert.deepEqual(storedGroup.chats, [destinationId]);
});

test('restart recovery restores an interrupted durable chat-family rename', async () => {
    const fixture = writeChatFixture({
        marker: 'rename-restart',
    });
    const destinationPath = path.join(path.dirname(fixture.filePath), 'rename-restart-destination.jsonl');
    const before = snapshotTree(path.dirname(fixture.filePath));
    const transaction = createDurableChatFamilyTransaction({
        root,
        handle: user.profile.handle,
        directories,
        operation: 'rename',
        sourcePath: fixture.filePath,
        destinationPath,
    });
    transaction.markMutating();
    await renameChatBranchFamily(root, fixture.filePath, destinationPath);
    resetChatBranchRecoveryForTests();
    assert.deepEqual(recoverChatBranchTransactions(root, user.profile.handle, directories), { restored: 1, cleaned: 0 });
    assert.deepEqual(snapshotTree(path.dirname(fixture.filePath)), before);
    assert.equal(fs.existsSync(destinationPath), false);
});

test('imports allocate collision-free family names under frozen time and for multi-chat files', async () => {
    const frozenTime = 1_735_689_600_123;
    const originalNow = Date.now;
    Date.now = () => frozenTime;
    try {
        const base = humanizedDateTime(frozenTime);
        const orphanCollision = path.join(directories.groupChats, `${base}.jsonl.chunks`);
        fs.mkdirSync(orphanCollision);
        const groupUploads = [0, 1].map(index => {
            const uploadPath = path.join(testRoot, `group-import-${index}.jsonl`);
            fs.writeFileSync(uploadPath, JSON.stringify({ user_name: 'unused', character_name: 'unused' }));
            return uploadPath;
        });
        const groupResults = await Promise.all(groupUploads.map(uploadPath => post(
            '/group/import',
            {},
            true,
            { 'x-test-upload-path': uploadPath },
        )));
        assert.deepEqual(groupResults.map(result => result.response.status), [200, 200]);
        const groupNames = groupResults.map(result => result.data.res);
        assert.equal(new Set(groupNames).size, 2);
        assert.deepEqual(new Set(groupNames), new Set([`${base} (1)`, `${base} (2)`]));
        for (const name of groupNames) {
            assert.equal(fs.existsSync(path.join(directories.groupChats, `${name}.jsonl`)), true);
        }

        const uploadPath = path.join(testRoot, 'multi-chat-import.json');
        fs.writeFileSync(uploadPath, JSON.stringify({
            histories: {
                histories: [0, 1].map(index => ({
                    msgs: [{ src: { is_human: index === 0 }, text: `history-${index}` }],
                })),
            },
        }));
        const imported = await post('/import', {
            file_type: 'json',
            avatar_url: 'import-avatar.png',
            character_name: 'Frozen Character',
            user_name: 'User',
        }, true, { 'x-test-upload-path': uploadPath });
        assert.equal(imported.response.status, 200);
        assert.equal(imported.data.fileNames.length, 2);
        assert.equal(new Set(imported.data.fileNames).size, 2);
        for (const fileName of imported.data.fileNames) {
            assert.equal(fs.existsSync(path.join(directories.chats, 'import-avatar', fileName)), true);
        }
    } finally {
        Date.now = originalNow;
    }
});

test('chat imports reject malformed nonempty JSONL lines without publishing partial data', async () => {
    const uploadPath = path.join(testRoot, 'malformed-import.jsonl');
    fs.writeFileSync(uploadPath, [
        JSON.stringify({ user_name: 'User', character_name: 'Character', chat_metadata: {} }),
        JSON.stringify({ name: 'User', is_user: true, mes: 'valid message' }),
        '{"name":"broken"',
    ].join('\n'));
    const before = new Set(fs.readdirSync(directories.groupChats));
    const result = await post('/group/import', {}, true, { 'x-test-upload-path': uploadPath });
    assert.equal(result.response.status, 400);
    assert.deepEqual(result.data, { error: true });
    assert.deepEqual(new Set(fs.readdirSync(directories.groupChats)), before);
});

test('multi-history import rolls every history back when a later artifact publish fails', async () => {
    const avatar = 'atomic-multi-import-avatar';
    const importDirectory = path.join(directories.chats, avatar);
    const uploadPath = path.join(testRoot, 'atomic-multi-import.json');
    fs.writeFileSync(uploadPath, JSON.stringify({
        histories: {
            histories: [0, 1, 2].map(index => ({
                msgs: [{ src: { is_human: index % 2 === 0 }, text: `atomic-history-${index}` }],
            })),
        },
    }));

    const originalRename = fs.promises.rename;
    let publishedArtifacts = 0;
    fs.promises.rename = async function (source, destination) {
        const relative = path.relative(importDirectory, path.resolve(String(destination)));
        const targetsImport = relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        if (targetsImport && ++publishedArtifacts === 3) {
            throw Object.assign(new Error('injected later import publication failure'), { code: 'EIO' });
        }
        return await originalRename.call(this, source, destination);
    };

    let result;
    try {
        result = await post('/import', {
            file_type: 'json',
            avatar_url: `${avatar}.png`,
            character_name: 'Atomic Import Character',
            user_name: 'Atomic Import User',
        }, true, { 'x-test-upload-path': uploadPath });
    } finally {
        fs.promises.rename = originalRename;
    }

    assert.equal(result.response.status, 500);
    assert.ok(publishedArtifacts >= 3);
    assert.equal(fs.existsSync(importDirectory), false);
});

test('chunked group and multi-history imports reserve exact final artifact growth', async () => {
    const originalLimit = user.profile.storageLimitMiB;
    try {
        user.profile.storageLimitMiB = 50;

        const groupPayload = makeMessages('group-import-quota', 450, 120)
            .map(message => JSON.stringify(message)).join('\n');
        const firstGroupUpload = path.join(testRoot, 'group-quota-first.jsonl');
        fs.writeFileSync(firstGroupUpload, groupPayload);
        const groupBefore = directorySize(directories.root);
        const firstGroup = await post('/group/import', {}, true, { 'x-test-upload-path': firstGroupUpload });
        assert.equal(firstGroup.response.status, 200);
        const groupGrowth = directorySize(directories.root) - groupBefore;
        assert.ok(groupGrowth > Buffer.byteLength(groupPayload, 'utf8'));

        const groupFilesBeforeReject = new Set(fs.readdirSync(directories.groupChats));
        const rejectedGroupUpload = path.join(testRoot, 'group-quota-rejected.jsonl');
        fs.writeFileSync(rejectedGroupUpload, groupPayload);
        const usedBeforeGroupReject = directorySize(directories.root);
        user.profile.storageLimitMiB = (usedBeforeGroupReject + groupGrowth - 1) / (1024 * 1024);
        const rejectedGroup = await post('/group/import', {}, true, { 'x-test-upload-path': rejectedGroupUpload });
        assert.equal(rejectedGroup.response.status, 403);
        assert.equal(rejectedGroup.data.error, 'storage_limit');
        assert.deepEqual(new Set(fs.readdirSync(directories.groupChats)), groupFilesBeforeReject);
        assert.equal(directorySize(directories.root), usedBeforeGroupReject);

        const acceptedGroupUpload = path.join(testRoot, 'group-quota-accepted.jsonl');
        fs.writeFileSync(acceptedGroupUpload, groupPayload);
        user.profile.storageLimitMiB = (usedBeforeGroupReject + groupGrowth) / (1024 * 1024);
        const acceptedGroup = await post('/group/import', {}, true, { 'x-test-upload-path': acceptedGroupUpload });
        assert.equal(acceptedGroup.response.status, 200);
        assert.equal(directorySize(directories.root) - usedBeforeGroupReject, groupGrowth);

        user.profile.storageLimitMiB = 50;
        const multiPayload = JSON.stringify({
            histories: {
                histories: [0, 1, 2].map(history => ({
                    msgs: makeMessages(`multi-import-${history}`, 230, 80).map((message, index) => ({
                        src: { is_human: index % 2 === 0 },
                        text: message.mes,
                    })),
                })),
            },
        });
        const firstMultiUpload = path.join(testRoot, 'multi-quota-first.json');
        fs.writeFileSync(firstMultiUpload, multiPayload);
        const multiBefore = directorySize(directories.root);
        const firstMulti = await post('/import', {
            file_type: 'json',
            avatar_url: 'quota-import-avatar.png',
            character_name: 'Quota Character',
            user_name: 'Quota User',
        }, true, { 'x-test-upload-path': firstMultiUpload });
        assert.equal(firstMulti.response.status, 200);
        assert.equal(firstMulti.data.fileNames.length, 3);
        const multiGrowth = directorySize(directories.root) - multiBefore;
        assert.ok(multiGrowth > 0);

        const importDirectory = path.join(directories.chats, 'quota-import-avatar');
        const multiFilesBeforeReject = new Set(fs.readdirSync(importDirectory));
        const rejectedMultiUpload = path.join(testRoot, 'multi-quota-rejected.json');
        fs.writeFileSync(rejectedMultiUpload, multiPayload);
        const usedBeforeMultiReject = directorySize(directories.root);
        user.profile.storageLimitMiB = (usedBeforeMultiReject + multiGrowth - 1) / (1024 * 1024);
        const rejectedMulti = await post('/import', {
            file_type: 'json',
            avatar_url: 'quota-import-avatar.png',
            character_name: 'Quota Character',
            user_name: 'Quota User',
        }, true, { 'x-test-upload-path': rejectedMultiUpload });
        assert.equal(rejectedMulti.response.status, 403);
        assert.equal(rejectedMulti.data.error, 'storage_limit');
        assert.deepEqual(new Set(fs.readdirSync(importDirectory)), multiFilesBeforeReject);
        assert.equal(directorySize(directories.root), usedBeforeMultiReject);

        const acceptedMultiUpload = path.join(testRoot, 'multi-quota-accepted.json');
        fs.writeFileSync(acceptedMultiUpload, multiPayload);
        user.profile.storageLimitMiB = (usedBeforeMultiReject + multiGrowth) / (1024 * 1024);
        const acceptedMulti = await post('/import', {
            file_type: 'json',
            avatar_url: 'quota-import-avatar.png',
            character_name: 'Quota Character',
            user_name: 'Quota User',
        }, true, { 'x-test-upload-path': acceptedMultiUpload });
        assert.equal(acceptedMulti.response.status, 200);
        assert.equal(acceptedMulti.data.fileNames.length, 3);
        assert.equal(directorySize(directories.root) - usedBeforeMultiReject, multiGrowth);
    } finally {
        user.profile.storageLimitMiB = originalLimit;
    }
});

test('deprecated group metadata edit holds the user root before save-tail can rewrite a referenced chat', async () => {
    const fixture = writeChatFixture({
        family: 'group',
        layout: 'chunked',
        id: 'migration-lock-chat',
        marker: 'migration-lock',
    });
    const groupPath = path.join(directories.groups, `${fixture.groupId}.json`);
    const originalReadFile = fs.promises.readFile;
    let releaseMigration;
    let signalMigration;
    const migrationEntered = new Promise(resolve => { signalMigration = resolve; });
    const release = new Promise(resolve => { releaseMigration = resolve; });
    let held = false;
    fs.promises.readFile = async function (target, ...args) {
        // eslint-disable-next-line playwright/no-conditional-in-test -- This gate releases one deterministic lock-order probe.
        if (!held && path.resolve(String(target)) === path.resolve(groupPath)) {
            held = true;
            signalMigration();
            await release;
        }
        return await originalReadFile.call(this, target, ...args);
    };

    try {
        const editPromise = postGroup('/edit', {
            id: fixture.groupId,
            name: 'Migrated Group',
            chat_id: fixture.id,
            chats: [fixture.id],
            members: [],
            chat_metadata: { migrated: true },
            past_metadata: {},
        });
        await migrationEntered;
        let tailSettled = false;
        const appended = { name: 'User', is_user: true, send_date: 1_900_000_000_000, mes: 'after-migration' };
        const tailPromise = post('/group/save-tail', {
            id: fixture.id,
            header: fixture.header,
            messages: [appended],
            before: fixture.messages.length,
            expectedRevision: fixture.revision,
            force: true,
        }).finally(() => { tailSettled = true; });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(tailSettled, false);
        releaseMigration();
        const [edited, tail] = await Promise.all([editPromise, tailPromise]);
        assert.equal(edited.response.status, 200);
        assert.equal(tail.response.status, 200);
        assert.equal(readStoredMessages(fixture.filePath).at(-1).mes, appended.mes);
        const storedGroup = JSON.parse(fs.readFileSync(groupPath, 'utf8'));
        assert.equal(Object.hasOwn(storedGroup, 'chat_metadata'), false);
        assert.equal(Object.hasOwn(storedGroup, 'past_metadata'), false);
    } finally {
        fs.promises.readFile = originalReadFile;
        releaseMigration?.();
    }
});

test('concurrent full saves hold one user-root quota scan and reject the stale second reservation', async () => {
    const firstHeader = makeHeader('save-quota-a');
    const secondHeader = makeHeader('save-quota-b');
    const firstMessages = makeMessages('save-quota-a', 6, 20_000);
    const secondMessages = makeMessages('save-quota-b', 6, 20_000);
    const payloadBytes = Buffer.byteLength(firstMessages.map(message => JSON.stringify(message)).join('\n'), 'utf8');
    const usedBytes = directorySize(directories.root);
    user.profile.storageLimitMiB = (usedBytes + payloadBytes + Math.floor(payloadBytes / 2)) / (1024 * 1024);

    const originalReaddir = fs.promises.readdir;
    let quotaScans = 0;
    let releaseFirstScan;
    let signalFirstScan;
    const firstScan = new Promise(resolve => { signalFirstScan = resolve; });
    const release = new Promise(resolve => { releaseFirstScan = resolve; });
    fs.promises.readdir = async function (target, ...args) {
        // eslint-disable-next-line playwright/no-conditional-in-test -- The hook synchronizes only the user-root quota scan.
        if (path.resolve(String(target)) === path.resolve(directories.root)) {
            quotaScans++;
            // eslint-disable-next-line playwright/no-conditional-in-test -- Only the first scan is held to expose the race.
            if (quotaScans === 1) {
                signalFirstScan();
                await release;
            }
        }
        return await originalReaddir.call(this, target, ...args);
    };

    try {
        const firstPromise = post('/save', {
            avatar_url: 'save-quota-a-avatar.png',
            file_name: 'save-quota-a-target',
            chat: [firstHeader, ...firstMessages],
        });
        await firstScan;
        const secondPromise = post('/save', {
            avatar_url: 'save-quota-b-avatar.png',
            file_name: 'save-quota-b-target',
            chat: [secondHeader, ...secondMessages],
        });
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(quotaScans, 1);
        releaseFirstScan();
        const [first, second] = await Promise.all([firstPromise, secondPromise]);
        assert.equal(first.response.status, 200);
        assert.equal(second.response.status, 403);
        assert.equal(second.data.error, 'storage_limit');
    } finally {
        fs.promises.readdir = originalReaddir;
        releaseFirstScan?.();
        user.profile.storageLimitMiB = 50;
    }
});

test('chunked full save counts large headers and sidecars before committing quota usage', async () => {
    const usedBytes = directorySize(directories.root);
    const originalLimit = user.profile.storageLimitMiB;
    const avatar = 'large-header-quota-avatar.png';
    const chatId = 'large-header-quota-chat';
    const header = {
        ...makeHeader('large-header-quota'),
        chat_metadata: {
            marker: 'large-header-quota',
            oversized: 'h'.repeat(64 * 1024),
        },
    };
    user.profile.storageLimitMiB = (usedBytes + 16 * 1024) / (1024 * 1024);

    try {
        const rejected = await post('/save', {
            avatar_url: avatar,
            file_name: chatId,
            chat: [header],
        });
        assert.equal(rejected.response.status, 403);
        assert.equal(rejected.data.error, 'storage_limit');

        const filePath = path.join(directories.chats, avatar.replace('.png', ''), `${chatId}.jsonl`);
        assert.equal(fs.existsSync(filePath), false);
        assert.equal(fs.existsSync(`${filePath}.metadata.json`), false);
        assert.equal(fs.existsSync(`${filePath}.index.json`), false);
        assert.equal(fs.existsSync(`${filePath}.revision.json`), false);
        assert.equal(fs.existsSync(`${filePath}.chunks`), false);
        assert.ok(directorySize(directories.root) <= Math.ceil(user.profile.storageLimitMiB * 1024 * 1024));
    } finally {
        user.profile.storageLimitMiB = originalLimit;
    }
});
