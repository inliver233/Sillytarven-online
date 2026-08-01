import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    RecentChatsCache,
    clearRecentChatsCache,
    getRecentChatsCacheStatus,
    invalidateRecentChatsCache,
    recentChatsCacheInvalidationMiddleware,
    registerRecentChatsCache,
} from '../src/recent-chats-cache.js';

async function withDirectories(callback) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-recent-chats-'));
    const directories = {};
    for (const key of ['characters', 'chats', 'groups', 'groupChats']) {
        directories[key] = path.join(root, key);
        await fs.promises.mkdir(directories[key], { recursive: true });
    }
    try {
        return await callback(directories, root);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}

function get(cache, directories, load, overrides = {}) {
    return cache.get({
        userKey: 'alice',
        directories,
        max: 15,
        metadata: false,
        load,
        ...overrides,
    });
}

test('recent chats cache retains final response variants without mixing users or request shapes', async () => {
    await withDirectories(async directories => {
        const cache = new RecentChatsCache({ signatureTtlMs: 1_000, ttlMs: 60_000 });
        let loads = 0;
        const load = async () => [{ file_name: `chat-${++loads}` }];

        const first = await get(cache, directories, load);
        const hit = await get(cache, directories, load);
        const metadataVariant = await get(cache, directories, load, { metadata: true });
        const maxVariant = await get(cache, directories, load, { max: 5 });
        const otherUser = await get(cache, directories, load, { userKey: 'bob' });

        assert.equal(first.state, 'miss');
        assert.equal(hit.state, 'hit');
        assert.deepEqual(hit.value, first.value);
        assert.deepEqual([metadataVariant.state, maxVariant.state, otherUser.state], ['miss', 'miss', 'miss']);
        assert.equal(loads, 4);
        assert.equal(cache.getStatus().entries, 4);
        assert.equal(cache.getStatus().signatures, 2);
    });
});

test('concurrent misses single-flight per user and failed loads are not cached', async () => {
    await withDirectories(async directories => {
        const cache = new RecentChatsCache({ signatureTtlMs: 1_000, ttlMs: 60_000 });
        let loads = 0;
        let release;
        let markStarted;
        const gate = new Promise(resolve => { release = resolve; });
        const started = new Promise(resolve => { markStarted = resolve; });
        const load = async () => {
            loads++;
            markStarted();
            await gate;
            return [{ file_name: 'shared' }];
        };
        const firstPromise = get(cache, directories, load);
        await started;
        const secondPromise = get(cache, directories, load);
        await new Promise(resolve => setImmediate(resolve));
        release();
        const results = await Promise.all([firstPromise, secondPromise]);
        assert.deepEqual(results.map(result => result.state).sort(), ['miss', 'shared']);
        assert.equal(loads, 1);

        cache.invalidate('alice');
        let attempts = 0;
        const failingLoad = async () => {
            attempts++;
            throw new Error('scan failed');
        };
        await assert.rejects(() => get(cache, directories, failingLoad), /scan failed/);
        await assert.rejects(() => get(cache, directories, failingLoad), /scan failed/);
        assert.equal(attempts, 2);
    });
});

test('root signatures, absolute TTL, and explicit invalidation refresh stale results', async () => {
    await withDirectories(async (directories, root) => {
        let now = 1_000;
        const cache = new RecentChatsCache({ now: () => now, signatureTtlMs: 0, ttlMs: 10 });
        registerRecentChatsCache(cache);
        const nested = path.join(directories.chats, 'character');
        const nestedChat = path.join(nested, 'chat.jsonl');
        await fs.promises.mkdir(nested);
        await fs.promises.writeFile(nestedChat, '{"version":1}\n');
        let value = 1;
        let loads = 0;
        const load = async () => [{ file_name: `chat-${value}`, load: ++loads }];

        assert.equal((await get(cache, directories, load)).state, 'miss');
        assert.equal((await get(cache, directories, load)).state, 'hit');

        const relocatedChats = path.join(root, 'relocated-chats');
        await fs.promises.mkdir(relocatedChats);
        const relocated = { ...directories, chats: relocatedChats };
        assert.equal((await get(cache, relocated, load)).state, 'miss');

        cache.invalidate('alice');
        await get(cache, directories, load);
        value = 2;
        await fs.promises.writeFile(nestedChat, '{"version":2}\n');
        assert.equal((await get(cache, directories, load)).state, 'hit');
        now += 11;
        const expired = await get(cache, directories, load);
        assert.equal(expired.state, 'miss');
        assert.equal(expired.value[0].file_name, 'chat-2');

        invalidateRecentChatsCache('alice');
        assert.equal((await get(cache, directories, load)).state, 'miss');
        assert.ok(getRecentChatsCacheStatus().entries > 0);
        clearRecentChatsCache();
        assert.deepEqual(getRecentChatsCacheStatus(), {
            entries: 0,
            inflight: 0,
            totalBytes: 0,
            generations: 0,
            signatures: 0,
            variants: 0,
        });
    });
});

