import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const publicFile = (path) => new URL(`../public/${path}`, import.meta.url);

const [indexHtml, scriptSource, styleCss, popupCss] = await Promise.all([
    readFile(publicFile('index.html'), 'utf8'),
    readFile(publicFile('script.js'), 'utf8'),
    readFile(publicFile('style.css'), 'utf8'),
    readFile(publicFile('css/popup.css'), 'utf8'),
]);

const importedStylesheets = [
    'css/animations.css',
    'css/popup.css',
    'css/promptmanager.css',
    'css/loader.css',
    'css/character-group-overlay.css',
    'css/file-form.css',
    'css/logprobs.css',
    'css/accounts.css',
    'css/tags.css',
    'css/scrollable-button.css',
    'css/welcome.css',
    'css/data-maid.css',
    'css/secrets.css',
    'css/backgrounds.css',
    'css/chat-backups.css',
];

function getAttribute(tag, name) {
    const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
    return match?.[2] ?? null;
}

function hasRel(tag, value) {
    return getAttribute(tag, 'rel')?.toLowerCase().split(/\s+/).includes(value) ?? false;
}

test('startup stylesheets are explicit ordered links before style.css', () => {
    assert.match(styleCss, /^@charset "UTF-8";\r?\n/);
    assert.doesNotMatch(styleCss, /^\s*@import\b/m);

    const links = [...indexHtml.matchAll(/<link\b[^>]*>/gi)].map((match) => ({
        end: match.index + match[0].length,
        href: getAttribute(match[0], 'href'),
        index: match.index,
        tag: match[0],
    }));
    const stylesheetLinks = links.filter(({ tag }) => hasRel(tag, 'stylesheet'));
    const expectedSequence = [...importedStylesheets, 'style.css'];
    const orderedLinks = expectedSequence.map((href) => {
        const matches = stylesheetLinks.filter((link) => link.href === href);
        assert.equal(matches.length, 1, `expected one stylesheet link for ${href}`);
        return matches[0];
    });

    assert.deepEqual(orderedLinks.map(({ href }) => href), expectedSequence);
    for (let index = 1; index < orderedLinks.length; index++) {
        const previous = orderedLinks[index - 1];
        const current = orderedLinks[index];
        assert.ok(previous.index < current.index, `${current.href} must follow ${previous.href}`);
        assert.match(indexHtml.slice(previous.end, current.index), /^\s*$/, `${current.href} must be contiguous with the ordered stylesheet block`);
    }

    const stylePreloads = links.filter(({ href, tag }) => href === 'style.css' && hasRel(tag, 'preload'));
    assert.equal(stylePreloads.length, 1, 'style.css preload must be preserved');
    assert.ok(stylePreloads[0].index < orderedLinks[0].index, 'style.css preload must remain before the explicit stylesheet block');

    assert.match(popupCss, /^@import url\('\/lib\/dialog-polyfill\.css'\);\r?\n@import url\('\.\/popup-safari-fix\.css'\);/);
});

test('startup initialization does not wait for window.load', () => {
    const readyStart = scriptSource.indexOf('jQuery(async function () {');
    assert.notEqual(readyStart, -1, 'jQuery ready callback must be preserved');

    const beforeReady = scriptSource.slice(0, readyStart);
    assert.doesNotMatch(beforeReady, /document\.readyState\s*===\s*['"]complete['"]/);
    assert.doesNotMatch(beforeReady, /window\.addEventListener\(\s*['"]load['"]\s*,\s*resolve\s*\)/);

    const readyCallback = scriptSource.slice(readyStart);
    assert.equal((readyCallback.match(/\bawait firstLoadInit\(\);/g) ?? []).length, 1);
    assert.ok(scriptSource.indexOf('async function firstLoadInit()') < readyStart, 'firstLoadInit must be defined before the ready callback');
    assert.ok(readyCallback.trimEnd().endsWith('});'), 'jQuery ready callback must remain the final startup wrapper');
});

test('the main module remains after required classic scripts at the end of body', () => {
    const scripts = [...indexHtml.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*><\/script>/gi)].map((match) => ({
        end: match.index + match[0].length,
        index: match.index,
        src: match[2],
        tag: match[0],
    }));
    const mainModules = scripts.filter(({ src, tag }) => src === 'script.js' && getAttribute(tag, 'type') === 'module');
    assert.equal(mainModules.length, 1, 'script.js must remain a module script');

    const mainModule = mainModules[0];
    const bodyOpen = indexHtml.indexOf('<body');
    const bodyClose = indexHtml.lastIndexOf('</body>');
    assert.equal(scripts.at(-1)?.src, 'script.js', 'script.js must remain the final external script');
    assert.ok(bodyOpen < mainModule.index && mainModule.end < bodyClose, 'script.js must remain inside the body');

    const trailingBodyMarkup = indexHtml
        .slice(mainModule.end, bodyClose)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .trim();
    assert.equal(trailingBodyMarkup, '', 'only inline scripts may follow script.js before the body closes');

    const requiredClassicScripts = [
        'lib/polyfill.js',
        'lib/jquery-3.5.1.min.js',
        'lib/jquery-ui.min.js',
        'lib/jquery.transit.min.js',
        'lib/jquery-cookie-1.4.1.min.js',
        'lib/jquery.ui.touch-punch.min.js',
        'lib/cropper.min.js',
        'lib/jquery-cropper.min.js',
        'lib/toastr.min.js',
        'lib/select2.min.js',
        'lib/select2-search-placeholder.js',
        'lib/pagination.js',
        'lib/toolcool-color-picker.js',
        'lib/jquery.izoomify.js',
    ];

    for (const src of requiredClassicScripts) {
        const matches = scripts.filter((script) => script.src === src);
        assert.equal(matches.length, 1, `expected one classic script for ${src}`);
        assert.equal(getAttribute(matches[0].tag, 'type'), null, `${src} must remain a classic script`);
        assert.ok(matches[0].index < mainModule.index, `${src} must load before script.js`);
    }
});
