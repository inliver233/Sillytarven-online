/* eslint-disable playwright/expect-expect -- Node test runner uses assert. */
/* eslint-disable playwright/no-conditional-in-test -- Matrix assertions cover solo/group and legacy/chunked layouts. */
/* global globalThis */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-branch-crash-'));
const dataRoot = path.join(testRoot, 'data');
const configPath = path.join(testRoot, 'config.yaml');
const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const childPath = fileURLToPath(new URL('./fixtures/chat-branch-crash-child.mjs', import.meta.url));
const config = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
config.userStorage.enabled = false;
config.performance.chatChunkingEnabled = true;
config.performance.chatChunkSize = 200;
fs.writeFileSync(configPath, stringifyYaml(config));
setConfigFilePath(configPath);
globalThis.DATA_ROOT = dataRoot;
fs.mkdirSync(dataRoot, { recursive: true });

const {
    executeChatBranch,
    getChatBranchJournalNamespace,
    getChatContentHash,
    recoverChatBranchTransactions,
} = await import('../src/chat-branch.js');
const { runWithChatStorageLocks } = await import('../src/endpoints/chats.js');
const { default: systemMonitor } = await import('../src/system-monitor.js');

after(() => {
    systemMonitor.destroy();
    systemMonitor.saveDataToDisk = () => {};
    fs.rmSync(testRoot, { recursive: true, force: true });
});

function makeMessages(marker) {
    return Array.from({ length: 6 }, (_, index) => ({
        name: index % 2 ? 'Character' : 'User',
        is_user: index % 2 === 0,
        send_date: 1_700_000_000_000 + index,
        mes: `${marker}-${index}-active`,
        swipes: [`${marker}-${index}-zero`, `${marker}-${index}-one`],
        swipe_id: 0,
        extra: { marker, index },
    }));
}

function createFixture(marker, family) {
    const root = path.join(dataRoot, marker);
    const directories = {
        root,
        chats: path.join(root, 'chats'),
        groupChats: path.join(root, 'group-chats'),
        groups: path.join(root, 'groups'),
        backups: path.join(root, 'backups'),
        characters: path.join(root, 'characters'),
    };
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    const user = { profile: { handle: marker, name: marker }, directories };
    const header = {
        user_name: 'User',
        character_name: 'Character',
        chat_metadata: { marker, message_count: 6 },
    };
    const messages = makeMessages(marker);
    const revision = `${marker}-revision`;
    const chatId = `${marker}-source`;
    const avatar = `${marker}-avatar`;
    const groupId = `${marker}-group`;
    const group = family.endsWith('-group');
    const chunked = family.startsWith('chunked-');
    const directory = group ? directories.groupChats : path.join(directories.chats, avatar);
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, `${chatId}.jsonl`);
    if (!chunked) {
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
            shards.push({ file: name, count: values.length, size, last_mes: values.at(-1).send_date, last_message: values.at(-1).mes });
        }
        fs.writeFileSync(filePath, JSON.stringify(header));
        fs.writeFileSync(`${filePath}.metadata.json`, JSON.stringify(header));
        fs.writeFileSync(`${filePath}.index.json`, JSON.stringify({
            version: 1,
            chunk_size: 200,
            message_count: messages.length,
            last_mes: messages.at(-1).send_date,
            last_message: messages.at(-1).mes,
            total_bytes: totalBytes,
            shards,
        }));
    }
    if (group) {
        fs.writeFileSync(path.join(directories.groups, `${groupId}.json`), JSON.stringify({
            id: groupId,
            chat_id: chatId,
            chats: [chatId],
        }, null, 4));
    }
    fs.writeFileSync(`${filePath}.revision.json`, JSON.stringify({ version: 1, revision }));
    const body = {
        source: group
            ? { type: 'group', groupId, chatId }
            : { type: 'solo', avatarUrl: `${avatar}.png`, chatId },
        absoluteMessageIndex: 3,
        swipeId: 1,
        expectedRevision: revision,
        expectedContentHash: getChatContentHash(header, messages),
        idempotencyKey: `${marker}-key`,
    };
    return { user, body, filePath, group, groupId, chatId, messages };
}

