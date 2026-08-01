/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    canonicalJsonStringify,
    createCanonicalFileManifest,
    hashCanonicalJson,
    verifyCanonicalFileManifest,
} from '../src/canonical-hash.js';

test('canonical JSON and hashes ignore object insertion order without dropping unknown fields', () => {
    const first = {
        z: 1,
        nested: { unknown: 'preserved', a: true },
        list: [{ b: 2, a: 1 }, 3],
    };
    const second = {
        list: [{ a: 1, b: 2 }, 3],
        nested: { a: true, unknown: 'preserved' },
        z: 1,
    };

    assert.equal(canonicalJsonStringify(first), canonicalJsonStringify(second));
    assert.equal(hashCanonicalJson(first), hashCanonicalJson(second));
    assert.equal(JSON.parse(canonicalJsonStringify(first)).nested.unknown, 'preserved');
});

test('canonical file manifests are path ordered, byte sensitive, and verifiable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-manifest-'));
    try {
        const nested = path.join(root, 'nested');
        fs.mkdirSync(nested);
        const alpha = path.join(root, 'alpha.json');
        const beta = path.join(nested, 'beta.jsonl');
        fs.writeFileSync(alpha, '{"b":2,"a":1}');
        fs.writeFileSync(beta, '{"mes":"one"}\n');

        const manifest = createCanonicalFileManifest(root, [beta, alpha]);
        assert.deepEqual(manifest.files.map(file => file.path), ['alpha.json', 'nested/beta.jsonl']);
        assert.equal(verifyCanonicalFileManifest(root, manifest), true);

        fs.appendFileSync(beta, '{"mes":"two"}\n');
        assert.equal(verifyCanonicalFileManifest(root, manifest), false);
        assert.notEqual(createCanonicalFileManifest(root, [alpha, beta]).digest, manifest.digest);
        assert.throws(() => createCanonicalFileManifest(root, [path.join(root, '..', 'outside')]), /outside/i);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
