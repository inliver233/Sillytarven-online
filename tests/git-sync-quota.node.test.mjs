import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import git from 'isomorphic-git';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-git-quota-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
globalThis.DATA_ROOT = root;
const { getRepoContext, ensureRepo, commitAll, commitByCategory, commitFiles, readSettings, estimateCommitGrowth, getStatus, CommitTooLargeError } = await import('../src/git-sync/repo.js');

const author = { name: 't', email: 't@t' };

/** A user's data directory with an empty repository beside it. */
async function setup(handle, files) {
    const dir = path.join(root, handle);
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), content);
    }
    const fresh = () => getRepoContext(handle, dir);
    await ensureRepo(fresh());
    return { dir, fresh, settings: readSettings(fresh()) };
}

/** Objects git stored, packed or loose. */
function storedObjects(ctx) {
    const objects = path.join(ctx.gitdir, 'objects');
    return fs.readdirSync(objects).filter(name => /^[0-9a-f]{2}$/.test(name)).reduce((count, name) => count + fs.readdirSync(path.join(objects, name)).length, 0)
        + fs.readdirSync(path.join(objects, 'pack')).length;
}

test('a commit that does not fit in the room left is refused and records nothing', async () => {
    // A card picture does not compress: what git stores is about as big as the file.
    const { fresh, settings } = await setup('full', {
        'characters/big.png': crypto.randomBytes(300_000),
        'settings.json': '{"a":1}',
    });
    const tooLarge = error => error instanceof CommitTooLargeError && error.estimatedBytes > 280_000 && error.roomBytes === 100_000;
    await assert.rejects(commitAll(fresh(), settings, { author, roomBytes: 100_000 }), tooLarge);
    await assert.rejects(commitByCategory(fresh(), settings, { author, roomBytes: 100_000 }), tooLarge);
    await assert.rejects(commitFiles(fresh(), settings, { author, paths: ['characters/big.png'], roomBytes: 100_000 }), tooLarge);

    await assert.rejects(git.resolveRef({ fs, gitdir: fresh().gitdir, ref: 'HEAD' }), 'no commit was made');
    assert.equal(storedObjects(fresh()), 0, 'and no file was copied into the repository');
    assert.equal(fs.statSync(path.join(fresh().dir, 'characters/big.png')).size, 300_000, 'the tavern data is untouched');

    const fits = await commitAll(fresh(), settings, { author, roomBytes: 1_000_000 });
    assert.ok(fits?.oid, 'with enough room it is recorded');
});

test('text is measured compressed, so a large but compressible commit still fits', async () => {
    const entry = { key: ['苍穹', 'sky'], content: '这是一段很长的世界书条目，会重复很多次。'.repeat(20) };
    const lorebook = JSON.stringify({ entries: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [i, { ...entry, uid: i }])) });
    assert.ok(Buffer.byteLength(lorebook) > 400_000);
    const { fresh, settings } = await setup('text', { 'worlds/lore.json': lorebook });

    const { changes } = await getStatus(fresh(), settings);
    const estimated = await estimateCommitGrowth(fresh(), changes);
    assert.ok(estimated < 100_000, `compressed estimate ${estimated}`);

    const result = await commitAll(fresh(), settings, { author, roomBytes: 100_000 });
    assert.ok(result?.oid, 'a 400 KB lorebook fits in 100 KB of room');
});

test('without a quota there is no limit', async () => {
    const { fresh, settings } = await setup('unlimited', { 'characters/big.png': crypto.randomBytes(200_000) });
    assert.ok((await commitAll(fresh(), settings, { author }))?.oid);
    fs.writeFileSync(path.join(fresh().dir, 'characters/big.png'), crypto.randomBytes(200_000));
    assert.ok((await commitAll(fresh(), settings, { author, roomBytes: Infinity }))?.oid);
});
