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
config.backups.chat.enabled = true;
config.backups.chat.throttleInterval = 0;
config.performance.chatChunkingEnabled = true;
config.performance.chatChunkSize = 50;
config.performance.chatTailCompareLimit = 200;
config.performance.chatPaging = { enabled: true };
fs.writeFileSync(configPath, stringifyYaml(config));
setConfigFilePath(configPath);
globalThis.DATA_ROOT = path.join(testRoot, 'data');
fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });

const { router: chatsRouter } = await import('../src/endpoints/chats.js');
const { getChatContentHash } = await import('../src/chat-branch.js');
const { getRecentChatsCacheStatus, invalidateRecentChatsCache } = await import('../src/recent-chats-cache.js');
const { default: systemMonitor } = await import('../src/system-monitor.js');

const userRoot = path.join(testRoot, 'user');
const directories = {
    root: userRoot,
    groupChats: path.join(userRoot, 'group-chats'),
    backups: path.join(userRoot, 'backups'),
    characters: path.join(userRoot, 'characters'),
    chats: path.join(userRoot, 'chats'),
    groups: path.join(userRoot, 'groups'),
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

function snapshotFiles(candidates, baseDirectory) {
    return Object.fromEntries(candidates.filter(candidate => fs.existsSync(candidate)).map(candidate => {
        const stats = fs.statSync(candidate, { bigint: true });
        return [path.relative(baseDirectory, candidate), {
            bytes: fs.readFileSync(candidate).toString('base64'),
            ino: String(stats.ino),
            mtimeNs: String(stats.mtimeNs),
            size: String(stats.size),
        }];
    }));
}

function snapshotChatArtifacts(filePath) {
    const candidates = [
        filePath,
        `${filePath}.metadata.json`,
        `${filePath}.index.json`,
        `${filePath}.revision.json`,
    ];
    const chunkDirectory = `${filePath}.chunks`;
    if (fs.existsSync(chunkDirectory)) {
        candidates.push(...fs.readdirSync(chunkDirectory).sort().map(name => path.join(chunkDirectory, name)));
    }
    return snapshotFiles(candidates, path.dirname(filePath));
}

function snapshotDirectoryFiles(directory) {
    const candidates = fs.existsSync(directory)
        ? fs.readdirSync(directory).sort().map(name => path.join(directory, name)).filter(candidate => fs.statSync(candidate).isFile())
        : [];
    return snapshotFiles(candidates, directory);
}

async function captureChunkReads(filePath, callback) {
    const chunkDirectory = `${filePath}.chunks`;
    const reads = [];
    const originalReadFile = fs.promises.readFile;
    fs.promises.readFile = async function (target, ...args) {
        if (path.dirname(String(target)) === chunkDirectory) {
            reads.push(path.basename(String(target)));
        }
        return await originalReadFile.call(this, target, ...args);
    };
    try {
        const result = await callback();
        return { reads, result };
    } finally {
        fs.promises.readFile = originalReadFile;
    }
}

async function readAllGroupRangeMessages(id, pageSize = 200) {
    const pages = [];
    let before = null;
    let revision = null;
    do {
        const body = { id, limit: pageSize };
        if (before !== null) {
            body.before = before;
        }
        const page = await post('/group/get-range', body);
        assert.equal(page.response.status, 200);
        revision ??= page.data.revision;
        assert.equal(page.data.revision, revision);
        pages.unshift(page.data.messages);
        before = page.data.hasMore ? page.data.cursor : null;
    } while (before !== null);
    return pages.flat();
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
        revision: 'revision-a',
    }), {
        header: makeHeader('page'),
        messages: [{ mes: 'tail' }],
        cursor: 10,
        messageOffset: 9,
        hasMore: true,
        revision: 'revision-a',
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
        pagingState: { active: true, isGroup: true, chatId: 'chat-a', cursor: 42, revision: 'revision-a' },
    });
    assert.deepEqual(tail, {
        url: '/api/chats/group/save-tail',
        body: { id: 'chat-a', header, messages, before: 42, expectedRevision: 'revision-a', force: false },
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

test('group chat routes reject traversal, cross-user paths, sanitize mismatches, controls, and symlinks', async t => {
    const outsideDirectory = path.join(testRoot, 'other-user');
    const outsidePath = path.join(outsideDirectory, 'private-chat.jsonl');
    fs.mkdirSync(outsideDirectory, { recursive: true });
    fs.writeFileSync(outsidePath, JSON.stringify(makeHeader('outside')));
    const outsideBefore = fs.readFileSync(outsidePath);
    const traversalId = `..${path.sep}other-user${path.sep}private-chat`;
    const routeCases = [
        ['/group/get', { id: traversalId }],
        ['/group/get-range', { id: traversalId }],
        ['/group/save', { id: traversalId, chat: [makeHeader('blocked')] }],
        ['/group/save-tail', { id: traversalId, header: makeHeader('blocked'), messages: [], before: 0, expectedRevision: null }],
        ['/group/delete', { id: traversalId }],
    ];
    for (const [route, body] of routeCases) {
        assert.equal((await post(route, body)).response.status, 400, route);
    }

    for (const id of ['..', '../other-user/private-chat', '..\\other-user\\private-chat', 'bad:name', 'control\u0000name', path.join(outsideDirectory, 'private-chat')]) {
        assert.equal((await post('/group/get', { id })).response.status, 400, JSON.stringify(id));
    }
    assert.deepEqual(fs.readFileSync(outsidePath), outsideBefore);

    const linkPath = path.join(directories.groupChats, 'linked-private-chat.jsonl');
    try {
        fs.symlinkSync(outsidePath, linkPath);
    } catch (error) {
        // eslint-disable-next-line playwright/no-conditional-in-test -- Symlink creation is unavailable on some test hosts.
        if (error.code === 'EPERM' || error.code === 'EACCES') {
            t.diagnostic(`Symlink assertion skipped: ${error.code}`);
            return;
        }
        throw error;
    }
    try {
        assert.equal((await post('/group/get', { id: 'linked-private-chat' })).response.status, 400);
        assert.deepEqual(fs.readFileSync(outsidePath), outsideBefore);
    } finally {
        fs.rmSync(linkPath, { force: true });
    }
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
    assert.equal(typeof first.data.revision, 'string');
    assert.match(first.data.contentHash, /^[a-f0-9]{64}$/);
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
        expectedRevision: first.data.revision,
    });
    assert.equal(appendResult.response.status, 200);
    assert.notEqual(appendResult.data.revision, first.data.revision);
    assert.notEqual(appendResult.data.contentHash, first.data.contentHash);
    assert.equal(
        JSON.parse(fs.readFileSync(`${filePath}.revision.json`, 'utf8')).contentHash,
        appendResult.data.contentHash,
    );

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
        expectedRevision: recent.data.revision,
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
        expectedRevision: recent.data.revision,
    });
    assert.equal(malformed.response.status, 400);
    assert.equal(splitGroupChatFile((await post('/group/get', { id })).data).messages.length, 1_001);

    const conflict = await post('/group/save-tail', {
        id,
        header: makeHeader('other-tab'),
        messages: editedSuffix,
        before: recent.data.cursor,
        expectedRevision: editResult.data.revision,
    });
    assert.equal(conflict.response.status, 400);
    assert.equal(conflict.data.error, 'integrity');

    const forced = await post('/group/save-tail', {
        id,
        header: makeHeader('other-tab'),
        messages: editedSuffix,
        before: recent.data.cursor,
        expectedRevision: editResult.data.revision,
        force: true,
    });
    assert.equal(forced.response.status, 200);
    assert.equal(splitGroupChatFile((await post('/group/get', { id })).data).header.chat_metadata.integrity, 'other-tab');
});

