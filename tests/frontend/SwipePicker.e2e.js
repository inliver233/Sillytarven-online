import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

async function finishAccountOnboarding(page) {
    const onboarding = page.locator('dialog:visible').filter({ hasText: 'Welcome to SillyTavern!' });
    if (!await onboarding.count()) return;

    const personaName = onboarding.getByRole('textbox');
    await personaName.fill('default-user');
    await onboarding.getByText('Save', { exact: true }).click();
    await expect(onboarding).toBeHidden();
    await page.evaluate(async () => {
        const context = globalThis.SillyTavern.getContext();
        await context.getCharacters();
    });
}

async function installPickerFixture(page, swipeCount = 3) {
    await page.evaluate(async count => {
        const picker = await import('/scripts/swipe-picker.js');
        const { power_user } = await import('/scripts/power-user.js');
        power_user.confirm_message_delete = false;
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async text => { window.__swipePickerCopied = text; } },
        });

        const message = {
            mes: 'Swipe 1\nfull text',
            is_user: false,
            swipe_id: 0,
            swipes: Array.from({ length: count }, (_, index) => `Swipe ${index + 1}\nfull text`),
            swipe_info: Array.from({ length: count }, (_, index) => ({
                send_date: Date.now() - index * 1000,
                extra: index === 0 ? { token_count: 4 } : {},
            })),
            extra: {},
        };
        window.__swipePickerMessage = message;
        window.__swipePickerContextIdentity = {};
        window.__swipePickerJump = null;
        window.__swipePickerBranch = null;
        window.__swipePickerDelete = null;

        const chat = document.getElementById('chat');
        const fixture = document.createElement('div');
        fixture.className = 'mes last_mes';
        fixture.setAttribute('mesid', '0');
        fixture.innerHTML = '<div class="swipeRightBlock"><div role="button" tabindex="0" class="swipes-counter swipe-picker-enabled interactable">1 / 3</div></div>';
        chat.appendChild(fixture);

        await picker.initSwipePicker({
            enabled: true,
            getMessage: id => id === 0 ? message : null,
            ensureSwipes: () => false,
            canJumpToSwipe: () => true,
            resolveMessageIndex: localId => 120 + localId,
            resolveLocalMessageIndex: absoluteId => absoluteId === 120 ? 0 : null,
            getContextIdentity: () => window.__swipePickerContextIdentity,
            getTokenCount: async text => {
                await new Promise(resolve => setTimeout(resolve, 5));
                return text.length;
            },
            onDelete: ({ swipeId }) => {
                window.__swipePickerDelete = swipeId;
                message.swipes.splice(swipeId, 1);
                message.swipe_info.splice(swipeId, 1);
                if (message.swipe_id >= message.swipes.length) message.swipe_id = message.swipes.length - 1;
                return message.swipe_id;
            },
            onBranch: detail => {
                window.__swipePickerBranch = {
                    messageId: detail.messageId,
                    absoluteMessageId: detail.absoluteMessageId,
                    swipeId: detail.swipeId,
                    signalAborted: detail.signal.aborted,
                };
            },
            onJump: detail => {
                window.__swipePickerJump = {
                    messageId: detail.messageId,
                    absoluteMessageId: detail.absoluteMessageId,
                    swipeId: detail.swipeId,
                    direction: detail.direction,
                    source: detail.source,
                    signalAborted: detail.signal.aborted,
                };
            },
        });
    }, swipeCount);
}

async function postApp(page, route, body) {
    return page.evaluate(async ({ apiRoute, payload }) => {
        const context = globalThis.SillyTavern.getContext();
        const response = await fetch(apiRoute, {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify(payload),
        });
        const text = await response.text();
        let data = text;
        try {
            data = JSON.parse(text);
        } catch {
            // Some application endpoints return status-only responses.
        }
        return { status: response.status, ok: response.ok, data };
    }, { apiRoute: route, payload: body });
}

