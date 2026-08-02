import { expect, test } from '@playwright/test';

import { testSetup } from './frontent-test-utils.js';

async function routeReasoningToolsEnabled(page) {
    await page.route('**/api/public-config/reasoning-tools', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: true, recurseHardLimit: 50 }),
    }));
}

async function restoreOpenAiSettings(page, values) {
    await page.evaluate(async original => {
        const { oai_settings } = await import('./scripts/openai.js');
        const { saveSettings } = await import('./script.js');
        oai_settings.tool_call_recurse_limit = original.recurse;
        oai_settings.tool_reasoning_mode = original.mode;
        oai_settings.chat_completion_source = original.source;
        oai_settings.show_thoughts = original.thoughts;
        oai_settings.function_calling = original.functionCalling;
        const mainApi = document.querySelector('#main_api');
        mainApi.value = original.mainApi;
        mainApi.dispatchEvent(new Event('change', { bubbles: true }));
        const range = document.querySelector('#tool_call_recurse_limit');
        range.value = String(original.recurse);
        range.dispatchEvent(new Event('input', { bubbles: true }));
        const mode = document.querySelector('#tool_reasoning_mode');
        mode.value = original.mode;
        mode.dispatchEvent(new Event('input', { bubbles: true }));
        await saveSettings();
    }, values);
}

