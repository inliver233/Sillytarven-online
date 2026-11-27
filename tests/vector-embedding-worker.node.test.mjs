import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createEmbeddingWorker } from '../src/vectors/embedding.js';
import { embedText, MAX_WINDOW_TOKENS, splitToWindows } from '../src/vectors/embedding-core.js';

const workerUrl = new URL('./fixtures/fake-embedding-worker.mjs', import.meta.url);
const options = { task: 'feature-extraction', model: 'fake/model' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('texts are embedded in one reused thread; a model error fails only its own request', async () => {
    const embeddings = createEmbeddingWorker({ workerUrl, idleMs: 60_000, timeoutMs: 10_000 });
    try {
        const first = await embeddings.run(options, 'abc');
        assert.equal(first[0], 3);
        assert.equal(first[2], options.model.length);
        await assert.rejects(embeddings.run(options, 'fail'), /model failed/);
        const second = await embeddings.run(options, 'abcd');
        assert.equal(second[0], 4);
        assert.equal(second[1], first[1], 'the thread was not reused');
    } finally {
        embeddings.stop();
    }
});

test('a crashed or stuck thread fails its request and the next one gets a new thread', async () => {
    const embeddings = createEmbeddingWorker({ workerUrl, idleMs: 60_000, timeoutMs: 300 });
    try {
        const before = await embeddings.run(options, 'a');
        await assert.rejects(embeddings.run(options, 'crash'), /stopped/);
        const afterCrash = await embeddings.run(options, 'b');
        assert.notEqual(afterCrash[1], before[1]);

        await assert.rejects(embeddings.run(options, 'hang'), /took too long/);
        assert.equal(embeddings.running, false);
        const afterHang = await embeddings.run(options, 'c');
        assert.notEqual(afterHang[1], afterCrash[1]);
    } finally {
        embeddings.stop();
    }
});

test('an idle thread is ended, and another model starts a new thread', async () => {
    const embeddings = createEmbeddingWorker({ workerUrl, idleMs: 150, timeoutMs: 10_000 });
    try {
        const first = await embeddings.run(options, 'a');
        assert.equal(embeddings.running, true);
        const other = await embeddings.run({ ...options, model: 'fake/other-model' }, 'a');
        assert.notEqual(other[1], first[1], 'a different model ran in the old thread');
        assert.equal(other[2], 'fake/other-model'.length);
        await sleep(400);
        assert.equal(embeddings.running, false, 'the idle thread was kept');
        const again = await embeddings.run(options, 'a');
        assert.equal(again[0], 1);
    } finally {
        embeddings.stop();
    }
});

test('an idle embedding thread does not keep the process alive', () => {
    const moduleUrl = new URL('../src/vectors/embedding.js', import.meta.url).href;
    // A script file: a worker inherits the node options, and --input-type would stop it from starting
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-embedding-worker-'));
    const scriptPath = path.join(directory, 'child.mjs');
    fs.writeFileSync(scriptPath, `
        const { createEmbeddingWorker } = await import(${JSON.stringify(moduleUrl)});
        const embeddings = createEmbeddingWorker({ workerUrl: new URL(${JSON.stringify(workerUrl.href)}), idleMs: 600000, timeoutMs: 600000 });
        console.log(JSON.stringify(await embeddings.run({ model: 'x' }, 'hello')));
    `);
    try {
        const child = spawnSync(process.execPath, ['--max-old-space-size=4096', scriptPath], { encoding: 'utf8', timeout: 30_000 });
        assert.equal(child.signal, null, 'the idle thread kept the process alive');
        assert.equal(child.status, 0, child.stderr);
        assert.equal(JSON.parse(child.stdout.trim())[0], 5);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

/** A pipeline whose tokens are characters and whose vector is [characters, 1] */
function fakePipe() {
    const calls = [];
    const pipe = async (text, options) => {
        calls.push({ text, options });
        const raw = [text.length, 1];
        const norm = options.normalize ? Math.hypot(...raw) : 1;
        return { data: Float32Array.from(raw, value => value / norm) };
    };
    pipe.tokenizer = text => ({ input_ids: { size: text.length } });
    pipe.calls = calls;
    return pipe;
}

test('ordinary texts are embedded whole; long ones in windows combined by their tokens', async () => {
    const short = fakePipe();
    const vector = await embedText(short, 'hello');
    assert.deepEqual(short.calls.map(call => call.options), [{ pooling: 'mean', normalize: true }]);
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-6);

    const long = fakePipe();
    const text = ('一句话。'.repeat(300) + '\n').repeat(4);
    const windows = splitToWindows(long, text);
    assert.ok(windows.length > 1);
    assert.ok(windows.every(window => window.tokens <= MAX_WINDOW_TOKENS));
    assert.equal(windows.map(window => window.text).join(''), text);
    const combined = await embedText(long, text);
    assert.ok(long.calls.every(call => call.options.normalize === false));
    // Every window answers [length, 1], weighted by its length: the mean is [Σl²/Σl, 1], normalized
    const sumSquares = windows.reduce((sum, window) => sum + window.tokens ** 2, 0);
    const sum = windows.reduce((total, window) => total + window.tokens, 0);
    const expected = [sumSquares / sum, 1];
    const norm = Math.hypot(...expected);
    assert.ok(Math.abs(combined[0] - expected[0] / norm) < 1e-6);
    assert.ok(Math.abs(combined[1] - expected[1] / norm) < 1e-6);
});
