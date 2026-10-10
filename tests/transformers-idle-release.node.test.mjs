import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createIdleRelease } from '../src/transformers.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a model is released once, only after it has been idle for the whole delay', async () => {
    let released = 0;
    const idle = createIdleRelease(100, () => released++);
    idle.touch();
    await sleep(60);
    idle.touch();
    await sleep(60);
    idle.touch();
    await sleep(60);
    assert.equal(released, 0, 'every use restarts the idle time');
    await sleep(150);
    assert.equal(released, 1);
    await sleep(150);
    assert.equal(released, 1, 'released only once');
});

test('a pending release does not keep the process alive', () => {
    const moduleUrl = new URL('../src/transformers.js', import.meta.url).href;
    const script = `const { createIdleRelease } = await import(${JSON.stringify(moduleUrl)}); createIdleRelease(60000, () => {}).touch();`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
    assert.equal(child.signal, null, 'the idle timer kept the process alive');
    assert.equal(child.status, 0, child.stderr);
});
