/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { getChatContentHash } from '../src/chat-branch.js';
import { setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-group-edit-concurrency-'));
const configPath = path.join(testRoot, 'config.yaml');
const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const config = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
config.userStorage.enabled = true;
config.performance.chatChunkingEnabled = true;
config.performance.chatPaging = { enabled: true };
fs.writeFileSync(configPath, stringifyYaml(config));
setConfigFilePath(configPath);
globalThis.DATA_ROOT = path.join(testRoot, 'data');
fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });

const { router: chatsRouter } = await import('../src/endpoints/chats.js');
const { router: groupsRouter } = await import('../src/endpoints/groups.js');
const { default: systemMonitor } = await import('../src/system-monitor.js');

const root = path.join(testRoot, 'user');
const directories = {
    root,
    chats: path.join(root, 'chats'),
    groupChats: path.join(root, 'group-chats'),
    groups: path.join(root, 'groups'),
    backups: path.join(root, 'backups'),
    characters: path.join(root, 'characters'),
};
for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
const user = { profile: { handle: 'group-edit-test', name: 'Group Edit Test', admin: true }, directories };

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use((request, _response, next) => {
    request.user = user;
    next();
});
app.use('/api/chats', chatsRouter);
app.use('/api/groups', groupsRouter);
const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
});
const address = server.address();
assert.ok(address && typeof address !== 'string');
const chatsBaseUrl = `http://127.0.0.1:${address.port}/api/chats`;
const groupsBaseUrl = `http://127.0.0.1:${address.port}/api/groups`;

after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    systemMonitor.destroy();
    systemMonitor.saveDataToDisk = () => {};
    fs.rmSync(testRoot, { recursive: true, force: true });
});

async function post(baseUrl, route, body) {
    const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let data = text;
    try {
        data = JSON.parse(text);
    } catch {
        // Empty responses are expected for status-only validation failures.
    }
    return { response, data };
}

function makeFixture(marker, extraChatId = null) {
    const groupId = `${marker}-group`;
    const chatId = `${marker}-chat`;
    const header = {
        user_name: 'User',
        character_name: 'Character',
        create_date: 'test',
        chat_metadata: { marker, message_count: 3 },
    };
    const messages = [0, 1, 2].map(index => ({
        name: index % 2 ? 'Character' : 'User',
        is_user: index % 2 === 0,
        send_date: 1_700_000_000_000 + index,
        mes: `${marker}-${index}`,
        swipes: [`${marker}-${index}-zero`, `${marker}-${index}-one`],
        swipe_id: 0,
    }));
    const chatPath = path.join(directories.groupChats, `${chatId}.jsonl`);
    fs.writeFileSync(chatPath, [header, ...messages].map(value => JSON.stringify(value)).join('\n'));
    fs.writeFileSync(`${chatPath}.metadata.json`, JSON.stringify(header));
    fs.writeFileSync(`${chatPath}.revision.json`, JSON.stringify({ version: 1, revision: `${marker}-revision` }));

    const chats = [chatId];
    if (extraChatId) {
        const extraPath = path.join(directories.groupChats, `${extraChatId}.jsonl`);
        fs.writeFileSync(extraPath, JSON.stringify(header));
        chats.push(extraChatId);
    }
    const group = { id: groupId, name: groupId, chat_id: chatId, chats };
    fs.writeFileSync(path.join(directories.groups, `${groupId}.json`), JSON.stringify(group, null, 4));
    return { group, groupId, chatId, chatPath, header, messages, revision: `${marker}-revision` };
}

function branchBody(fixture, idempotencyKey) {
    return {
        source: { type: 'group', groupId: fixture.groupId, chatId: fixture.chatId },
        absoluteMessageIndex: 1,
        swipeId: 1,
        expectedRevision: fixture.revision,
        expectedContentHash: getChatContentHash(fixture.header, fixture.messages),
        idempotencyKey,
    };
}

function readGroup(groupId) {
    return JSON.parse(fs.readFileSync(path.join(directories.groups, `${groupId}.json`), 'utf8'));
}

test('stale group edit after a committed branch preserves the new branch', async () => {
    const fixture = makeFixture('post-branch');
    const staleEdit = { ...fixture.group, name: 'stale metadata edit', chats: [fixture.chatId] };

    const branched = await post(chatsBaseUrl, '/branch', branchBody(fixture, 'post-branch-key'));
    assert.equal(branched.response.status, 201);
    assert.ok(branched.data.chatId);

    const edited = await post(groupsBaseUrl, '/edit', staleEdit);
    assert.equal(edited.response.status, 200);
    const stored = readGroup(fixture.groupId);
    assert.equal(stored.name, 'stale metadata edit');
    assert.deepEqual(stored.chats, [fixture.chatId, branched.data.chatId]);
});

