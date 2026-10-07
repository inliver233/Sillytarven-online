import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { checkForNewContent } = await import('../src/endpoints/content-manager.js');
const { USER_DIRECTORY_TEMPLATE } = await import('../src/constants.js');

const contentDirectory = fileURLToPath(new URL('../default/content', import.meta.url));
const contentIndex = JSON.parse(fs.readFileSync(path.join(contentDirectory, 'index.json'), 'utf8'));
const backgrounds = contentIndex.filter(item => item.type === 'background').map(item => item.filename);
const theme = contentIndex.find(item => item.type === 'theme').filename;

const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function dataRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-content-seeding-'));
    roots.push(root);
    return root;
}

function userDirectories(root, handle) {
    return Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(root, handle, value)]));
}

const userFile = (directories, filename) => path.join(directories.backgrounds, path.basename(filename));
const builtIn = filename => fs.readFileSync(path.join(contentDirectory, filename));

test('new users share one copy of each built-in background, other content is copied', async () => {
    const root = dataRoot();
    const alice = userDirectories(root, 'alice');
    const bob = userDirectories(root, 'bob');
    await checkForNewContent([alice, bob]);

    assert.ok(backgrounds.length > 0);
    for (const filename of backgrounds) {
        const a = fs.statSync(userFile(alice, filename));
        const b = fs.statSync(userFile(bob, filename));
        assert.equal(a.ino, b.ino, filename);
        assert.equal(a.nlink, 3, `${filename}: two users and the shared copy`);
        assert.deepEqual(fs.readFileSync(userFile(alice, filename)), builtIn(filename));
    }
    assert.equal(fs.readdirSync(path.join(root, '_shared-content', 'backgrounds')).length, new Set(backgrounds).size);
    assert.equal(fs.statSync(path.join(alice.themes, path.basename(theme))).nlink, 1, 'themes are edited in place, so never shared');
});

test('deleting one user\'s background leaves everyone else\'s intact', async () => {
    const root = dataRoot();
    const alice = userDirectories(root, 'alice');
    const bob = userDirectories(root, 'bob');
    await checkForNewContent([alice, bob]);

    const filename = backgrounds[0];
    fs.unlinkSync(userFile(alice, filename));
    assert.deepEqual(fs.readFileSync(userFile(bob, filename)), builtIn(filename));
});

test('backgrounds are copied when they cannot be linked', async () => {
    const root = dataRoot();
    fs.writeFileSync(path.join(root, '_shared-content'), 'not a folder');
    const carol = userDirectories(root, 'carol');
    await checkForNewContent([carol]);

    for (const filename of backgrounds) {
        assert.equal(fs.statSync(userFile(carol, filename)).nlink, 1, filename);
        assert.deepEqual(fs.readFileSync(userFile(carol, filename)), builtIn(filename));
    }
});
