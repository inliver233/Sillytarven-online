import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.describe('Macros 2.0 cloud integration', () => {
    test.beforeEach(testSetup.awaitST);

    test('feature gate preserves the saved user preference and acts as a kill switch', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { power_user } = await import('./scripts/power-user.js');
            const { isMacros2Available, isMacros2Enabled } = await import('./scripts/macros/feature-gate.js');
            const saved = power_user.experimental_macro_engine;
            const before = isMacros2Enabled(saved);
            power_user.experimental_macro_engine = true;
            const enabled = isMacros2Enabled(power_user.experimental_macro_engine);
            power_user.experimental_macro_engine = saved;
            return {
                available: isMacros2Available(),
                saved,
                before,
                enabled,
                restored: power_user.experimental_macro_engine,
            };
        });

        expect(result.available).toBe(true);
        expect(result.before).toBe(result.saved);
        expect(result.enabled).toBe(true);
        expect(result.restored).toBe(result.saved);
    });

    test('legacy role, world, and quick-reply macro registrations remain compatible', async ({ page }) => {
        const output = await page.evaluate(async () => {
            const { power_user } = await import('./scripts/power-user.js');
            const { MacrosParser, evaluateMacros } = await import('./scripts/macros.js');
            const saved = power_user.experimental_macro_engine;
            power_user.experimental_macro_engine = false;
            const names = ['cloudRole', 'cloudWorld', 'cloudQuickReply'];
            const values = ['assistant', 'lore', 'reply'];
            try {
                names.forEach((name, index) => MacrosParser.registerMacro(name, values[index]));
                return evaluateMacros(names.map(name => `{{${name}}}`).join('|'), {});
            } finally {
                names.forEach(name => MacrosParser.unregisterMacro(name));
                power_user.experimental_macro_engine = saved;
            }
        });

        expect(output).toBe('assistant|lore|reply');
    });

    test('nested false if has no side effect', async ({ page }) => {
        const output = await evaluate(page, '{{setvar::cloudLazy::before}}{{if false}}{{setvar::cloudLazy::changed}}{{if true}}{{setvar::cloudLazy::nested}}{{/if}}{{/if}}{{getvar::cloudLazy}}');
        expect(output).toBe('before');
    });

    test('local and global scopes remain isolated', async ({ page }) => {
        const output = await page.evaluate(async () => {
            const { MacroEngine } = await import('./scripts/macros/engine/MacroEngine.js');
            const { MacroEnvBuilder } = await import('./scripts/macros/engine/MacroEnvBuilder.js');
            const context = globalThis.SillyTavern.getContext();
            context.variables.local.set('cloudScope', 'local');
            context.variables.global.set('cloudScope', 'global');
            try {
                const input = '{{.cloudScope}}|{{$cloudScope}}|{{.cloudScope = changed}}{{.cloudScope}}|{{$cloudScope}}';
                return MacroEngine.evaluate(input, MacroEnvBuilder.buildFromRawEnv({ content: input }));
            } finally {
                context.variables.local.del('cloudScope');
                context.variables.global.del('cloudScope');
            }
        });

        expect(output).toBe('local|global|changed|global');
    });

    test('logical greeting selection and pick evaluation are stable', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { MacroEngine } = await import('./scripts/macros/engine/MacroEngine.js');
            const { MacroEnvBuilder } = await import('./scripts/macros/engine/MacroEnvBuilder.js');
            const { macros } = await import('./scripts/macros/macro-system.js');
            const greeting = macros.registry.getMacro('greeting');
            const env = { character: { firstMessage: 'primary', alternateGreetings: ['alternate-1', 'alternate-2'] } };
            const selected = [0, 1, 2].map(index => greeting.handler({ env, unnamedArgs: [String(index)] }));
            const input = '{{pick::alpha::beta::gamma}}';
            const first = MacroEngine.evaluate(input, MacroEnvBuilder.buildFromRawEnv({ content: input }));
            const second = MacroEngine.evaluate(input, MacroEnvBuilder.buildFromRawEnv({ content: input }));
            return { selected, first, second };
        });

        expect(result.selected).toEqual(['primary', 'alternate-1', 'alternate-2']);
        expect(result.first).toBe(result.second);
        expect(['alpha', 'beta', 'gamma']).toContain(result.first);
    });
});

async function evaluate(page, input) {
    return page.evaluate(async value => {
        const { MacroEngine } = await import('./scripts/macros/engine/MacroEngine.js');
        const { MacroEnvBuilder } = await import('./scripts/macros/engine/MacroEnvBuilder.js');
        return MacroEngine.evaluate(value, MacroEnvBuilder.buildFromRawEnv({ content: value }));
    }, input);
}
