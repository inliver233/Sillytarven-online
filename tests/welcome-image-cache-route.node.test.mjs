import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

function get(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, { headers }, (response) => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({
                body: Buffer.concat(chunks).toString('utf8'),
                headers: response.headers,
                status: response.statusCode,
            }));
        });
        request.once('error', reject);
    });
}

test('character images use cookie-scoped private HTTP caching and validators', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-welcome-image-cache-'));
    const characters = path.join(root, 'characters');
    fs.mkdirSync(characters, { recursive: true });
    const avatarPath = path.join(characters, 'Alice.png');
    fs.writeFileSync(avatarPath, 'first-avatar');

    globalThis.DATA_ROOT = root;
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(fileURLToPath(new URL('../config.yaml', import.meta.url)));
    const [{ router }, { default: systemMonitor }] = await Promise.all([
        import('../src/users.js'),
        import('../src/system-monitor.js'),
    ]);

    const app = express();
    app.use((request, _response, next) => {
        request.user = { directories: { characters } };
        next();
    });
    app.use(router);
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });

    try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const url = `http://127.0.0.1:${address.port}/characters/Alice.png`;
        const first = await get(url, { cookie: 'session=account-a' });
        assert.equal(first.status, 200);
        assert.equal(first.body, 'first-avatar');
        assert.equal(first.headers['cache-control'], 'private, max-age=300, must-revalidate');
        assert.match(first.headers.vary ?? '', /(?:^|,\s*)Cookie(?:,|$)/i);
        assert.ok(first.headers.etag);
        assert.ok(first.headers['last-modified']);

        const etag = first.headers.etag;
        const unchanged = await get(url, {
            cookie: 'session=account-a',
            'if-none-match': etag,
        });
        assert.equal(unchanged.status, 304);

        fs.writeFileSync(avatarPath, 'second-avatar-with-new-size');
        const changed = await get(url, {
            cookie: 'session=account-a',
            'if-none-match': etag,
        });
        assert.equal(changed.status, 200);
        assert.equal(changed.body, 'second-avatar-with-new-size');
        assert.notEqual(changed.headers.etag, etag);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        systemMonitor.destroy();
        systemMonitor.saveDataToDisk = () => {};
        fs.rmSync(root, { recursive: true, force: true });
    }
});
