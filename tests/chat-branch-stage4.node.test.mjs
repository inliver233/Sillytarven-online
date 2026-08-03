/* eslint-disable playwright/expect-expect, playwright/no-conditional-in-test -- Node tests use assert and platform guards. */
/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { hashCanonicalJson } from '../src/canonical-hash.js';
import { setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-stage4-branch-'));
const configPath = path.join(testRoot, 'config.yaml');
const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const config = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
config.userStorage.enabled = false;
fs.writeFileSync(configPath, stringifyYaml(config));
setConfigFilePath(configPath);
globalThis.DATA_ROOT = path.join(testRoot, 'data');
fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });

const {
    executeChatBranch: executeChatBranchUnlocked,
    getChatBranchJournalNamespace,
    getChatContentHash,
    recoverChatBranchTransactions,
    setChatBranchFaultInjectorForTests,
} = await import('../src/chat-branch.js');

async function executeChatBranch(request) {
    return await executeChatBranchUnlocked(request, {
        runWithStorageLocks: async (filePaths, callback) => {
            assert.deepEqual(filePaths.map(filePath => path.resolve(filePath)), [...filePaths].map(filePath => path.resolve(filePath)));
            return await callback();
        },
    });
}

function createUser(handle) {
    const root = path.join(testRoot, handle);
    const directories = {
        root,
        chats: path.join(root, 'chats'),
        groupChats: path.join(root, 'group-chats'),
        groups: path.join(root, 'groups'),
        backups: path.join(root, 'backups'),
        characters: path.join(root, 'characters'),
    };
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    return { profile: { handle, name: handle }, directories };
}

const users = { a: createUser('stage4-a'), b: createUser('stage4-b') };

after(() => {
    setChatBranchFaultInjectorForTests(null);
    fs.rmSync(testRoot, { recursive: true, force: true });
});

function makeHeader(marker = 'source') {
    return {
        user_name: 'User',
        character_name: 'Character',
        create_date: 'test',
        chat_metadata: { marker, message_count: 1000 },
    };
}

function makeMessages(count, prefix = 'message') {
    return Array.from({ length: count }, (_, index) => ({
        name: index % 2 ? 'Character' : 'User',
        is_user: index % 2 === 0,
        send_date: 1_700_000_000_000 + index,
        mes: `${prefix}-${index}-active`,
        swipes: [`${prefix}-${index}-zero`, `${prefix}-${index}-one`],
        swipe_id: 0,
        swipe_info: [
            { send_date: 1_600_000_000_000 + index, extra: { swipe: 0 } },
            { send_date: 1_650_000_000_000 + index, extra: { swipe: 1 } },
        ],
        extra: { original: index },
    }));
}

function writeRevision(filePath, revision) {
    fs.writeFileSync(`${filePath}.revision.json`, JSON.stringify({ version: 1, revision }));
}

function writeLegacy(user, avatar, chatId, header, messages, revision) {
    const directory = path.join(user.directories.chats, avatar);
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, `${chatId}.jsonl`);
    fs.writeFileSync(filePath, [header, ...messages].map(value => JSON.stringify(value)).join('\n'));
    fs.writeFileSync(`${filePath}.metadata.json`, JSON.stringify(header));
    writeRevision(filePath, revision);
    return filePath;
}

function writeChunkedGroup(user, groupId, chatId, header, messages, revision, chunkSize = 200) {
    const filePath = path.join(user.directories.groupChats, `${chatId}.jsonl`);
    const chunkDirectory = `${filePath}.chunks`;
    fs.mkdirSync(chunkDirectory, { recursive: true });
    const index = {
        version: 1,
        chunk_size: chunkSize,
        message_count: messages.length,
        last_mes: messages.at(-1).send_date,
        last_message: messages.at(-1).mes,
        total_bytes: 0,
        shards: [],
    };
    for (let offset = 0, shardIndex = 0; offset < messages.length; offset += chunkSize, shardIndex++) {
        const values = messages.slice(offset, offset + chunkSize);
        const name = `${String(shardIndex).padStart(6, '0')}.jsonl`;
        const shardPath = path.join(chunkDirectory, name);
        fs.writeFileSync(shardPath, values.map(value => JSON.stringify(value)).join('\n'));
        const size = fs.statSync(shardPath).size;
        index.total_bytes += size;
        index.shards.push({
            file: name,
            count: values.length,
            size,
            last_mes: values.at(-1).send_date,
            last_message: values.at(-1).mes,
        });
    }
    fs.writeFileSync(filePath, JSON.stringify(header));
    fs.writeFileSync(`${filePath}.metadata.json`, JSON.stringify(header));
    fs.writeFileSync(`${filePath}.index.json`, JSON.stringify(index));
    writeRevision(filePath, revision);
    fs.writeFileSync(path.join(user.directories.groups, `${groupId}.json`), JSON.stringify({
        id: groupId,
        name: groupId,
        chat_id: chatId,
        chats: [chatId],
    }, null, 4));
    return filePath;
}

