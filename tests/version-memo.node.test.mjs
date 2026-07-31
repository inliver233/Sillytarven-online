import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { VersionMemo } from '../src/version.js';

async function withRoot(callback) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-version-memo-'));
    await fs.promises.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '9.8.7' }));
    try {
        return await callback(root);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}

function writeLooseHead(root, revision, branch = 'main') {
    const gitDirectory = path.join(root, '.git');
    const refPath = path.join(gitDirectory, 'refs', 'heads', branch);
    fs.mkdirSync(path.dirname(refPath), { recursive: true });
    fs.writeFileSync(path.join(gitDirectory, 'HEAD'), `ref: refs/heads/${branch}\n`);
    fs.writeFileSync(refPath, `${revision}\n`);
}

function readRevision(root) {
    const gitDirectory = path.join(root, '.git');
    const head = fs.readFileSync(path.join(gitDirectory, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head;
    const refName = head.slice(4).trim();
    const loosePath = path.join(gitDirectory, ...refName.split('/'));
    if (fs.existsSync(loosePath)) return fs.readFileSync(loosePath, 'utf8').trim();
    const packed = fs.readFileSync(path.join(gitDirectory, 'packed-refs'), 'utf8');
    return packed.split(/\r?\n/).find(line => line.endsWith(` ${refName}`))?.split(' ')[0] ?? '';
}

function createFakeGitFactory({ delayMs = 0, failTracking = false } = {}) {
    const stats = { factories: 0, commands: 0 };
    const factory = root => {
        stats.factories++;
        return {
            async revparse(args) {
                stats.commands++;
                if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
                const revision = readRevision(root);
                if (args[0] === '--short') return revision.slice(0, 9);
                if (args[0] === '--abbrev-ref' && args[1] === 'HEAD') {
                    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
                    return head.startsWith('ref:') ? head.split('/').at(-1) : 'HEAD';
                }
                if (args[0] === '--abbrev-ref' && args[1] === '@{u}') {
                    if (failTracking) throw new Error('no upstream');
                    return 'origin/main';
                }
                if (args[0] === 'HEAD' || args[0] === 'origin/main') return revision;
                throw new Error(`Unexpected revparse: ${args.join(' ')}`);
            },
            async show() {
                stats.commands++;
                return '2026-07-31 12:34:56 +0800\n';
            },
        };
    };
    return { factory, stats };
}

test('version memo supports source archives without Git and returns isolated values', async () => {
    await withRoot(async root => {
        const states = [];
        const memo = new VersionMemo({ rootDirectory: root, hasGit: () => false, ttlMs: 30_000 });
        const first = await memo.get({ onCacheState: state => states.push(state) });
        first.pkgVersion = 'mutated';
        const second = await memo.get({ onCacheState: state => states.push(state) });

        assert.deepEqual(states, ['miss', 'hit']);
        assert.deepEqual(second, {
            agent: 'SillyTavern:9.8.7:Cohee#1207',
            pkgVersion: '9.8.7',
            gitRevision: null,
            gitBranch: null,
            commitDate: null,
            isLatest: true,
        });

        memo.clear();
        await memo.get({ onCacheState: state => states.push(state) });
        assert.equal(states.at(-1), 'miss');

        const brokenProbe = new VersionMemo({ rootDirectory: root, hasGit: () => { throw new Error('probe failed'); } });
        assert.equal((await brokenProbe.get()).gitRevision, null);
    });
});

test('concurrent version misses share one complete Git lookup', async () => {
    await withRoot(async root => {
        const revision = 'a'.repeat(40);
        writeLooseHead(root, revision);
        const { factory, stats } = createFakeGitFactory({ delayMs: 2 });
        const memo = new VersionMemo({ rootDirectory: root, hasGit: () => true, createGit: factory });
        const states = [];

        const values = await Promise.all(Array.from({ length: 6 }, () => memo.get({ onCacheState: state => states.push(state) })));
        assert.equal(stats.factories, 1);
        assert.equal(stats.commands, 6);
        assert.equal(states.filter(state => state === 'miss').length, 1);
        assert.equal(values.every(value => value.gitRevision === revision.slice(0, 9)), true);
        assert.equal(values.every(value => value.gitBranch === 'main'), true);
        assert.equal(values.every(value => value.isLatest), true);
    });
});

test('loose HEAD ref changes invalidate the memo before TTL expiry', async () => {
    await withRoot(async root => {
        writeLooseHead(root, 'a'.repeat(40));
        const { factory, stats } = createFakeGitFactory();
        const memo = new VersionMemo({ rootDirectory: root, hasGit: () => true, createGit: factory, ttlMs: 60_000 });
        const states = [];

        assert.equal((await memo.get({ onCacheState: state => states.push(state) })).gitRevision, 'a'.repeat(9));
        await memo.get({ onCacheState: state => states.push(state) });
        fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`);
        assert.equal((await memo.get({ onCacheState: state => states.push(state) })).gitRevision, 'b'.repeat(9));

        assert.deepEqual(states, ['miss', 'hit', 'miss']);
        assert.equal(stats.factories, 2);
    });
});

test('detached HEAD and packed refs retain the complete response shape', async () => {
    await withRoot(async root => {
        const gitDirectory = path.join(root, '.git');
        fs.mkdirSync(gitDirectory, { recursive: true });
        fs.writeFileSync(path.join(gitDirectory, 'HEAD'), `${'c'.repeat(40)}\n`);
        const detachedFactory = createFakeGitFactory({ failTracking: true });
        const detachedMemo = new VersionMemo({ rootDirectory: root, hasGit: () => true, createGit: detachedFactory.factory });
        const detached = await detachedMemo.get();
        assert.equal(detached.gitRevision, 'c'.repeat(9));
        assert.equal(detached.gitBranch, 'HEAD');
        assert.equal(detached.commitDate, '2026-07-31 12:34:56 +0800');
        assert.equal(detached.isLatest, true);

        fs.writeFileSync(path.join(gitDirectory, 'HEAD'), 'ref: refs/heads/main\n');
        fs.writeFileSync(path.join(gitDirectory, 'packed-refs'), `${'d'.repeat(40)} refs/heads/main\n`);
        const packedFactory = createFakeGitFactory();
        const packedMemo = new VersionMemo({ rootDirectory: root, hasGit: () => true, createGit: packedFactory.factory, ttlMs: 60_000 });
        assert.equal((await packedMemo.get()).gitRevision, 'd'.repeat(9));
        fs.writeFileSync(path.join(gitDirectory, 'packed-refs'), `${'e'.repeat(40)} refs/heads/main\n`);
        assert.equal((await packedMemo.get()).gitRevision, 'e'.repeat(9));
        assert.equal(packedFactory.stats.factories, 2);
    });
});

test('TTL and disabled mode control reuse without affecting single-flight correctness', async () => {
    await withRoot(async root => {
        let now = 1000;
        const memo = new VersionMemo({ rootDirectory: root, hasGit: () => false, ttlMs: 50, now: () => now });
        const states = [];
        await memo.get({ onCacheState: state => states.push(state) });
        now += 49;
        await memo.get({ onCacheState: state => states.push(state) });
        now += 1;
        await memo.get({ onCacheState: state => states.push(state) });
        assert.deepEqual(states, ['miss', 'hit', 'miss']);

        const disabledStates = [];
        const disabled = new VersionMemo({ rootDirectory: root, hasGit: () => false, enabled: false });
        await disabled.get({ onCacheState: state => disabledStates.push(state) });
        await disabled.get({ onCacheState: state => disabledStates.push(state) });
        assert.deepEqual(disabledStates, ['miss', 'miss']);
    });
});

test('util getVersion wrapper exposes memo hits and a clear tool', async () => {
    const util = await import('../src/util.js');
    util.setConfigFilePath(fileURLToPath(new URL('../config.yaml', import.meta.url)));
    const states = [];
    const first = await util.getVersion({ onCacheState: state => states.push(state) });
    const second = await util.getVersion({ onCacheState: state => states.push(state) });
    util.clearVersionCache();
    const third = await util.getVersion({ onCacheState: state => states.push(state) });

    assert.deepEqual(Object.keys(first), ['agent', 'pkgVersion', 'gitRevision', 'gitBranch', 'commitDate', 'isLatest']);
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.deepEqual(states, ['miss', 'hit', 'miss']);
});
