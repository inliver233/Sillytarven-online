/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
/* eslint-disable playwright/no-conditional-in-test -- Read counters intentionally branch by cache path. */
/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-range-cache-legacy-'));
const configPath = path.join(testRoot, 'config.yaml');
const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const config = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
config.backups.chat.enabled = true;
config.backups.chat.throttleInterval = 0;
config.performance.chatChunkingEnabled = false;
config.performance.chatPaging = { enabled: true };
fs.writeFileSync(configPath, stringifyYaml(config));
setConfigFilePath(configPath);
globalThis.DATA_ROOT = path.join(testRoot, 'data');
fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });

const { router: chatsRouter } = await import('../src/endpoints/chats.js');
const { getChatContentHash } = await import('../src/chat-branch.js');
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
for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((request, _response, next) => {
    request.user = {
        profile: { handle: 'legacy-range-test', name: 'Legacy Range Test', admin: true },
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
    return { response, data: JSON.parse(await response.text()) };
}

function makeMessages(count, prefix) {
    return Array.from({ length: count }, (_, index) => ({
        name: index % 2 ? 'Character' : 'User',
        is_user: index % 2 === 0,
        send_date: 1_700_000_000_000 + index,
        mes: `${prefix}-${index}`,
        extra: { index },
    }));
}

async function captureCompleteHistoryReads(filePath, callback) {
    let syncReads = 0;
    let streamReads = 0;
    const targetPath = path.resolve(filePath);
    const originalReadFileSync = fs.readFileSync;
    const originalCreateReadStream = fs.createReadStream;
    fs.readFileSync = function (target, ...args) {
        if (typeof target === 'string' && path.resolve(target) === targetPath) syncReads++;
        return originalReadFileSync.call(this, target, ...args);
    };
    fs.createReadStream = function (target, ...args) {
        if (typeof target === 'string' && path.resolve(target) === targetPath) streamReads++;
        return originalCreateReadStream.call(this, target, ...args);
    };
    try {
        const result = await callback();
        return { result, syncReads, streamReads };
    } finally {
        fs.readFileSync = originalReadFileSync;
        fs.createReadStream = originalCreateReadStream;
    }
}

test('legacy solo and group ranges cache 1000-message hashes, offsets, and tail revisions', async () => {
    const cases = [
        {
            name: 'solo',
            filePath: path.join(directories.chats, 'legacy-cache.png'.replace('.png', ''), 'legacy-cache.jsonl'),
            saveRoute: '/save',
            saveBody: (header, messages) => ({
                avatar_url: 'legacy-cache.png',
                ch_name: 'Character',
                file_name: 'legacy-cache',
                chat: [header, ...messages],
            }),
            rangeRoute: '/get-range',
            rangeBody: extra => ({ avatar_url: 'legacy-cache.png', file_name: 'legacy-cache', ...extra }),
            tailRoute: '/save-tail',
            tailBody: extra => ({
                avatar_url: 'legacy-cache.png',
                ch_name: 'Character',
                file_name: 'legacy-cache',
                ...extra,
            }),
        },
        {
            name: 'group',
            filePath: path.join(directories.groupChats, 'legacy-cache-group.jsonl'),
            saveRoute: '/group/save',
            saveBody: (header, messages) => ({ id: 'legacy-cache-group', chat: [header, ...messages] }),
            rangeRoute: '/group/get-range',
            rangeBody: extra => ({ id: 'legacy-cache-group', ...extra }),
            tailRoute: '/group/save-tail',
            tailBody: extra => ({ id: 'legacy-cache-group', ...extra }),
        },
    ];

    for (const fixture of cases) {
        const header = {
            user_name: fixture.name === 'solo' ? 'User' : 'unused',
            character_name: fixture.name === 'solo' ? 'Character' : 'unused',
            chat_metadata: { integrity: `${fixture.name}-cache-integrity` },
        };
        const messages = makeMessages(1_000, fixture.name);
        const saved = await post(fixture.saveRoute, fixture.saveBody(header, messages));
        assert.equal(saved.response.status, 200);

        const revisionPath = `${fixture.filePath}.revision.json`;
        const revision = JSON.parse(fs.readFileSync(revisionPath, 'utf8')).revision;
        fs.writeFileSync(revisionPath, JSON.stringify({ version: 1, revision }));

        const initial = await captureCompleteHistoryReads(fixture.filePath, () => post(
            fixture.rangeRoute,
            fixture.rangeBody({ limit: 25 }),
        ));
        assert.equal(initial.result.response.status, 200);
        assert.equal(initial.syncReads, 1);
        assert.equal(initial.streamReads, 1);
        assert.equal(initial.result.data.total, 1_000);
        assert.equal(initial.result.data.messageOffset, 975);
        assert.equal(Number.isFinite(initial.result.data.messageOffset), true);
        assert.equal(initial.result.data.contentHash, getChatContentHash(initial.result.data.header, messages));

        const cached = await captureCompleteHistoryReads(fixture.filePath, () => post(
            fixture.rangeRoute,
            fixture.rangeBody({ before: initial.result.data.cursor, limit: 25 }),
        ));
        assert.equal(cached.result.response.status, 200);
        assert.equal(cached.syncReads, 0);
        assert.equal(cached.streamReads, 1);
        assert.equal(cached.result.data.total, 1_000);
        assert.equal(cached.result.data.messageOffset, 950);
        assert.equal(Number.isFinite(cached.result.data.cursor), true);
        assert.equal(cached.result.data.contentHash, initial.result.data.contentHash);

        const appended = {
            ...makeMessages(1, `${fixture.name}-appended`)[0],
            send_date: 1_900_000_000_000,
        };
        const tailSave = await captureCompleteHistoryReads(fixture.filePath, () => post(
            fixture.tailRoute,
            fixture.tailBody({
                header: initial.result.data.header,
                messages: [...initial.result.data.messages, appended],
                before: initial.result.data.cursor,
                expectedRevision: initial.result.data.revision,
            }),
        ));
        assert.equal(tailSave.result.response.status, 200);
        assert.equal(tailSave.syncReads, 1);
        assert.equal(tailSave.streamReads, 0);
        assert.notEqual(tailSave.result.data.contentHash, initial.result.data.contentHash);
        assert.equal(
            JSON.parse(fs.readFileSync(revisionPath, 'utf8')).contentHash,
            tailSave.result.data.contentHash,
        );

        const afterTail = await captureCompleteHistoryReads(fixture.filePath, () => post(
            fixture.rangeRoute,
            fixture.rangeBody({ limit: 25 }),
        ));
        assert.equal(afterTail.syncReads, 0);
        assert.equal(afterTail.streamReads, 1);
        assert.equal(afterTail.result.data.total, 1_001);
        assert.equal(afterTail.result.data.messageOffset, 976);
        assert.equal(afterTail.result.data.contentHash, tailSave.result.data.contentHash);
    }
});
