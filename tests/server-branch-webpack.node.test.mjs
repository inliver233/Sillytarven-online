import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import webpack from 'webpack';

import getPublicLibConfig from '../webpack.config.js';

test('the production browser library bundle compiles with the locked dependencies', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-server-webpack-'));
    const previousDataRoot = globalThis.DATA_ROOT;
    globalThis.DATA_ROOT = outputRoot;

    const compiler = webpack(getPublicLibConfig(false));
    let stats;
    try {
        stats = await new Promise((resolve, reject) => {
            compiler.run((error, result) => error ? reject(error) : resolve(result));
        });
    } finally {
        await new Promise((resolve, reject) => {
            compiler.close(error => error ? reject(error) : resolve());
        });
        if (previousDataRoot === undefined) {
            delete globalThis.DATA_ROOT;
        } else {
            globalThis.DATA_ROOT = previousDataRoot;
        }
    }

    try {
        assert.equal(stats.hasErrors(), false, stats.toString({ colors: false }));
        const bundlePath = path.join(outputRoot, '_webpack', webpack.version, 'output', 'lib.js');
        const bundle = fs.readFileSync(bundlePath, 'utf8');
        assert.ok(bundle.length > 1_000_000, 'browser library bundle is unexpectedly small');
        assert.match(bundle, /showdown/i);
    } finally {
        fs.rmSync(outputRoot, { recursive: true, force: true });
    }
});
