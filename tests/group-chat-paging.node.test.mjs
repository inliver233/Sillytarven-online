import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
    createGroupChatSaveRequest,
    getFullGroupMessageIndex,
    normalizeGroupChatPage,
    splitGroupChatFile,
} from '../public/scripts/group-chat-paging.js';
import { setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-group-paging-'));
const configPath = path.join(testRoot, 'config.yaml');
const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const config = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
config.backups.chat.enabled = false;
config.performance.chatChunkingEnabled = true;
config.performance.chatChunkSize = 50;
config.performance.chatTailCompareLimit = 200;
fs.writeFileSync(configPath, stringifyYaml(config));
setConfigFilePath(configPath);
globalThis.DATA_ROOT = path.join(testRoot, 'data');
fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });

const { router: chatsRouter } = await import('../src/endpoints/chats.js');
const { default: systemMonitor } = await import('../src/system-monitor.js');

const directories = {
    root: path.join(testRoot, 'user'),
    groupChats: path.join(testRoot, 'group-chats'),
    backups: path.join(testRoot, 'backups'),
    characters: path.join(testRoot, 'characters'),
    chats: path.join(testRoot, 'chats'),
    groups: path.join(testRoot, 'groups'),
};
for (const directory of Object.values(directories)) {
    fs.mkdirSync(directory, { recursive: true });
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((request, _response, next) => {
    request.user = {
        profile: { handle: 'group-test', name: 'Group Test', admin: true },
        directories,
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
const baseUrl = `http://127.0.0.1:${address.port}/api/chats`;

after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    systemMonitor.destroy();
    systemMonitor.saveDataToDisk = () => {};
    fs.rmSync(testRoot, { recursive: true, force: true });
});

async function post(route, body) {
    const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try {
        data = JSON.parse(text);
    } catch {
        data = text;
    }
    return { response, data };
}

function makeHeader(integrity, extra = {}) {
    return {
        user_name: 'unused',
        character_name: 'unused',
        chat_metadata: { integrity, ...extra },
    };
}

function makeMessages(count, prefix = 'message') {
    return Array.from({ length: count }, (_, index) => ({
        name: index % 2 ? 'Character' : 'User',
        is_user: index % 2 === 0,
        is_system: false,
        send_date: 1_700_000_000_000 + index,
        mes: `${prefix}-${index}`,
        extra: { index },
    }));
}

test('group paging frontend helpers reject malformed pages and preserve compatibility request shapes', () => {
    assert.equal(normalizeGroupChatPage(null), null);
    assert.equal(normalizeGroupChatPage({ messages: 'bad' }), null);
    assert.deepEqual(normalizeGroupChatPage({
        header: makeHeader('page'),
        messages: [{ mes: 'tail' }],
        cursor: 10,
        messageOffset: 9,
        hasMore: true,
    }), {
        header: makeHeader('page'),
        messages: [{ mes: 'tail' }],
        cursor: 10,
        messageOffset: 9,
        hasMore: true,
    });

    const file = [makeHeader('file'), { name: 'User', mes: 'one' }];
    assert.deepEqual(splitGroupChatFile(file), { header: file[0], messages: [file[1]] });
    assert.deepEqual(file, [makeHeader('file'), { name: 'User', mes: 'one' }]);

    const messages = [{ mes: 'one' }];
    const header = makeHeader('save');
    const tail = createGroupChatSaveRequest({
        chatId: 'chat-a',
        header,
        messages,
        pagingState: { active: true, isGroup: true, chatId: 'chat-a', cursor: 42 },
    });
    assert.deepEqual(tail, {
        url: '/api/chats/group/save-tail',
        body: { id: 'chat-a', header, messages, before: 42, force: false },
        tail: true,
    });
    const full = createGroupChatSaveRequest({
        chatId: 'chat-b',
        header,
        messages,
        pagingState: { active: true, isGroup: true, chatId: 'another-chat', cursor: 42 },
        force: true,
    });
    assert.deepEqual(full, {
        url: '/api/chats/group/save',
        body: { id: 'chat-b', chat: [header, ...messages], force: true },
        tail: false,
    });

    const fullMessages = makeMessages(10);
    const loaded = fullMessages.slice(6);
    assert.equal(getFullGroupMessageIndex(2, 6, fullMessages, loaded), 8);
    assert.equal(getFullGroupMessageIndex(1, null, fullMessages, loaded), 7);
});

test('group range reads return header and bounded pages while tail saves append and edit safely', async () => {
    const id = 'paged-main';
    const header = makeHeader('integrity-a', { custom: 'initial' });
    const messages = makeMessages(1_000);
    const saved = await post('/group/save', { id, chat: [header, ...messages] });
    assert.equal(saved.response.status, 200);

    const filePath = path.join(directories.groupChats, `${id}.jsonl`);
    const index = JSON.parse(fs.readFileSync(`${filePath}.index.json`, 'utf8'));
    assert.equal(index.message_count, messages.length);
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).chat_metadata.integrity, 'integrity-a');

    const first = await post('/group/get-range', { id, limit: 20 });
    assert.equal(first.response.status, 200);
    assert.equal(first.data.header.chat_metadata.integrity, 'integrity-a');
    assert.deepEqual(first.data.messages, messages.slice(980));
    assert.deepEqual({ cursor: first.data.cursor, offset: first.data.messageOffset, total: first.data.total, hasMore: first.data.hasMore }, {
        cursor: 980,
        offset: 980,
        total: 1_000,
        hasMore: true,
    });

    const older = await post('/group/get-range', { id, before: first.data.cursor, limit: 30 });
    assert.deepEqual(older.data.messages, messages.slice(950, 980));
    assert.equal(older.data.cursor, 950);
    assert.equal(older.data.messageOffset, 950);

    const appended = { ...makeMessages(1, 'appended')[0], send_date: 1_800_000_000_000 };
    const updatedHeader = makeHeader('integrity-a', { custom: 'updated' });
    const appendResult = await post('/group/save-tail', {
        id,
        header: updatedHeader,
        messages: [...first.data.messages, appended],
        before: first.data.cursor,
    });
    assert.equal(appendResult.response.status, 200);

    const afterAppend = await post('/group/get', { id });
    const appendedFile = splitGroupChatFile(afterAppend.data);
    assert.equal(appendedFile.header.chat_metadata.custom, 'updated');
    assert.equal(appendedFile.header.chat_metadata.message_count, 1_001);
    assert.deepEqual(appendedFile.messages, [...messages, appended]);

    const recent = await post('/group/get-range', { id, limit: 20 });
    const editedSuffix = recent.data.messages.map(message => ({ ...message }));
    editedSuffix[0].mes = 'edited-in-the-middle';
    const editResult = await post('/group/save-tail', {
        id,
        header: updatedHeader,
        messages: editedSuffix,
        before: recent.data.cursor,
    });
    assert.equal(editResult.response.status, 200);
    const afterEdit = splitGroupChatFile((await post('/group/get', { id })).data);
    assert.equal(afterEdit.messages.length, 1_001);
    assert.equal(afterEdit.messages[recent.data.cursor].mes, 'edited-in-the-middle');
    assert.deepEqual(afterEdit.messages.slice(0, recent.data.cursor), messages.slice(0, recent.data.cursor));

    const malformed = await post('/group/save-tail', {
        id,
        header: updatedHeader,
        messages: null,
        before: recent.data.cursor,
    });
    assert.equal(malformed.response.status, 400);
    assert.equal(splitGroupChatFile((await post('/group/get', { id })).data).messages.length, 1_001);

    const conflict = await post('/group/save-tail', {
        id,
        header: makeHeader('other-tab'),
        messages: editedSuffix,
        before: recent.data.cursor,
    });
    assert.equal(conflict.response.status, 400);
    assert.equal(conflict.data.error, 'integrity');

    const forced = await post('/group/save-tail', {
        id,
        header: makeHeader('other-tab'),
        messages: editedSuffix,
        before: recent.data.cursor,
        force: true,
    });
    assert.equal(forced.response.status, 200);
    assert.equal(splitGroupChatFile((await post('/group/get', { id })).data).header.chat_metadata.integrity, 'other-tab');
});

