/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
    MAX_EXTENSION_STORAGE_VALUE_BYTES,
    extensionStorageRouter,
    validateExtensionStorageId,
    validateExtensionStorageKey,
} from '../src/extension-storage.js';

async function startStorageServer(root) {
    const app = express();
    app.use((request, _response, next) => {
        const handle = request.get('x-test-user') || 'alice';
        request.user = {
            profile: { handle },
            directories: { extensionData: path.join(root, handle, 'user', 'extension-data') },
        };
        next();
    });
    app.use('/api/extensions/:extensionId/storage', extensionStorageRouter);
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function request(baseUrl, extensionId, key = '', options = {}) {
    return await fetch(`${baseUrl}/api/extensions/${extensionId}/storage${key ? `/${key}` : ''}`, options);
}

test('extension storage validates identifiers without path traversal', () => {
    assert.equal(validateExtensionStorageId('image-cache.v2'), 'image-cache.v2');
    assert.equal(validateExtensionStorageKey('page-0001'), 'page-0001');
    for (const invalid of ['', '.', '..', '../other-user', 'a/b', '\\escape', ' space']) {
        assert.throws(() => validateExtensionStorageId(invalid), error => error.code === 'invalid_extension_id');
        assert.throws(() => validateExtensionStorageKey(invalid), error => error.code === 'invalid_storage_key');
    }
});

test('extension storage enforces versions, user isolation, pagination, and value limits', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-extension-storage-api-'));
    const { server, baseUrl } = await startStorageServer(root);
    try {
        for (const key of ['a', 'b']) {
            const response = await request(baseUrl, 'gallery', key, {
                method: 'PUT',
                headers: { 'content-type': 'application/json', 'x-test-user': 'alice' },
                body: JSON.stringify({ value: { key } }),
            });
            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.version, 1);
            assert.equal(typeof body.updatedAt, 'string');
        }

        const page = await request(baseUrl, 'gallery', '', {
            headers: { 'x-test-user': 'alice' },
        });
        assert.equal(page.status, 200);
        const pageBody = await page.json();
        assert.deepEqual(pageBody.items.map(item => item.key), ['a', 'b']);
        assert.equal(pageBody.total, 2);

        const loaded = await request(baseUrl, 'gallery', 'a', { headers: { 'x-test-user': 'alice' } });
        assert.equal(loaded.status, 200);
        assert.equal(loaded.headers.get('etag'), '"1"');
        assert.deepEqual((await loaded.json()).value, { key: 'a' });

        const otherUser = await request(baseUrl, 'gallery', 'a', { headers: { 'x-test-user': 'bob' } });
        assert.equal(otherUser.status, 404);

        const updates = await Promise.all([1, 2].map(value => request(baseUrl, 'gallery', 'a', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'x-test-user': 'alice', 'if-match': '"1"' },
            body: JSON.stringify({ value }),
        })));
        assert.deepEqual(updates.map(response => response.status).sort(), [200, 409]);

        const tooLarge = await request(baseUrl, 'gallery', 'large', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'x-test-user': 'alice' },
            body: JSON.stringify({ value: 'x'.repeat(MAX_EXTENSION_STORAGE_VALUE_BYTES + 1) }),
        });
        assert.equal(tooLarge.status, 413);
        assert.equal((await tooLarge.json()).error, 'payload_too_large');

        const deleted = await request(baseUrl, 'gallery', 'b', {
            method: 'DELETE',
            headers: { 'x-test-user': 'alice', 'if-match': '"1"' },
        });
        assert.equal(deleted.status, 204);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
