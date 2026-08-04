import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const criticalStylesheets = [
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

test('loads core UI and preloader styles directly from the document head', () => {
    const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const mainStyle = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
    const head = index.slice(index.indexOf('<head>'), index.indexOf('</head>'));

    for (const stylesheet of criticalStylesheets) {
        assert.match(head, new RegExp(`<link[^>]+href="${stylesheet.replaceAll('.', '\\.')}"`));
        assert.doesNotMatch(mainStyle, new RegExp(`@import\\s+url\\(${stylesheet.replaceAll('.', '\\.')}\\)`));
    }
    const mainStylesheet = '<link rel="stylesheet" type="text/css" href="style.css">';
    assert.ok(head.indexOf('css/loader.css') < head.indexOf(mainStylesheet));
    assert.match(index, /<div id="preloader">/u);
    assert.match(index, /class="st-loader-card"/u);
});