function readStoredSoloChat(dataRoot, avatarUrl, chatId) {
    const avatarDirectory = avatarUrl.replace(/\.png$/u, '');
    const filePath = path.join(dataRoot, 'default-user', 'chats', avatarDirectory, `${chatId}.jsonl`);
    const metadataPath = `${filePath}.metadata.json`;
    const indexPath = `${filePath}.index.json`;
    const revisionPath = `${filePath}.revision.json`;
    const header = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    let messages;
    let index = null;

    if (fs.existsSync(indexPath)) {
        index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        messages = index.shards.flatMap(shard => fs.readFileSync(path.join(`${filePath}.chunks`, shard.file), 'utf8')
            .split('\n').filter(Boolean).map(line => JSON.parse(line)));
    } else {
        messages = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).slice(1).map(line => JSON.parse(line));
    }

    return {
        filePath,
        header,
        messages,
        index,
        hasMetadata: fs.existsSync(metadataPath),
        hasRevision: fs.existsSync(revisionPath),
        hasChunks: fs.existsSync(`${filePath}.chunks`),
    };
}

async function deleteSoloChat(page, avatarUrl, chatId) {
    if (!chatId) return;
    await postApp(page, '/api/chats/delete', { avatar_url: avatarUrl, chatfile: chatId });
}

async function dispatchCounterTouch(page, type, { x = 20, y = 20 } = {}) {
    return page.evaluate(({ eventType, clientX, clientY }) => {
        const target = document.querySelector('#chat .mes[mesid="0"] .swipes-counter');
        const touch = new Touch({
            identifier: 7,
            target,
            clientX,
            clientY,
            screenX: clientX,
            screenY: clientY,
            pageX: clientX,
            pageY: clientY,
        });
        const ended = eventType === 'touchend' || eventType === 'touchcancel';
        const event = new TouchEvent(eventType, {
            bubbles: true,
            cancelable: true,
            touches: ended ? [] : [touch],
            targetTouches: ended ? [] : [touch],
            changedTouches: [touch],
        });
        return target.dispatchEvent(event);
    }, { eventType: type, clientX: x, clientY: y });
}

