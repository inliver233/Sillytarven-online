/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyCharXAssetRewrites, persistCharXAssets } from '../src/charx.js';

const imageBuffer = fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url));

test('CharX backgrounds are discoverable globally and isolated by internal character name', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-charx-assets-'));
    const directories = {
        root,
        backgrounds: path.join(root, 'backgrounds'),
        characters: path.join(root, 'characters'),
        userImages: path.join(root, 'user', 'images'),
    };
    await Promise.all(Object.values(directories).slice(1).map(directory => fs.promises.mkdir(directory, { recursive: true })));

    const assets = [{
        type: 'background',
        name: 'Moon Light',
        ext: 'png',
        zipPath: 'assets/moon.png',
        order: 1,
        storageCategory: 'background',
        baseName: 'moon_light',
    }];

    try {
        const first = persistCharXAssets(assets, new Map([['assets/moon.png', imageBuffer]]), directories, {
            characterFolder: 'Shared Display Name',
            assetFolder: 'Card One',
        });
        const second = persistCharXAssets(assets, new Map([['assets/moon.png', imageBuffer]]), directories, {
            characterFolder: 'Shared Display Name',
            assetFolder: 'Card Two',
        });

        assert.equal(first.backgrounds, 1);
        assert.equal(second.backgrounds, 1);
        assert.notEqual(first.rewrites[0].uri, second.rewrites[0].uri);
        assert.match(first.rewrites[0].uri, /^\/backgrounds\//);
        assert.equal(fs.existsSync(path.join(directories.characters, 'Shared Display Name', 'backgrounds')), false);
        assert.equal(fs.readdirSync(directories.backgrounds).length, 2);

        const card = { data: { assets: [{}, { uri: 'embedded://assets/moon.png' }] } };
        applyCharXAssetRewrites(card, first.rewrites);
        assert.equal(card.data.assets[1].uri, first.rewrites[0].uri);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('CharX persistence ignores a background whose bytes are not an image', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-charx-invalid-'));
    const directories = {
        root,
        backgrounds: path.join(root, 'backgrounds'),
        characters: path.join(root, 'characters'),
        userImages: path.join(root, 'user', 'images'),
    };
    await Promise.all(Object.values(directories).slice(1).map(directory => fs.promises.mkdir(directory, { recursive: true })));

    try {
        const summary = persistCharXAssets([{
            zipPath: 'assets/not-image.png',
            order: 0,
            ext: 'png',
            storageCategory: 'background',
            baseName: 'not-image',
        }], new Map([['assets/not-image.png', Buffer.from('not an image')]]), directories, {
            characterFolder: 'Character',
            assetFolder: 'Character 1',
        });

        assert.equal(summary.backgrounds, 0);
        assert.deepEqual(summary.rewrites, []);
        assert.deepEqual(fs.readdirSync(directories.backgrounds), []);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('CharX sprites can be isolated by the internal card filename', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-charx-sprites-'));
    const directories = {
        root,
        backgrounds: path.join(root, 'backgrounds'),
        characters: path.join(root, 'characters'),
        userImages: path.join(root, 'user', 'images'),
    };
    await Promise.all(Object.values(directories).slice(1).map(directory => fs.promises.mkdir(directory, { recursive: true })));
    const sprite = [{
        zipPath: 'assets/happy.png',
        order: 0,
        ext: 'png',
        storageCategory: 'sprite',
        baseName: 'joy',
    }];

    try {
        for (const internalName of ['Card One', 'Card Two']) {
            const summary = persistCharXAssets(sprite, new Map([['assets/happy.png', imageBuffer]]), directories, {
                characterFolder: 'Shared Display Name',
                assetFolder: internalName,
                spriteFolder: internalName,
            });
            assert.equal(summary.sprites, 1);
            assert.equal(fs.existsSync(path.join(directories.characters, internalName, 'joy.png')), true);
            assert.match(summary.rewrites[0].uri, new RegExp(`/characters/${internalName}/joy\\.png$`));
        }
        assert.equal(fs.existsSync(path.join(directories.characters, 'Shared Display Name')), false);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
