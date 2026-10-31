/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { router, applyDraftSave, pruneDrafts, INPUT_DRAFTS_FILE, MAX_DRAFTS, MAX_DRAFT_LENGTH, MAX_TOTAL_LENGTH } from '../src/endpoints/input-drafts.js';
import { isHardExcluded } from '../src/git-sync/tracking.js';

async function startServer(root) {
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use((request, _response, next) => {
        request.user = /** @type {any} */ ({ directories: { root } });
        next();
    });
    app.use('/api/input-drafts', router);
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/api/input-drafts`;
    return {
        get: async key => {
            const response = await fetch(`${baseUrl}?${new URLSearchParams({ key })}`);
            return { status: response.status, data: await response.json() };
        },
        save: async body => {
            const response = await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            return { status: response.status, data: await response.json() };
        },
        close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    };
}

test('drafts are saved per chat, versioned, and a save on top of an older version from elsewhere is refused', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-input-drafts-'));
    const api = await startServer(root);
    try {
        assert.deepEqual((await api.get('c:Alice.png:chat 1')).data, { text: '', updatedAt: 0, clientId: '' });

        const first = await api.save({ key: 'c:Alice.png:chat 1', text: 'hello wor', clientId: 'phone', baseUpdatedAt: 0 });
        assert.equal(first.status, 200);
        const stored = (await api.get('c:Alice.png:chat 1')).data;
        assert.deepEqual(stored, { text: 'hello wor', updatedAt: first.data.updatedAt, clientId: 'phone' });
        assert.equal((await api.get('c:Alice.png:chat 2')).data.text, '', 'other chats have their own draft');

        const second = await api.save({ key: 'c:Alice.png:chat 1', text: 'hello world', clientId: 'pc', baseUpdatedAt: first.data.updatedAt });
        assert.equal(second.status, 200);
        assert.ok(second.data.updatedAt > first.data.updatedAt, 'versions only go up');

        // The phone still thinks the first version is current.
        const stale = await api.save({ key: 'c:Alice.png:chat 1', text: 'hello wor!!', clientId: 'phone', baseUpdatedAt: first.data.updatedAt });
        assert.equal(stale.status, 409);
        assert.deepEqual(stale.data, { text: 'hello world', updatedAt: second.data.updatedAt, clientId: 'pc' });
        assert.equal((await api.get('c:Alice.png:chat 1')).data.text, 'hello world', 'a refused save changes nothing');

        // Same text, or the same page saving again, is not a conflict.
        assert.equal((await api.save({ key: 'c:Alice.png:chat 1', text: 'hello world', clientId: 'phone', baseUpdatedAt: first.data.updatedAt })).status, 200);
        assert.equal((await api.save({ key: 'c:Alice.png:chat 1', text: 'hello world?', clientId: 'phone', baseUpdatedAt: 0 })).status, 200);

        // Emptying (the message was sent) keeps a version, so other devices learn about it.
        const latest = (await api.get('c:Alice.png:chat 1')).data;
        const cleared = await api.save({ key: 'c:Alice.png:chat 1', text: '', clientId: 'phone', baseUpdatedAt: latest.updatedAt });
        assert.equal(cleared.status, 200);
        assert.deepEqual((await api.get('c:Alice.png:chat 1')).data, { text: '', updatedAt: cleared.data.updatedAt, clientId: 'phone' });

        assert.ok(fs.existsSync(path.join(root, INPUT_DRAFTS_FILE)));
        assert.ok(isHardExcluded(INPUT_DRAFTS_FILE), 'tavern git never commits drafts');
        assert.ok(!isHardExcluded(`chats/Alice/${INPUT_DRAFTS_FILE}`), 'only the file at the root is excluded');
    } finally {
        await api.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('draft saves are validated', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-input-drafts-'));
    const api = await startServer(root);
    try {
        assert.equal((await api.get('')).status, 400);
        assert.equal((await api.save({ key: 'none', text: 'x' })).status, 400, 'a client id is required');
        assert.equal((await api.save({ key: '', text: 'x', clientId: 'a' })).status, 400);
        assert.equal((await api.save({ key: 'none', text: 1, clientId: 'a' })).status, 400);
        assert.equal((await api.save({ key: 'none', text: 'x'.repeat(MAX_DRAFT_LENGTH + 1), clientId: 'a' })).status, 413);
        assert.equal((await api.save({ key: 'none', text: 'x'.repeat(MAX_DRAFT_LENGTH), clientId: 'a' })).status, 200);
    } finally {
        await api.close();
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('old cleared drafts expire and the oldest drafts make room beyond the limits', () => {
    const now = Date.UTC(2026, 9, 31);
    const day = 24 * 60 * 60 * 1000;
    const drafts = {
        sentLongAgo: { text: '', updatedAt: now - 31 * day, clientId: 'a' },
        sentRecently: { text: '', updatedAt: now - day, clientId: 'a' },
    };
    for (let i = 0; i < MAX_DRAFTS; i++) {
        drafts[`chat ${i}`] = { text: 'draft', updatedAt: now - (MAX_DRAFTS - i) * 1000, clientId: 'a' };
    }
    applyDraftSave(drafts, { key: 'new chat', text: 'newest', clientId: 'a', baseUpdatedAt: 0 }, now);
    assert.ok(!('sentLongAgo' in drafts));
    assert.ok('sentRecently' in drafts);
    assert.ok(!('chat 0' in drafts), 'the oldest draft made room');
    assert.ok('chat 1' in drafts && 'new chat' in drafts);
    assert.equal(Object.values(drafts).filter(draft => draft.text).length, MAX_DRAFTS);

    const big = {
        old: { text: 'x'.repeat(MAX_TOTAL_LENGTH / 2), updatedAt: now - 2000, clientId: 'a' },
        middle: { text: 'x'.repeat(MAX_TOTAL_LENGTH / 2), updatedAt: now - 1000, clientId: 'a' },
        kept: { text: 'x'.repeat(10), updatedAt: now, clientId: 'a' },
    };
    pruneDrafts(big, 'kept', now);
    assert.deepEqual(Object.keys(big).sort(), ['kept', 'middle']);
});
