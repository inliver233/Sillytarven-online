/* eslint-disable playwright/expect-expect -- Node test runner uses assert. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { setConfigFilePath } from '../src/util.js';
import {
    isExtensionLifecycleEnabled,
    loadExtensionLifecycleFeatureGate,
    resetExtensionLifecycleFeatureGateForTests,
} from '../public/scripts/extensions/feature-gate.js';

const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
setConfigFilePath(defaultConfigPath);
const source = relativePath => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('extension lifecycle gate is cached and fail closed', async () => {
    resetExtensionLifecycleFeatureGateForTests();
    let fetches = 0;
    const fetchImpl = async () => {
        fetches++;
        return { ok: true, json: async () => ({ enabled: true }) };
    };

    assert.equal(await loadExtensionLifecycleFeatureGate(fetchImpl), true);
    assert.equal(await loadExtensionLifecycleFeatureGate(async () => { throw new Error('must not fetch'); }), true);
    assert.equal(fetches, 1);
    assert.equal(isExtensionLifecycleEnabled(), true);

    resetExtensionLifecycleFeatureGateForTests();
    assert.equal(await loadExtensionLifecycleFeatureGate(async () => { throw new Error('offline'); }), false);
    assert.equal(isExtensionLifecycleEnabled(), false);
});

test('public extension lifecycle config is off by default', async () => {
    const { router } = await import('../src/endpoints/public-config.js');
    const app = express();
    app.use('/api/public-config', router);
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/public-config/extension-lifecycle`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { enabled: false });
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

test('startup awaits all gates and extension UI initialization before command registration', () => {
    const script = source('public/script.js');
    const gateBarrier = script.indexOf('await Promise.all([loadMacros2FeatureGate(), loadReasoningToolsFeatureGate(), loadExtensionLifecycleFeatureGate(), loadSwipePickerFeatureGate()])');
    const extensionInit = script.indexOf('const extensionsReady = initExtensions();');
    const extensionBarrier = script.indexOf('await Promise.all([extensionsReady, settingsManagersReady]);');
    const extensionCommands = script.indexOf('initExtensionSlashCommands();');
    const settingsLoad = script.indexOf('await getSettings()');
    const macroRegistration = script.indexOf('initMacros();');
    const extensionSettingsLoad = script.indexOf('await loadExtensionSettings(settings');

    assert.ok(gateBarrier >= 0 && gateBarrier < extensionInit);
    assert.ok(extensionInit < extensionBarrier);
    assert.ok(extensionBarrier < extensionCommands && extensionCommands < settingsLoad);
    assert.ok(macroRegistration >= 0 && macroRegistration < extensionSettingsLoad);
});

test('extension startup orders discovery, manifest, eligibility, auto-update, preload, activation, and disposal', () => {
    const extensions = source('public/scripts/extensions.js');
    const start = extensions.indexOf('export async function loadExtensionSettings');
    const end = extensions.indexOf('export function doDailyExtensionUpdatesCheck', start);
    const startup = extensions.slice(start, end);
    const checkpoints = [
        'await discoverExtensions()',
        'await getManifests(extensionNames)',
        'const activationPlan = getExtensionActivationPlan',
        'await autoUpdateExtensions(false)',
        'await activateDiscoveredExtensions(activationPlan)',
    ].map(text => startup.indexOf(text));

    assert.equal(checkpoints.every(index => index >= 0), true);
    assert.deepEqual([...checkpoints].sort((a, b) => a - b), checkpoints);

    const activationStart = extensions.indexOf('async function activateDiscoveredExtensions');
    const activationEnd = extensions.indexOf('async function connectClickHandler', activationStart);
    const activation = extensions.slice(activationStart, activationEnd);
    const activationCheckpoints = [
        'preloadExtensionResources(extensionDescriptors',
        'await activateExtensions()',
        'resourcePreloads?.dispose()',
    ].map(text => activation.indexOf(text));
    assert.equal(activationCheckpoints.every(index => index >= 0), true);
    assert.deepEqual([...activationCheckpoints].sort((a, b) => a - b), activationCheckpoints);
    assert.match(extensions, /if \(isExtensionLifecycleEnabled\(\)\)[\s\S]*extensionLifecycle\.activate\(descriptor\)/);
    assert.match(extensions, /else \{[\s\S]*addExtensionScript\(name, manifest\)/);
    assert.match(extensions, /extensionLifecycle\.update\(descriptor, pullUpdate\)/);

    const installStart = extensions.indexOf('export async function installExtension');
    const installEnd = extensions.indexOf('export async function loadExtensionSettings', installStart);
    const installation = extensions.slice(installStart, installEnd);
    const installCheckpoints = [
        'const activationPlan = await loadExtensionSettings({}, false, false, { activate: !lifecycleEnabled })',
        'await extensionLifecycle.install(descriptor)',
        'await activateDiscoveredExtensions(activationPlan)',
    ].map(text => installation.indexOf(text));
    assert.equal(installCheckpoints.every(index => index >= 0), true);
    assert.deepEqual([...installCheckpoints].sort((a, b) => a - b), installCheckpoints);

    const enableStart = extensions.indexOf('export async function enableExtension');
    const enableEnd = extensions.indexOf('export async function disableExtension', enableStart);
    const enableAction = extensions.slice(enableStart, enableEnd);
    assert.ok(enableAction.indexOf('extensionLifecycle.enable(descriptor)') < enableAction.indexOf('extension_settings.disabledExtensions ='));
    assert.match(extensions, /extensionLifecycle\.disable\(descriptor\)/);
    assert.match(extensions, /extensionLifecycle\.install\(descriptor\)/);
    assert.match(extensions, /extensionLifecycle\.clean\(descriptor\)/);
    assert.match(extensions, /extensionLifecycle\.delete\(descriptor, removeExtension, \{ clean: shouldClean \}\)/);
    assert.match(extensions, /class="btn_clean menu_button"/);
    assert.match(extensions, /id: 'extension_delete_cleanup'/);

    const lifecycle = source('public/scripts/util/extension-lifecycle.js');
    assert.match(lifecycle, /globalThis\.setTimeout\.bind\(globalThis\)/);
    assert.match(lifecycle, /globalThis\.clearTimeout\.bind\(globalThis\)/);
});