test('missing and legacy JSONL group chats retain headers and migrate without losing messages', async () => {
    const missing = await post('/group/get-range', { id: 'missing', limit: 20 });
    assert.deepEqual(missing.data, { header: null, messages: [], cursor: 0, messageOffset: 0, total: 0, hasMore: false });

    const createdHeader = makeHeader('created');
    const createdMessages = makeMessages(20, 'created');
    assert.equal((await post('/group/save-tail', {
        id: 'created-by-tail',
        header: createdHeader,
        messages: createdMessages,
        before: 0,
    })).response.status, 200);
    const created = await post('/group/get-range', { id: 'created-by-tail', limit: 20 });
    assert.equal(created.data.header.chat_metadata.integrity, 'created');
    assert.deepEqual(created.data.messages, createdMessages);
    assert.equal(created.data.hasMore, false);
    const createdPath = path.join(directories.groupChats, 'created-by-tail.jsonl');
    assert.equal(fs.existsSync(`${createdPath}.metadata.json`), true);
    assert.equal((await post('/group/delete', { id: 'created-by-tail' })).response.status, 200);
    assert.equal(fs.existsSync(createdPath), false);
    assert.equal(fs.existsSync(`${createdPath}.metadata.json`), false);

    const legacyId = 'legacy-jsonl';
    const legacyHeader = makeHeader('legacy');
    const legacyMessages = makeMessages(100, 'legacy');
    fs.writeFileSync(
        path.join(directories.groupChats, `${legacyId}.jsonl`),
        [legacyHeader, ...legacyMessages].map(item => JSON.stringify(item)).join('\n'),
    );
    const legacyPage = await post('/group/get-range', { id: legacyId, limit: 20 });
    assert.equal(legacyPage.data.header.chat_metadata.integrity, 'legacy');
    assert.deepEqual(legacyPage.data.messages, legacyMessages.slice(80));
    assert.equal(legacyPage.data.messageOffset, 80);
    assert.equal(legacyPage.data.total, 100);
    const legacyFull = splitGroupChatFile((await post('/group/get', { id: legacyId })).data);
    assert.deepEqual(legacyFull.messages, legacyMessages);
    assert.equal(legacyFull.header.chat_metadata.integrity, 'legacy');
});

