/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';

import { write } from '../src/character-card-parser.js';

const basePng = fs.readFileSync(new URL('../default/content/user-default.png', import.meta.url));

async function postImport(baseUrl, bytes, fileName, format, mimeType = 'application/octet-stream') {
    const form = new FormData();
    form.append('file_type', format);
    form.append('user_name', 'User');
    form.append('avatar', new Blob([bytes], { type: mimeType }), fileName);
    return await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: form });
}

async function assertDirectoryBecomesEmpty(directory) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        if (fs.readdirSync(directory).length === 0) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(fs.readdirSync(directory), []);
}

test('character import returns real error statuses and always removes temporary uploads', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-character-route-'));
    const uploads = path.join(root, '_uploads');
    const directories = {
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        worlds: path.join(root, 'worlds'),
        userImages: path.join(root, 'user', 'images'),
        backgrounds: path.join(root, 'backgrounds'),
    };
    await Promise.all([uploads, ...Object.values(directories).slice(1)].map(directory => fs.promises.mkdir(directory, { recursive: true })));

    global.DATA_ROOT = root;
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(fileURLToPath(new URL('../config.yaml', import.meta.url)));
    const { router, diskCache } = await import('../src/endpoints/characters.js');
    const app = express();
    app.use(multer({ dest: uploads }).single('avatar'));
    app.use((request, _response, next) => {
        request.user = { profile: { handle: 'route-test-user' }, directories };
        next();
    });
    app.use('/api/characters', router);

    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });

    try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const ordinaryImage = await postImport(baseUrl, basePng, 'ordinary.png', 'png', '');
        assert.equal(ordinaryImage.status, 400);
        assert.equal((await ordinaryImage.json()).error, 'invalid_character_card');
        await assertDirectoryBecomesEmpty(uploads);

        const unsupported = await postImport(baseUrl, Buffer.from('not a card'), 'card.jpg', 'jpg', 'image/jpeg');
        assert.equal(unsupported.status, 415);
        assert.equal((await unsupported.json()).error, 'unsupported_character_format');
        await assertDirectoryBecomesEmpty(uploads);

        const card = {
            name: 'Route Card',
            description: 'Imported by route test',
            personality: '',
            first_mes: 'Hello',
            mes_example: '',
            scenario: '',
        };
        const cardPng = write(basePng, JSON.stringify(card));
        const imported = await postImport(baseUrl, cardPng, 'route-card.png', 'png', 'application/octet-stream');
        assert.equal(imported.status, 200);
        assert.equal((await imported.json()).file_name, 'Route Card');
        assert.equal(fs.existsSync(path.join(directories.characters, 'Route Card.png')), true);
        await assertDirectoryBecomesEmpty(uploads);
    } finally {
        diskCache.dispose();
        const systemMonitor = (await import('../src/system-monitor.js')).default;
        systemMonitor.destroy();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        // system-monitor persists once more on beforeExit; remove the isolated
        // test root immediately afterwards to avoid a false ENOENT warning.
        process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
    }
});