test('invalidation during an in-flight scan prevents the older result from being retained', async () => {
    await withDirectories(async directories => {
        const cache = new RecentChatsCache({ signatureTtlMs: 1_000, ttlMs: 60_000 });
        let release;
        let markStarted;
        const gate = new Promise(resolve => { release = resolve; });
        const started = new Promise(resolve => { markStarted = resolve; });
        const oldLoad = get(cache, directories, async () => {
            markStarted();
            await gate;
            return [{ file_name: 'old' }];
        });
        await started;
        cache.invalidate('alice');
        release();
        assert.equal((await oldLoad).value[0].file_name, 'old');

        const fresh = await get(cache, directories, async () => [{ file_name: 'fresh' }]);
        assert.equal(fresh.state, 'miss');
        assert.equal(fresh.value[0].file_name, 'fresh');
    });
});

test('recent chat variants are bounded per user and retired generations are reclaimed', async () => {
    await withDirectories(async directories => {
        const cache = new RecentChatsCache({
            signatureTtlMs: 1_000,
            ttlMs: 60_000,
            maxVariantsPerUser: 2,
        });
        let loads = 0;
        const load = async () => [{ file_name: `chat-${++loads}` }];

        await get(cache, directories, load, { max: 1 });
        await get(cache, directories, load, { max: 2 });
        await get(cache, directories, load, { max: 3 });
        assert.equal(cache.getStatus().entries, 2);
        assert.equal(cache.getStatus().generations, 0);

        const evicted = await get(cache, directories, load, { max: 1 });
        assert.equal(evicted.state, 'miss');
        assert.equal(cache.getStatus().entries, 2);

        for (let max = 4; max < 40; max++) {
            await get(cache, directories, load, { max });
            cache.invalidate('alice');
        }
        assert.equal(cache.getStatus().generations, 0);
        assert.equal(cache.getStatus().variants, 0);
    });
});

test('mutation middleware invalidates successful chat, character, and group writes only', async () => {
    await withDirectories(async directories => {
        const cache = new RecentChatsCache({ signatureTtlMs: 1_000, ttlMs: 60_000 });
        registerRecentChatsCache(cache);
        const load = async () => [{ file_name: 'chat' }];

        for (const [baseUrl, requestPath] of [
            ['/api/chats', '/save-tail'],
            ['/api/characters', '/rename'],
            ['', '/api/groups/edit'],
            ['/api/data-maid', '/delete'],
        ]) {
            await get(cache, directories, load);
            assert.equal((await get(cache, directories, load)).state, 'hit');
            const response = new EventEmitter();
            response.statusCode = 200;
            let nextCalled = false;
            recentChatsCacheInvalidationMiddleware({
                baseUrl,
                path: requestPath,
                method: 'POST',
                user: { profile: { handle: 'alice' } },
            }, response, () => { nextCalled = true; });
            assert.equal(nextCalled, true);
            response.emit('finish');
            assert.equal((await get(cache, directories, load)).state, 'miss');
        }

        const failedResponse = new EventEmitter();
        failedResponse.statusCode = 500;
        recentChatsCacheInvalidationMiddleware({
            baseUrl: '/api/chats',
            path: '/delete',
            method: 'POST',
            user: { profile: { handle: 'alice' } },
        }, failedResponse, () => {});
        failedResponse.emit('finish');
        assert.equal((await get(cache, directories, load)).state, 'hit');

        const readResponse = new EventEmitter();
        readResponse.statusCode = 200;
        recentChatsCacheInvalidationMiddleware({
            baseUrl: '/api/chats',
            path: '/recent',
            method: 'POST',
            user: { profile: { handle: 'alice' } },
        }, readResponse, () => {});
        readResponse.emit('finish');
        assert.equal((await get(cache, directories, load)).state, 'hit');
    });
});