test('previous embedded-header chunk layout remains readable and normalizes on full save', async () => {
    const id = 'embedded-header-layout';
    const filePath = path.join(directories.groupChats, `${id}.jsonl`);
    const chunkDirectory = `${filePath}.chunks`;
    const header = makeHeader('embedded');
    const messages = makeMessages(5, 'embedded');
    fs.mkdirSync(chunkDirectory, { recursive: true });
    fs.writeFileSync(filePath, '');
    const shardPath = path.join(chunkDirectory, '000000.jsonl');
    fs.writeFileSync(shardPath, [header, ...messages].map(item => JSON.stringify(item)).join('\n'));
    const shardSize = fs.statSync(shardPath).size;
    fs.writeFileSync(`${filePath}.index.json`, JSON.stringify({
        version: 1,
        chunk_size: 50,
        message_count: 6,
        last_mes: messages[4].send_date,
        last_message: messages[4].mes,
        total_bytes: shardSize,
        shards: [{
            file: '000000.jsonl',
            count: 6,
            size: shardSize,
            last_mes: messages[4].send_date,
            last_message: messages[4].mes,
        }],
    }));

    const recent = await post('/group/get-range', { id, limit: 2 });
    assert.equal(recent.data.header.chat_metadata.integrity, 'embedded');
    assert.deepEqual(recent.data.messages, messages.slice(3));
    assert.deepEqual({ cursor: recent.data.cursor, offset: recent.data.messageOffset, total: recent.data.total }, {
        cursor: 4,
        offset: 3,
        total: 5,
    });
    const oldest = await post('/group/get-range', { id, before: recent.data.cursor, limit: 3 });
    assert.deepEqual(oldest.data.messages, messages.slice(0, 3));
    assert.equal(oldest.data.cursor, 1);
    assert.equal(oldest.data.messageOffset, 0);
    assert.equal(oldest.data.hasMore, false);

    const appended = makeMessages(1, 'embedded-new')[0];
    assert.equal((await post('/group/save-tail', {
        id,
        header,
        messages: [...recent.data.messages, appended],
        before: recent.data.cursor,
    })).response.status, 200);
    const fullAfterTail = splitGroupChatFile((await post('/group/get', { id })).data);
    assert.deepEqual(fullAfterTail.messages, [...messages, appended]);
    assert.equal(fullAfterTail.header.chat_metadata.message_count, 6);

    assert.equal((await post('/group/save', { id, chat: [fullAfterTail.header, ...fullAfterTail.messages] })).response.status, 200);
    const normalizedIndex = JSON.parse(fs.readFileSync(`${filePath}.index.json`, 'utf8'));
    assert.equal(normalizedIndex.message_count, 6);
    const firstShardLine = fs.readFileSync(path.join(chunkDirectory, '000000.jsonl'), 'utf8').split('\n')[0];
    assert.equal(Object.hasOwn(JSON.parse(firstShardLine), 'chat_metadata'), false);
    assert.deepEqual(splitGroupChatFile((await post('/group/get', { id })).data).messages, [...messages, appended]);
});
