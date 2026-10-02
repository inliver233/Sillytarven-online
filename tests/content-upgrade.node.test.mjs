import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { RETIRED_CONTENT_VERSIONS, upgradeRetiredContent } = await import('../src/endpoints/content-manager.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-content-upgrade-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const contentDirectory = fileURLToPath(new URL('../default/content', import.meta.url));
const fingerprint = data => ({ size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });

test('an unedited copy of an earlier built-in version is updated, an edited one is kept', () => {
    const item = { filename: 'themes/sample.json', type: 'theme', folder: root };
    fs.mkdirSync(path.join(root, 'themes'));
    fs.writeFileSync(path.join(root, 'themes/sample.json'), '{"name":"sample","v":2}');
    const earlier = Buffer.from('{"name":"sample","v":1}');
    const retired = [fingerprint(earlier)];

    const unedited = path.join(root, 'unedited.json');
    fs.writeFileSync(unedited, earlier);
    assert.equal(upgradeRetiredContent(item, unedited, retired), true);
    assert.equal(fs.readFileSync(unedited, 'utf8'), '{"name":"sample","v":2}');
    assert.equal(upgradeRetiredContent(item, unedited, retired), false, 'already current');

    const edited = path.join(root, 'edited.json');
    fs.writeFileSync(edited, '{"name":"sample","v":9}');
    assert.equal(upgradeRetiredContent(item, edited, retired), false);
    assert.equal(fs.readFileSync(edited, 'utf8'), '{"name":"sample","v":9}');
    assert.equal(upgradeRetiredContent(item, path.join(root, 'missing.json'), retired), false);
});

test('the shipped version of an upgraded file is never listed as retired', () => {
    for (const [filename, versions] of Object.entries(RETIRED_CONTENT_VERSIONS)) {
        const current = fingerprint(fs.readFileSync(path.join(contentDirectory, filename)));
        assert.ok(!versions.some(version => version.sha256 === current.sha256), filename);
        versions.forEach(version => assert.match(version.sha256, /^[0-9a-f]{64}$/));
    }
});