function request(user, body) {
    return { user, body };
}

function soloBody({ avatar, chatId, messages, header, revision, key = 'solo-key', index = 750, swipeId = 1 }) {
    return {
        source: { type: 'solo', avatarUrl: `${avatar}.png`, chatId },
        absoluteMessageIndex: index,
        swipeId,
        expectedRevision: revision,
        expectedContentHash: getChatContentHash(header, messages),
        idempotencyKey: key,
    };
}

function snapshotTree(directory) {
    const result = {};
    const visit = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            const relative = path.relative(directory, fullPath).split(path.sep).join('/');
            if (entry.isDirectory()) {
                visit(fullPath);
            } else if (entry.isSymbolicLink()) {
                result[relative] = `symlink:${fs.readlinkSync(fullPath)}`;
            } else {
                result[relative] = fs.readFileSync(fullPath).toString('base64');
            }
        }
    };
    visit(directory);
    return result;
}

function readLegacy(filePath) {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function readChunkMessages(filePath) {
    const index = JSON.parse(fs.readFileSync(`${filePath}.index.json`, 'utf8'));
    return index.shards.flatMap(shard => fs.readFileSync(path.join(`${filePath}.chunks`, shard.file), 'utf8')
        .split('\n').filter(Boolean).map(line => JSON.parse(line)));
}

async function copyActiveJournal(user, branchRequest, transactionName) {
    let releaseBranch;
    let signalEntered;
    const entered = new Promise(resolve => { signalEntered = resolve; });
    const release = new Promise(resolve => { releaseBranch = resolve; });
    setChatBranchFaultInjectorForTests(async point => {
        if (point !== 'after-journal-mutating') return;
        signalEntered();
        await release;
    });
    const branchPromise = executeChatBranch(branchRequest);
    await entered;
    const namespace = getChatBranchJournalNamespace(user.directories.root, user.profile.handle, false);
    const activeName = fs.readdirSync(namespace).find(name => fs.existsSync(path.join(namespace, name, 'manifest.json')));
    assert.ok(activeName);
    const copiedPath = path.join(namespace, transactionName);
    fs.cpSync(path.join(namespace, activeName), copiedPath, { recursive: true, errorOnExist: true });
    releaseBranch();
    const result = await branchPromise;
    setChatBranchFaultInjectorForTests(null);
    assert.equal(result.status, 201);
    return copiedPath;
}

test('destination orphan artifacts and dangling links are collisions', async t => {
    const cases = [
        { name: 'metadata sidecar', suffix: '.metadata.json', create: filePath => fs.writeFileSync(filePath, '{}') },
        { name: 'chunk directory', suffix: '.chunks', create: filePath => fs.mkdirSync(filePath) },
        {
            name: 'dangling symlink',
            suffix: '.revision.json',
            create: filePath => fs.symlinkSync(path.join(testRoot, 'missing-orphan-target'), filePath),
        },
    ];

    for (const [caseIndex, collision] of cases.entries()) {
        await t.test(collision.name, async () => {
            const avatar = `orphan-character-${caseIndex}`;
            const chatId = `orphan-source-${caseIndex}`;
            const revision = `orphan-revision-${caseIndex}`;
            const header = makeHeader(`orphan-${caseIndex}`);
            const messages = makeMessages(8, `orphan-${caseIndex}`);
            const sourcePath = writeLegacy(users.a, avatar, chatId, header, messages, revision);
            const before = fs.readFileSync(sourcePath);
            let collisionPath;
            const result = await executeChatBranchUnlocked(request(users.a, soloBody({
                avatar,
                chatId,
                messages,
                header,
                revision,
                key: `orphan-key-${caseIndex}`,
                index: 4,
            })), {
                runWithStorageLocks: async (filePaths, callback) => {
                    const destinationPath = filePaths.find(filePath => filePath.endsWith('.jsonl') && !fs.existsSync(filePath));
                    if (destinationPath && !collisionPath) {
                        collisionPath = `${destinationPath}${collision.suffix}`;
                        try {
                            collision.create(collisionPath);
                        } catch (error) {
                            if (error.code === 'EPERM' || error.code === 'EACCES') {
                                t.skip(`Symlink assertion skipped: ${error.code}`);
                                return { status: 409, body: { error: 'source_or_destination_changed' } };
                            }
                            throw error;
                        }
                    }
                    return await callback();
                },
            });
            assert.equal(result.status, 409);
            assert.equal(result.body.error, 'source_or_destination_changed');
            assert.deepEqual(fs.readFileSync(sourcePath), before);
            if (collisionPath) fs.rmSync(collisionPath, { recursive: true, force: true });
        });
    }
});

test('journal recovery rejects exact snapshot path, digest, and symlink tampering', async t => {
    const avatar = 'journal-audit-character';
    const chatId = 'journal-audit-source';
    const revision = 'journal-audit-revision';
    const header = makeHeader('journal-audit');
    const messages = makeMessages(8, 'journal-audit');
    writeLegacy(users.a, avatar, chatId, header, messages, revision);
    const body = soloBody({ avatar, chatId, messages, header, revision, key: 'journal-audit-key', index: 4 });
    const first = await copyActiveJournal(users.a, request(users.a, body), 'tx-Aa0001');
    fs.cpSync(first, path.join(path.dirname(first), 'tx-Aa0002'), { recursive: true, errorOnExist: true });
    fs.cpSync(first, path.join(path.dirname(first), 'tx-Aa0003'), { recursive: true, errorOnExist: true });
    fs.cpSync(first, path.join(path.dirname(first), 'tx-Aa0004'), { recursive: true, errorOnExist: true });
    const namespace = path.dirname(first);

    const exactPathTransaction = path.join(namespace, 'tx-Aa0001');
    const exactManifestPath = path.join(exactPathTransaction, 'manifest.json');
    const exactManifest = JSON.parse(fs.readFileSync(exactManifestPath, 'utf8'));
    exactManifest.snapshots[0].file = 'snapshot/000001';
    delete exactManifest.digest;
    exactManifest.digest = hashCanonicalJson(exactManifest);
    fs.writeFileSync(exactManifestPath, JSON.stringify(exactManifest));
    assert.throws(() => recoverChatBranchTransactions(users.a.directories.root, users.a.profile.handle, users.a.directories), /Invalid chat branch journal manifest|Invalid snapshot entry/);
    fs.rmSync(exactPathTransaction, { recursive: true, force: true });

    const digestTransaction = path.join(namespace, 'tx-Aa0002');
    const digestManifestPath = path.join(digestTransaction, 'manifest.json');
    const digestManifest = JSON.parse(fs.readFileSync(digestManifestPath, 'utf8'));
    digestManifest.state = 'prepared';
    fs.writeFileSync(digestManifestPath, JSON.stringify(digestManifest));
    assert.throws(() => recoverChatBranchTransactions(users.a.directories.root, users.a.profile.handle, users.a.directories), /Invalid chat branch journal manifest/);
    fs.rmSync(digestTransaction, { recursive: true, force: true });

    const symlinkTransaction = path.join(namespace, 'tx-Aa0003');
    const snapshotPath = path.join(symlinkTransaction, 'snapshot', '000000');
    fs.rmSync(snapshotPath);
    let symlinkCreated = true;
    try {
        fs.symlinkSync(path.join(users.a.directories.chats, avatar, `${chatId}.jsonl`), snapshotPath);
    } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') {
            t.diagnostic(`Symlink assertion skipped: ${error.code}`);
            symlinkCreated = false;
        } else {
            throw error;
        }
    }
    if (symlinkCreated) {
        assert.throws(() => recoverChatBranchTransactions(users.a.directories.root, users.a.profile.handle, users.a.directories), /regular file/);
    }
    fs.rmSync(symlinkTransaction, { recursive: true, force: true });

    const temporaryTransaction = path.join(namespace, 'tx-Aa0004');
    const temporaryManifestPath = path.join(temporaryTransaction, 'manifest.json');
    const temporaryManifest = JSON.parse(fs.readFileSync(temporaryManifestPath, 'utf8'));
    delete temporaryManifest.digest;
    temporaryManifest.state = 'committed';
    temporaryManifest.digest = hashCanonicalJson(temporaryManifest);
    fs.writeFileSync(temporaryManifestPath, JSON.stringify(temporaryManifest));
    const manifestTemporaryPath = `${temporaryManifestPath}.123456`;
    const sourceTemporaryPath = `${path.join(users.a.directories.chats, avatar, `${chatId}.jsonl`)}.654321`;
    fs.writeFileSync(manifestTemporaryPath, 'partial manifest');
    fs.writeFileSync(sourceTemporaryPath, 'partial source');
    const unknownTemplate = path.join(testRoot, 'unknown-journal-template');
    fs.cpSync(temporaryTransaction, unknownTemplate, { recursive: true, errorOnExist: true });
    assert.deepEqual(
        recoverChatBranchTransactions(users.a.directories.root, users.a.profile.handle, users.a.directories),
        { restored: 0, cleaned: 1 },
    );
    assert.equal(fs.existsSync(manifestTemporaryPath), false);
    assert.equal(fs.existsSync(sourceTemporaryPath), false);

    const unknownTransaction = path.join(namespace, 'tx-Aa0005');
    fs.cpSync(unknownTemplate, unknownTransaction, { recursive: true, errorOnExist: true });
    fs.rmSync(unknownTemplate, { recursive: true, force: true });
    fs.writeFileSync(path.join(unknownTransaction, 'unknown.bin'), 'unknown');
    assert.throws(
        () => recoverChatBranchTransactions(users.a.directories.root, users.a.profile.handle, users.a.directories),
        /Unknown chat branch journal artifact/,
    );
    fs.rmSync(unknownTransaction, { recursive: true, force: true });
});

