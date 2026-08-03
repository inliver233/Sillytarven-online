import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pickerPath = fileURLToPath(new URL('../public/scripts/swipe-picker.js', import.meta.url));
const gateUrl = new URL('../public/scripts/swipe-picker/feature-gate.js', import.meta.url);
const sessionUrl = new URL('../public/scripts/swipe-picker/session.js', import.meta.url);
const htmlPath = fileURLToPath(new URL('../public/index.html', import.meta.url));
const cssPath = fileURLToPath(new URL('../public/style.css', import.meta.url));
const constantsPath = fileURLToPath(new URL('../public/scripts/constants.js', import.meta.url));
const keyboardPath = fileURLToPath(new URL('../public/scripts/keyboard.js', import.meta.url));
const scriptPath = fileURLToPath(new URL('../public/script.js', import.meta.url));
const tokenizerPath = fileURLToPath(new URL('../public/scripts/tokenizers.js', import.meta.url));
const utilsPath = fileURLToPath(new URL('../public/scripts/utils.js', import.meta.url));

void root;

test('swipe picker feature gate enables only an explicit boolean true', async () => {
    const enabledGate = await import(`${gateUrl.href}?enabled`);
    const enabled = await enabledGate.loadSwipePickerFeatureGate(async input => {
        assert.equal(input, '/api/public-config/feature-flags');
        return { ok: true, json: async () => ({ swipePicker: true, privateValue: 'ignored' }) };
    });
    assert.equal(enabled, true);
    assert.equal(enabledGate.isSwipePickerAvailable(), true);

    const disabledGate = await import(`${gateUrl.href}?disabled`);
    const disabled = await disabledGate.loadSwipePickerFeatureGate(async () => ({
        ok: true,
        json: async () => ({ swipePicker: 'true' }),
    }));
    assert.equal(disabled, false);
    assert.equal(disabledGate.isSwipePickerAvailable(), false);
});

test('500-swipe render windows stay bounded at every scroll position', async () => {
    const { getSwipePickerRenderWindow, SWIPE_PICKER_DOM_LIMIT } = await import(sessionUrl.href);
    const starts = [0, 1, 24, 100, 251, 452, 499, 900];

    for (const startIndex of starts) {
        const window = getSwipePickerRenderWindow(500, { startIndex });
        assert.ok(window.start >= 0);
        assert.ok(window.end <= 500);
        assert.ok(window.end - window.start <= SWIPE_PICKER_DOM_LIMIT);
    }

    for (const selectedIndex of [0, 250, 499]) {
        const window = getSwipePickerRenderWindow(500, { selectedIndex });
        assert.ok(window.start <= selectedIndex && selectedIndex < window.end);
        assert.equal(window.end - window.start, SWIPE_PICKER_DOM_LIMIT);
    }
});

