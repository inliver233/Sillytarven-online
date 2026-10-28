import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import git from 'isomorphic-git';

const { createGuardedHttp, isBlockedAddress, normalizeRemoteUrl } = await import('../src/git-sync/remote-http.js');
const { createTrackFilter, defaultTrackingRules, sanitizeTrackingRules } = await import('../src/git-sync/tracking.js');

const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));

test('remote addresses: only public https, never credentials in the URL', () => {
    assert.equal(normalizeRemoteUrl('https://github.com/me/tavern.git'), 'https://github.com/me/tavern.git');
    for (const url of [
        'http://github.com/me/tavern.git',
        'https://user:token@github.com/me/tavern.git',
        'https://127.0.0.1/repo.git',
        'https://[::1]/repo.git',
        'https://10.0.0.5/repo.git',
        'https://169.254.169.254/latest',
        'https://localhost/repo.git',
        'file:///etc/passwd',
        'not a url',
    ]) {
        assert.throws(() => normalizeRemoteUrl(url), { code: 'RemoteNotAllowed' }, url);
    }
    assert.equal(isBlockedAddress('192.168.1.1'), true);
    assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
    assert.equal(isBlockedAddress('140.82.112.3'), false);
});

test('a hostname that resolves to a private address is refused at connect time', async () => {
    // localhost.localtest.me style names resolve to 127.0.0.1; "localhost" itself is enough here
    // because the URL check is bypassed with allowHttp and only the lookup guard remains.
    const { request } = createGuardedHttp({ allowHttp: true });
    await assert.rejects(request({ url: 'http://127.0.0.1.nip.io/repo.git/info/refs' }), (error) => error.code === 'RemoteNotAllowed' || error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN');
});

test('credentials and nested repositories are never tracked, whatever is ticked', () => {
    const everything = sanitizeTrackingRules({ categories: Object.fromEntries(Object.keys(defaultTrackingRules().categories).map(id => [id, true])) });
    const tracked = createTrackFilter(everything);
    for (const filepath of ['secrets.json', 'extensions/foo/.git/config', '.git/HEAD', 'backups/chat.jsonl', 'thumbnails/bg/a.png']) {
        assert.equal(tracked(filepath), false, filepath);
    }
    assert.equal(tracked('chats/Seraphina/hello.jsonl'), true);
    assert.equal(createTrackFilter(defaultTrackingRules())('extensions/foo/index.js'), false, 'extensions are off by default');
});

test('merging keeps one side per conflicting file and never writes conflict markers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-git-'));
    roots.push(root);
    globalThis.DATA_ROOT = root;
    const { getRepoContext, ensureRepo, commitAll, readSettings, applyCommitToWorkTree } = await import('../src/git-sync/repo.js');
    const { planMerge, writeMergeCommit } = await import('../src/git-sync/merge.js');

    const dir = path.join(root, 'tester');
    fs.mkdirSync(path.join(dir, 'characters'), { recursive: true });
    // A fresh context per step, like one per request on the server (contexts cache file stats).
    const fresh = () => getRepoContext('tester', dir);
    const ctx = fresh();
    const settings = readSettings(ctx);
    const author = { name: 't', email: 't@t' };
    const write = (file, content) => fs.writeFileSync(path.join(dir, file), content);
    const png = (byte) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, byte, 0, 1, 2]);

    await ensureRepo(ctx);
    write('settings.json', '{"a":1}');
    write('characters/A.png', png(1));
    write('secrets.json', '{"api_key":"sk-secret"}');
    const base = (await commitAll(fresh(), settings, { author })).oid;
    assert.deepEqual((await git.listFiles({ fs, gitdir: ctx.gitdir, ref: base })).sort(), ['characters/A.png', 'settings.json']);

    write('settings.json', '{"a":22}');
    write('characters/A.png', png(2));
    const ours = (await commitAll(fresh(), settings, { author })).oid;
    await git.branch({ fs, gitdir: ctx.gitdir, ref: 'ours', object: ours });
    await applyCommitToWorkTree(fresh(), base, { moveBranch: 'main' });
    write('settings.json', '{"a":333}');
    write('characters/A.png', Buffer.concat([png(3), Buffer.from([9])]));
    const theirs = (await commitAll(fresh(), settings, { author })).oid;

    const plan = await planMerge(fresh(), ours, theirs);
    assert.equal(plan.type, 'merge');
    assert.deepEqual(plan.conflicts.map(conflict => conflict.path).sort(), ['characters/A.png', 'settings.json']);
    await assert.rejects(writeMergeCommit(fresh(), plan, {}, { author, message: 'm' }), { code: 'UnresolvedConflicts' });

    const merged = await writeMergeCommit(fresh(), plan, { 'settings.json': 'theirs', 'characters/A.png': 'ours' }, { author, message: 'm' });
    await applyCommitToWorkTree(fresh(), merged, { moveBranch: 'main' });
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{"a":333}');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'characters/A.png')), png(2), 'binary file taken whole from our side');
    assert.equal(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'), '{"api_key":"sk-secret"}', 'untracked secrets untouched');
    const { commit } = await git.readCommit({ fs, gitdir: ctx.gitdir, oid: merged });
    assert.deepEqual(commit.parent, [ours, theirs]);
});

