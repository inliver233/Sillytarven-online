import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import showdown from 'showdown';

import { addShowdownPatch } from '../public/scripts/util/showdown-patch.js';

const pinnedCommit = 'd1a8d16344b855ea2f37677ee8a9e0cc2c597ea4';

test('Showdown is integrity-locked to the reviewed 3.0 release candidate commit', () => {
    const packageManifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const packageLock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    const browserLibraryEntry = fs.readFileSync(new URL('../public/lib.js', import.meta.url), 'utf8');
    const locked = packageLock.packages['node_modules/showdown'];

    assert.equal(
        packageManifest.dependencies.showdown,
        `https://github.com/showdownjs/showdown/archive/${pinnedCommit}.tar.gz`,
    );
    assert.equal(locked.version, '3.0.0-rc2');
    assert.match(locked.resolved, new RegExp(`${pinnedCommit}\\.tar\\.gz$`));
    assert.match(locked.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
    assert.ok(browserLibraryEntry.includes('import showdownModule from \'showdown/dist/showdown.esm.js\';'));
    assert.ok(browserLibraryEntry.includes('const showdown = showdownModule;'));
});

test('Showdown escapes metadata title and table-header attribute injection payloads', () => {
    const documentConverter = new showdown.Converter({ metadata: true, completeHTMLDocument: true });
    const titlePayload = '</title><svg onload=globalThis.__showdown_xss=1>';
    const document = documentConverter.makeHtml(`---\ntitle: ${titlePayload}\n---\nbody`);
    assert.doesNotMatch(document, /<\/title><svg/i);
    assert.match(document, /<title>&lt;\/title&gt;&lt;svg onload=/i);

    const tableConverter = new showdown.Converter({ tables: true });
    const table = tableConverter.makeHtml('header" autofocus onfocus=globalThis.__showdown_xss=1 x" | safe\n---|---\n1|2');
    assert.doesNotMatch(table, /<th[^>]*\sautofocus(?:\s|=|>)/i);
    assert.doesNotMatch(table, /<th[^>]*\sonfocus=/i);
    assert.match(table, /header&quot; autofocus onfocus=/i);
});

test('Showdown anchor parser handles the published CVE-2024-1899 payload in bounded time', () => {
    const converter = new showdown.Converter({ tables: true });
    const malicious = '[[[[[[[[['.repeat(9_999);
    const startedAt = performance.now();
    const output = converter.makeHtml(malicious);
    const elapsedMs = performance.now() - startedAt;

    assert.ok(output.length >= malicious.length, 'conversion unexpectedly discarded the payload');
    assert.ok(elapsedMs < 2_000, `CVE-2024-1899 regression: conversion took ${elapsedMs.toFixed(1)}ms`);
});

test('SillyTavern Showdown extension remains compatible with the pinned release candidate', () => {
    addShowdownPatch(showdown);
    const converter = new showdown.Converter({ tables: true, emoji: true });
    const output = converter.makeHtml('**safe** | value\n---|---\n:smile:|ok');
    assert.match(output, /<strong>safe<\/strong>/);
    assert.match(output, /<table>/);
});
