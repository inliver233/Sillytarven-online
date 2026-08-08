import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import storage from 'node-persist';

test('reset everything deletes data only after the signed-in username is confirmed', async t => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-account-reset-'));
    globalThis.DATA_ROOT = dataRoot;
    await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0 });
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.resolve('config.yaml'));
    const [{ router }, { getUserDirectories }, monitorModule] = await Promise.all([
        import('../src/endpoints/users-private.js'),
        import('../src/users.js'),
        import('../src/system-monitor.js'),
    ]);
    const directories = getUserDirectories('alice');
    fs.mkdirSync(directories.root, { recursive: true });
    const marker = path.join(directories.root, 'must-be-deleted.txt');
    fs.writeFileSync(marker, 'private data');

    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle: 'alice' }, directories };
        next();
    });
    app.use('/api/users', router);
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    t.after(async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        monitorModule.default.destroy();
        if (typeof storage.stop === 'function') storage.stop();
        globalThis.DATA_ROOT = previousDataRoot;
        process.once('exit', () => fs.rmSync(dataRoot, { recursive: true, force: true }));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const missing = await fetch(`${baseUrl}/api/users/reset-step2`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(missing.status, 400);
    assert.equal(fs.existsSync(marker), true);

    const wrong = await fetch(`${baseUrl}/api/users/reset-step2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'mallory' }),
    });
    assert.equal(wrong.status, 403);
    assert.equal(fs.existsSync(marker), true);

    const confirmed = await fetch(`${baseUrl}/api/users/reset-step2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice' }),
    });
    assert.equal(confirmed.status, 204);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(directories.root), true);
});