test.describe('Swipe Picker UI', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        await finishAccountOnboarding(page);
    });

    test('supports inspection, copy, expand, delete, branch, paging IDs, and keyboard jump', async ({ page }) => {
        const runtimeErrors = [];
        page.on('pageerror', error => runtimeErrors.push(`pageerror: ${error.stack ?? error.message}`));
        page.on('console', message => {
            if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`);
        });
        await installPickerFixture(page);
        const chatMessageCount = await page.locator('#chat .mes').count();
        const counter = page.locator('#chat .mes[mesid="0"] .swipes-counter');
        await counter.focus();
        await counter.press('Enter');

        const popup = page.locator('.swipe_picker_popup');
        await expect(popup).toBeVisible();
        await expect(popup.locator('.swipe_picker_block')).toHaveCount(3);
        await expect(popup.locator('.swipe_picker_block').first()).toHaveAttribute('aria-current', 'true');

        const firstBlock = popup.locator('.swipe_picker_block').first();
        await firstBlock.locator('.swipe_picker_copy').click();
        await expect.poll(() => page.evaluate(() => window.__swipePickerCopied)).toBe('Swipe 1\nfull text');

        const expand = firstBlock.locator('button.swipe_picker_expand');
        await expect(expand).toHaveAttribute('aria-label', 'Expand swipe 1');
        await expand.focus();
        await expand.press('Enter');
        await expect(expand).toHaveAttribute('aria-expanded', 'true');
        await expect(expand).toHaveAttribute('aria-label', 'Collapse swipe 1');
        await expect(firstBlock.locator('.select_chat_block_mes')).toHaveCSS('white-space', 'pre-wrap');

        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            power_user.confirm_message_delete = false;
        });
        const thirdBlock = popup.locator('.swipe_picker_block').nth(2);
        await thirdBlock.getByRole('button', { name: 'Select swipe 3' }).click();
        await expect(thirdBlock).toHaveAttribute('aria-current', 'true');
        await thirdBlock.getByRole('button', { name: 'Delete swipe 3' }).click();
        expect(runtimeErrors).toEqual([]);
        await expect.poll(() => page.evaluate(() => window.__swipePickerDelete)).toBe(2);
        await expect(popup.locator('.swipe_picker_block')).toHaveCount(2);
        await popup.locator('.swipe_picker_block').first().locator('.swipe_picker_branch').click();
        await expect(popup).toBeHidden();
        await expect.poll(() => page.evaluate(() => window.__swipePickerBranch)).toEqual({
            messageId: 0,
            absoluteMessageId: 120,
            swipeId: 0,
            signalAborted: false,
        });

        await counter.focus();
        await counter.press('Enter');
        await expect(popup).toBeVisible();
        await popup.locator('input[type="number"]').fill('2');
        await popup.locator('.popup-button-ok').click();
        await expect.poll(() => page.evaluate(() => window.__swipePickerJump)).toEqual({
            messageId: 0,
            absoluteMessageId: 120,
            swipeId: 1,
            direction: 'right',
            source: 'swipe_picker',
            signalAborted: false,
        });
        await expect(page.locator('#chat .mes')).toHaveCount(chatMessageCount);
        expect(runtimeErrors).toEqual([]);
    });

    test('chat context invalidation aborts an in-flight branch after its popup closes', async ({ page }) => {
        await installPickerFixture(page);
        await page.evaluate(async () => {
            const picker = await import('/scripts/swipe-picker.js');
            window.__swipePickerLifecycle = { started: false, aborted: false, settled: false };
            picker.configureSwipePicker({
                onBranch: ({ signal }) => {
                    window.__swipePickerLifecycle.started = true;
                    return new Promise(resolve => {
                        const onAbort = () => {
                            window.__swipePickerLifecycle.aborted = true;
                            window.__swipePickerLifecycle.settled = true;
                            resolve();
                        };
                        if (signal.aborted) onAbort();
                        else signal.addEventListener('abort', onAbort, { once: true });
                    });
                },
            });
        });

        const counter = page.locator('#chat .mes[mesid="0"] .swipes-counter');
        await counter.click();
        const popup = page.locator('.swipe_picker_popup');
        await expect(popup).toBeVisible();
        await popup.locator('.swipe_picker_branch').first().click();
        await expect(popup).toBeHidden();
        await expect.poll(() => page.evaluate(() => window.__swipePickerLifecycle.started)).toBe(true);

        await page.evaluate(async () => {
            const { eventSource, event_types } = await import('/scripts/events.js');
            await eventSource.emit(event_types.CHAT_CONTEXT_INVALIDATED, 'other-chat');
        });

        await expect.poll(() => page.evaluate(() => window.__swipePickerLifecycle)).toEqual({
            started: true,
            aborted: true,
            settled: true,
        });
    });

    test('yields while opening 500 swipes, caps live DOM, and cancels four-worker token work', async ({ page }) => {
        await page.evaluate(async () => {
            const picker = await import('/scripts/swipe-picker.js');
            await picker.initSwipePicker({ enabled: true });
            const message = {
                mes: 'Swipe 1',
                is_user: false,
                swipe_id: 0,
                swipes: Array.from({ length: 500 }, (_, index) => `Swipe ${index + 1}`),
                swipe_info: Array.from({ length: 500 }, () => null),
                extra: {},
            };
            window.__tokenStats = { active: 0, maxActive: 0, calls: 0 };
            window.__renderStats = { maxBlocks: 0, timerFired: false };
            window.__renderObserver = new MutationObserver(() => {
                const count = document.querySelectorAll('.swipe_picker_block').length;
                window.__renderStats.maxBlocks = Math.max(window.__renderStats.maxBlocks, count);
            });
            window.__renderObserver.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { window.__renderStats.timerFired = true; }, 0);

            picker.configureSwipePicker({
                getMessage: () => message,
                ensureSwipes: () => false,
                canJumpToSwipe: () => false,
                getTokenCount: async () => {
                    const stats = window.__tokenStats;
                    stats.calls++;
                    stats.active++;
                    stats.maxActive = Math.max(stats.maxActive, stats.active);
                    await new Promise(resolve => setTimeout(resolve, 30));
                    stats.active--;
                    return 2;
                },
            });
            window.__largePickerPromise = picker.openSwipePicker(0);
        });

        const popup = page.locator('.swipe_picker_popup');
        const blocks = popup.locator('.swipe_picker_block');
        await expect(popup).toBeVisible();
        await expect(blocks).toHaveCount(48);
        expect(await page.evaluate(() => window.__renderStats.timerFired)).toBe(true);
        expect(await page.evaluate(() => window.__renderStats.maxBlocks)).toBeLessThanOrEqual(48);

        const list = popup.locator('.swipe_picker_div');
        await page.evaluate(() => {
            window.__stableSwipeIdControl = document.querySelector('.swipe_picker_popup input[type="number"]');
        });
        await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await expect(popup.locator('.swipe_picker_block[data-swipe-id="499"]')).toHaveCount(1);
        await expect(blocks).toHaveCount(48);
        expect(await page.evaluate(() => document.querySelectorAll('.swipe_picker_block').length)).toBeLessThanOrEqual(48);
        expect(await page.evaluate(() => window.__stableSwipeIdControl
            === document.querySelector('.swipe_picker_popup input[type="number"]'))).toBe(true);

        await expect.poll(() => page.evaluate(() => window.__tokenStats.maxActive)).toBeGreaterThan(0);
        expect(await page.evaluate(() => window.__tokenStats.maxActive)).toBeLessThanOrEqual(4);

        await page.evaluate(() => document.dispatchEvent(new CustomEvent('swipe-picker:cancel', { detail: { reason: 'chat-switch' } })));
        await expect(popup).toBeHidden();
        await page.evaluate(() => window.__largePickerPromise);
        const callsAfterClose = await page.evaluate(() => window.__tokenStats.calls);
        await page.evaluate(ms => new Promise(resolve => setTimeout(resolve, ms)), 100);
        const stats = await page.evaluate(() => {
            window.__renderObserver.disconnect();
            return window.__tokenStats;
        });
        expect(stats.maxActive).toBeLessThanOrEqual(4);
        expect(stats.calls).toBe(callsAfterClose);
        expect(stats.calls).toBeLessThan(500);
    });
});

test.describe('Swipe Picker production adapter', () => {
    // Production setup and cleanup branch on persisted runtime state and storage layout.
    /* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect */
    test('branches an alternate swipe from a paged 1000-message solo chat without optimistic conflict mutation', async ({ page }, testInfo) => {
        // eslint-disable-next-line playwright/no-skipped-test
        test.skip(process.env.ST_SWIPE_PICKER_PRODUCTION_E2E !== '1', 'Requires the isolated production-adapter runtime.');
        test.setTimeout(120_000);

        const dataRoot = process.env.ST_TEST_DATA_ROOT;
        expect(dataRoot, 'ST_TEST_DATA_ROOT must identify the external runtime data directory').toBeTruthy();
        const runtimeErrors = [];
        page.on('pageerror', error => runtimeErrors.push(`pageerror: ${error.stack ?? error.message}`));
        page.on('console', message => {
            if (message.type() === 'error' && !message.text().includes('status of 409')) {
                runtimeErrors.push(`console: ${message.text()}`);
            }
        });
        page.on('response', response => {
            if (response.status() >= 500) runtimeErrors.push(`http ${response.status()}: ${response.url()}`);
        });

        await testSetup.awaitST({ page });
        await finishAccountOnboarding(page);
        const selected = await page.evaluate(async () => {
            let context = globalThis.SillyTavern.getContext();
            const characterId = context.characters.findIndex(character => character?.avatar && character.avatar !== 'none');
            if (characterId < 0) throw new Error('The default-user account has no selectable character.');
            if (String(context.characterId) !== String(characterId)) {
                await context.selectCharacterById(characterId, { switchMenu: false });
            }
            context = globalThis.SillyTavern.getContext();
            const character = context.characters[characterId];
            return {
                characterId,
                characterName: character.name,
                avatarUrl: character.avatar,
                originalChatId: context.getCurrentChatId() ?? null,
            };
        });

        const sourceChatId = `swipe-picker-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const currentText = 'production-current-swipe-999';
        const alternateText = 'production-alternate-swipe-999';
        const header = {
            user_name: 'default-user',
            character_name: selected.characterName,
            create_date: 'Swipe Picker production E2E',
            chat_metadata: { message_count: 1000, e2e: sourceChatId },
        };
        const messages = Array.from({ length: 1000 }, (_, index) => {
            const mes = `production-message-${String(index).padStart(4, '0')}`;
            const message = {
                name: index % 2 === 0 ? 'default-user' : selected.characterName,
                is_user: index % 2 === 0,
                send_date: 1_730_000_000_000 + index,
                mes,
                extra: { e2eIndex: index },
            };
            if (index === 999) {
                Object.assign(message, {
                    is_user: false,
                    mes: currentText,
                    swipe_id: 0,
                    swipes: [currentText, alternateText],
                    swipe_info: [
                        { send_date: 1_730_000_000_999, extra: { e2eIndex: 999 } },
                        { send_date: 1_730_000_001_000, extra: { e2eIndex: 999 } },
                    ],
                });
            }
            return message;
        });
        let destinationChatId = null;

        try {
            const saved = await postApp(page, '/api/chats/save', {
                avatar_url: selected.avatarUrl,
                ch_name: selected.characterName,
                file_name: sourceChatId,
                chat: [header, ...messages],
            });
            expect(saved.status).toBe(200);
            expect(saved.data.result).toBe('ok');

            await page.evaluate(chatId => globalThis.SillyTavern.getContext().openCharacterChat(chatId), sourceChatId);
            await expect.poll(() => page.evaluate(() => globalThis.SillyTavern.getContext().getCurrentChatId())).toBe(sourceChatId);
            await testSetup.awaitST({ page });
            if (await page.evaluate(() => globalThis.SillyTavern.getContext().getCurrentChatId()) !== sourceChatId) {
                await page.evaluate(async ({ characterId, chatId }) => {
                    const context = globalThis.SillyTavern.getContext();
                    if (String(context.characterId) !== String(characterId)) {
                        await context.selectCharacterById(characterId, { switchMenu: false });
                    }
                    await globalThis.SillyTavern.getContext().openCharacterChat(chatId);
                }, { characterId: selected.characterId, chatId: sourceChatId });
            }

            await expect.poll(() => page.evaluate(async () => {
                const context = globalThis.SillyTavern.getContext();
                const { getChatPagingState } = await import('/script.js');
                const paging = getChatPagingState();
                return {
                    chatId: context.getCurrentChatId(),
                    loaded: context.chat.length,
                    offset: paging.messageOffset,
                    active: paging.active,
                    first: context.chat[0]?.extra?.e2eIndex,
                    last: context.chat.at(-1)?.extra?.e2eIndex,
                };
            })).toEqual({ chatId: sourceChatId, loaded: 20, offset: 980, active: true, first: 980, last: 999 });
            await expect(page.locator('#chat .mes')).toHaveCount(20);

            const counter = page.locator('#chat .mes[mesid="19"] .swipes-counter.swipe-picker-enabled');
            await expect(counter).toBeVisible();
            await expect(counter).toContainText(/1[\s\u200B]*\/[\s\u200B]*2/u);

            const beforeConflict = await postApp(page, '/api/chats/get', {
                avatar_url: selected.avatarUrl,
                file_name: sourceChatId,
            });
            expect(beforeConflict.status).toBe(200);
            expect(beforeConflict.data).toHaveLength(1001);
            expect(beforeConflict.data.at(-1).extra.branches).toBeUndefined();

            const conflictHandler = async route => {
                const body = route.request().postDataJSON();
                await route.continue({ postData: JSON.stringify({ ...body, expectedRevision: 'forced-stale-e2e-revision' }) });
            };
            await page.route('**/api/chats/branch', conflictHandler);
            await counter.click();
            const picker = page.locator('.swipe_picker_popup');
            await expect(picker).toBeVisible();
            await expect(picker.locator('.swipe_picker_block[data-swipe-id="1"] .select_chat_block_mes')).toHaveText(alternateText);
            const conflictResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/chats/branch'));
            await picker.locator('.swipe_picker_block[data-swipe-id="1"] .swipe_picker_branch').click();
            expect((await conflictResponsePromise).status()).toBe(409);
            await expect(page.getByText(/No chat data was changed\./u)).toBeVisible();
            await page.locator('.popup-button-cancel:visible').click();
            await page.unroute('**/api/chats/branch', conflictHandler);

            const conflictState = await page.evaluate(() => {
                const context = globalThis.SillyTavern.getContext();
                const message = context.chat.at(-1);
                return {
                    chatId: context.getCurrentChatId(),
                    mes: message.mes,
                    swipeId: message.swipe_id,
                    branches: message.extra?.branches ?? [],
                };
            });
            expect(conflictState).toEqual({ chatId: sourceChatId, mes: currentText, swipeId: 0, branches: [] });
            const afterConflict = await postApp(page, '/api/chats/get', {
                avatar_url: selected.avatarUrl,
                file_name: sourceChatId,
            });
            expect(afterConflict.data.at(-1).mes).toBe(currentText);
            expect(afterConflict.data.at(-1).extra.branches).toBeUndefined();

            await counter.click();
            await expect(picker).toBeVisible();
            const branchResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/chats/branch'));
            await picker.locator('.swipe_picker_block[data-swipe-id="1"] .swipe_picker_branch').click();
            const branchResponse = await branchResponsePromise;
            const branchResult = await branchResponse.json();
            expect({ status: branchResponse.status(), body: branchResult }).toEqual(expect.objectContaining({ status: 201 }));
            destinationChatId = branchResult.chatId;
            expect(destinationChatId).toBeTruthy();
            await expect.poll(() => page.evaluate(() => globalThis.SillyTavern.getContext().getCurrentChatId())).toBe(destinationChatId);

            const sourceApi = await postApp(page, '/api/chats/get', {
                avatar_url: selected.avatarUrl,
                file_name: sourceChatId,
            });
            const destinationApi = await postApp(page, '/api/chats/get', {
                avatar_url: selected.avatarUrl,
                file_name: destinationChatId,
            });
            expect(sourceApi.data).toHaveLength(1001);
            expect(sourceApi.data.at(-1).mes).toBe(currentText);
            expect(sourceApi.data.at(-1).swipe_id).toBe(0);
            expect(sourceApi.data.at(-1).extra.branches).toContain(destinationChatId);
            expect(destinationApi.data).toHaveLength(1001);
            expect(destinationApi.data.slice(1).map(message => message.extra.e2eIndex)).toEqual(Array.from({ length: 1000 }, (_, index) => index));
            expect(destinationApi.data.at(-1).mes).toBe(alternateText);
            expect(destinationApi.data.at(-1).swipe_id).toBe(1);
            expect(destinationApi.data[0].chat_metadata.main_chat).toBe(sourceChatId);

            const sourceDisk = readStoredSoloChat(dataRoot, selected.avatarUrl, sourceChatId);
            const destinationDisk = readStoredSoloChat(dataRoot, selected.avatarUrl, destinationChatId);
            for (const stored of [sourceDisk, destinationDisk]) {
                expect(stored.hasMetadata).toBe(true);
                expect(stored.hasRevision).toBe(true);
                expect(stored.messages).toHaveLength(1000);
                if (stored.index) {
                    expect(stored.hasChunks).toBe(true);
                    expect(stored.index.message_count).toBe(1000);
                }
            }
            expect(sourceDisk.messages.at(-1).extra.branches).toContain(destinationChatId);
            expect(destinationDisk.messages.map(message => message.extra.e2eIndex)).toEqual(Array.from({ length: 1000 }, (_, index) => index));
            expect(destinationDisk.messages.at(-1).mes).toBe(alternateText);

            await testSetup.awaitST({ page });
            if (await page.evaluate(() => globalThis.SillyTavern.getContext().getCurrentChatId()) !== destinationChatId) {
                await page.evaluate(async ({ characterId, chatId }) => {
                    const context = globalThis.SillyTavern.getContext();
                    if (String(context.characterId) !== String(characterId)) {
                        await context.selectCharacterById(characterId, { switchMenu: false });
                    }
                    await globalThis.SillyTavern.getContext().openCharacterChat(chatId);
                }, { characterId: selected.characterId, chatId: destinationChatId });
            }
            await expect.poll(() => page.evaluate(() => globalThis.SillyTavern.getContext().getCurrentChatId())).toBe(destinationChatId);
            await expect.poll(() => page.evaluate(() => ({
                loaded: globalThis.SillyTavern.getContext().chat.length,
                first: globalThis.SillyTavern.getContext().chat[0]?.extra?.e2eIndex,
                last: globalThis.SillyTavern.getContext().chat.at(-1)?.extra?.e2eIndex,
                mes: globalThis.SillyTavern.getContext().chat.at(-1)?.mes,
            }))).toEqual({ loaded: 20, first: 980, last: 999, mes: alternateText });

            const refreshedFullPrefix = await postApp(page, '/api/chats/get', {
                avatar_url: selected.avatarUrl,
                file_name: destinationChatId,
            });
            expect(refreshedFullPrefix.data.slice(1).map(message => message.extra.e2eIndex))
                .toEqual(Array.from({ length: 1000 }, (_, index) => index));
            expect(runtimeErrors).toEqual([]);
        } finally {
            await testInfo.attach('production-runtime-errors', {
                body: Buffer.from(runtimeErrors.length ? runtimeErrors.join('\n') : 'none', 'utf8'),
                contentType: 'text/plain',
            });
            if (!page.isClosed()) {
                if (selected.originalChatId) {
                    await page.evaluate(chatId => globalThis.SillyTavern.getContext().openCharacterChat(chatId), selected.originalChatId).catch(() => {});
                }
                await deleteSoloChat(page, selected.avatarUrl, destinationChatId).catch(() => {});
                await deleteSoloChat(page, selected.avatarUrl, sourceChatId).catch(() => {});
            }
        }
    });
    /* eslint-enable playwright/no-conditional-in-test, playwright/no-conditional-expect */
});

