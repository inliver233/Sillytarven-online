import { SWIPE_DIRECTION, SWIPE_SOURCE } from './constants.js';
import { event_types, eventSource } from './events.js';
import { t } from './i18n.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { power_user } from './power-user.js';
import { isMobile } from './RossAscends-mods.js';
import { loadSwipePickerFeatureGate } from './swipe-picker/feature-gate.js';
import { createSwipePickerActionResolver, getSwipePickerRenderWindow, SWIPE_PICKER_DOM_LIMIT } from './swipe-picker/session.js';
import { getTokenCountAsync } from './tokenizers.js';
import { addLongPressEvent, clamp, copyText, timestampToMoment } from './utils.js';

const TOKEN_COUNT_CONCURRENCY = 4;
const SWIPE_RENDER_BATCH_SIZE = 8;
const SWIPE_VIRTUAL_ROW_HEIGHT = 110;
const SWIPE_PICKER_SELECTOR = '.swipes-counter.swipe-picker-enabled';

/**
 * @typedef {object} SwipePickerDependencies
 * @property {(messageId: number) => object|null|undefined} getMessage
 * @property {(message: object, messageId: number) => boolean} [ensureSwipes]
 * @property {(messageId: number) => void} [syncMesToSwipe]
 * @property {(messageId: number, message: object) => boolean} [canJumpToSwipe]
 * @property {(messageId: number, message: object) => number|Promise<number>} [resolveMessageIndex]
 * @property {(absoluteMessageId: number, message: object) => number|null|Promise<number|null>} [resolveLocalMessageIndex]
 * @property {() => unknown} [getContextIdentity]
 * @property {(detail: object) => unknown|Promise<unknown>} [onJump]
 * @property {(detail: object) => unknown|Promise<unknown>} [onDelete]
 * @property {(detail: object) => unknown|Promise<unknown>} [onBranch]
 * @property {(text: string, padding: number, options?: {signal?: AbortSignal}) => Promise<number>} [getTokenCount]
 */

/** @type {SwipePickerDependencies} */
let dependencies = {
    getMessage: messageId => globalThis.SillyTavern?.getContext?.().chat?.[messageId] ?? null,
    ensureSwipes: ensureMessageSwipes,
    syncMesToSwipe: () => {},
    canJumpToSwipe: () => false,
    resolveMessageIndex: messageId => messageId,
    resolveLocalMessageIndex: absoluteMessageId => absoluteMessageId,
    getContextIdentity: () => null,
    getTokenCount: getTokenCountAsync,
};

let initialized = false;
let activeSession = null;

/**
 * Supplies chat and persistence adapters without coupling the picker to saveChat or branch storage.
 * @param {Partial<SwipePickerDependencies>} overrides
 */
export function configureSwipePicker(overrides = {}) {
    dependencies = { ...dependencies, ...overrides };
}

/**
 * Lazily normalizes legacy swipe fields in memory. No persistence is triggered here.
 * @param {object} message
 * @returns {boolean}
 */
export function ensureMessageSwipes(message) {
    if (!message || typeof message !== 'object') {
        return false;
    }

    let changed = false;
    if (!Array.isArray(message.swipes) || message.swipes.length === 0) {
        message.swipes = [String(message.mes ?? '')];
        changed = true;
    }

    const swipeId = clamp(Number.isInteger(message.swipe_id) ? message.swipe_id : 0, 0, message.swipes.length - 1);
    if (message.swipe_id !== swipeId) {
        message.swipe_id = swipeId;
        changed = true;
    }

    if (!Array.isArray(message.swipe_info)) {
        message.swipe_info = [];
        changed = true;
    }
    while (message.swipe_info.length < message.swipes.length) {
        message.swipe_info.push(null);
        changed = true;
    }
    if (message.swipe_info.length > message.swipes.length) {
        message.swipe_info.length = message.swipes.length;
        changed = true;
    }

    return changed;
}