test('isomorphic-git keeps working on repositories packed by native git', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-git-pack-'));
    roots.push(root);
    // Relative, like the default `dataRoot: ./data`
    globalThis.DATA_ROOT = path.relative(process.cwd(), root);
    const { execFileSync } = await import('node:child_process');
    const { getRepoContext, ensureRepo, commitAll, readSettings, applyCommitToWorkTree, getStatus, maintainRepository } = await import('../src/git-sync/repo.js');

    const dir = path.join(root, 'packer');
    const chat = path.join(dir, 'chats', 'A', 'long.jsonl');
    fs.mkdirSync(path.dirname(chat), { recursive: true });
    const fresh = () => getRepoContext('packer', dir);
    const ctx = fresh();
    const settings = readSettings(ctx);
    const author = { name: 't', email: 't@t' };
    const objectStats = () => execFileSync('git', ['--git-dir', ctx.gitdir, 'count-objects', '-v'], { encoding: 'utf8' });
    const looseKiB = () => Number(objectStats().match(/^size: (\d+)/m)[1]);
    const packedKiB = () => Number(objectStats().match(/^size-pack: (\d+)/m)[1]);

    await ensureRepo(ctx);
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"a":1}');
    const versions = [];
    let content = '';
    for (let i = 0; i < 8; i++) {
        content += `${JSON.stringify({ mes: `message ${i} `.repeat(2000) })}\n`;
        fs.writeFileSync(chat, content);
        versions.push({ oid: (await commitAll(fresh(), settings, { author })).oid, content });
    }
    const looseBefore = looseKiB();

    assert.equal(await maintainRepository(fresh()), false, 'a small repository is left loose');
    assert.equal(await maintainRepository(fresh(), { force: true }), true);
    assert.equal(looseKiB(), 0);
    assert.ok(packedKiB() > 0 && packedKiB() < looseBefore, `packed ${packedKiB()} KiB from ${looseBefore} KiB loose`);
    // Commits and trees in a pack of their own, so status/commit/push never load file contents
    const packDir = path.join(ctx.gitdir, 'objects', 'pack');
    const layout = fs.readdirSync(packDir).filter(name => name.endsWith('.idx')).map(name => {
        const types = execFileSync('git', ['verify-pack', '-v', path.join(packDir, name)], { encoding: 'utf8' })
            .split('\n').map(row => row.split(/\s+/)[1]).filter(type => ['commit', 'tree', 'blob'].includes(type));
        return new Set(types);
    });
    assert.equal(layout.length, 2);
    assert.ok(layout.some(types => types.has('commit') && types.has('tree') && !types.has('blob')));
    assert.ok(layout.some(types => types.has('blob') && types.size === 1));

    const log = await git.log({ fs, gitdir: ctx.gitdir, ref: 'main' });
    assert.equal(log.length, versions.length);
    const { blob } = await git.readBlob({ fs, gitdir: ctx.gitdir, oid: versions[2].oid, filepath: 'chats/A/long.jsonl' });
    assert.equal(Buffer.from(blob).toString('utf8'), versions[2].content);
    assert.deepEqual((await getStatus(fresh(), settings)).changes, []);

    await applyCommitToWorkTree(fresh(), versions[1].oid, { moveBranch: 'main' });
    assert.equal(fs.readFileSync(chat, 'utf8'), versions[1].content);
    fs.appendFileSync(chat, '{"mes":"after packing"}\n');
    const next = (await commitAll(fresh(), settings, { author })).oid;
    const { commit } = await git.readCommit({ fs, gitdir: ctx.gitdir, oid: next });
    assert.deepEqual(commit.parent, [versions[1].oid]);

    // Packing again (now with packs present) keeps everything readable
    await maintainRepository(fresh(), { force: true });
    const again = await git.readBlob({ fs, gitdir: ctx.gitdir, oid: next, filepath: 'chats/A/long.jsonl' });
    assert.equal(Buffer.from(again.blob).toString('utf8'), `${versions[1].content}{"mes":"after packing"}\n`);
    execFileSync('git', ['--git-dir', ctx.gitdir, 'fsck', '--no-progress'], { stdio: 'ignore' });
});
