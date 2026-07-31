/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createUploadMiddleware } from '../src/upload-middleware.js';

test('upload middleware independently limits file bytes and returns a stable 413', async () => {
    const uploads = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-upload-limit-'));
    const app = express();
    app.use(createUploadMiddleware(uploads, { fileSize: 64, fieldSize: 1024 }));
    app.post('/upload', (request, response) => response.json({ size: request.file?.size ?? 0 }));

    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const acceptedForm = new FormData();
        acceptedForm.append('avatar', new Blob([Buffer.alloc(63)]), 'small.bin');
        const accepted = await fetch(`${baseUrl}/upload`, { method: 'POST', body: acceptedForm });
        assert.equal(accepted.status, 200);
        assert.equal((await accepted.json()).size, 63);

        const rejectedForm = new FormData();
        rejectedForm.append('avatar', new Blob([Buffer.alloc(65)]), 'large.bin');
        const rejected = await fetch(`${baseUrl}/upload`, { method: 'POST', body: rejectedForm });
        assert.equal(rejected.status, 413);
        assert.deepEqual(await rejected.json(), {
            error: 'upload_file_too_large',
            message: 'The uploaded file exceeds the configured size limit.',
        });
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await fs.promises.rm(uploads, { recursive: true, force: true });
    }
});