/**
 * Runs work with bounded concurrency and stops scheduling after cancellation.
 * Already-running work is allowed to settle, but its result is discarded.
 * @template T,R
 * @param {T[]} items
 * @param {(item: T, index: number, signal: AbortSignal) => Promise<R>} worker
 * @param {(result: R, item: T, index: number) => void} onResult
 * @param {{concurrency?: number, signal?: AbortSignal, onError?: (error: unknown, item: T, index: number) => void}} [options]
 * @returns {{done: Promise<void>, cancel: () => void, signal: AbortSignal}}
 */
export function runBoundedSwipeTasks(items, worker, onResult, { concurrency = TOKEN_COUNT_CONCURRENCY, signal, onError = console.warn } = {}) {
    const controller = new AbortController();
    const maxConcurrency = Math.min(TOKEN_COUNT_CONCURRENCY, Math.max(1, items.length));
    const limit = clamp(Math.trunc(Number(concurrency) || 1), 1, maxConcurrency);
    let nextIndex = 0;

    if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }

    async function consume() {
        while (!controller.signal.aborted) {
            const index = nextIndex++;
            if (index >= items.length) return;
            try {
                const result = await worker(items[index], index, controller.signal);
                if (!controller.signal.aborted) onResult(result, items[index], index);
            } catch (error) {
                if (!controller.signal.aborted) onError(error, items[index], index);
            }
        }
    }

    const done = Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume)).then(() => undefined);
    return {
        done,
        cancel: () => controller.abort(),
        signal: controller.signal,
    };
}

/**
 * Returns whether the picker can inspect the requested loaded message.
 * @param {number} messageId Local index in the currently loaded contiguous chat suffix
 * @returns {boolean}
 */
export function canOpenSwipePickerForMessage(messageId) {
    const message = dependencies.getMessage(messageId);
    if (!message) return false;

    if (dependencies.ensureSwipes?.(message, messageId)) {
        dependencies.syncMesToSwipe?.(messageId);
    }

    return Boolean(
        message.swipes?.length > 1
        && !message.is_user
        && !message.extra?.isSmallSys
        && message.extra?.swipeable !== false,
    );
}

/**
 * Returns whether the integration permits changing the active swipe.
 * @param {number} messageId
 * @returns {boolean}
 */
export function canJumpToSwipeForMessage(messageId) {
    const message = dependencies.getMessage(messageId);
    return Boolean(canOpenSwipePickerForMessage(messageId) && dependencies.canJumpToSwipe?.(messageId, message));
}

/**
 * Cancels token work and closes the active picker. Integration should call this before chat switches.
 * @param {string} [reason]
 */
export function cancelSwipePicker(reason = 'cancelled') {
    const session = activeSession;
    if (!session) return;
    session.controller.abort(reason);
    session.cancelWork?.();
    if (session.popup) void session.popup.completeCancelled();
}

/**
 * Opens the swipe picker for a local, currently loaded message index.
 * @param {number} messageId
 * @returns {Promise<void>}
 */