function createGroupRenameFixture(marker, active) {
    const root = path.join(dataRoot, marker);
    const directories = {
        root,
        chats: path.join(root, 'chats'),
        groupChats: path.join(root, 'group-chats'),
        groups: path.join(root, 'groups'),
        backups: path.join(root, 'backups'),
        characters: path.join(root, 'characters'),
    };
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    const user = { profile: { handle: marker, name: marker }, directories };
    const groupId = `${marker}-group`;
    const oldChatId = `${marker}-source`;
    const newChatId = `${marker}-destination`;
    const activeChatId = active ? oldChatId : `${marker}-active`;
    const sourcePath = path.join(directories.groupChats, `${oldChatId}.jsonl`);
    const destinationPath = path.join(directories.groupChats, `${newChatId}.jsonl`);
    const groupPath = path.join(directories.groups, `${groupId}.json`);
    const familyBytes = new Map([
        [sourcePath, Buffer.from(` {"marker":"${marker}","kind":"chat"} `)],
        [`${sourcePath}.metadata.json`, Buffer.from(`\n{"marker":"${marker}","kind":"metadata"}\n`)],
        [`${sourcePath}.index.json`, Buffer.from('{"version":1,"message_count":0,"shards":[]}')],
        [`${sourcePath}.revision.json`, Buffer.from(`{"version":1,"revision":"${marker}-revision"}`)],
    ]);
    for (const [filePath, contents] of familyBytes) fs.writeFileSync(filePath, contents);
    fs.mkdirSync(`${sourcePath}.chunks`);
    const group = {
        id: groupId,
        name: `${marker} display name`,
        chat_id: activeChatId,
        chats: [`${marker}-before`, oldChatId, `${marker}-after`],
        activation_strategy: 1,
        allow_self_responses: true,
        metadata: { untouched: marker, nested: { value: 7 } },
    };
    const groupBytes = Buffer.from(`${JSON.stringify(group, null, 2)}\n`);
    fs.writeFileSync(groupPath, groupBytes);
    return {
        user,
        body: { action: 'group-rename', groupId, oldChatId, newChatId },
        active,
        oldChatId,
        newChatId,
        sourcePath,
        destinationPath,
        groupPath,
        group,
        groupBytes,
        familyBytes,
    };
}

function snapshotTree(root) {
    const files = {};
    const visit = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            const relative = path.relative(root, fullPath).split(path.sep).join('/');
            if (relative.startsWith('.chat-branch-journals/')) continue;
            if (entry.isDirectory()) visit(fullPath);
            else files[relative] = fs.readFileSync(fullPath).toString('base64');
        }
    };
    visit(root);
    return files;
}

function readMessages(filePath) {
    if (fs.existsSync(`${filePath}.index.json`)) {
        const index = JSON.parse(fs.readFileSync(`${filePath}.index.json`, 'utf8'));
        return index.shards.flatMap(shard => fs.readFileSync(path.join(`${filePath}.chunks`, shard.file), 'utf8')
            .split('\n').filter(Boolean).map(line => JSON.parse(line)));
    }
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).slice(1).map(line => JSON.parse(line));
}

function crashAt(fixture, point) {
    const result = spawnSync(process.execPath, [
        childPath,
        configPath,
        dataRoot,
        JSON.stringify(fixture.user),
        JSON.stringify(fixture.body),
        point,
    ], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 86, result.stderr || result.stdout || `signal=${result.signal}`);
}

function recoverInFreshProcess(fixture) {
    const result = spawnSync(process.execPath, [
        childPath,
        configPath,
        dataRoot,
        JSON.stringify(fixture.user),
        JSON.stringify({ action: 'recover' }),
        'unused',
    ], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout || `signal=${result.signal}`);
    return JSON.parse(result.stdout);
}

function readRetainedManifest(fixture) {
    const namespace = getChatBranchJournalNamespace(
        fixture.user.directories.root,
        fixture.user.profile.handle,
        false,
    );
    const transactionNames = fs.readdirSync(namespace)
        .filter(name => fs.existsSync(path.join(namespace, name, 'manifest.json')));
    assert.equal(transactionNames.length, 1);
    return {
        namespace,
        manifest: JSON.parse(fs.readFileSync(path.join(namespace, transactionNames[0], 'manifest.json'), 'utf8')),
    };
}

const commonPoints = [
    'after-journal-mutating',
    'after-destination-chat-write',
    'after-destination-metadata-write',
    'after-destination-revision-write',
    'after-destination-publish',
    'after-source-revision-write',
    'after-source-update',
    'after-idempotency-update',
    'before-commit',
];
const layoutPoints = {
    legacy: ['after-source-chat-write'],
    chunked: [
        'after-destination-chunk-directory',
        'after-destination-shard-write',
        'after-destination-index-write',
        'after-source-shard-write',
        'after-source-index-write',
    ],
};