test('chunked range hashes scan once per revision and invalidate on external artifact changes', async () => {
    const id = 'range-hash-cache';
    const header = makeHeader('range-hash-cache');
    const messages = makeMessages(1_000, 'cached');
    const saved = await post('/group/save', { id, chat: [header, ...messages] });
    assert.equal(saved.response.status, 200);

    const filePath = path.join(directories.groupChats, `${id}.jsonl`);
    const revisionPath = `${filePath}.revision.json`;
    const initialRevision = JSON.parse(fs.readFileSync(revisionPath, 'utf8')).revision;
    fs.writeFileSync(revisionPath, JSON.stringify({ version: 1, revision: initialRevision }));
    const shardNames = fs.readdirSync(`${filePath}.chunks`).filter(name => name.endsWith('.jsonl')).sort();
    assert.equal(shardNames.length, 5);

    const initialCapture = await captureChunkReads(filePath, () => post('/group/get-range', { id, limit: 20 }));
    const first = initialCapture.result;
    assert.equal(first.response.status, 200);
    assert.deepEqual(new Set(initialCapture.reads), new Set(shardNames));
    assert.equal(first.data.total, 1_000);
    assert.equal(first.data.messageOffset, 980);
    assert.equal(first.data.contentHash, getChatContentHash(first.data.header, messages));

    const cachedCapture = await captureChunkReads(filePath, () => post('/group/get-range', {
        id,
        before: first.data.cursor,
        limit: 20,
    }));
    assert.equal(cachedCapture.result.response.status, 200);
    assert.equal(cachedCapture.result.data.contentHash, first.data.contentHash);
    assert.equal(cachedCapture.result.data.messageOffset, 960);
    assert.equal(cachedCapture.reads.includes('000001.jsonl'), false);
    assert.equal(cachedCapture.reads.includes('000002.jsonl'), false);
    assert.equal(cachedCapture.reads.includes('000003.jsonl'), false);

    const changedShardPath = path.join(`${filePath}.chunks`, '000002.jsonl');
    const changedLines = fs.readFileSync(changedShardPath, 'utf8').split('\n');
    const changedMessage = JSON.parse(changedLines[0]);
    changedMessage.mes = 'externally-modified';
    changedLines[0] = JSON.stringify(changedMessage);
    fs.writeFileSync(changedShardPath, changedLines.join('\n'));

    const staleSave = await post('/group/save-tail', {
        id,
        header: first.data.header,
        messages: first.data.messages,
        before: first.data.cursor,
        expectedRevision: first.data.revision,
    });
    assert.equal(staleSave.response.status, 409);
    assert.equal(staleSave.data.error, 'revision_conflict');

    const refreshCapture = await captureChunkReads(filePath, () => post('/group/get-range', { id, limit: 20 }));
    const refreshed = refreshCapture.result;
    assert.equal(refreshed.response.status, 200);
    assert.notEqual(refreshed.data.revision, first.data.revision);
    assert.notEqual(refreshed.data.contentHash, first.data.contentHash);
    assert.deepEqual(new Set(refreshCapture.reads), new Set(shardNames));
    const complete = splitGroupChatFile((await post('/group/get', { id })).data);
    assert.equal(refreshed.data.contentHash, getChatContentHash(complete.header, complete.messages));

    const refreshedCachedCapture = await captureChunkReads(filePath, () => post('/group/get-range', {
        id,
        before: refreshed.data.cursor,
        limit: 20,
    }));
    assert.equal(refreshedCachedCapture.result.data.contentHash, refreshed.data.contentHash);
    assert.equal(refreshedCachedCapture.reads.includes('000001.jsonl'), false);
    assert.equal(refreshedCachedCapture.reads.includes('000002.jsonl'), false);
    assert.equal(refreshedCachedCapture.reads.includes('000003.jsonl'), false);
});