async function openAiResponseConfiguration(page) {
    const onboarding = page.locator('.popup:has(#onboarding_ui_language_select)');
    if (await onboarding.isVisible()) {
        const input = onboarding.locator('.popup-input');
        if (!(await input.inputValue()).trim()) {
            await input.fill('User');
        }
        await onboarding.locator('.popup-button-ok').click();
        await expect(onboarding).toBeHidden();
    }

    await page.evaluate(() => {
        const mainApi = document.querySelector('#main_api');
        mainApi.value = 'openai';
        mainApi.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const panel = page.locator('#left-nav-panel');
    if (!await panel.isVisible()) {
        await page.locator('#leftNavDrawerIcon').click();
    }
    await expect(panel).toBeVisible();
}

test.describe('Reasoning and Tool Calling browser integration', () => {
    test('disabled feature gate hides real controls without rewriting the saved recurse setting', async ({ page }) => {
        let enabled = true;
        await page.route('**/api/public-config/reasoning-tools', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ enabled, recurseHardLimit: 50 }),
        }));
        await testSetup.awaitST({ page });

        const sentinel = 17;
        const originalSetting = await page.evaluate(async () => {
            const { oai_settings } = await import('./scripts/openai.js');
            return oai_settings.tool_call_recurse_limit;
        });
        try {
            await page.evaluate(async value => {
                const { oai_settings } = await import('./scripts/openai.js');
                const { saveSettings } = await import('./script.js');
                oai_settings.tool_call_recurse_limit = value;
                await saveSettings();
            }, sentinel);

            enabled = false;
            await page.reload();
            await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });

            const result = await page.evaluate(async () => {
                const { oai_settings } = await import('./scripts/openai.js');
                const { isReasoningToolsEnabled } = await import('./scripts/reasoning-tools/feature-gate.js');
                return {
                    enabled: isReasoningToolsEnabled(),
                    recurse: oai_settings.tool_call_recurse_limit,
                    recurseHidden: document.querySelector('#tool_call_recurse_limit_block')?.classList.contains('displayNone'),
                    modeHidden: document.querySelector('#tool_reasoning_mode')?.closest('[data-feature="reasoningTools"]')?.classList.contains('displayNone'),
                };
            });

            expect(result.enabled).toBe(false);
            expect(result.recurse).toBe(sentinel);
            expect(result.recurseHidden).toBe(true);
            expect(result.modeHidden).toBe(true);
        } finally {
            await page.evaluate(async value => {
                const { oai_settings } = await import('./scripts/openai.js');
                const { saveSettings } = await import('./script.js');
                oai_settings.tool_call_recurse_limit = value;
                await saveSettings();
            }, originalSetting);
        }
    });

    test('real recurse and reasoning controls honor the gate and persist user input', async ({ page }) => {
        await routeReasoningToolsEnabled(page);
        await testSetup.awaitST({ page });

        const initial = await page.evaluate(async () => {
            const { oai_settings } = await import('./scripts/openai.js');
            const { isReasoningToolsEnabled } = await import('./scripts/reasoning-tools/feature-gate.js');
            return {
                enabled: isReasoningToolsEnabled(),
                recurse: oai_settings.tool_call_recurse_limit,
                mode: oai_settings.tool_reasoning_mode,
                mainApi: document.querySelector('#main_api').value,
                source: oai_settings.chat_completion_source,
                thoughts: oai_settings.show_thoughts,
                functionCalling: oai_settings.function_calling,
            };
        });
        expect(initial.enabled).toBe(true);

        try {
            await openAiResponseConfiguration(page);
            await page.evaluate(() => {
                const source = document.querySelector('#chat_completion_source');
                source.value = 'custom';
                source.dispatchEvent(new Event('change', { bubbles: true }));
                const tools = document.querySelector('#openai_function_calling');
                tools.checked = true;
                tools.dispatchEvent(new Event('input', { bubbles: true }));
                const thoughts = document.querySelector('#openai_show_thoughts');
                thoughts.checked = true;
                thoughts.dispatchEvent(new Event('input', { bubbles: true }));
            });

            const recurseBlock = page.locator('#tool_call_recurse_limit_block');
            await expect(recurseBlock).not.toHaveClass(/displayNone/);
            await expect(page.locator('#tool_call_recurse_limit')).toBeVisible();
            await page.locator('#tool_call_recurse_limit').fill('7');
            await page.locator('#tool_reasoning_mode').selectOption('active_chain');

            await expect.poll(() => page.evaluate(async () => {
                const { oai_settings } = await import('./scripts/openai.js');
                return [oai_settings.tool_call_recurse_limit, oai_settings.tool_reasoning_mode];
            })).toEqual([7, 'active_chain']);
            await page.evaluate(async () => {
                const { saveSettings } = await import('./script.js');
                await saveSettings();
            });

            await page.reload();
            await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
            await expect.poll(() => page.evaluate(async () => {
                const { oai_settings } = await import('./scripts/openai.js');
                return [oai_settings.tool_call_recurse_limit, oai_settings.tool_reasoning_mode];
            })).toEqual([7, 'active_chain']);
        } finally {
            await restoreOpenAiSettings(page, initial);
        }
    });

    test('mobile recurse and reasoning controls remain visible, bounded, and interactive', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await routeReasoningToolsEnabled(page);
        await testSetup.awaitST({ page });
        const initial = await page.evaluate(async () => {
            const { oai_settings } = await import('./scripts/openai.js');
            return {
                recurse: oai_settings.tool_call_recurse_limit,
                mode: oai_settings.tool_reasoning_mode,
                mainApi: document.querySelector('#main_api').value,
                source: oai_settings.chat_completion_source,
                thoughts: oai_settings.show_thoughts,
                functionCalling: oai_settings.function_calling,
            };
        });

        try {
            await openAiResponseConfiguration(page);
            await page.evaluate(() => {
                const source = document.querySelector('#chat_completion_source');
                source.value = 'custom';
                source.dispatchEvent(new Event('change', { bubbles: true }));
                const tools = document.querySelector('#openai_function_calling');
                tools.checked = true;
                tools.dispatchEvent(new Event('input', { bubbles: true }));
                const thoughts = document.querySelector('#openai_show_thoughts');
                thoughts.checked = true;
                thoughts.dispatchEvent(new Event('input', { bubbles: true }));
            });

            const slider = page.locator('#tool_call_recurse_limit');
            const counter = page.locator('#tool_call_recurse_limit_counter');
            const mode = page.locator('#tool_reasoning_mode');
            await expect(slider).toBeVisible();
            await expect(counter).toBeVisible();
            await expect(mode).toBeVisible();

            const bounds = await page.locator('#tool_call_recurse_limit_block').evaluate(element => ({
                left: element.getBoundingClientRect().left,
                right: element.getBoundingClientRect().right,
                viewport: document.documentElement.clientWidth,
                overflow: element.scrollWidth - element.clientWidth,
            }));
            expect(bounds.left).toBeGreaterThanOrEqual(0);
            expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
            expect(bounds.overflow).toBeLessThanOrEqual(1);

            await slider.fill('9');
            await mode.selectOption('since_last_user');
            await expect(counter).toHaveValue('9');
            await expect.poll(() => page.evaluate(async () => {
                const { oai_settings } = await import('./scripts/openai.js');
                return [oai_settings.tool_call_recurse_limit, oai_settings.tool_reasoning_mode];
            })).toEqual([9, 'since_last_user']);
        } finally {
            await restoreOpenAiSettings(page, initial);
        }
    });

    test('tool invocation protocol covers success, error, empty, stealth, and error:true', async ({ page }) => {
        await routeReasoningToolsEnabled(page);
        await testSetup.awaitST({ page });
        const result = await page.evaluate(async () => {
            const { ToolManager } = await import('./scripts/tool-calling.js');
            const prefix = `reasoning_test_${Date.now()}`;
            const names = {
                success: `${prefix}_success`,
                error: `${prefix}_error`,
                empty: `${prefix}_empty`,
                stealth: `${prefix}_stealth`,
                stealthError: `${prefix}_stealth_error`,
            };
            const register = (name, action, stealth = false) => ToolManager.registerFunctionTool({
                name,
                displayName: name,
                description: 'Reasoning protocol integration test',
                parameters: { type: 'object', properties: {} },
                action,
                formatMessage: () => '',
                shouldRegister: () => true,
                stealth,
            });
            register(names.success, () => ({ ok: true }));
            register(names.error, () => { throw new Error('expected failure'); });
            register(names.empty, () => undefined);
            register(names.stealth, () => 'hidden', true);
            register(names.stealthError, () => { throw new Error('hidden failure'); }, true);

            const toolCalls = Object.values(names).map((name, index) => ({
                id: `call_${index}`,
                type: 'function',
                function: { name, arguments: '' },
            }));
            try {
                const invocation = await ToolManager.invokeFunctionTools({
                    choices: [{ index: 0, message: { tool_calls: toolCalls } }],
                }, { reasoningText: 'editable current reasoning' });
                return {
                    invocations: invocation.invocations.map(item => ({
                        name: item.name,
                        result: item.result,
                        hasResult: Object.hasOwn(item, 'result'),
                        error: item.error,
                        reasoning: item.reasoning,
                    })),
                    errors: invocation.errors.map(error => error.toString()),
                    stealthCalls: invocation.stealthCalls,
                };
            } finally {
                Object.values(names).forEach(name => ToolManager.unregisterFunctionTool(name));
            }
        });

        expect(result.invocations).toHaveLength(3);
        expect(result.invocations.find(item => item.name.endsWith('_success'))).toMatchObject({
            result: '{"ok":true}', error: false, reasoning: 'editable current reasoning',
        });
        expect(result.invocations.find(item => item.name.endsWith('_error'))).toMatchObject({
            result: 'Error: expected failure', error: true, reasoning: 'editable current reasoning',
        });
        expect(result.invocations.find(item => item.name.endsWith('_empty'))).toMatchObject({
            hasResult: true, error: false, reasoning: 'editable current reasoning',
        });
        expect(result.errors).toEqual(expect.arrayContaining(['Error: expected failure', 'Error: hidden failure']));
        expect(result.stealthCalls).toHaveLength(2);
    });

    test('effective recursion uses validated user/default values and the instance minimum', async ({ page }) => {
        await routeReasoningToolsEnabled(page);
        await testSetup.awaitST({ page });
        const result = await page.evaluate(async () => {
            const { ToolManager } = await import('./scripts/tool-calling.js');
            const { normalizeRecurseLimit } = await import('./scripts/reasoning-tools/feature-gate.js');
            ToolManager.configureRecurseLimit(12, 4, true);
            const capped = ToolManager.getRecurseLimit();
            ToolManager.configureRecurseLimit(2, 40, true);
            const userLower = ToolManager.getRecurseLimit();
            ToolManager.configureRecurseLimit('invalid', 40, true);
            const defaulted = ToolManager.getRecurseLimit();
            ToolManager.configureRecurseLimit(12, 4, false);
            const legacy = ToolManager.getRecurseLimit();
            return {
                capped,
                userLower,
                defaulted,
                legacy,
                normalizedInvalid: normalizeRecurseLimit(0, 5),
            };
        });
        expect(result).toEqual({ capped: 4, userLower: 2, defaulted: 5, legacy: 5, normalizedInvalid: 5 });
    });

    test('multipart text/reasoning and OpenRouter streaming signatures retain all parts', async ({ page }) => {
        await routeReasoningToolsEnabled(page);
        await testSetup.awaitST({ page });
        const result = await page.evaluate(async () => {
            const { extractMessageFromData } = await import('./script.js');
            const { extractReasoningFromData } = await import('./scripts/reasoning.js');
            const { chat_completion_sources, getStreamingReply } = await import('./scripts/openai.js');
            const multipart = {
                content: [
                    { type: 'thinking', thinking: 'reason one' },
                    { type: 'text', text: 'text one' },
                    { type: 'thinking', thinking: 'reason two' },
                    { type: 'text', text: 'text two' },
                ],
            };
            const state = { reasoning: '', images: [], signature: '', toolSignatures: {} };
            getStreamingReply({
                choices: [{
                    delta: {
                        content: 'answer',
                        reasoning_content: 'stream reason',
                        reasoning_details: [
                            { type: 'reasoning.encrypted', id: 'call_123', data: 'tool-signature' },
                            { type: 'reasoning.encrypted', id: 'reasoning_123', data: 'message-signature' },
                        ],
                    },
                }],
            }, state, { chatCompletionSource: chat_completion_sources.OPENROUTER, overrideShowThoughts: true });
            return {
                text: extractMessageFromData(multipart, 'openai'),
                reasoning: extractReasoningFromData(multipart, {
                    mainApi: 'openai',
                    ignoreShowThoughts: true,
                    chatCompletionSource: chat_completion_sources.CLAUDE,
                }),
                state,
            };
        });
        expect(result.text).toBe('text one\n\ntext two');
        expect(result.reasoning).toBe('reason one\n\nreason two');
        expect(result.state.reasoning).toBe('stream reason');
        expect(result.state.signature).toBe('message-signature');
        expect(result.state.toolSignatures).toEqual({ call_123: 'tool-signature', reasoning_123: 'message-signature' });
    });

    test('StreamRenderBuffer coalesces intermediary frames and cancel prevents post-delete rendering', async ({ page }) => {
        await routeReasoningToolsEnabled(page);
        await testSetup.awaitST({ page });
        const events = await page.evaluate(async () => {
            const { StreamRenderBuffer } = await import('./scripts/util/stream-fadein.js');
            const order = [];
            const intermediary = new StreamRenderBuffer(0);
            intermediary.schedule(() => order.push('stale intermediary'));
            intermediary.schedule(() => order.push('latest intermediary'));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

            const deletion = new StreamRenderBuffer(0);
            deletion.schedule(() => order.push('render deleted message'));
            deletion.cancel();
            order.push('delete message');
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return order;
        });
        expect(events).toEqual(['latest intermediary', 'delete message']);
    });
});