for (const family of ['legacy-solo', 'legacy-group', 'chunked-solo', 'chunked-group']) {
    const layout = family.startsWith('chunked-') ? 'chunked' : 'legacy';
    const points = [...commonPoints, ...layoutPoints[layout]];
    if (family.endsWith('-group')) points.push('after-group-update');
    for (const point of points) {
        test(`process crash at ${family} ${point} rolls back the whole branch transaction`, () => {
            const marker = `${family}-${point}`;
            const fixture = createFixture(marker, family);
            const before = snapshotTree(fixture.user.directories.root);
            crashAt(fixture, point);
            const journalNamespace = getChatBranchJournalNamespace(
                fixture.user.directories.root,
                fixture.user.profile.handle,
                false,
            );
            assert.equal(path.relative(fixture.user.directories.root, journalNamespace).startsWith('..'), true);
            const manifests = fs.readdirSync(journalNamespace)
                .filter(name => fs.existsSync(path.join(journalNamespace, name, 'manifest.json')));
            assert.equal(manifests.length, 1);
            assert.deepEqual(recoverChatBranchTransactions(
                fixture.user.directories.root,
                fixture.user.profile.handle,
                fixture.user.directories,
            ), { restored: 1, cleaned: 0 });
            assert.deepEqual(fs.readdirSync(journalNamespace), []);
            assert.deepEqual(snapshotTree(fixture.user.directories.root), before);
        });
    }
}

for (const family of ['legacy-solo', 'legacy-group', 'chunked-solo', 'chunked-group']) {
    test(`process crash at ${family} after the branch commit marker preserves all participants and replays idempotently`, async () => {
        const marker = `committed-${family}`;
        const fixture = createFixture(marker, family);
        crashAt(fixture, 'after-commit-marker');

        const journalNamespace = getChatBranchJournalNamespace(
            fixture.user.directories.root,
            fixture.user.profile.handle,
            false,
        );
        assert.equal(path.relative(fixture.user.directories.root, journalNamespace).startsWith('..'), true);
        const transactionDirectories = fs.readdirSync(journalNamespace)
            .filter(name => fs.existsSync(path.join(journalNamespace, name, 'manifest.json')));
        assert.equal(transactionDirectories.length, 1);
        const manifest = JSON.parse(fs.readFileSync(
            path.join(journalNamespace, transactionDirectories[0], 'manifest.json'),
            'utf8',
        ));
        assert.equal(manifest.state, 'committed');

        assert.deepEqual(recoverChatBranchTransactions(
            fixture.user.directories.root,
            fixture.user.profile.handle,
            fixture.user.directories,
        ), { restored: 0, cleaned: 1 });
        assert.deepEqual(fs.readdirSync(journalNamespace), []);

        const sourceMessages = readMessages(fixture.filePath);
        const destinationId = sourceMessages[3].extra.branches?.[0];
        assert.equal(typeof destinationId, 'string');
        const expectedSourceMessages = structuredClone(fixture.messages);
        expectedSourceMessages[3].extra.branches = [destinationId];
        assert.deepEqual(sourceMessages, expectedSourceMessages);

        const destinationPath = path.join(
            fixture.group ? fixture.user.directories.groupChats : path.dirname(fixture.filePath),
            `${destinationId}.jsonl`,
        );
        assert.equal(fs.existsSync(destinationPath), true);
        assert.equal(fs.existsSync(`${destinationPath}.metadata.json`), true);
        assert.equal(fs.existsSync(`${destinationPath}.revision.json`), true);
        assert.equal(fs.existsSync(`${destinationPath}.index.json`), family.startsWith('chunked-'));
        assert.equal(fs.existsSync(`${destinationPath}.chunks`), family.startsWith('chunked-'));
        const expectedDestinationMessages = structuredClone(fixture.messages.slice(0, 4));
        expectedDestinationMessages[3].mes = fixture.messages[3].swipes[1];
        expectedDestinationMessages[3].swipe_id = 1;
        expectedDestinationMessages[3].extra = {};
        assert.deepEqual(readMessages(destinationPath), expectedDestinationMessages);

        if (fixture.group) {
            const groupPath = path.join(fixture.user.directories.groups, `${fixture.groupId}.json`);
            const group = JSON.parse(fs.readFileSync(groupPath, 'utf8'));
            assert.deepEqual(group.chats, [fixture.chatId, destinationId]);
        } else {
            assert.deepEqual(fs.readdirSync(fixture.user.directories.groups), []);
        }
        assert.equal(fs.readdirSync(path.join(fixture.user.directories.root, '.chat-branch-idempotency')).length, 1);

        const committedTree = snapshotTree(fixture.user.directories.root);
        const request = { user: fixture.user, body: fixture.body };
        const replay = await executeChatBranch(request, {
            runWithStorageLocks: (filePaths, callback) => runWithChatStorageLocks(request, filePaths, callback),
        });
        assert.equal(replay.status, 200);
        assert.equal(replay.body.chatId, destinationId);
        assert.deepEqual(snapshotTree(fixture.user.directories.root), committedTree);
    });
}