test('swipe picker keeps production actions behind adapters and fixes worker capacity', () => {
    const source = fs.readFileSync(pickerPath, 'utf8');
    assert.match(source, /const TOKEN_COUNT_CONCURRENCY = 4;/);
    assert.match(source, /runBoundedSwipeTasks/);
    assert.match(source, /session\.cancelWork\?\.\(\)/);
    assert.match(source, /swipe-picker:\$\{action\}/);
    assert.match(source, /absoluteMessageId/);
    assert.match(source, /resolveMessageIndex/);
    assert.doesNotMatch(source, /import .*branchChat/);
    assert.doesNotMatch(source, /import .* from ['"]\/script\.js['"]/);
    assert.doesNotMatch(source, /saveChat\s*\(/);
    assert.doesNotMatch(source, /Promise\.all\s*\(\s*message\.swipes/);
});

test('owned UI hooks preserve accessible picker controls and mobile layout', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const css = fs.readFileSync(cssPath, 'utf8');
    const constants = fs.readFileSync(constantsPath, 'utf8');
    const keyboard = fs.readFileSync(keyboardPath, 'utf8');
    const utils = fs.readFileSync(utilsPath, 'utf8');

    assert.match(html, /class="select_chat_actions flex-container gap10px"/);
    assert.match(html, /class="mes_button mes_swipe_picker fa-solid fa-bookmark"/);
    assert.match(html, /aria-label="Jump to swipe history"/);
    assert.match(html, /<div class="swipes-counter"><\/div>/);
    assert.match(css, /\.swipe_picker_row\s*\{[^}]*height: 110px;/s);
    assert.match(css, /\.swipe_picker_block\s*\{[^}]*height: 105px;/s);
    assert.match(css, /\.swipe_picker_block\[data-expanded="true"\][^{]*\{[^}]*overflow-y: auto;/s);
    assert.match(css, /white-space: pre-wrap/);
    assert.match(css, /@media screen and \(max-width: 600px\)/);
    assert.match(css, /\.swipe_picker_popup\.large_dialogue_popup/);
    assert.match(constants, /SWIPE_PICKER: 'swipe_picker'/);
    assert.doesNotMatch(keyboard, /\.swipe_picker_block, \.swipe_picker_action/);
    assert.match(utils, /export function addLongPressEvent/);
    assert.match(utils, /Math\.hypot/);
    assert.match(utils, /contextmenu/);
    assert.match(utils, /touchmove/);
    assert.match(utils, /stopImmediatePropagation/);
});

test('picker uses grouped rows, native action controls, and complete keyboard navigation', () => {
    const source = fs.readFileSync(pickerPath, 'utf8');
    const keyboard = fs.readFileSync(keyboardPath, 'utf8');

    assert.match(source, /listContainer\.setAttribute\('role', 'region'\)/);
    assert.match(source, /role: 'group'/);
    assert.doesNotMatch(source, /role: 'listbox'/);
    assert.doesNotMatch(source, /role: 'option'/);
    assert.doesNotMatch(source, /aria-selected/);

    for (const control of ['branchButton', 'deleteButton', 'expandButton', 'copyButton', 'selectButton']) {
        assert.match(source, new RegExp(`const ${control} = document\\.createElement\\('button'\\);`));
        assert.match(source, new RegExp(`${control}\\.type = 'button';`));
    }

    for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End', 'Enter']) {
        assert.match(source, new RegExp(`event\\.key === '${key}'`));
    }
    assert.match(source, /event\.target !== block\[0\]/);
    assert.match(source, /event\.key === ' '/);
    assert.match(source, /event\.key === 'Enter' && mobilePicker/);
    assert.match(keyboard, /target\?\.matches\('button, input, select, textarea, a\[href\], summary'\)/);
    assert.match(source, /aria-current/);
});

test('picker action resolver fails closed without an authoritative absolute message index', async () => {
    const { createSwipePickerActionResolver } = await import(sessionUrl.href);
    let localResolutionCalls = 0;
    const message = { swipes: ['a', 'b'] };
    const resolver = createSwipePickerActionResolver({
        message,
        messageId: 4,
        absoluteMessageId: null,
        getMessage: () => message,
        resolveLocalMessageIndex: () => {
            localResolutionCalls++;
            return 4;
        },
        signal: new AbortController().signal,
    });

    assert.equal(await resolver(1), null);
    assert.equal(localResolutionCalls, 0);

    const pickerSource = fs.readFileSync(pickerPath, 'utf8');
    const scriptSource = fs.readFileSync(scriptPath, 'utf8');
    assert.match(pickerSource, /!Number\.isSafeInteger\(absoluteMessageId\) \|\| absoluteMessageId < 0/);
    assert.match(scriptSource, /chatPagingState\.active\s*\? getAbsoluteMessageIndex\(messageId, chatPagingState\.messageOffset\)\s*:\s*messageId/s);
    assert.doesNotMatch(scriptSource, /getAbsoluteMessageIndex\(messageId, chatPagingState\.messageOffset\) \?\? messageId/);
});

test('tokenizer cancellation aborts the jqXHR and rejects with AbortError', async () => {
    const source = fs.readFileSync(tokenizerPath, 'utf8');
    const helperStart = source.indexOf('function getTokenizerAbortError');
    const helperEnd = source.indexOf('/**\n * Calls the underlying tokenizer model', helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart);

    let doneHandler;
    let failHandler;
    let abortCalls = 0;
    let ajaxCalls = 0;
    const request = {
        done(handler) {
            doneHandler = handler;
            return this;
        },
        fail(handler) {
            failHandler = handler;
            return this;
        },
        abort() {
            abortCalls++;
            failHandler?.({}, 'abort');
        },
    };
    const jQuery = {
        ajax: () => {
            ajaxCalls++;
            return request;
        },
    };
    const factory = new Function('jQuery', `${source.slice(helperStart, helperEnd)}\nreturn tokenizerAjax;`);
    const tokenizerAjax = factory(jQuery);
    const controller = new AbortController();
    const pending = tokenizerAjax({ url: '/api/tokenizers/llama/count' }, controller.signal);
    controller.abort('picker-closed');

    await assert.rejects(pending, error => error?.name === 'AbortError');
    assert.equal(ajaxCalls, 1);
    assert.equal(abortCalls, 1);
    assert.equal(doneHandler instanceof Function, true);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(async () => tokenizerAjax({}, alreadyAborted.signal), error => error?.name === 'AbortError');
    assert.equal(ajaxCalls, 1);
    assert.match(source, /getTokenCountAsync\(str, padding = undefined, \{ signal \} = \{\}\)/);
    assert.match(source, /requestTokenCountAsync\(endpointUrl, \{ text: str \}, str, \{ signal \}\)/);
});
