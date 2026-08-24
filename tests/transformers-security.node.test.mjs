import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import sharp from 'sharp';

import { getRawImage } from '../src/transformers.js';

test('Transformers image and inference runtimes are locked to the reviewed dependency set', () => {
    const packageManifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const packageLock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

    assert.equal(packageManifest.dependencies['@xenova/transformers'], '2.17.2');
    assert.equal(packageManifest.dependencies['onnxruntime-web'], '1.16.1');
    assert.equal(packageManifest.dependencies.sharp, '0.35.0');
    assert.equal(packageManifest.overrides['onnxruntime-web'], '$onnxruntime-web');
    assert.equal(packageManifest.overrides.sharp, '$sharp');
    assert.equal(packageManifest.engines.node, '>= 24.0');
    assert.equal(packageManifest.dependencies['sillytavern-transformers'], undefined);

    assert.equal(packageLock.packages['node_modules/@xenova/transformers'].version, '2.17.2');
    assert.equal(packageLock.packages['node_modules/onnxruntime-web'].version, '1.16.1');
    assert.equal(packageLock.packages['node_modules/sharp'].version, '0.35.0');
    assert.equal(packageLock.packages['node_modules/@xenova/transformers/node_modules/onnxruntime-web'], undefined);
    assert.equal(packageLock.packages['node_modules/@xenova/transformers/node_modules/sharp'], undefined);
    assert.equal(packageLock.packages['node_modules/sillytavern-transformers'], undefined);
    assert.equal(packageLock.packages['node_modules/jimp'], undefined);
});

test('application image conversion remains compatible with sharp 0.35', async () => {
    const png = await sharp({
        create: {
            width: 2,
            height: 3,
            channels: 4,
            background: { r: 10, g: 20, b: 30, alpha: 0.5 },
        },
    }).png().toBuffer();

    const rawImage = await getRawImage(png.toString('base64'));
    assert.equal(rawImage?.width, 2);
    assert.equal(rawImage?.height, 3);
    assert.equal(rawImage?.channels, 4);
    assert.equal(await getRawImage('not-an-image'), null);
});
