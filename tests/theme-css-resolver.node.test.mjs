import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveThemeCustomCss } from '../public/scripts/util/theme-css-resolver.js';

const baseCss = `
:root { --il-spring: cubic-bezier(0.16, 1, 0.3, 1); }
@keyframes il-rise { from { opacity: 0; } to { opacity: 1; } }
#top-settings-holder .drawer-icon { color: blue; }
`.trim();
const themes = [{ name: 'inliver', custom_css: baseCss }];

test('non-inliver themes retain their custom CSS without built-in additions', () => {
    assert.equal(resolveThemeCustomCss('Default', '.menu_button { color: red; }', themes), '.menu_button { color: red; }');
});

test('inliver restores its built-in animation system when saved CSS is empty', () => {
    assert.equal(resolveThemeCustomCss('inliver', '', themes), baseCss);
});

test('inliver prepends its base while preserving user-only additions', () => {
    const customCss = '.my-adjustment { opacity: 0.9; }';
    const resolved = resolveThemeCustomCss('inliver', customCss, themes);
    assert.equal(resolved, `${baseCss}\n\n${customCss}`);
});

test('inliver does not duplicate an existing complete base theme', () => {
    const completeCss = `${baseCss}\n.my-adjustment { opacity: 0.9; }`;
    assert.equal(resolveThemeCustomCss('inliver', completeCss, themes), completeCss);
});

test('missing inliver preset fails closed to the saved CSS', () => {
    assert.equal(resolveThemeCustomCss('inliver', '.custom {}', []), '.custom {}');
});