export async function openSwipePicker(messageId) {
    if (!canOpenSwipePickerForMessage(messageId)) {
        toastr.info(t`This message has no alternate swipes yet.`, t`Jump to Swipe`);
        return;
    }

    cancelSwipePicker('replaced');
    const message = dependencies.getMessage(messageId);
    const canJumpToSwipe = canJumpToSwipeForMessage(messageId);
    const contextIdentity = dependencies.getContextIdentity?.();
    const session = {
        controller: new AbortController(),
        popup: null,
        tokenTasks: null,
        tokenDrain: Promise.resolve(),
        cancelWork: null,
        actionPromises: new Set(),
    };
    activeSession = session;

    const absoluteMessageId = await dependencies.resolveMessageIndex(messageId, message);
    if (session.controller.signal.aborted
        || (typeof dependencies.getContextIdentity === 'function'
            && !Object.is(dependencies.getContextIdentity(), contextIdentity))) {
        if (activeSession === session) activeSession = null;
        return;
    }
    if (!Number.isSafeInteger(absoluteMessageId) || absoluteMessageId < 0) {
        if (activeSession === session) activeSession = null;
        toastr.error(t`Reload the chat before using swipe history.`, t`Message position is unavailable`);
        return;
    }

    const resolveAction = createSwipePickerActionResolver({
        message,
        messageId,
        absoluteMessageId,
        getMessage: dependencies.getMessage,
        resolveLocalMessageIndex: dependencies.resolveLocalMessageIndex,
        getContextIdentity: dependencies.getContextIdentity,
        contextIdentity,
        canJumpToSwipe: dependencies.canJumpToSwipe,
        signal: session.controller.signal,
    });
    let selectedSwipeId = clamp(Number(message.swipe_id ?? 0), 0, message.swipes.length - 1);
    let renderVersion = 0;
    let branchActionSwipeId = null;
    let swipeIdInput;

    const wrapper = document.createElement('div');
    wrapper.classList.add('swipe_picker_content', 'flex-container', 'flexFlowColumn', 'flexNoGap', 'wide100p', 'flex1', 'overflowHidden');
    const header = document.createElement('div');
    header.classList.add('swipe_picker_header', 'flex-container', 'alignItemsCenter', 'justifySpaceBetween', 'gap10px');
    const heading = document.createElement('h3');
    heading.classList.add('margin0', 'justifyLeft');
    const headingId = `swipe_picker_heading_${messageId}`;
    heading.id = headingId;
    heading.textContent = t`Swipe Selection`;
    header.appendChild(heading);
    wrapper.appendChild(header);

    const listContainer = document.createElement('div');
    listContainer.classList.add('swipe_picker_div', 'flex1', 'marginTop10');
    listContainer.setAttribute('role', 'region');
    listContainer.setAttribute('aria-labelledby', headingId);
    wrapper.appendChild(listContainer);

    async function actionDetail(swipeId, { requireJump = false } = {}) {
        const detail = await resolveAction(swipeId, { requireJump });
        if (!detail) {
            toastr.warning(
                requireJump ? t`Swiping is unavailable right now.` : t`The source message is no longer loaded.`,
                t`Swipe Selection`,
            );
        }
        return detail;
    }

    function syncSwipeIdInput() {
        if (swipeIdInput instanceof HTMLInputElement) swipeIdInput.value = String(selectedSwipeId + 1);
    }

    function setSelectedSwipe(nextSwipeId) {
        selectedSwipeId = clamp(Number(nextSwipeId), 0, message.swipes.length - 1);
        listContainer.querySelectorAll('.swipe_picker_block').forEach(element => {
            const selected = Number(element.dataset.swipeId) === selectedSwipeId;
            element.toggleAttribute('highlight', selected);
            element.setAttribute('aria-current', selected ? 'true' : 'false');
        });
        syncSwipeIdInput();
    }

    function scrollToSelectedSwipe() {
        const block = listContainer.querySelector(`.swipe_picker_block[data-swipe-id="${selectedSwipeId}"]`);
        if (!(block instanceof HTMLElement)) return;
        const blockRect = block.getBoundingClientRect();
        const parentRect = listContainer.getBoundingClientRect();
        if (blockRect.top < parentRect.top) listContainer.scrollTop -= (parentRect.top - blockRect.top) + 5;
        else if (blockRect.bottom > parentRect.bottom) listContainer.scrollTop += (blockRect.bottom - parentRect.bottom) + 5;
    }

    function canDeleteSwipe(swipeId) {
        if (message.swipes.length <= 1) return false;
        const currentSwipeId = clamp(Number(message.swipe_id ?? 0), 0, message.swipes.length - 1);
        return canJumpToSwipe || swipeId !== currentSwipeId;
    }

    let currentRenderStart = 0;
    let virtualScrollFrame = null;

    function cancelTokenWork() {
        const tokenTasks = session.tokenTasks;
        tokenTasks?.cancel();
        if (tokenTasks) session.tokenDrain = tokenTasks.done;
        session.tokenTasks = null;
    }

    function cancelRenderWork() {
        renderVersion++;
        cancelTokenWork();
        if (virtualScrollFrame !== null) {
            cancelAnimationFrame(virtualScrollFrame);
            virtualScrollFrame = null;
        }
    }
    session.cancelWork = cancelRenderWork;

    async function renderSwipeList(startIndex = null) {
        const version = ++renderVersion;
        cancelTokenWork();
        const tokenItems = [];
        const previousScrollTop = listContainer.scrollTop;
        const { start, end } = getSwipePickerRenderWindow(message.swipes.length, {
            selectedIndex: selectedSwipeId,
            startIndex,
            limit: SWIPE_PICKER_DOM_LIMIT,
        });
        currentRenderStart = start;
        const fragment = document.createDocumentFragment();
        const topSpacer = document.createElement('div');
        topSpacer.classList.add('swipe_picker_virtual_spacer');
        topSpacer.style.height = `${start * SWIPE_VIRTUAL_ROW_HEIGHT}px`;
        topSpacer.setAttribute('aria-hidden', 'true');
        fragment.appendChild(topSpacer);

        for (let index = start; index < end; index++) {
            if (session.controller.signal.aborted || version !== renderVersion) return;
            const swipe = message.swipes[index];
            const swipeText = String(swipe ?? '');
            const previewText = swipeText.replace(/\s+/g, ' ').trim();
            const swipeInfo = message.swipe_info?.[index] ?? null;
            const template = $('#past_chat_template .select_chat_block_wrapper').first().clone();
            template.addClass('swipe_picker_row');
            const block = template.find('.select_chat_block');
            block.removeClass('select_chat_block').addClass('swipe_picker_block');
            block.removeAttr('file_name').attr({
                'data-swipe-id': index,
                role: 'group',
                tabindex: '0',
                'aria-current': 'false',
                'aria-label': t`Swipe ${index + 1}`,
            });
            block.find('[id]').removeAttr('id');
            block.find('.select_chat_actions').removeClass('gap10px');
            template.find('.renameChatButton, .exportChatButton').remove();

            const branchSource = template.find('.exportRawChatButton')[0];
            const branchButton = document.createElement('button');
            branchButton.type = 'button';
            branchButton.className = branchSource.className;
            branchSource.replaceWith(branchButton);
            $(branchButton).removeAttr('data-format').attr({
                title: t`Create Branch`,
                'aria-label': t`Create Branch from swipe ${index + 1}`,
                'data-i18n': '[title]Create Branch',
            }).removeClass('exportRawChatButton fa-solid fa-file-export')
                .addClass('swipe_picker_action swipe_picker_branch mes_button fa-fw fa-regular fa-code-branch')
                .on('click', async event => {
                    event.preventDefault();
                    event.stopPropagation();
                    setSelectedSwipe(index);
                    branchActionSwipeId = index;
                    await session.popup.completeCancelled();
                });

            const deleteSource = template.find('.PastChat_cross')[0];
            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = deleteSource.className;
            deleteSource.replaceWith(deleteButton);
            const deletable = canDeleteSwipe(index);
            deleteButton.disabled = !deletable;
            $(deleteButton).removeAttr('file_name').attr({
                'aria-label': deletable ? t`Delete swipe ${index + 1}` : t`Delete swipe ${index + 1} unavailable`,
            }).removeClass('fa-skull').addClass('swipe_picker_action swipe_picker_delete fa-fw fa-trash-can')
                .toggleClass('hoverglow', deletable).toggleClass('disabled', !deletable).off('click')
                .on('click', async event => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!deletable || session.controller.signal.aborted) return;

                    if (power_user.confirm_message_delete) {
                        const result = await callGenericPopup(t`Are you sure you want to delete swipe #${index + 1}?`, POPUP_TYPE.CONFIRM, null, {
                            okButton: t`Delete Swipe`,
                            cancelButton: t`Cancel`,
                        });
                        if (result !== POPUP_RESULT.AFFIRMATIVE) return;
                    }

                    const nextSelected = index < selectedSwipeId
                        ? selectedSwipeId - 1
                        : index > selectedSwipeId ? selectedSwipeId : Math.min(selectedSwipeId, message.swipes.length - 2);
                    const detail = await actionDetail(index);
                    if (!detail) return;
                    const result = await invokeSessionAction('delete', detail, dependencies.onDelete);
                    if (session.controller.signal.aborted || !Number.isInteger(normalizeSwipeResult(result))) return;
                    selectedSwipeId = clamp(nextSelected, 0, message.swipes.length - 1);
                    if (swipeIdInput instanceof HTMLInputElement) swipeIdInput.max = String(message.swipes.length);
                    if (session.popup !== popup) return;
                    await renderSwipeList();
                });

            const messageTextId = `swipe_picker_text_${messageId}_${index}`;
            const expandButton = document.createElement('button');
            expandButton.type = 'button';
            expandButton.classList.add('swipe_picker_action', 'swipe_picker_expand', 'fa-solid', 'fa-fw', 'fa-chevron-down');
            expandButton.title = t`Expand/Collapse`;
            expandButton.setAttribute('aria-label', t`Expand swipe ${index + 1}`);
            expandButton.setAttribute('aria-controls', messageTextId);
            expandButton.setAttribute('aria-expanded', 'false');
            expandButton.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                const expanded = expandButton.getAttribute('aria-expanded') !== 'true';
                expandButton.setAttribute('aria-expanded', String(expanded));
                expandButton.setAttribute('aria-label', expanded ? t`Collapse swipe ${index + 1}` : t`Expand swipe ${index + 1}`);
                block.attr('data-expanded', String(expanded));
            });

            const copyButton = document.createElement('button');
            copyButton.type = 'button';
            copyButton.classList.add('swipe_picker_action', 'swipe_picker_copy', 'mes_button', 'fa-solid', 'fa-fw', 'fa-copy');
            copyButton.title = t`Copy`;
            copyButton.setAttribute('aria-label', t`Copy swipe ${index + 1}`);
            copyButton.addEventListener('click', async event => {
                event.preventDefault();
                event.stopPropagation();
                await copyText(swipeText);
                toastr.info(t`Copied!`, '', { timeOut: 2000 });
            });
            const selectButton = document.createElement('button');
            selectButton.type = 'button';
            selectButton.classList.add('swipe_picker_action', 'swipe_picker_select', 'mes_button', 'fa-solid', 'fa-fw', 'fa-check');
            selectButton.title = t`Select Swipe`;
            selectButton.setAttribute('aria-label', t`Select swipe ${index + 1}`);
            selectButton.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                setSelectedSwipe(index);
                block.trigger('focus');
            });
            $(branchButton).before(selectButton, expandButton, copyButton);

            const current = index === Number(message.swipe_id ?? 0) ? ` ${t`[Current]`}` : '';
            template.find('.select_chat_block_filename').text(`#${index + 1}${current}`);
            template.find('.chat_messages_date').text(swipeInfo?.send_date ? timestampToMoment(swipeInfo.send_date).format('lll') : '');
            template.find('.chat_file_size').text(previewText ? `(${previewText.length} ${t`chars`},` : '');
            const tokenElement = template.find('.chat_messages_num');
            const cachedTokenCount = swipeInfo?.extra?.token_count;
            tokenElement.text(Number.isFinite(cachedTokenCount) && cachedTokenCount > 0 ? ` ${cachedTokenCount}t)` : previewText ? ` ${t`counting...`})` : '');
            const messageText = template.find('.select_chat_block_mes');
            messageText.attr('id', messageTextId).text(previewText ? swipeText : t`(empty swipe)`);

            block.on('click', () => setSelectedSwipe(index));
            block.on('keydown', async event => {
                if (event.target !== block[0]) return;

                let nextSwipeId = null;
                if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextSwipeId = selectedSwipeId + 1;
                else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextSwipeId = selectedSwipeId - 1;
                else if (event.key === 'Home') nextSwipeId = 0;
                else if (event.key === 'End') nextSwipeId = message.swipes.length - 1;
                else if (event.key === 'Enter' || event.key === ' ') nextSwipeId = index;
                if (nextSwipeId === null) return;

                event.preventDefault();
                event.stopPropagation();
                setSelectedSwipe(nextSwipeId);
                let selectedBlock = listContainer.querySelector(`.swipe_picker_block[data-swipe-id="${selectedSwipeId}"]`);
                if (!(selectedBlock instanceof HTMLElement)) {
                    listContainer.scrollTop = selectedSwipeId * SWIPE_VIRTUAL_ROW_HEIGHT;
                    await renderSwipeList(selectedSwipeId);
                    selectedBlock = listContainer.querySelector(`.swipe_picker_block[data-swipe-id="${selectedSwipeId}"]`);
                }
                scrollToSelectedSwipe();
                selectedBlock?.focus();
            });
            block.on('dblclick', async () => {
                if (!canJumpToSwipe) return;
                setSelectedSwipe(index);
                await session.popup.completeAffirmative();
            });

            if (previewText && !(Number.isFinite(cachedTokenCount) && cachedTokenCount > 0)) {
                tokenItems.push({ swipeText, tokenElement: tokenElement[0] });
            }
            fragment.appendChild(template[0]);
            if ((index - start + 1) % SWIPE_RENDER_BATCH_SIZE === 0 && index + 1 < end) {
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
        }

        if (session.controller.signal.aborted || version !== renderVersion) return;
        const bottomSpacer = document.createElement('div');
        bottomSpacer.classList.add('swipe_picker_virtual_spacer');
        bottomSpacer.style.height = `${Math.max(0, message.swipes.length - end) * SWIPE_VIRTUAL_ROW_HEIGHT}px`;
        bottomSpacer.setAttribute('aria-hidden', 'true');
        fragment.appendChild(bottomSpacer);
        listContainer.replaceChildren(fragment);
        if (startIndex !== null) listContainer.scrollTop = previousScrollTop;
        setSelectedSwipe(selectedSwipeId);
        if (!message.swipes.length) {
            const empty = document.createElement('div');
            empty.classList.add('textAlignCenter', 'opacity50p', 'padding10');
            empty.textContent = t`No swipes available.`;
            listContainer.replaceChildren(empty);
            return;
        }

        await session.tokenDrain;
        if (session.controller.signal.aborted || version !== renderVersion) return;
        session.tokenTasks = runBoundedSwipeTasks(tokenItems,
            (item, _index, signal) => dependencies.getTokenCount(item.swipeText, 0, { signal }),
            (tokenCount, item) => {
                if (version !== renderVersion || !item.tokenElement.isConnected) return;
                item.tokenElement.textContent = Number(tokenCount) > 0 ? ` ${tokenCount}t)` : ')';
            }, {
                concurrency: TOKEN_COUNT_CONCURRENCY,
                signal: session.controller.signal,
                onError: (error, item) => {
                    if (version === renderVersion && item.tokenElement.isConnected) item.tokenElement.textContent = ')';
                    console.warn('Swipe token count failed.', error);
                },
            });
        session.tokenDrain = session.tokenTasks.done;
    }

    listContainer.addEventListener('scroll', () => {
        if (virtualScrollFrame !== null) cancelAnimationFrame(virtualScrollFrame);
        virtualScrollFrame = requestAnimationFrame(() => {
            virtualScrollFrame = null;
            const requestedStart = Math.max(0, Math.floor(listContainer.scrollTop / SWIPE_VIRTUAL_ROW_HEIGHT));
            const { start } = getSwipePickerRenderWindow(message.swipes.length, {
                selectedIndex: selectedSwipeId,
                startIndex: requestedStart,
            });
            if (start !== currentRenderStart) void renderSwipeList(start);
        });
    });

    const swipeIdInputId = `swipe_picker_id_${messageId}`;
    const popup = new Popup(wrapper, POPUP_TYPE.CONFIRM, '', {
        okButton: canJumpToSwipe ? t`Go` : false,
        cancelButton: false,
        customInputs: [{
            id: swipeIdInputId,
            label: t`Swipe ID`,
            type: 'text',
            defaultState: String(selectedSwipeId + 1),
            tooltip: `1-${message.swipes.length}`,
        }],
        large: true,
        wider: true,
        allowVerticalScrolling: true,
        onOpen: () => {
            scrollToSelectedSwipe();
            if (swipeIdInput instanceof HTMLInputElement) {
                swipeIdInput.focus();
                swipeIdInput.select();
            }
        },
        onClosing: closingPopup => {
            if (closingPopup.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            const input = closingPopup.dlg.querySelector(`#${swipeIdInputId}`);
            const targetNumber = Number.parseInt(input instanceof HTMLInputElement ? input.value.trim() : '', 10);
            if (!Number.isInteger(targetNumber) || targetNumber < 1 || targetNumber > message.swipes.length) {
                toastr.warning(t`Enter a swipe ID between 1 and ${message.swipes.length}.`, t`Jump to Swipe`);
                if (input instanceof HTMLInputElement) {
                    input.focus();
                    input.select();
                }
                return false;
            }
            setSelectedSwipe(targetNumber - 1);
            return true;
        },
        onClose: cancelRenderWork,
    });
    session.popup = popup;
    popup.dlg.classList.add('swipe_picker_popup');
    popup.closeButton.style.display = 'block';
    popup.closeButton.classList.add('opacity50p', 'hoverglow', 'fontsize120p');
    popup.closeButton.style.cssText += 'position:static;top:auto;right:auto;width:auto;height:auto;padding:0;filter:none;';
    popup.closeButton.setAttribute('aria-label', t`Close`);
    header.appendChild(popup.closeButton);

    swipeIdInput = popup.dlg.querySelector(`#${swipeIdInputId}`);
    const swipeIdLabel = popup.dlg.querySelector(`label[for="${swipeIdInputId}"]`);
    if (swipeIdLabel instanceof HTMLLabelElement) {
        swipeIdLabel.classList.add('swipe_picker_id_label', 'flex-container', 'alignItemsCenter', 'justifyCenter', 'gap10px', 'margin0');
        popup.buttonControls.insertBefore(swipeIdLabel, canJumpToSwipe ? popup.okButton : popup.buttonControls.firstChild);
        popup.inputControls.style.display = 'none';
    }
    if (swipeIdInput instanceof HTMLInputElement) {
        Object.assign(swipeIdInput, { type: 'number', min: '1', max: String(message.swipes.length), step: '1', inputMode: 'numeric' });
        swipeIdInput.classList.add('flex1', 'width100px', 'textAlignCenter');
        swipeIdInput.setAttribute('autofocus', '');
        syncSwipeIdInput();
        swipeIdInput.addEventListener('input', async function () {
            const next = Number.parseInt(this.value, 10);
            if (!Number.isInteger(next) || next < 1 || next > message.swipes.length) return;
            setSelectedSwipe(next - 1);
            const { start } = getSwipePickerRenderWindow(message.swipes.length, { selectedIndex: selectedSwipeId });
            listContainer.scrollTop = start * SWIPE_VIRTUAL_ROW_HEIGHT;
            if (start !== currentRenderStart) await renderSwipeList(start);
            scrollToSelectedSwipe();
        });
        swipeIdInput.addEventListener('blur', syncSwipeIdInput);
    }

    await renderSwipeList();
    if (session.controller.signal.aborted) {
        cancelRenderWork();
        if (activeSession === session) activeSession = null;
        return;
    }

    const popupResult = await popup.show();
    if (session.popup === popup) session.popup = null;
    cancelRenderWork();
    let completionReason = 'popup-closed';

    try {
        if (branchActionSwipeId !== null) {
            completionReason = 'action-complete';
            const detail = await actionDetail(branchActionSwipeId);
            if (detail) await invokeSessionAction('branch', detail, dependencies.onBranch);
            return;
        }
        if (popupResult !== POPUP_RESULT.AFFIRMATIVE || !canJumpToSwipe) return;

        completionReason = 'action-complete';
        const targetSwipeId = clamp(selectedSwipeId, 0, message.swipes.length - 1);
        const currentSwipeId = clamp(Number(message.swipe_id ?? 0), 0, message.swipes.length - 1);
        if (targetSwipeId === currentSwipeId) {
            toastr.info(t`Already showing swipe #${targetSwipeId + 1}.`, t`Jump to Swipe`);
            return;
        }

        const detail = await actionDetail(targetSwipeId, { requireJump: true });
        if (detail) {
            await invokeSessionAction('jump', {
                ...detail,
                direction: targetSwipeId > currentSwipeId ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT,
                source: SWIPE_SOURCE.SWIPE_PICKER,
            }, dependencies.onJump);
        }
    } finally {
        while (session.actionPromises.size > 0) {
            await Promise.allSettled([...session.actionPromises]);
        }
        if (!session.controller.signal.aborted) session.controller.abort(completionReason);
        if (activeSession === session) activeSession = null;
    }

    function invokeSessionAction(action, detail, callback) {
        const actionPromise = invokeAction(action, detail, callback);
        session.actionPromises.add(actionPromise);
        actionPromise.then(
            () => session.actionPromises.delete(actionPromise),
            () => session.actionPromises.delete(actionPromise),
        );
        return actionPromise;
    }
}