for (const active of [true, false]) {
    const activity = active ? 'active' : 'inactive';

    test(`process restart rolls back a group ${activity} rename crashed after metadata write`, () => {
        const fixture = createGroupRenameFixture(`rename-rollback-${activity}`, active);
        const before = snapshotTree(fixture.user.directories.root);
        crashAt(fixture, 'after-chat-family-rename-group-write');

        const retained = readRetainedManifest(fixture);
        assert.equal(retained.manifest.type, 'chat-family');
        assert.equal(retained.manifest.state, 'mutating');
        assert.equal(fs.existsSync(fixture.sourcePath), false);
        assert.equal(fs.existsSync(fixture.destinationPath), true);
        assert.deepEqual(fs.readdirSync(`${fixture.destinationPath}.chunks`), []);
        const interruptedGroup = JSON.parse(fs.readFileSync(fixture.groupPath, 'utf8'));
        assert.deepEqual(interruptedGroup.chats, [
            `${fixture.user.profile.handle}-before`,
            fixture.newChatId,
            `${fixture.user.profile.handle}-after`,
        ]);
        assert.equal(interruptedGroup.chat_id, active ? fixture.newChatId : fixture.group.chat_id);
        assert.deepEqual(interruptedGroup.metadata, fixture.group.metadata);
        assert.equal(interruptedGroup.allow_self_responses, true);

        assert.deepEqual(recoverInFreshProcess(fixture), { restored: 1, cleaned: 0 });
        assert.deepEqual(fs.readdirSync(retained.namespace), []);
        assert.deepEqual(snapshotTree(fixture.user.directories.root), before);
        assert.deepEqual(fs.readFileSync(fixture.groupPath), fixture.groupBytes);
        assert.deepEqual(fs.readdirSync(`${fixture.sourcePath}.chunks`), []);
        assert.equal(fs.existsSync(`${fixture.destinationPath}.chunks`), false);
        for (const [filePath, contents] of fixture.familyBytes) {
            assert.deepEqual(fs.readFileSync(filePath), contents);
        }
    });

    test(`process restart preserves a committed group ${activity} rename`, () => {
        const fixture = createGroupRenameFixture(`rename-committed-${activity}`, active);
        crashAt(fixture, 'after-chat-family-rename-commit-marker');

        const retained = readRetainedManifest(fixture);
        assert.equal(retained.manifest.type, 'chat-family');
        assert.equal(retained.manifest.state, 'committed');
        const committedTree = snapshotTree(fixture.user.directories.root);
        const committedGroupBytes = fs.readFileSync(fixture.groupPath);
        const committedGroup = JSON.parse(committedGroupBytes.toString('utf8'));
        assert.deepEqual(committedGroup.chats, [
            `${fixture.user.profile.handle}-before`,
            fixture.newChatId,
            `${fixture.user.profile.handle}-after`,
        ]);
        assert.equal(committedGroup.chat_id, active ? fixture.newChatId : fixture.group.chat_id);
        assert.equal(committedGroup.activation_strategy, fixture.group.activation_strategy);
        assert.equal(committedGroup.allow_self_responses, fixture.group.allow_self_responses);
        assert.deepEqual(committedGroup.metadata, fixture.group.metadata);
        assert.equal(fs.existsSync(fixture.sourcePath), false);
        assert.equal(fs.existsSync(fixture.destinationPath), true);
        assert.deepEqual(fs.readdirSync(`${fixture.destinationPath}.chunks`), []);

        assert.deepEqual(recoverInFreshProcess(fixture), { restored: 0, cleaned: 1 });
        assert.deepEqual(fs.readdirSync(retained.namespace), []);
        assert.deepEqual(snapshotTree(fixture.user.directories.root), committedTree);
        assert.deepEqual(fs.readFileSync(fixture.groupPath), committedGroupBytes);
        assert.equal(fs.existsSync(fixture.sourcePath), false);
        for (const [sourceFilePath, contents] of fixture.familyBytes) {
            const suffix = sourceFilePath.slice(fixture.sourcePath.length);
            assert.deepEqual(fs.readFileSync(`${fixture.destinationPath}${suffix}`), contents);
        }
        assert.deepEqual(fs.readdirSync(`${fixture.destinationPath}.chunks`), []);
    });
}
