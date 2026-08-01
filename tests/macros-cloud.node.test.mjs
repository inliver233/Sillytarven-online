import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('client macro gate is additive and never rewrites the saved user setting', async () => {
    const moduleUrl = pathToFileURL(path.join(root, 'public/scripts/macros/feature-gate.js')).href + `?test=${Date.now()}`;
    const gate = await import(moduleUrl);
    const calls = [];
    const enabled = await gate.loadMacros2FeatureGate(async url => {
        calls.push(url);
        return new Response(JSON.stringify({ macros2: true }), { status: 200 });
    });

    assert.equal(enabled, true);
    assert.deepEqual(calls, ['/api/public-config/feature-flags']);
    assert.equal(gate.isMacros2Enabled(false), false);
    assert.equal(gate.isMacros2Enabled(true), true);
    assert.doesNotMatch(read('public/scripts/macros/feature-gate.js'), /saveSettings|experimental_macro_engine\s*=/);
});

test('macro initialization follows saved settings and precedes extension registration', () => {
    const source = read('public/script.js');
    const settingsSelection = source.indexOf('selected_button = settings.selected_button;');
    const macroInit = source.indexOf('initMacros();', settingsSelection);
    const extensionLoad = source.indexOf('loadExtensionSettings(settings', macroInit);
    assert.ok(settingsSelection >= 0 && macroInit > settingsSelection && extensionLoad > macroInit);

    const firstLoad = source.slice(source.indexOf('async function firstLoadInit()'), source.indexOf('//MARK: getSettings()'));
    assert.equal((firstLoad.match(/initMacros\(\);/g) || []).length, 0);
});

test('paging-aware pristine greeting sync uses logical history state', () => {
    const source = read('public/script.js');
    const syncStart = source.indexOf('export function syncMesToSwipe');
    const syncEnd = source.indexOf('\n}\n', syncStart) + 2;
    const syncSource = source.slice(syncStart, syncEnd);
    assert.match(syncSource, /chat_metadata\.tainted \|\| chatPagingState\.hasMore \|\| chat\.length > 1/);
    assert.match(syncSource, /targetMessage\.swipes\[targetMessage\.swipe_id\] = targetMessage\.mes/);
});

test('cloud extension resolver preserves discovery order before preload and activation', () => {
    const source = read('public/scripts/extensions.js');
    assert.match(source, /extensionNames = extensions\.map\(x => x\.name\)/);
    assert.match(source, /extensionNames\.find\(extensionName =>/);
    assert.ok(source.indexOf('extensionNames = extensions.map(x => x.name)') < source.indexOf('preloadExtensionResources(', source.indexOf('extensionNames = extensions.map(x => x.name)')));
});

test('official conformance files and staging-only regressions are present', () => {
    const names = [
        'MacroEngine.e2e.js',
        'MacroEnvBuilder.e2e.js',
        'MacroLexer.e2e.js',
        'MacroParser.e2e.js',
        'MacroRegistry.e2e.js',
        'MacroSlashCommands.e2e.js',
        'MacroStoryString.e2e.js',
        'MacrosParser.e2e.js',
    ];
    names.forEach(name => assert.ok(fs.existsSync(path.join(root, 'tests/frontend', name)), name));

    const engineTests = read('tests/frontend/MacroEngine.e2e.js');
    const lexerTests = read('tests/frontend/MacroLexer.e2e.js');
    assert.match(engineTests, /should remove scoped comment block \(basic\)/);
    assert.match(lexerTests, /pipe character in argument values \(issue #5618\)/);
    assert.match(lexerTests, /SKIPPED: Pipe\/filter feature temporarily disabled/);
    assert.equal((lexerTests.match(/\.skip\(/g) || []).length, 1);
});

test('new installs opt in by default while the instance gate remains authoritative', () => {
    const defaults = JSON.parse(read('default/content/settings.json'));
    const powerUserSource = read('public/scripts/power-user.js');
    const featureDefaults = read('default/config.yaml');

    assert.equal(defaults.power_user.experimental_macro_engine, true);
    assert.match(powerUserSource, /experimental_macro_engine: true/);
    assert.match(featureDefaults, /macros2: false/);
});

test('autocomplete keeps upstream inactive and detached-element guards', () => {
    const source = read('public/scripts/autocomplete/AutoComplete.js');
    assert.match(source, /if \(this\.isActive\) \{\s*this\.updateFloatingPositionDebounced\(\)/);
    assert.match(source, /if \(this\.isActive\) \{\s*this\.updatePositionDebounced\(\)/);
    assert.match(source, /if \(this\.textarea\.parentElement\) \{\s*mo\.observe/);
});

test('Chevrotain runtime and types resolve together at 11.2.0', () => {
    const manifest = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    assert.equal(manifest.dependencies.chevrotain, '^11.2.0');
    assert.equal(manifest.devDependencies['@chevrotain/types'], '^11.2.0');
    assert.equal(lock.packages['node_modules/chevrotain'].version, '11.2.0');
    assert.equal(lock.packages['node_modules/@chevrotain/types'].version, '11.2.0');
});