test('missing and legacy JSONL group chats retain headers and migrate without losing messages', async () => {
    const missing = await post('/group/get-range', { id: 'missing', limit: 20 });
    assert.deepEqual(missing.data, { header: null, messages: [], cursor: 0, messageOffset: 0, total: 0, hasMore: false, revision: null, contentHash: null });

    const createdHeader = makeHeader('created');
    const createdMessages = makeMessages(20, 'created');
    assert.equal((await post('/group/save-tail', {
        id: 'created-by-tail',
        header: createdHeader,
        messages: createdMessages,
        before: 0,
        expectedRevision: null,
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

    const headerlessId = 'headerless-jsonl';
    const headerlessMessages = makeMessages(3, 'headerless');
    const headerlessPath = path.join(directories.groupChats, `${headerlessId}.jsonl`);
    fs.writeFileSync(headerlessPath, headerlessMessages.map(item => JSON.stringify(item)).join('\n'));
    const headerlessPage = await post('/group/get-range', { id: headerlessId, limit: 20 });
    assert.deepEqual(headerlessPage.data.messages, headerlessMessages);
    assert.equal(headerlessPage.data.total, headerlessMessages.length);
    assert.equal(headerlessPage.data.header.user_name, 'unused');
    assert.equal(headerlessPage.data.header.chat_metadata.message_count, headerlessMessages.length);
    assert.deepEqual(
        splitGroupChatFile((await post('/group/get', { id: headerlessId })).data).messages,
        headerlessMessages,
    );
    assert.deepEqual(
        fs.readFileSync(path.join(`${headerlessPath}.chunks`, '000000.jsonl'), 'utf8').split('\n').map(JSON.parse),
        headerlessMessages,
    );

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
        expectedRevision: recent.data.revision,
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

test('stale group revision returns 409 without modifying disk or caches', async () => {
    const id = 'stale-revision';
    const header = makeHeader('stale-revision-integrity');
    const messages = makeMessages(240, 'stale');
    assert.equal((await post('/group/save', { id, chat: [header, ...messages] })).response.status, 200);

    const firstTab = await post('/group/get-range', { id, limit: 20 });
    const secondTab = await post('/group/get-range', { id, limit: 20 });
    assert.equal(firstTab.data.revision, secondTab.data.revision);

    const secondTabMessage = { ...makeMessages(1, 'second-tab')[0], send_date: 1_900_000_000_000 };
    const winningSave = await post('/group/save-tail', {
        id,
        header,
        messages: [...secondTab.data.messages, secondTabMessage],
        before: secondTab.data.cursor,
        expectedRevision: secondTab.data.revision,
    });
    assert.equal(winningSave.response.status, 200);
    assert.notEqual(winningSave.data.revision, secondTab.data.revision);

    const filePath = path.join(directories.groupChats, `${id}.jsonl`);
    const beforeConflict = snapshotChatArtifacts(filePath);
    const backupsBeforeConflict = snapshotDirectoryFiles(directories.backups);
    assert.equal((await post('/recent', { max: 10 })).response.status, 200);
    const cacheBeforeConflict = getRecentChatsCacheStatus();
    assert.equal(cacheBeforeConflict.entries > 0, true);
    const staleMessage = { ...makeMessages(1, 'stale-tab')[0], send_date: 1_900_000_000_001 };
    const staleSave = await post('/group/save-tail', {
        id,
        header,
        messages: [...firstTab.data.messages, staleMessage],
        before: firstTab.data.cursor,
        expectedRevision: firstTab.data.revision,
        force: true,
    });

    assert.equal(staleSave.response.status, 409);
    assert.equal(staleSave.data.error, 'revision_conflict');
    assert.deepEqual(snapshotChatArtifacts(filePath), beforeConflict);
    assert.deepEqual(snapshotDirectoryFiles(directories.backups), backupsBeforeConflict);
    assert.deepEqual(getRecentChatsCacheStatus(), cacheBeforeConflict);
    assert.deepEqual(splitGroupChatFile((await post('/group/get', { id })).data).messages, [...messages, secondTabMessage]);
});

test('concurrent group tail saves serialize and leave shards, index, header, and ranges consistent', async () => {
    const id = 'concurrent-tail';
    const header = makeHeader('concurrent-integrity');
    const messages = makeMessages(210, 'concurrent');
    assert.equal((await post('/group/save', { id, chat: [header, ...messages] })).response.status, 200);
    const page = await post('/group/get-range', { id, limit: 200 });
    const additions = ['first', 'second'].map((prefix, index) => ({
        ...makeMessages(1, prefix)[0],
        send_date: 2_000_000_000_000 + index,
    }));

    const results = await Promise.all(additions.map(addition => post('/group/save-tail', {
        id,
        header,
        messages: [...page.data.messages, addition],
        before: page.data.cursor,
        expectedRevision: page.data.revision,
    })));
    assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);

    const filePath = path.join(directories.groupChats, `${id}.jsonl`);
    const index = JSON.parse(fs.readFileSync(`${filePath}.index.json`, 'utf8'));
    const shardLines = fs.readdirSync(`${filePath}.chunks`)
        .filter(name => name.endsWith('.jsonl'))
        .sort()
        .flatMap(name => fs.readFileSync(path.join(`${filePath}.chunks`, name), 'utf8').split('\n').filter(Boolean));
    const fullMessages = splitGroupChatFile((await post('/group/get', { id })).data).messages;
    const rangeMessages = await readAllGroupRangeMessages(id);
    const storedHeader = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    assert.equal(shardLines.length, 211);
    assert.equal(index.message_count, 211);
    assert.equal(storedHeader.chat_metadata.message_count, 211);
    assert.equal(fullMessages.length, 211);
    assert.deepEqual(rangeMessages, fullMessages);
    assert.deepEqual(fullMessages.slice(0, 210), messages);
    assert.equal(additions.some(addition => addition.mes === fullMessages.at(-1).mes), true);
});

test('forged chunk indexes rebuild from safe shards and stored group ids cannot escape the user root', async t => {
    const id = 'forged-index-source';
    const groupId = 'forged-index-group';
    const header = makeHeader('forged-index-integrity');
    const messages = makeMessages(80, 'forged-index');
    assert.equal((await post('/group/save', { id, chat: [header, ...messages] })).response.status, 200);

    const filePath = path.join(directories.groupChats, `${id}.jsonl`);
    const indexPath = `${filePath}.index.json`;
    const originalIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const outsidePath = path.join(testRoot, 'forged-outside.jsonl');
    const outsidePayload = JSON.stringify({
        name: 'Outside',
        is_user: false,
        send_date: 2_200_000_000_000,
        mes: 'cross-user-secret-marker',
    });
    fs.writeFileSync(outsidePath, outsidePayload);
    fs.writeFileSync(path.join(directories.groups, `${groupId}.json`), JSON.stringify({
        id: groupId,
        chat_id: id,
        chats: [id, '../../forged-outside'],
    }));

    const forgeIndex = () => {
        const forged = structuredClone(originalIndex);
        forged.shards[0].file = '../../forged-outside.jsonl';
        fs.writeFileSync(indexPath, JSON.stringify(forged));
    };
    const assertSafeRebuild = () => {
        const rebuilt = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        assert.equal(rebuilt.message_count, messages.length);
        assert.equal(rebuilt.shards.every(shard => /^\d{6}\.jsonl$/.test(shard.file)), true);
        assert.equal(fs.readFileSync(outsidePath, 'utf8'), outsidePayload);
    };

    await t.test('range', async () => {
        forgeIndex();
        const result = await post('/group/get-range', { id, limit: 20 });
        assert.equal(result.response.status, 200);
        assert.deepEqual(result.data.messages, messages.slice(-20));
        assertSafeRebuild();
    });

    await t.test('export', async () => {
        forgeIndex();
        const result = await post('/export', {
            is_group: true,
            file: `${id}.jsonl`,
            format: 'jsonl',
            exportfilename: 'forged-index-export.jsonl',
        });
        assert.equal(result.response.status, 200);
        assert.equal(result.data.result.includes('forged-index-79'), true);
        assertSafeRebuild();
    });

    await t.test('search', async () => {
        forgeIndex();
        const result = await post('/search', { query: 'forged-index-40', group_id: groupId });
        assert.equal(result.response.status, 200);
        assert.equal(result.data.some(item => item.file_name === id), true);
        assertSafeRebuild();

        const escaped = await post('/search', { query: 'cross-user-secret-marker', group_id: groupId });
        assert.equal(escaped.response.status, 200);
        assert.deepEqual(escaped.data, []);
    });

    await t.test('recent', async () => {
        forgeIndex();
        invalidateRecentChatsCache('group-test');
        const result = await post('/recent', { max: 100 });
        assert.equal(result.response.status, 200);
        assert.equal(result.data.some(item => item.file_name === `${id}.jsonl`), true);
        assert.equal(result.data.some(item => item.mes === 'cross-user-secret-marker'), false);
        assertSafeRebuild();
    });
});

test('tail mutation rebuilds a size-valid index with forged shard counts before truncating', async () => {
    const id = 'forged-count-tail';
    const header = makeHeader('forged-count-tail');
    const messages = makeMessages(80, 'forged-count-tail');
    assert.equal((await post('/group/save', { id, chat: [header, ...messages] })).response.status, 200);

    const filePath = path.join(directories.groupChats, `${id}.jsonl`);
    const indexPath = `${filePath}.index.json`;
    const forged = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    forged.shards[0].count += 20;
    forged.message_count += 20;
    fs.writeFileSync(indexPath, JSON.stringify(forged));

    const forgedPage = await post('/group/get-range', { id, limit: 20 });
    assert.equal(forgedPage.response.status, 200);
    assert.equal(forgedPage.data.total, 80);
    assert.equal(JSON.parse(fs.readFileSync(indexPath, 'utf8')).message_count, 100);
    const appended = { ...makeMessages(1, 'forged-count-new')[0], send_date: 2_300_000_000_000 };
    const saved = await post('/group/save-tail', {
        id,
        header,
        messages: [appended],
        before: 80,
        expectedRevision: forgedPage.data.revision,
        force: true,
    });
    assert.equal(saved.response.status, 200);

    const stored = splitGroupChatFile((await post('/group/get', { id })).data).messages;
    assert.deepEqual(stored, [...messages, appended]);
    assert.equal(JSON.parse(fs.readFileSync(indexPath, 'utf8')).message_count, 81);
});

test('chunked export holds the chat lock until every shard is assembled', async () => {
    const id = 'locked-export';
    const header = makeHeader('locked-export');
    const messages = makeMessages(80, 'locked-export');
    assert.equal((await post('/group/save', { id, chat: [header, ...messages] })).response.status, 200);
    const page = await post('/group/get-range', { id, limit: 20 });
    const shardPath = path.join(`${path.join(directories.groupChats, `${id}.jsonl`)}.chunks`, '000000.jsonl');
    const originalReadFile = fs.promises.readFile;
    let releaseRead;
    let signalRead;
    const entered = new Promise(resolve => { signalRead = resolve; });
    const release = new Promise(resolve => { releaseRead = resolve; });
    let held = false;
    fs.promises.readFile = async function (target, ...args) {
        if (!held && path.resolve(String(target)) === path.resolve(shardPath)) {
            held = true;
            signalRead();
            await release;
        }
        return await originalReadFile.call(this, target, ...args);
    };

    try {
        const exporting = post('/export', {
            is_group: true,
            file: `${id}.jsonl`,
            format: 'jsonl',
            exportfilename: 'locked-export.jsonl',
        });
        await entered;
        let saveSettled = false;
        const appended = { ...makeMessages(1, 'locked-export-new')[0], send_date: 2_400_000_000_000 };
        const saving = post('/group/save-tail', {
            id,
            header,
            messages: [...page.data.messages, appended],
            before: page.data.cursor,
            expectedRevision: page.data.revision,
        }).finally(() => { saveSettled = true; });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(saveSettled, false);
        releaseRead();
        const [exported, saved] = await Promise.all([exporting, saving]);
        assert.equal(exported.response.status, 200);
        assert.equal(exported.data.result.includes('locked-export-79'), true);
        assert.equal(exported.data.result.includes('locked-export-new'), false);
        assert.equal(saved.response.status, 200);
    } finally {
        fs.promises.readFile = originalReadFile;
        releaseRead?.();
    }
});

test('direct group chat deletion rolls a partially removed artifact family back before retry', async () => {
    const id = 'durable-direct-delete';
    const header = makeHeader('durable-direct-delete');
    const messages = makeMessages(75, 'durable-direct-delete');
    assert.equal((await post('/group/save', { id, chat: [header, ...messages] })).response.status, 200);

    const filePath = path.join(directories.groupChats, `${id}.jsonl`);
    const bytesOnly = () => Object.fromEntries(Object.entries(snapshotChatArtifacts(filePath))
        .map(([name, value]) => [name, value.bytes]));
    const before = bytesOnly();
    const artifactPaths = new Set([
        filePath,
        `${filePath}.metadata.json`,
        `${filePath}.index.json`,
        `${filePath}.revision.json`,
    ].map(candidate => path.resolve(candidate)));
    const originalRemove = fs.rmSync;
    let removals = 0;
    fs.rmSync = function (target, ...args) {
        if (artifactPaths.has(path.resolve(String(target))) && ++removals === 2) {
            throw Object.assign(new Error('injected direct-delete failure'), { code: 'EIO' });
        }
        return originalRemove.call(this, target, ...args);
    };
    let failed;
    try {
        failed = await post('/group/delete', { id });
    } finally {
        fs.rmSync = originalRemove;
    }

    assert.equal(failed.response.status, 500);
    assert.deepEqual(bytesOnly(), before);
    assert.deepEqual(splitGroupChatFile((await post('/group/get', { id })).data).messages, messages);

    const retried = await post('/group/delete', { id });
    assert.equal(retried.response.status, 200);
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(fs.existsSync(`${filePath}.metadata.json`), false);
    assert.equal(fs.existsSync(`${filePath}.index.json`), false);
    assert.equal(fs.existsSync(`${filePath}.revision.json`), false);
    assert.equal(fs.existsSync(`${filePath}.chunks`), false);
});

test('character chat range revisions protect tail saves too', async () => {
    const avatar = 'revision-character.png';
    const fileName = 'revision-chat';
    const header = {
        user_name: 'User',
        character_name: 'Character',
        create_date: 'test',
        chat_metadata: { integrity: 'character-revision-integrity' },
    };
    const messages = makeMessages(30, 'character');
    assert.equal((await post('/save', {
        avatar_url: avatar,
        ch_name: 'Character',
        file_name: fileName,
        chat: [header, ...messages],
    })).response.status, 200);

    const page = await post('/get-range', { avatar_url: avatar, file_name: fileName, limit: 20 });
    assert.equal(typeof page.data.revision, 'string');
    assert.equal(page.data.total, 30);
    assert.equal(page.data.messageOffset, 10);
    assert.equal(Number.isFinite(page.data.cursor), true);
    assert.equal(Number.isFinite(page.data.messageOffset), true);
    const appended = { ...makeMessages(1, 'character-new')[0], send_date: 2_100_000_000_000 };
    const saved = await post('/save-tail', {
        avatar_url: avatar,
        ch_name: 'Character',
        file_name: fileName,
        header,
        messages: [...page.data.messages, appended],
        before: page.data.cursor,
        expectedRevision: page.data.revision,
    });
    assert.equal(saved.response.status, 200);
    assert.notEqual(saved.data.revision, page.data.revision);
});