test.describe('Swipe Picker mobile long press', () => {
    test.use({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
    });

    test('preserves short taps, cancels on movement, and suppresses native long-press events', async ({ page }) => {
        await testSetup.awaitST({ page });
        await finishAccountOnboarding(page);
        await installPickerFixture(page);
        const counter = page.locator('#chat .mes[mesid="0"] .swipes-counter');
        await page.evaluate(() => {
            window.__swipeCounterClicks = 0;
            document.querySelector('#chat .mes[mesid="0"] .swipes-counter')
                .addEventListener('click', () => window.__swipeCounterClicks++);
        });

        await counter.tap();
        await expect.poll(() => page.evaluate(() => window.__swipeCounterClicks)).toBe(1);
        await expect(page.locator('.swipe_picker_popup')).toHaveCount(0);

        await dispatchCounterTouch(page, 'touchstart');
        await dispatchCounterTouch(page, 'touchmove', { x: 45, y: 20 });
        await dispatchCounterTouch(page, 'touchend', { x: 45, y: 20 });
        await page.evaluate(ms => new Promise(resolve => setTimeout(resolve, ms)), 550);
        await expect(page.locator('.swipe_picker_popup')).toHaveCount(0);
        expect(await page.evaluate(() => {
            const target = document.querySelector('#chat .mes[mesid="0"] .swipes-counter');
            return target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        })).toBe(true);

        await dispatchCounterTouch(page, 'touchstart');
        await page.evaluate(ms => new Promise(resolve => setTimeout(resolve, ms)), 100);
        expect(await page.evaluate(() => {
            const target = document.querySelector('#chat .mes[mesid="0"] .swipes-counter');
            return target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        })).toBe(false);
        await page.evaluate(ms => new Promise(resolve => setTimeout(resolve, ms)), 450);

        const popup = page.locator('.swipe_picker_popup');
        await expect(popup).toBeVisible();
        expect(await dispatchCounterTouch(page, 'touchmove', { x: 21, y: 20 })).toBe(false);
        await dispatchCounterTouch(page, 'touchend', { x: 21, y: 20 });
        expect(await page.evaluate(() => {
            const target = document.querySelector('#chat .mes[mesid="0"] .swipes-counter');
            return target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        })).toBe(false);
        await expect.poll(() => page.evaluate(() => window.__swipeCounterClicks)).toBe(1);

        const box = await popup.boundingBox();
        expect(box).not.toBeNull();
        expect(box.width).toBeLessThanOrEqual(390);
        expect(box.height).toBeLessThanOrEqual(844);

        const actions = await popup.locator('.select_chat_actions').first().boundingBox();
        const text = await popup.locator('.select_chat_block_mes').first().boundingBox();
        expect(actions).not.toBeNull();
        expect(text).not.toBeNull();
        expect(actions.x + actions.width).toBeLessThanOrEqual(390);
        await popup.locator('.popup-button-close').click();
    });
});