test('stale group edit submitted after an active chat rename keeps only the renamed chat active', async () => {
    const fixture = makeFixture('post-active-rename');
    const staleEdit = { ...fixture.group, name: 'stale active rename edit', chats: [...fixture.group.chats] };
    const renamedChatId = 'post-active-rename-destination';

    const renamed = await post(chatsBaseUrl, '/rename', {
        is_group: true,
        group_id: fixture.groupId,
        original_file: `${fixture.chatId}.jsonl`,
        renamed_file: `${renamedChatId}.jsonl`,
    });
    assert.equal(renamed.response.status, 200);
    assert.deepEqual(readGroup(fixture.groupId).chats, [renamedChatId]);

    const edited = await post(groupsBaseUrl, '/edit', staleEdit);
    assert.equal(edited.response.status, 200);
    const stored = readGroup(fixture.groupId);
    assert.equal(stored.name, 'stale active rename edit');
    assert.deepEqual(stored.chats, [renamedChatId]);
    assert.equal(stored.chat_id, renamedChatId);
});

test('stale group edit submitted after an inactive chat rename keeps only its renamed history entry', async () => {
    const renamedChatId = 'post-inactive-rename-destination';
    const inactiveChatId = 'post-inactive-rename-source';
    const fixture = makeFixture('post-inactive-rename', inactiveChatId);
    const staleEdit = { ...fixture.group, name: 'stale inactive rename edit', chats: [...fixture.group.chats] };

    const renamed = await post(chatsBaseUrl, '/rename', {
        is_group: true,
        group_id: fixture.groupId,
        original_file: `${inactiveChatId}.jsonl`,
        renamed_file: `${renamedChatId}.jsonl`,
    });
    assert.equal(renamed.response.status, 200);
    assert.deepEqual(readGroup(fixture.groupId).chats, [fixture.chatId, renamedChatId]);

    const edited = await post(groupsBaseUrl, '/edit', staleEdit);
    assert.equal(edited.response.status, 200);
    const stored = readGroup(fixture.groupId);
    assert.equal(stored.name, 'stale inactive rename edit');
    assert.deepEqual(stored.chats, [fixture.chatId, renamedChatId]);
    assert.equal(stored.chat_id, fixture.chatId);
});

test('stale group edit removes a chat after its artifact family was deleted', async () => {
    const removedChatId = 'deleted-artifact-chat';
    const fixture = makeFixture('post-delete', removedChatId);
    const staleEdit = { ...fixture.group, name: 'removed chat edit', chats: [fixture.chatId] };

    const deleted = await post(chatsBaseUrl, '/group/delete', { id: removedChatId });
    assert.equal(deleted.response.status, 200);
    assert.equal(fs.existsSync(path.join(directories.groupChats, `${removedChatId}.jsonl`)), false);

    const edited = await post(groupsBaseUrl, '/edit', staleEdit);
    assert.equal(edited.response.status, 200);
    const stored = readGroup(fixture.groupId);
    assert.equal(stored.name, 'removed chat edit');
    assert.deepEqual(stored.chats, [fixture.chatId]);
});

test('group edit preserves an acknowledged chat placeholder before its first artifact is written', async () => {
    const groupId = 'placeholder-group';
    const chatId = 'placeholder-chat';
    const group = { id: groupId, name: 'Placeholder', chat_id: chatId, chats: [chatId] };
    fs.writeFileSync(path.join(directories.groups, `${groupId}.json`), JSON.stringify(group, null, 4));

    const edited = await post(groupsBaseUrl, '/edit', { ...group, name: 'Edited Placeholder' });
    assert.equal(edited.response.status, 200);
    const stored = readGroup(groupId);
    assert.equal(stored.name, 'Edited Placeholder');
    assert.deepEqual(stored.chats, [chatId]);
    assert.equal(stored.chat_id, chatId);
});

test('group edit rejects malicious chat IDs before writing group metadata', async () => {
    const fixture = makeFixture('malicious-id');
    const original = fs.readFileSync(path.join(directories.groups, `${fixture.groupId}.json`));
    const maliciousIds = [
        '../outside-chat',
        '..\\outside-chat',
        'bad:name',
        'control\u0000name',
    ];

    for (const chatId of maliciousIds) {
        const result = await post(groupsBaseUrl, '/edit', { ...fixture.group, chats: [chatId] });
        assert.equal(result.response.status, 400, JSON.stringify(chatId));
        assert.deepEqual(fs.readFileSync(path.join(directories.groups, `${fixture.groupId}.json`)), original);
    }
});