test('branch recovery rejects manifestless ordinary journals and forged cleanup tombstones', async t => {
    const makeCopiedTransaction = async (marker, transactionName) => {
        const avatar = `${marker}-character`;
        const chatId = `${marker}-source`;
        const revision = `${marker}-revision`;
        const header = makeHeader(marker);
        const messages = makeMessages(8, marker);
        writeLegacy(users.a, avatar, chatId, header, messages, revision);
        const body = soloBody({ avatar, chatId, messages, header, revision, key: `${marker}-key`, index: 4 });
        return await copyActiveJournal(users.a, request(users.a, body), transactionName);
    };

    const manifestless = await makeCopiedTransaction('manifestless-ordinary', 'tx-Ml0001');
    const namespace = path.dirname(manifestless);
    const manifestPath = path.join(manifestless, 'manifest.json');
    const manifestBytes = fs.readFileSync(manifestPath);
    fs.rmSync(manifestPath);
    assert.throws(
        () => recoverChatBranchTransactions(users.a.directories.root, users.a.profile.handle, users.a.directories),
        /transaction manifest is missing/i,
    );
    fs.writeFileSync(manifestPath, manifestBytes);
    const failed = path.join(namespace, 'failed-Ml0001');
    fs.renameSync(manifestless, failed);
    fs.rmSync(path.join(failed, 'manifest.json'));
    assert.throws(
        () => recoverChatBranchTransactions(users.a.directories.root, users.a.profile.handle, users.a.directories),
        /failed transaction manifest is missing/i,
    );
    fs.rmSync(failed, { recursive: true, force: true });

    const nonterminal = await makeCopiedTransaction('forged-cleanup-state', 'tx-Fg0001');
    const nonterminalCleanup = path.join(namespace, `cleanup-${'a'.repeat(32)}`);
    fs.renameSync(nonterminal, nonterminalCleanup);
    assert.throws(
        () => recoverChatBranchTransactions(users.a.directories.root, users.a.profile.handle, users.a.directories),
        /forged|nonterminal/i,
    );
    fs.rmSync(nonterminalCleanup, { recursive: true, force: true });

    const unknownCleanup = path.join(namespace, `cleanup-${'b'.repeat(32)}`);
    fs.mkdirSync(unknownCleanup);
    fs.writeFileSync(path.join(unknownCleanup, 'unknown.bin'), 'forged');
    assert.throws(
        () => recoverChatBranchTransactions(users.a.directories.root, users.a.profile.handle, users.a.directories),
        /unknown chat branch journal artifact/i,
    );
    fs.rmSync(unknownCleanup, { recursive: true, force: true });

    const symlinkCleanup = path.join(namespace, `cleanup-${'c'.repeat(32)}`);
    fs.mkdirSync(symlinkCleanup);
    const outside = path.join(testRoot, 'branch-cleanup-symlink-target');
    fs.mkdirSync(outside, { recursive: true });
    let symlinkCreated = true;
    try {
        fs.symlinkSync(outside, path.join(symlinkCleanup, 'snapshot'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (['EPERM', 'EACCES'].includes(error.code)) {
            t.diagnostic(`Symlink assertion skipped: ${error.code}`);
            symlinkCreated = false;
        } else {
            throw error;
        }
    }
    if (symlinkCreated) {
        assert.throws(
            () => recoverChatBranchTransactions(users.a.directories.root, users.a.profile.handle, users.a.directories),
            /unsafe chat branch journal artifact/i,
        );
    }
    fs.rmSync(symlinkCleanup, { recursive: true, force: true });

    const forgedCommitted = await makeCopiedTransaction('forged-cleanup-committed', 'tx-Fg0002');
    const forgedManifestPath = path.join(forgedCommitted, 'manifest.json');
    const forgedManifest = JSON.parse(fs.readFileSync(forgedManifestPath, 'utf8'));
    delete forgedManifest.digest;
    forgedManifest.state = 'committed';
    forgedManifest.digest = hashCanonicalJson(forgedManifest);
    fs.writeFileSync(forgedManifestPath, JSON.stringify(forgedManifest));
    const forgedCommittedCleanup = path.join(namespace, `cleanup-${'d'.repeat(32)}`);
    fs.renameSync(forgedCommitted, forgedCommittedCleanup);
    const tamperedManifest = JSON.parse(fs.readFileSync(path.join(forgedCommittedCleanup, 'manifest.json'), 'utf8'));
    tamperedManifest.handleHash = '0'.repeat(64);
    fs.writeFileSync(path.join(forgedCommittedCleanup, 'manifest.json'), JSON.stringify(tamperedManifest));
    assert.throws(
        () => recoverChatBranchTransactions(users.a.directories.root, users.a.profile.handle, users.a.directories),
        /invalid|tampered|cross-user/i,
    );
    assert.equal(fs.existsSync(forgedCommittedCleanup), true);
    fs.rmSync(forgedCommittedCleanup, { recursive: true, force: true });
});

test('ordinary committed branch journals do not hide snapshot corruption', async () => {
    const avatar = 'committed-corruption-character';
    const chatId = 'committed-corruption-source';
    const revision = 'committed-corruption-revision';
    const header = makeHeader('committed-corruption');
    const messages = makeMessages(8, 'committed-corruption');
    writeLegacy(users.a, avatar, chatId, header, messages, revision);
    const transactionDirectory = await copyActiveJournal(users.a, request(users.a, soloBody({
        avatar,
        chatId,
        messages,
        header,
        revision,
        key: 'committed-corruption-key',
        index: 4,
    })), 'tx-Cr0001');
    const manifestPath = path.join(transactionDirectory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest.digest;
    manifest.state = 'committed';
    manifest.digest = hashCanonicalJson(manifest);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(path.join(transactionDirectory, 'snapshot', '000000'), 'tampered committed snapshot');

    assert.throws(
        () => recoverChatBranchTransactions(users.a.directories.root, users.a.profile.handle, users.a.directories),
        /checksum mismatch/i,
    );
    assert.equal(fs.existsSync(transactionDirectory), true);
    fs.rmSync(transactionDirectory, { recursive: true, force: true });
});

test('solo journal recovery accepts null and rejects an empty group path', async () => {
    const nullAvatar = 'journal-null-group-character';
    const nullChatId = 'journal-null-group-source';
    const nullRevision = 'journal-null-group-revision';
    const nullHeader = makeHeader('journal-null-group');
    const nullMessages = makeMessages(8, 'journal-null-group');
    writeLegacy(users.a, nullAvatar, nullChatId, nullHeader, nullMessages, nullRevision);
    const nullBody = soloBody({
        avatar: nullAvatar,
        chatId: nullChatId,
        messages: nullMessages,
        header: nullHeader,
        revision: nullRevision,
        key: 'journal-null-group-key',
        index: 4,
    });
    const nullTransaction = await copyActiveJournal(
        users.a,
        request(users.a, nullBody),
        'tx-Nu1101',
    );
    const nullManifest = JSON.parse(fs.readFileSync(path.join(nullTransaction, 'manifest.json'), 'utf8'));
    assert.equal(nullManifest.paths.group, null);
    assert.deepEqual(
        recoverChatBranchTransactions(users.a.directories.root, users.a.profile.handle, users.a.directories),
        { restored: 1, cleaned: 0 },
    );

    const emptyAvatar = 'journal-empty-group-character';
    const emptyChatId = 'journal-empty-group-source';
    const emptyRevision = 'journal-empty-group-revision';
    const emptyHeader = makeHeader('journal-empty-group');
    const emptyMessages = makeMessages(8, 'journal-empty-group');
    writeLegacy(users.a, emptyAvatar, emptyChatId, emptyHeader, emptyMessages, emptyRevision);
    const emptyBody = soloBody({
        avatar: emptyAvatar,
        chatId: emptyChatId,
        messages: emptyMessages,
        header: emptyHeader,
        revision: emptyRevision,
        key: 'journal-empty-group-key',
        index: 4,
    });
    const emptyTransaction = await copyActiveJournal(
        users.a,
        request(users.a, emptyBody),
        'tx-Empt01',
    );
    const emptyManifestPath = path.join(emptyTransaction, 'manifest.json');
    const emptyManifest = JSON.parse(fs.readFileSync(emptyManifestPath, 'utf8'));
    emptyManifest.paths.group = '';
    delete emptyManifest.digest;
    emptyManifest.digest = hashCanonicalJson(emptyManifest);
    fs.writeFileSync(emptyManifestPath, JSON.stringify(emptyManifest));
    assert.throws(
        () => recoverChatBranchTransactions(users.a.directories.root, users.a.profile.handle, users.a.directories),
        /Invalid group path in branch journal/,
    );
    fs.rmSync(emptyTransaction, { recursive: true, force: true });
});

test('legacy solo branch uses the complete 1000-message source and selected swipe', async () => {
    const avatar = 'legacy-character';
    const chatId = 'legacy-source';
    const revision = 'legacy-revision';
    const header = makeHeader('legacy');
    const messages = makeMessages(1000, 'legacy');
    const sourcePath = writeLegacy(users.a, avatar, chatId, header, messages, revision);

    const created = await executeChatBranch(request(users.a, soloBody({ avatar, chatId, messages, header, revision })));
    assert.equal(created.status, 201);
    const destinationPath = path.join(users.a.directories.chats, avatar, `${created.body.chatId}.jsonl`);
    const destination = readLegacy(destinationPath);
    assert.equal(destination.length, 752);
    assert.equal(destination.at(-1).mes, 'legacy-750-one');
    assert.equal(destination.at(-1).swipe_id, 1);
    assert.deepEqual(destination.at(-1).extra, { swipe: 1 });
    assert.equal(destination[0].chat_metadata.main_chat, chatId);

    const source = readLegacy(sourcePath);
    assert.deepEqual(source[751].extra.branches, [created.body.chatId]);
    assert.equal(source[751].mes, 'legacy-750-active');
    assert.equal(JSON.parse(fs.readFileSync(`${sourcePath}.revision.json`, 'utf8')).revision, created.body.sourceRevision);
});

test('headerless imported solo chat keeps message zero when metadata is stored in its sidecar', async () => {
    const avatar = 'headerless-solo-character';
    const chatId = 'headerless-solo-source';
    const revision = 'headerless-solo-revision';
    const header = makeHeader('headerless-solo');
    const messages = makeMessages(4, 'headerless-solo');
    const directory = path.join(users.a.directories.chats, avatar);
    const sourcePath = path.join(directory, `${chatId}.jsonl`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(sourcePath, messages.map(value => JSON.stringify(value)).join('\n'));
    fs.writeFileSync(`${sourcePath}.metadata.json`, JSON.stringify(header));
    writeRevision(sourcePath, revision);

    const created = await executeChatBranch(request(users.a, soloBody({
        avatar,
        chatId,
        messages,
        header,
        revision,
        key: 'headerless-solo-key',
        index: 0,
    })));

    assert.equal(created.status, 201);
    const source = readLegacy(sourcePath);
    assert.equal(source.length, messages.length);
    assert.equal(source[0].mes, 'headerless-solo-0-active');
    assert.deepEqual(source[0].extra.branches, [created.body.chatId]);
    const destinationPath = path.join(directory, `${created.body.chatId}.jsonl`);
    const destination = readLegacy(destinationPath);
    assert.equal(destination.length, 2);
    assert.equal(destination[0].chat_metadata.main_chat, chatId);
    assert.equal(destination[1].mes, 'headerless-solo-0-one');
});

test('preconditions and idempotency are side-effect free and deterministic', async () => {
    const avatar = 'preconditions-character';
    const chatId = 'preconditions-source';
    const revision = 'preconditions-revision';
    const header = makeHeader('preconditions');
    const messages = makeMessages(30, 'preconditions');
    writeLegacy(users.a, avatar, chatId, header, messages, revision);
    const body = soloBody({ avatar, chatId, messages, header, revision, key: 'preconditions-key', index: 20 });

    const beforeStale = snapshotTree(users.a.directories.root);
    const missing = await executeChatBranch(request(users.a, { ...body, expectedRevision: undefined }));
    assert.equal(missing.status, 409);
    const stale = await executeChatBranch(request(users.a, { ...body, expectedRevision: 'stale' }));
    assert.equal(stale.status, 409);
    const staleHash = await executeChatBranch(request(users.a, { ...body, expectedContentHash: 'stale' }));
    assert.equal(staleHash.status, 409);
    assert.deepEqual(snapshotTree(users.a.directories.root), beforeStale);

    const created = await executeChatBranch(request(users.a, body));
    assert.equal(created.status, 201);
    const afterCreated = snapshotTree(users.a.directories.root);
    const replay = await executeChatBranch(request(users.a, body));
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, created.body);
    assert.deepEqual(snapshotTree(users.a.directories.root), afterCreated);
    const mismatch = await executeChatBranch(request(users.a, { ...body, swipeId: 0 }));
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error, 'idempotency_mismatch');
    assert.deepEqual(snapshotTree(users.a.directories.root), afterCreated);
});

test('chunked group branch preserves source shard prefix and updates group membership', async () => {
    const groupId = 'group-1000';
    const chatId = 'group-source';
    const revision = 'group-revision';
    const header = makeHeader('group');
    const messages = makeMessages(1000, 'group');
    const sourcePath = writeChunkedGroup(users.a, groupId, chatId, header, messages, revision);
    const prefixBefore = [0, 1, 2].map(index => fs.readFileSync(path.join(`${sourcePath}.chunks`, `${String(index).padStart(6, '0')}.jsonl`)));
    const body = {
        source: { type: 'group', groupId, chatId },
        absoluteMessageIndex: 750,
        swipeId: 1,
        expectedRevision: revision,
        expectedContentHash: getChatContentHash(header, messages),
        idempotencyKey: 'group-key',
    };

    const created = await executeChatBranch(request(users.a, body));
    assert.equal(created.status, 201);
    const destinationPath = path.join(users.a.directories.groupChats, `${created.body.chatId}.jsonl`);
    const destination = readChunkMessages(destinationPath);
    assert.equal(destination.length, 751);
    assert.equal(destination.at(-1).mes, 'group-750-one');
    const destinationIndex = JSON.parse(fs.readFileSync(`${destinationPath}.index.json`, 'utf8'));
    assert.deepEqual(destinationIndex.shards.map(shard => shard.count), [200, 200, 200, 151]);
    for (let index = 0; index < prefixBefore.length; index++) {
        assert.deepEqual(fs.readFileSync(path.join(`${sourcePath}.chunks`, `${String(index).padStart(6, '0')}.jsonl`)), prefixBefore[index]);
    }
    const source = readChunkMessages(sourcePath);
    assert.deepEqual(source[750].extra.branches, [created.body.chatId]);
    const group = JSON.parse(fs.readFileSync(path.join(users.a.directories.groups, `${groupId}.json`), 'utf8'));
    assert.deepEqual(group.chats, [chatId, created.body.chatId]);
});

test('old embedded and headerless group layouts preserve metadata and absolute source indexes', async () => {
    const embeddedGroupId = 'embedded-layout-group';
    const embeddedChatId = 'embedded-layout-source';
    const embeddedRevision = 'embedded-layout-revision';
    const embeddedHeader = makeHeader('embedded-layout');
    const embeddedMessages = makeMessages(6, 'embedded-layout');
    const embeddedPath = path.join(users.a.directories.groupChats, `${embeddedChatId}.jsonl`);
    const embeddedChunkDirectory = `${embeddedPath}.chunks`;
    fs.mkdirSync(embeddedChunkDirectory);
    fs.writeFileSync(embeddedPath, '');
    const embeddedShardPath = path.join(embeddedChunkDirectory, '000000.jsonl');
    fs.writeFileSync(embeddedShardPath, [embeddedHeader, ...embeddedMessages].map(value => JSON.stringify(value)).join('\n'));
    const embeddedSize = fs.statSync(embeddedShardPath).size;
    fs.writeFileSync(`${embeddedPath}.index.json`, JSON.stringify({
        version: 1,
        chunk_size: 200,
        message_count: embeddedMessages.length + 1,
        last_mes: embeddedMessages.at(-1).send_date,
        last_message: embeddedMessages.at(-1).mes,
        total_bytes: embeddedSize,
        shards: [{
            file: '000000.jsonl',
            count: embeddedMessages.length + 1,
            size: embeddedSize,
            last_mes: embeddedMessages.at(-1).send_date,
            last_message: embeddedMessages.at(-1).mes,
        }],
    }));
    writeRevision(embeddedPath, embeddedRevision);
    fs.writeFileSync(path.join(users.a.directories.groups, `${embeddedGroupId}.json`), JSON.stringify({
        id: embeddedGroupId,
        chat_id: embeddedChatId,
        chats: [embeddedChatId],
    }));
    const embedded = await executeChatBranch(request(users.a, {
        source: { type: 'group', groupId: embeddedGroupId, chatId: embeddedChatId },
        absoluteMessageIndex: 2,
        swipeId: 1,
        expectedRevision: embeddedRevision,
        expectedContentHash: getChatContentHash(embeddedHeader, embeddedMessages),
        idempotencyKey: 'embedded-layout-key',
    }));
    assert.equal(embedded.status, 201);
    const embeddedSource = readChunkMessages(embeddedPath);
    assert.deepEqual(embeddedSource[3].extra.branches, [embedded.body.chatId]);
    const embeddedDestinationPath = path.join(users.a.directories.groupChats, `${embedded.body.chatId}.jsonl`);
    const embeddedDestinationHeader = JSON.parse(fs.readFileSync(`${embeddedDestinationPath}.metadata.json`, 'utf8'));
    assert.equal(embeddedDestinationHeader.chat_metadata.marker, 'embedded-layout');
    assert.equal(embeddedDestinationHeader.chat_metadata.main_chat, embeddedChatId);

    const headerlessGroupId = 'headerless-layout-group';
    const headerlessChatId = 'headerless-layout-source';
    const headerlessRevision = 'headerless-layout-revision';
    const headerlessMessages = makeMessages(4, 'headerless-layout');
    const headerlessPath = path.join(users.a.directories.groupChats, `${headerlessChatId}.jsonl`);
    fs.writeFileSync(headerlessPath, headerlessMessages.map(value => JSON.stringify(value)).join('\n'));
    writeRevision(headerlessPath, headerlessRevision);
    fs.writeFileSync(path.join(users.a.directories.groups, `${headerlessGroupId}.json`), JSON.stringify({
        id: headerlessGroupId,
        chat_id: headerlessChatId,
        chats: [headerlessChatId],
    }));
    const headerless = await executeChatBranch(request(users.a, {
        source: { type: 'group', groupId: headerlessGroupId, chatId: headerlessChatId },
        absoluteMessageIndex: 0,
        swipeId: 1,
        expectedRevision: headerlessRevision,
        expectedContentHash: getChatContentHash(null, headerlessMessages),
        idempotencyKey: 'headerless-layout-key',
    }));
    assert.equal(headerless.status, 201);
    assert.deepEqual(readLegacy(headerlessPath)[0].extra.branches, [headerless.body.chatId]);
    const headerlessDestinationPath = path.join(users.a.directories.groupChats, `${headerless.body.chatId}.jsonl`);
    assert.equal(readLegacy(headerlessDestinationPath)[1].mes, 'headerless-layout-0-one');
});

test('faults roll back destination, source, group list, revisions, and idempotency', async () => {
    const groupId = 'fault-group';
    const chatId = 'fault-source';
    const revision = 'fault-revision';
    const header = makeHeader('fault');
    const messages = makeMessages(400, 'fault');
    writeChunkedGroup(users.a, groupId, chatId, header, messages, revision);
    const body = {
        source: { type: 'group', groupId, chatId },
        absoluteMessageIndex: 250,
        swipeId: 1,
        expectedRevision: revision,
        expectedContentHash: getChatContentHash(header, messages),
        idempotencyKey: 'fault-key',
    };
    const before = snapshotTree(users.a.directories.root);
    setChatBranchFaultInjectorForTests(point => {
        if (point === 'after-group-update') throw new Error('injected branch failure');
    });
    await assert.rejects(() => executeChatBranch(request(users.a, body)), /injected branch failure/);
    setChatBranchFaultInjectorForTests(null);
    assert.deepEqual(snapshotTree(users.a.directories.root), before);
});

test('transient rollback restoration failure quarantines and retries before allowing another branch', async () => {
    const groupId = 'rollback-retry-group';
    const chatId = 'rollback-retry-source';
    const revision = 'rollback-retry-revision';
    const header = makeHeader('rollback-retry');
    const messages = makeMessages(12, 'rollback-retry');
    writeChunkedGroup(users.a, groupId, chatId, header, messages, revision);
    const body = {
        source: { type: 'group', groupId, chatId },
        absoluteMessageIndex: 7,
        swipeId: 1,
        expectedRevision: revision,
        expectedContentHash: getChatContentHash(header, messages),
        idempotencyKey: 'rollback-retry-key',
    };
    const before = snapshotTree(users.a.directories.root);
    let restoreFailures = 0;
    setChatBranchFaultInjectorForTests(point => {
        if (point === 'after-group-update') throw new Error('injected mutation failure');
        if (point === 'after-rollback-family-removal' && restoreFailures++ < 2) {
            throw new Error('injected transient restore failure');
        }
    });
    await assert.rejects(() => executeChatBranch(request(users.a, body)), /injected transient restore failure/);
    const namespace = getChatBranchJournalNamespace(users.a.directories.root, users.a.profile.handle, false);
    assert.equal(fs.readdirSync(namespace).some(name => name.startsWith('failed-')), true);
    const afterFirstFailure = snapshotTree(users.a.directories.root);

    await assert.rejects(() => executeChatBranch(request(users.a, body)), /injected transient restore failure/);
    assert.deepEqual(snapshotTree(users.a.directories.root), afterFirstFailure);

    setChatBranchFaultInjectorForTests(null);
    assert.deepEqual(
        recoverChatBranchTransactions(users.a.directories.root, users.a.profile.handle, users.a.directories),
        { restored: 1, cleaned: 0 },
    );
    assert.deepEqual(fs.readdirSync(namespace), []);
    assert.deepEqual(snapshotTree(users.a.directories.root), before);
});

test('same idempotency key is isolated per user and unsafe source roots are rejected', async t => {
    const avatar = 'isolated-character';
    const chatId = 'isolated-source';
    const revision = 'isolated-revision';
    const header = makeHeader('isolated');
    const messages = makeMessages(10, 'isolated');
    writeLegacy(users.a, avatar, chatId, header, messages, revision);
    writeLegacy(users.b, avatar, chatId, header, messages, revision);
    const body = soloBody({ avatar, chatId, messages, header, revision, key: 'shared-key', index: 5 });
    const [createdA, createdB] = await Promise.all([
        executeChatBranch(request(users.a, body)),
        executeChatBranch(request(users.b, body)),
    ]);
    assert.equal(createdA.status, 201);
    assert.equal(createdB.status, 201);
    assert.equal(fs.existsSync(path.join(users.a.directories.chats, avatar, `${createdA.body.chatId}.jsonl`)), true);
    assert.equal(fs.existsSync(path.join(users.b.directories.chats, avatar, `${createdB.body.chatId}.jsonl`)), true);

    const traversal = await executeChatBranch(request(users.a, {
        ...body,
        idempotencyKey: 'traversal-key',
        source: { type: 'solo', avatarUrl: '../outside.png', chatId },
    }));
    assert.equal(traversal.status, 400);

    const outside = path.join(testRoot, 'outside-chats');
    fs.mkdirSync(outside);
    const linked = path.join(users.a.directories.chats, 'linked-character');
    try {
        fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') {
            t.diagnostic(`Symlink assertion skipped: ${error.code}`);
            return;
        }
        throw error;
    }
    const linkedRequest = await executeChatBranch(request(users.a, {
        ...body,
        idempotencyKey: 'linked-key',
        source: { type: 'solo', avatarUrl: 'linked-character.png', chatId },
    }));
    assert.equal(linkedRequest.status, 400);
    assert.equal(linkedRequest.body.error, 'unsafe_path');
});
