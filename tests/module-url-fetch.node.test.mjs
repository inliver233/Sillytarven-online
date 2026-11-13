import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

// A page on https://example.org whose files come from a CDN mirror (see src/asset-version.js).
globalThis.location = new URL('https://example.org/');
const failed = [];
globalThis.__stAssetCdn = { thirdParty: {}, failed: url => failed.push(url) };
const { fetchAsset } = await import('../public/scripts/util/module-url.js');

const MIRROR = 'https://s1.example.cn/v/s/scripts/templates/t.html?v=44444444';
let calls = [];
let answer = () => new Response('mirror');
beforeEach(() => {
    calls = [];
    failed.length = 0;
    globalThis.fetch = (url, init) => {
        calls.push(String(url));
        if (String(url).startsWith('https://example.org/') || String(url).startsWith('/')) {
            return Promise.resolve(new Response('origin'));
        }
        return answer(init);
    };
});

test('a file from the mirror comes from the mirror', async () => {
    answer = () => Promise.resolve(new Response('mirror'));
    assert.equal(await (await fetchAsset(MIRROR)).text(), 'mirror');
    assert.deepEqual(calls, [MIRROR]);
    assert.deepEqual(failed, []);
});

test('a mirror that does not answer in time or fails: the same file from this server', async () => {
    answer = init => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    assert.equal(await (await fetchAsset(MIRROR, {}, { timeoutMs: 50 })).text(), 'origin');
    assert.deepEqual(calls, [MIRROR, 'https://example.org/v/s/scripts/templates/t.html?v=44444444']);
    assert.deepEqual(failed, [MIRROR]);

    answer = () => Promise.resolve(new Response('bad gateway', { status: 502 }));
    assert.equal(await (await fetchAsset(MIRROR)).text(), 'origin');
    // A file that does not exist is not the mirror's fault
    answer = () => Promise.resolve(new Response('', { status: 404 }));
    assert.equal((await fetchAsset(MIRROR)).status, 404);
});

test('files of this server and requests the caller cancels are left alone', async () => {
    assert.equal(await (await fetchAsset('/scripts/templates/t.html')).text(), 'origin');
    const controller = new AbortController();
    answer = init => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const pending = fetchAsset(MIRROR, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending);
    assert.deepEqual(failed, []);
});
