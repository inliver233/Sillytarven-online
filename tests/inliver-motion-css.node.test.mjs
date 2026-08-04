import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'inliver-motion.css'), 'utf8');
const themeSource = fs.readFileSync(path.join(root, 'tools', 'inliver-theme.source.css'), 'utf8');
const normalizedThemeSource = themeSource.replace(/\r\n/g, '\n').trim();
const themePreset = JSON.parse(fs.readFileSync(path.join(root, 'default', 'content', 'themes', 'inliver.json'), 'utf8'));

test('inliver enhancements never cancel the original message or recent-chat animations', () => {
    assert.doesNotMatch(css, /#chat\s*>\s*\.mes\s*\{[^}]*animation\s*:\s*none/is);
    assert.doesNotMatch(css, /\.recentChat\.st-motion-running\s*\{[^}]*animation\s*:\s*none/is);
});

test('inliver enhancements preserve top-bar feedback and the singular toast icon fix', () => {
    assert.match(css, /#top-settings-holder \.drawer-icon\.openIcon/);
    assert.match(css, /#top-settings-holder \.drawer-icon:active/);
    assert.match(css, /background-repeat:\s*no-repeat\s*!important/);
    assert.match(css, /\.drawer-content\s*\{[^}]*transition-duration:\s*var\(--il-dur-fast/is);
    assert.match(css, /\.drawer-content\.openDrawer\s*>\s*\*\s*\{[^}]*animation-duration:\s*var\(--il-dur-fast/is);
});

test('the built-in preset stays synchronized and highlights the actual open drawer icon', () => {
    assert.equal(themePreset.custom_css, normalizedThemeSource);
    assert.match(themeSource, /#top-settings-holder \.drawer-icon\.openIcon/);
    assert.doesNotMatch(themeSource, /\.drawer-icon:has\([^)]*openDrawer[^)]*\) \.fa-solid/);
});
