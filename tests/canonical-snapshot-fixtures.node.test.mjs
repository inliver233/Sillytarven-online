/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createCanonicalDryRunSnapshot,
    diffCanonicalSnapshots,
    sha256,
} from '../src/canonical-hash.js';

const MESSAGE_COUNTS = [0, 1, 199, 200, 299, 300, 301, 1000];
const CHUNK_SIZE = 300;

function makeHeader(marker, messageCount) {
    return {
        character_name: 'Fixture',
        user_name: 'User',
        unknown_top_level: { preserved: true, order: ['b', 'a'] },
        chat_metadata: { message_count: messageCount, marker },
    };
}

function makeMessages(count) {
    return Array.from({ length: count }, (_, index) => ({
        name: index % 2 ? 'Fixture' : 'User',
        is_user: index % 2 === 0,
        send_date: 1_700_000_000_000 + index,
        mes: `message-${index}`,
        extra: { unknown: index },
    }));
}

function fileHash(snapshot, filePath) {
    return snapshot.artifacts.files.find(file => file.path === filePath)?.sha256;
}

function buildLegacySnapshot(header, messages, revision) {
    const messageBytes = messages.map(message => JSON.stringify(message)).join('\n');
    const main = [JSON.stringify(header), messageBytes].filter(Boolean).join('\n');
    return {
        messageBytes,
        snapshot: createCanonicalDryRunSnapshot({
            json: header,
            artifacts: [
                { path: 'chat.jsonl', contents: main },
                { path: 'chat.jsonl.metadata.json', contents: JSON.stringify(header) },
                { path: 'chat.jsonl.revision.json', contents: JSON.stringify({ version: 1, revision }) },
            ],
        }),
    };
}

function buildChunkSnapshot(header, messages, revision) {
    const shards = [];
    for (let offset = 0; offset < messages.length; offset += CHUNK_SIZE) {
        const shardMessages = messages.slice(offset, offset + CHUNK_SIZE);
        const contents = shardMessages.map(message => JSON.stringify(message)).join('\n');
        shards.push({
            path: `chat.jsonl.chunks/${String(shards.length).padStart(6, '0')}.jsonl`,
            contents,
            count: shardMessages.length,
        });
    }
    const index = {
        version: 1,
        chunk_size: CHUNK_SIZE,
        message_count: messages.length,
        total_bytes: shards.reduce((total, shard) => total + Buffer.byteLength(shard.contents), 0),
        shards: shards.map(shard => ({
            file: shard.path.split('/').at(-1),
            count: shard.count,
            size: Buffer.byteLength(shard.contents),
        })),
    };
    return createCanonicalDryRunSnapshot({
        json: header,
        directories: ['chat.jsonl.chunks'],
        artifacts: [
            { path: 'chat.jsonl', contents: JSON.stringify(header) },
            { path: 'chat.jsonl.metadata.json', contents: JSON.stringify(header) },
            { path: 'chat.jsonl.index.json', contents: JSON.stringify(index) },
            { path: 'chat.jsonl.revision.json', contents: JSON.stringify({ version: 1, revision }) },
            ...shards,
        ],
    });
}

for (const messageCount of MESSAGE_COUNTS) {
    test(`legacy dry-run manifest preserves raw message bytes at count ${messageCount}`, () => {
        const messages = makeMessages(messageCount);
        const before = buildLegacySnapshot(makeHeader('before', messageCount), messages, 'before');
        const after = buildLegacySnapshot(makeHeader('after', messageCount), messages, 'after');
        const diff = diffCanonicalSnapshots(before.snapshot, after.snapshot);

        assert.equal(before.snapshot.json.canonical.includes('unknown_top_level'), true);
        assert.equal(after.snapshot.json.canonical.includes('unknown_top_level'), true);
        assert.notEqual(before.snapshot.json.sha256, after.snapshot.json.sha256);
        assert.equal(sha256(before.messageBytes), sha256(after.messageBytes));
        assert.deepEqual(diff, {
            changed: true,
            canonicalJsonChanged: true,
            addedFiles: [],
            removedFiles: [],
            changedFiles: ['chat.jsonl', 'chat.jsonl.metadata.json', 'chat.jsonl.revision.json'],
            addedDirectories: [],
            removedDirectories: [],
        });
    });

    test(`chunk-like dry-run manifest preserves raw shard and index hashes at count ${messageCount}`, () => {
        const messages = makeMessages(messageCount);
        const before = buildChunkSnapshot(makeHeader('before', messageCount), messages, 'before');
        const after = buildChunkSnapshot(makeHeader('after', messageCount), messages, 'after');
        const diff = diffCanonicalSnapshots(before, after);

        assert.notEqual(before.json.sha256, after.json.sha256);
        assert.equal(fileHash(before, 'chat.jsonl.index.json'), fileHash(after, 'chat.jsonl.index.json'));
        const shardPaths = before.artifacts.files
            .map(file => file.path)
            .filter(filePath => filePath.startsWith('chat.jsonl.chunks/'));
        assert.equal(shardPaths.length, Math.ceil(messageCount / CHUNK_SIZE));
        for (const shardPath of shardPaths) {
            assert.equal(fileHash(before, shardPath), fileHash(after, shardPath));
        }
        assert.deepEqual(diff.changedFiles, [
            'chat.jsonl',
            'chat.jsonl.metadata.json',
            'chat.jsonl.revision.json',
        ]);
        assert.equal(diff.canonicalJsonChanged, true);
        assert.deepEqual(before.artifacts.directories, ['chat.jsonl.chunks']);
        assert.deepEqual(after.artifacts.directories, ['chat.jsonl.chunks']);
    });
}

test('canonical snapshot diff reports no changes for an identical dry run', () => {
    const snapshot = buildChunkSnapshot(makeHeader('same', 1), makeMessages(1), 'same');
    assert.deepEqual(diffCanonicalSnapshots(snapshot, snapshot), {
        changed: false,
        canonicalJsonChanged: false,
        addedFiles: [],
        removedFiles: [],
        changedFiles: [],
        addedDirectories: [],
        removedDirectories: [],
    });
});
