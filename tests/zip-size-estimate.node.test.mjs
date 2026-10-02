import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import zlib from 'node:zlib';

import { chatLinesToText, estimateZipBytes } from '../src/zip-size-estimate.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-zip-estimate-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function write(name, content) {
    const file = path.join(root, name);
    fs.writeFileSync(file, content);
    return { name, size: fs.statSync(file).size, samplePath: file };
}

function deflated(entries, level, transform) {
    return entries.reduce((total, entry) => {
        let data = fs.readFileSync(entry.samplePath);
        if (transform) data = Buffer.from(transform(data.toString('utf8')));
        return total + zlib.deflateRawSync(data, { level }).length;
    }, 0);
}

test('large files are measured from their own content, media is counted as stored', async () => {
    const lines = Array.from({ length: 6000 }, (_, i) => JSON.stringify({
        name: i % 2 ? 'User' : 'Bot',
        mes: `${crypto.randomBytes(24).toString('base64')} ${'对话内容'.repeat(i % 7)}`,
        extra: { snapshot: { hp: i, log: Array.from({ length: 5 }, (_, k) => `step ${k}`) } },
    }));
    const chat = write('a.jsonl', lines.join('\n'));
    const photo = write('b.jpg', crypto.randomBytes(300_000));
    const estimate = await estimateZipBytes([chat, photo], 6);

    const actual = deflated([chat], 6) + photo.size;
    assert.ok(Math.abs(estimate.estimatedBytes / actual - 1) < 0.15, `${estimate.estimatedBytes} vs ${actual}`);
    assert.equal(estimate.files, 2);
    assert.equal(estimate.rawBytes, chat.size + photo.size);

    const txt = await estimateZipBytes([{ ...chat, transform: chatLinesToText }], 6);
    const txtActual = deflated([chat], 6, chatLinesToText);
    assert.ok(Math.abs(txt.estimatedBytes / txtActual - 1) < 0.25, `${txt.estimatedBytes} vs ${txtActual}`);
    assert.ok(txt.estimatedBytes < estimate.estimatedBytes);
});

test('chat lines become the TXT export text', () => {
    const text = chatLinesToText('{"user_name":"U","character_name":"B"}\n{"name":"B","mes":"hi"}\n{"name":"U","mes":"yo"}\nnot json');
    assert.equal(text, 'B: hi\n\nU: yo\n\n');
});
