import { expect, test } from '@playwright/test';

import { testSetup } from './frontent-test-utils.js';

const BUILTIN_NAME = 'assets';
const LIFECYCLE_GATE_URL = '**/api/public-config/extension-lifecycle';
const SETTINGS_GET_URL = '**/api/settings/get';

async function routeLifecycleGate(page, enabled) {
    await page.route(LIFECYCLE_GATE_URL, route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled }),
    }));
}

async function routeSettings(page, mutateSettings = () => {}) {
    let savedDisabledExtensions = null;
    await page.route(SETTINGS_GET_URL, async route => {
        const response = await route.fetch();
        const payload = await response.json();
        if (typeof payload.settings === 'string') {
            const settings = JSON.parse(payload.settings);
            savedDisabledExtensions = [...(settings.extension_settings?.disabledExtensions ?? [])];
            mutateSettings(settings);
            payload.settings = JSON.stringify(settings);
        }
        await route.fulfill({
            status: response.status(),
            contentType: 'application/json',
            body: JSON.stringify(payload),
        });
    });
    return () => savedDisabledExtensions;
}

async function routeBuiltinEnabledSettings(page) {
    return routeSettings(page, settings => {
        settings.extension_settings ??= {};
        settings.extension_settings.disabledExtensions = (settings.extension_settings.disabledExtensions ?? [])
            .filter(name => name !== BUILTIN_NAME);
    });
}

async function getBuiltinLifecycle(page) {
    return page.evaluate(async name => {
        const extensions = await import('./scripts/extensions.js');
        const { isExtensionLifecycleEnabled } = await import('./scripts/extensions/feature-gate.js');
        return {
            gateEnabled: isExtensionLifecycleEnabled(),
            extension: extensions.findExtension(name),
            manifest: extensions.getExtensionManifest(name),
            status: extensions.getExtensionStatus(name),
            disabledExtensions: [...extensions.extension_settings.disabledExtensions],
        };
    }, BUILTIN_NAME);
}

async function openExtensionManager(page) {
    await page.locator('#extensions_details').evaluate(element => element.click());
    const popup = page.locator('.popup:has(.extensions_info)');
    await expect(popup).toBeVisible();
    return popup;
}

async function getExtensionManagerBounds(page) {
    return page.evaluate(name => {
        const popup = document.querySelector('.popup:has(.extensions_info)');
        const elements = {
            document: document.documentElement,
            popup,
            body: popup?.querySelector('.popup-body'),
            content: popup?.querySelector('.popup-content'),
            toolbar: popup?.querySelector('.extensions_toolbar'),
            extension: popup?.querySelector(`.extension_block[data-name="${CSS.escape(name)}"]`),
        };
        return Object.fromEntries(Object.entries(elements).map(([key, element]) => {
            if (!element) {
                return [key, null];
            }
            const rect = element.getBoundingClientRect();
            return [key, {
                left: rect.left,
                right: rect.right,
                viewportWidth: document.documentElement.clientWidth,
                horizontalOverflow: element.scrollWidth - element.clientWidth,
            }];
        }));
    }, BUILTIN_NAME);
}

function expectNoHorizontalOverflow(bounds) {
    for (const [name, measurement] of Object.entries(bounds)) {
        expect(measurement, `${name} should exist`).not.toBeNull();
        expect(measurement.horizontalOverflow, `${name} should not scroll horizontally`).toBeLessThanOrEqual(1);
        expect(measurement.left, `${name} should remain inside the left viewport edge`).toBeGreaterThanOrEqual(-1);
        expect(measurement.right, `${name} should remain inside the right viewport edge`).toBeLessThanOrEqual(measurement.viewportWidth + 1);
    }
}

async function verifyExtensionManagerLayout(page, viewport) {
    await page.setViewportSize(viewport);
    await routeLifecycleGate(page, true);
    await routeBuiltinEnabledSettings(page);
    await testSetup.awaitST({ page });

    const lifecycle = await getBuiltinLifecycle(page);
    expect(lifecycle.status?.status).toBe('active');

    const popup = await openExtensionManager(page);
    const block = popup.locator(`.extension_block[data-name="${BUILTIN_NAME}"]`);
    await expect(block).toBeVisible();
    await expect(block.locator('.extension_enabled')).toBeVisible();
    await expect(block.locator('.toggle_disable')).toBeChecked();
    expectNoHorizontalOverflow(await getExtensionManagerBounds(page));
    return true;
}

test.describe('Extension lifecycle browser integration', () => {
    test('disabled feature gate preserves legacy loading without rewriting settings', async ({ page }) => {
        let settingsSaveRequests = 0;
        page.on('request', request => {
            if (new URL(request.url()).pathname === '/api/settings/save') {
                settingsSaveRequests++;
            }
        });
        await routeLifecycleGate(page, false);
        const getSavedDisabledExtensions = await routeSettings(page);
        await testSetup.awaitST({ page });

        const lifecycle = await getBuiltinLifecycle(page);
        expect(lifecycle.gateEnabled).toBe(false);
        expect(lifecycle.manifest).toMatchObject({
            display_name: 'Assets',
            hooks: { activate: 'init' },
        });
        expect(lifecycle.status).toBeNull();
        expect(lifecycle.disabledExtensions).toEqual(getSavedDisabledExtensions());
        await expect(page.locator('script[src$="/scripts/extensions/assets/index.js"]')).toHaveCount(1);
        expect(settingsSaveRequests).toBe(0);
    });

    test('enabled feature gate exposes the builtin manifest and active lifecycle status', async ({ page }) => {
        await routeLifecycleGate(page, true);
        await routeBuiltinEnabledSettings(page);
        await testSetup.awaitST({ page });

        const lifecycle = await getBuiltinLifecycle(page);
        expect(lifecycle.gateEnabled).toBe(true);
        expect(lifecycle.extension).toEqual({ name: BUILTIN_NAME, enabled: true, type: 'builtin' });
        expect(lifecycle.manifest).toMatchObject({
            display_name: 'Assets',
            hooks: { activate: 'init' },
        });
        expect(lifecycle.status).toMatchObject({
            status: 'active',
            error: null,
            descriptor: {
                canonicalName: BUILTIN_NAME,
                type: 'builtin',
                enabled: true,
            },
            hooks: {
                activate: { status: 'ok', exportName: 'init' },
            },
        });
        await expect(page.locator('script[src$="/scripts/extensions/assets/index.js"]')).toHaveCount(0);
    });

    test('desktop extension manager shows active lifecycle state without horizontal overflow', async ({ page }) => {
        await expect(verifyExtensionManagerLayout(page, { width: 1280, height: 720 })).resolves.toBe(true);
    });

    test('mobile 390x844 extension manager shows active lifecycle state without horizontal overflow', async ({ page }) => {
        await expect(verifyExtensionManagerLayout(page, { width: 390, height: 844 })).resolves.toBe(true);
    });
});
