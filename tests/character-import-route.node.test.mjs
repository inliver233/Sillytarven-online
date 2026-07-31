/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import archiver from 'archiver';
import multer from 'multer';

import { write } from '../src/character-card-parser.js';

const basePng = fs.readFileSync(new URL('../default/content/user-default.png', import.meta.url));

async function postImport(baseUrl, bytes, fileName, format, mimeType = 'application/octet-stream', options = {}) {
    const form = new FormData();
    form.append('file_type', format);
    form.append('user_name', 'User');
    if (options.preservedName) form.append('preserved_name', options.preservedName);
    form.append('avatar', new Blob([bytes], { type: mimeType }), fileName);
    return await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: form, headers: options.headers });
}

async function createZip(entries) {
    const output = new PassThrough();
    const chunks = [];
    output.on('data', chunk => chunks.push(chunk));
    const completed = new Promise((resolve, reject) => {
        output.once('end', resolve);
        output.once('error', reject);
    });
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.once('error', error => output.destroy(error));
    archive.pipe(output);
    for (const [name, contents] of Object.entries(entries)) archive.append(contents, { name });
    await archive.finalize();
    await completed;
    return Buffer.concat(chunks);
}

function makeCharXCard(name, backgroundName = 'scene') {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: '',
            personality: '',
            scenario: '',
            first_mes: 'Hello',
            mes_example: '',
            creator_notes: '',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: [],
            creator: '',
            character_version: '',
            extensions: {},
            assets: [{
                type: 'background',
                name: backgroundName,
                ext: 'png',
                uri: 'embedded://assets/background.png',
            }],
        },
    };
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
    let quotaCheckedBytes = null;
    app.use((request, _response, next) => {
        request.user = { profile: { handle: 'route-test-user' }, directories };
        if (request.headers['x-test-transaction-failure'] === '1') {
            request.characterImportTransactionOptions = {
                beforeApply: ({ index }) => {
                    if (index === 1) throw Object.assign(new Error('simulated full disk'), { code: 'ENOSPC' });
                },
            };
        }
        if (request.headers['x-test-quota-failure'] === '1') {
            request.characterImportStorageCheck = async (_profile, _directories, additionalBytes) => {
                quotaCheckedBytes = additionalBytes;
                return { allowed: false, usedBytes: 100, limitBytes: 100, remainingBytes: 0 };
            };
        }
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

        const charx = await createZip({
            'card.json': JSON.stringify(makeCharXCard('Archive Card')),
            'assets/background.png': basePng,
        });
        const importedCharX = await postImport(baseUrl, charx, 'archive.charx', 'charx');
        assert.equal(importedCharX.status, 200);
        assert.equal((await importedCharX.json()).file_name, 'Archive Card');
        assert.equal(fs.existsSync(path.join(directories.characters, 'Archive Card.png')), true);
        assert.equal(fs.existsSync(path.join(directories.backgrounds, 'Archive Card_scene.png')), true);
        await assertDirectoryBecomesEmpty(uploads);

        const concurrentArchive = await createZip({
            'card.json': JSON.stringify(makeCharXCard('Concurrent Card')),
            'assets/background.png': basePng,
        });
        const concurrentResponses = await Promise.all([
            postImport(baseUrl, concurrentArchive, 'concurrent-a.charx', 'charx'),
            postImport(baseUrl, concurrentArchive, 'concurrent-b.charx', 'charx'),
        ]);
        assert.deepEqual(concurrentResponses.map(response => response.status), [200, 200]);
        const concurrentNames = new Set(await Promise.all(concurrentResponses.map(async response => (await response.json()).file_name)));
        assert.deepEqual(concurrentNames, new Set(['Concurrent Card', 'Concurrent Card1']));
        for (const name of concurrentNames) {
            assert.equal(fs.existsSync(path.join(directories.characters, `${name}.png`)), true);
            assert.equal(fs.existsSync(path.join(directories.backgrounds, `${name}_scene.png`)), true);
        }
        await assertDirectoryBecomesEmpty(uploads);

        const byaf = await createZip({
            'manifest.json': JSON.stringify({
                characters: ['characters/card.json'],
                scenarios: ['scenarios/one.json'],
                author: { name: 'Route Test' },
            }),
            'characters/card.json': JSON.stringify({
                name: 'BYAF Card',
                displayName: 'BYAF Card',
                persona: 'Imported from BYAF',
                images: [],
                loreItems: [],
            }),
            'scenarios/one.json': JSON.stringify({
                title: 'Opening',
                narrative: '',
                firstMessages: [{ text: 'Hello from BYAF' }],
                exampleMessages: [],
                messages: [],
            }),
        });
        const importedByaf = await postImport(baseUrl, byaf, 'archive.byaf', 'byaf');
        assert.equal(importedByaf.status, 200);
        assert.equal((await importedByaf.json()).file_name, 'BYAF Card');
        assert.equal(fs.existsSync(path.join(directories.characters, 'BYAF Card.png')), true);
        assert.equal((await fs.promises.readdir(path.join(directories.chats, 'BYAF Card'))).length, 1);
        await assertDirectoryBecomesEmpty(uploads);

        const quotaArchive = await createZip({
            'card.json': JSON.stringify(makeCharXCard('Quota Card')),
            'assets/background.png': basePng,
        });
        const quotaResponse = await postImport(baseUrl, quotaArchive, 'quota.charx', 'charx', 'application/octet-stream', {
            headers: { 'x-test-quota-failure': '1' },
        });
        assert.equal(quotaResponse.status, 507);
        assert.equal((await quotaResponse.json()).error, 'storage_limit');
        assert.ok(quotaCheckedBytes > basePng.length);
        assert.equal(fs.existsSync(path.join(directories.characters, 'Quota Card.png')), false);
        assert.equal(fs.existsSync(path.join(directories.backgrounds, 'Quota Card_scene.png')), false);
        await assertDirectoryBecomesEmpty(uploads);

        const oldCard = Buffer.from('old character bytes');
        const oldBackground = Buffer.from('old background bytes');
        const rollbackCardPath = path.join(directories.characters, 'Rollback Card.png');
        const rollbackBackgroundPath = path.join(directories.backgrounds, 'Rollback Card_scene.png');
        await fs.promises.writeFile(rollbackCardPath, oldCard);
        await fs.promises.writeFile(rollbackBackgroundPath, oldBackground);
        const replacement = await createZip({
            'card.json': JSON.stringify(makeCharXCard('Rollback Card')),
            'assets/background.png': basePng,
        });
        const failedReplacement = await postImport(baseUrl, replacement, 'replacement.charx', 'charx', 'application/octet-stream', {
            preservedName: 'Rollback Card.png',
            headers: { 'x-test-transaction-failure': '1' },
        });
        assert.equal(failedReplacement.status, 507);
        assert.equal((await failedReplacement.json()).error, 'storage_write_failed');
        assert.deepEqual(await fs.promises.readFile(rollbackCardPath), oldCard);
        assert.deepEqual(await fs.promises.readFile(rollbackBackgroundPath), oldBackground);
        const stagingParent = path.join(path.dirname(root), '.import-staging');
        if (fs.existsSync(stagingParent)) assert.deepEqual(await fs.promises.readdir(stagingParent), []);
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
