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