/**
 * Loads the public gate and registers delegated picker controls once.
 * @param {Partial<SwipePickerDependencies> & {enabled?: boolean}} [options]
 * @returns {Promise<boolean>}
 */
export async function initSwipePicker(options = {}) {
    const { enabled, ...adapters } = options;
    configureSwipePicker(adapters);
    const available = enabled ?? await loadSwipePickerFeatureGate();
    if (!available || initialized) return available;
    initialized = true;

    async function openFromControl(event) {
        event.preventDefault();
        event.stopPropagation();
        const messageId = getBoundedMessageId(this);
        if (messageId !== null) await openSwipePicker(messageId);
    }

    const mobilePicker = isMobile();
    if (mobilePicker) addLongPressEvent(SWIPE_PICKER_SELECTOR, openFromControl);
    else $(document).on('click.swipePicker', SWIPE_PICKER_SELECTOR, openFromControl);

    $(document).on('keydown.swipePicker', SWIPE_PICKER_SELECTOR, async function (event) {
        if (event.key === ' ' || (event.key === 'Enter' && mobilePicker)) await openFromControl.call(this, event);
    });
    $(document).on('click.swipePicker', '.mes_swipe_picker', openFromControl);
    document.addEventListener('swipe-picker:cancel', event => cancelSwipePicker(event.detail?.reason ?? 'chat-switch'));
    eventSource.on(event_types.CHAT_CONTEXT_INVALIDATED, () => cancelSwipePicker('chat-context-invalidated'));
    return true;
}

function getBoundedMessageId(control) {
    const messageElement = control instanceof Element ? control.closest('.mes') : null;
    if (!messageElement) return null;
    const chatRoot = document.getElementById('chat');
    if (chatRoot && !chatRoot.contains(messageElement)) return null;
    const messageId = Number(messageElement.getAttribute('mesid'));
    return Number.isInteger(messageId) && messageId >= 0 ? messageId : null;
}

async function invokeAction(action, detail, callback) {
    if (typeof callback === 'function') return await callback(detail);
    let response;
    let responded = false;
    const eventDetail = {
        ...detail,
        respondWith(value) {
            if (responded) throw new Error(`swipe-picker:${action} already has a response`);
            responded = true;
            response = Promise.resolve(value);
        },
    };
    document.dispatchEvent(new CustomEvent(`swipe-picker:${action}`, { detail: eventDetail }));
    return responded ? await response : undefined;
}

function normalizeSwipeResult(result) {
    if (Number.isInteger(result)) return result;
    if (result && Number.isInteger(result.swipeId)) return result.swipeId;
    return null;
}
