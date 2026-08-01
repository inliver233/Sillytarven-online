/* eslint-disable playwright/expect-expect, playwright/no-conditional-in-test -- Node test runner uses assert and generated cases. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { parse as parseYaml } from 'yaml';

import { MIGRATION_FEATURE_FLAGS, getPublicMigrationFeatureFlags } from '../src/feature-flags.js';
import { setConfigFilePath } from '../src/util.js';

const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
setConfigFilePath(defaultConfigPath);
const defaultConfig = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
const expectedDefaults = Object.fromEntries(Object.keys(MIGRATION_FEATURE_FLAGS).map(name => [name, false]));

test('all migration feature flags are explicitly disabled in default config', () => {
    assert.deepEqual(defaultConfig.featureFlags, expectedDefaults);
    assert.deepEqual(getPublicMigrationFeatureFlags(), expectedDefaults);
});

for (const [enabledName, enabledPath] of Object.entries(MIGRATION_FEATURE_FLAGS)) {
    test(`public migration projection isolates ${enabledName}`, () => {
        const projection = getPublicMigrationFeatureFlags(key => key === enabledPath);
        assert.equal(projection[enabledName], true);
        for (const [name, value] of Object.entries(projection)) {
            if (name !== enabledName) assert.equal(value, false);
            assert.equal(typeof value, 'boolean');
        }
    });
}

test('public feature flag endpoint returns only the boolean projection', async () => {
    const { router } = await import('../src/endpoints/public-config.js');
    const app = express();
    app.use('/api/public-config', router);
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/public-config/feature-flags`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), expectedDefaults);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
