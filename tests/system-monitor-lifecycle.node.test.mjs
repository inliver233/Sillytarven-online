import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const monitorUrl = new URL('../src/system-monitor.js', import.meta.url).href;
const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));

/** A data root whose monitor files already hold a user's numbers. */
function dataRootWithStats() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-monitor-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'system-monitor'));
    const statsFile = path.join(root, 'system-monitor', 'user-stats.json');
    fs.writeFileSync(statsFile, JSON.stringify({ alice: { userHandle: 'alice', totalMessages: 7, dailyStats: {} } }));
    return { root, statsFile };
}

const importScript = root => `globalThis.DATA_ROOT = ${JSON.stringify(root)}; await import(${JSON.stringify(monitorUrl)}); console.log('imported');`;

test('a script that only imports the monitor exits on its own and leaves the files alone', () => {
    const { root, statsFile } = dataRootWithStats();
    const before = fs.readFileSync(statsFile, 'utf8');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', importScript(root)], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.signal, null, 'timers kept the script alive');
    assert.equal(child.status, 0, child.stderr);
    assert.equal(fs.readFileSync(statsFile, 'utf8'), before);
});

test('stopping such a script does not overwrite the files with its empty numbers', async () => {
    const { root, statsFile } = dataRootWithStats();
    const before = fs.readFileSync(statsFile, 'utf8');
    const child = spawn(process.execPath, ['--input-type=module', '-e', `${importScript(root)} setTimeout(() => {}, 30000);`]);
    await new Promise((resolve, reject) => {
        child.stdout.on('data', data => String(data).includes('imported') && resolve());
        child.on('exit', () => reject(new Error('script exited early')));
    });
    const exited = new Promise(resolve => child.on('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    assert.equal(fs.readFileSync(statsFile, 'utf8'), before);
});

test('the started monitor loads the saved numbers and saves atomically', async () => {
    const { root, statsFile } = dataRootWithStats();
    globalThis.DATA_ROOT = root;
    const { default: systemMonitor } = await import(monitorUrl);
    const listenersBefore = process.listenerCount('SIGTERM');

    systemMonitor.start();
    try {
        assert.equal(systemMonitor.userLoadStats.get('alice').totalMessages, 7);
        systemMonitor.userLoadStats.get('alice').totalMessages = 8;
        systemMonitor.saveDataToDisk();
        assert.equal(JSON.parse(fs.readFileSync(statsFile, 'utf8')).alice.totalMessages, 8);
        assert.deepEqual(fs.readdirSync(path.dirname(statsFile)).sort(), ['load-history.json', 'system-stats.json', 'user-stats.json'], 'no temporary files left');
    } finally {
        systemMonitor.destroy();
    }
    assert.equal(process.listenerCount('SIGTERM'), listenersBefore, 'exit handlers are removed again');
});
