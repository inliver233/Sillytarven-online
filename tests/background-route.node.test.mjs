/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';

const basePng = fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url));

async function waitForEmptyDirectory(directory) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        if (fs.readdirSync(directory).length === 0) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(fs.readdirSync(directory), []);
}

test('background routes validate bytes, normalize extensions, rename safely, and clean uploads', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-background-route-'));
    const uploads = path.join(root, '_uploads');
    const backgrounds = path.join(root, 'backgrounds');
    const thumbnails = path.join(root, 'thumbnails');
    await Promise.all([uploads, backgrounds, thumbnails].map(directory => fs.promises.mkdir(directory, { recursive: true })));

    global.DATA_ROOT = root;
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(fileURLToPath(new URL('../config.yaml', import.meta.url)));
    const { router } = await import('../src/endpoints/backgrounds.js');

    const app = express();
    app.use(express.json());
    app.use(multer({ dest: uploads }).single('avatar'));
    app.use((request, _response, next) => {
        request.user = { directories: { root, backgrounds, thumbnails, thumbnailsBg: thumbnails } };
        next();
    });
    app.use('/api/backgrounds', router);

    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });

    try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const uploadForm = new FormData();
        uploadForm.append('avatar', new Blob([basePng], { type: 'image/jpeg' }), 'wrong.JPG');
        const uploadResponse = await fetch(`${baseUrl}/api/backgrounds/upload`, { method: 'POST', body: uploadForm });
        assert.equal(uploadResponse.status, 200);
        assert.equal(await uploadResponse.text(), 'wrong.png');
        assert.equal(fs.existsSync(path.join(backgrounds, 'wrong.png')), true);
        await waitForEmptyDirectory(uploads);

        const collisionForm = new FormData();
        collisionForm.append('avatar', new Blob([basePng], { type: 'image/png' }), 'wrong.jpeg');
        const collisionResponse = await fetch(`${baseUrl}/api/backgrounds/upload`, { method: 'POST', body: collisionForm });
        assert.equal(collisionResponse.status, 409);
        assert.equal((await collisionResponse.json()).error, 'background_exists');
        assert.deepEqual(fs.readFileSync(path.join(backgrounds, 'wrong.png')), basePng);
        await waitForEmptyDirectory(uploads);

        const truncatedForm = new FormData();
        truncatedForm.append('avatar', new Blob([basePng.subarray(0, 24)], { type: 'image/png' }), 'truncated.png');
        const truncatedResponse = await fetch(`${baseUrl}/api/backgrounds/upload`, { method: 'POST', body: truncatedForm });
        assert.equal(truncatedResponse.status, 415);
        assert.equal((await truncatedResponse.json()).error, 'invalid_background_file');
        assert.equal(fs.existsSync(path.join(backgrounds, 'truncated.png')), false);
        await waitForEmptyDirectory(uploads);

        const oversizedPng = Buffer.from(basePng);
        oversizedPng.writeUInt32BE(50_000, 16);
        oversizedPng.writeUInt32BE(50_000, 20);
        const oversizedForm = new FormData();
        oversizedForm.append('avatar', new Blob([oversizedPng], { type: 'image/png' }), 'oversized.png');
        const oversizedResponse = await fetch(`${baseUrl}/api/backgrounds/upload`, { method: 'POST', body: oversizedForm });
        assert.equal(oversizedResponse.status, 413);
        assert.equal((await oversizedResponse.json()).error, 'background_pixel_limit_exceeded');
        assert.equal(fs.existsSync(path.join(backgrounds, 'oversized.png')), false);
        await waitForEmptyDirectory(uploads);

        const videoForm = new FormData();
        videoForm.append('avatar', new Blob([Buffer.from('00000018667479706d703432', 'hex')], { type: 'video/mp4' }), 'video.mp4');
        const videoResponse = await fetch(`${baseUrl}/api/backgrounds/upload`, { method: 'POST', body: videoForm });
        assert.equal(videoResponse.status, 415);
        assert.equal((await videoResponse.json()).error, 'invalid_background_file');
        await waitForEmptyDirectory(uploads);

        const renameResponse = await fetch(`${baseUrl}/api/backgrounds/rename`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ old_bg: 'wrong.png', new_bg: 'new:name.JPG' }),
        });
        assert.equal(renameResponse.status, 200);
        assert.equal((await renameResponse.json()).new_bg, 'newname.png');
        assert.equal(fs.existsSync(path.join(backgrounds, 'newname.png')), true);
        assert.equal(fs.existsSync(path.join(backgrounds, 'wrong.png')), false);

        const allResponse = await fetch(`${baseUrl}/api/backgrounds/all`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        assert.equal(allResponse.status, 200);
        assert.deepEqual((await allResponse.json()).images, ['newname.png']);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
