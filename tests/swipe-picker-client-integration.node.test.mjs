/* eslint-disable playwright/expect-expect -- Node test runner uses assert. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    createChatBranchRequest,
    createSwipeSelectedPrefix,
    getAbsoluteMessageIndex,
    normalizeGroupChatPage,
} from '../public/scripts/group-chat-paging.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const bookmarksSource = fs.readFileSync(`${projectRoot}/public/scripts/bookmarks.js`, 'utf8');
const groupChatsSource = fs.readFileSync(`${projectRoot}/public/scripts/group-chats.js`, 'utf8');
const scriptSource = fs.readFileSync(`${projectRoot}/public/script.js`, 'utf8');

function loadDeleteSwipeRuntime({ saveResult = false, deferSave = false, overrides = {} } = {}) {
    const helperStart = scriptSource.indexOf('export function createSwipeDeleteSnapshot');
    const deleteStart = scriptSource.indexOf('export async function deleteSwipe');
    const deleteEnd = scriptSource.indexOf('export async function saveMetadata', deleteStart);
    assert.ok(helperStart >= 0 && deleteStart > helperStart && deleteEnd > deleteStart);

    const helperSource = scriptSource.slice(helperStart, deleteStart).replaceAll('export function', 'function');
    const deleteSource = scriptSource.slice(deleteStart, deleteEnd).replace('export async function', 'async function');
    const message = {
        mes: 'first',
        swipe_id: 0,
        swipes: ['first', 'second'],
        swipe_info: [{ extra: { token_count: 1 } }, { extra: { token_count: 2 } }],
        extra: { nested: { value: 'original' } },
    };
    const chat = [message];
    const chat_metadata = {};
    const calls = [];
    let identity = 'character:A:chat-a';
    let releaseSave = () => {};
    let markSaveStarted;
    const saveReady = deferSave ? new Promise(resolve => { releaseSave = resolve; }) : Promise.resolve();
    const saveStarted = new Promise(resolve => { markSaveStarted = resolve; });
    const dependencies = {
        chat,
        chat_metadata,
        toastr: { warning: () => {} },
        t: strings => strings.join(''),
        clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
        getCurrentChatIdentity: () => identity,
        eventSource: { emit: async (...args) => calls.push(['emit', ...args]) },
        event_types: { MESSAGE_SWIPE_DELETED: 'deleted', MESSAGE_SWIPED: 'swiped' },
        SWIPE_DIRECTION: { RIGHT: 'right', LEFT: 'left' },
        SWIPE_SOURCE: { DELETE: 'delete' },
        swipe: async (_event, _direction, options) => {
            chat[options.forceMesId].mes = chat[options.forceMesId].swipes[options.forceSwipeId];
            calls.push(['swipe', options]);
        },
        updateSwipeCounter: async (id, options) => calls.push(['counter', id, options]),
        refreshSwipeButtons: () => calls.push(['refresh']),
        saveChatDebounced: () => calls.push(['debounced-save']),
        saveChatConditional: async options => {
            calls.push(['save', options]);
            markSaveStarted();
            await saveReady;
            return saveResult;
        },
        cancelDebouncedChatSave: () => calls.push(['cancel-save']),
        redisplayChat: async (runtimeChat, id) => calls.push(['redisplay', structuredClone(runtimeChat[id])]),
        ...overrides,
    };
    const names = Object.keys(dependencies);
    const factory = new Function(...names, `${helperSource}\n${deleteSource}\nreturn { createSwipeDeleteSnapshot, restoreSwipeDeleteSnapshot, deleteSwipe };`);
    return {
        ...factory(...Object.values(dependencies)),
        message,
        chat,
        chat_metadata,
        calls,
        saveStarted,
        releaseSave,
        switchContext() {
            identity = 'character:B:chat-b';
            chat.splice(0, chat.length, { mes: 'B', swipe_id: 0, swipes: ['B'], swipe_info: [], extra: {} });
        },
    };
}

function getLoadMoreChatMessagesSource() {
    const loadStart = scriptSource.indexOf('async function loadMoreChatMessages');
    const loadEnd = scriptSource.indexOf('export async function showMoreMessages', loadStart);
    assert.ok(loadStart >= 0 && loadEnd > loadStart);
    return scriptSource.slice(loadStart, loadEnd);
}

function loadPagingRuntime({ switchSequence = [] } = {}) {
    const source = getLoadMoreChatMessagesSource();
    const oldMessages = [{ mes: 'a-1' }, { mes: 'a-2' }];
    const chat = oldMessages.slice();
    const domNodes = [createMessageNode(0), createMessageNode(1)];
    const idShifts = [];
    let currentChatId = 'chat-a';
    let currentIdentity = 'character:a:chat-a';
    let runtime;

    function createMessageNode(mesId) {
        let id = String(mesId);
        return {
            getAttribute: name => name === 'mesid' ? id : null,
            setAttribute: (name, value) => {
                if (name === 'mesid') id = String(value);
            },
        };
    }

    function createCollection(elements) {
        return {
            get length() {
                return elements.length;
            },
            each(callback) {
                elements.forEach((element, index) => callback(index, element));
                return this;
            },
            filter(callback) {
                return createCollection(elements.filter((element, index) => callback(index, element)));
            },
            remove() {
                for (const element of elements) {
                    const index = domNodes.indexOf(element);
                    if (index >= 0) domNodes.splice(index, 1);
                }
                return this;
            },
            removeClass() {
                return this;
            },
            addClass() {
                return this;
            },
            last() {
                return createCollection(elements.slice(-1));
            },
        };
    }

    const chatElement = {
        0: {},
        children: () => createCollection(domNodes.slice()),
        find: () => createCollection(domNodes.slice()),
    };
    const chatPagingState = {
        active: true,
        hasMore: true,
        loading: false,
        isGroup: false,
        chatId: currentChatId,
        cursor: 2,
        pageSize: 2,
        revision: 'revision-a',
    };
    const dependencies = {
        chat,
        chatElement,
        chatPagingState,
        chatPagingLoadGeneration: 0,
        CHAT_PAGING_MAX_RENDER: 400,
        toastr: { info: () => {}, error: () => {} },
        t: strings => strings.join(''),
        getCurrentChatId: () => currentChatId,
        getCurrentChatIdentity: () => currentIdentity,
        fetchChatRange: async () => ({
            messages: [{ mes: 'older-1' }, { mes: 'older-2' }],
            cursor: 0,
            messageOffset: 0,
            hasMore: false,
            revision: 'revision-a',
            contentHash: 'hash-a',
        }),
        clearCachedChatPage: () => {},
        window: { location: { reload: () => {} } },
        shiftDisplayedMessageIds: offset => {
            idShifts.push(offset);
            for (const node of domNodes) {
                node.setAttribute('mesid', Number(node.getAttribute('mesid')) + offset);
            }
        },
        isElementInViewport: () => false,
        $: () => ({ 0: undefined, remove: () => {} }),
        addOneMessage: (_message, { forceId }) => {
            const node = createMessageNode(forceId);
            const insertionIndex = domNodes.findIndex(element => Number(element.getAttribute('mesid')) > forceId);
            domNodes.splice(insertionIndex < 0 ? domNodes.length : insertionIndex, 0, node);
        },
        insertChatMessagesWithFrameBudget: async (messages, insertMessage, { shouldContinue }) => {
            insertMessage(messages[0], 0);
            for (const nextContext of switchSequence) {
                currentChatId = nextContext.chatId;
                currentIdentity = nextContext.identity;
                chat.splice(0, chat.length, ...nextContext.messages);
                domNodes.splice(0, domNodes.length, ...nextContext.messageIds.map(createMessageNode));
                runtime.resetPaging(nextContext.isGroup, nextContext.chatId);
            }
            if (switchSequence.length === 0) runtime.resetPaging(false, currentChatId);
            assert.equal(shouldContinue(), false);
            return { completed: false, inserted: 1, frames: 1, maxFrameDurationMs: 1 };
        },
        recordChatLoadMoreFrames: () => {},
        applyStylePins: () => {},
        setCachedChatPage: () => {},
        chat_metadata: {},
        chat_create_date: '',
        eventSource: { emit: async () => {} },
        event_types: { MORE_MESSAGES_LOADED: 'more' },
    };
    const names = Object.keys(dependencies);
    const factory = new Function(...names, `${source}\nreturn {
        loadMoreChatMessages,
        resetPaging(isGroup, chatId) {
            chatPagingLoadGeneration++;
            chatPagingState.isGroup = isGroup;
            chatPagingState.chatId = chatId;
            chatPagingState.loading = false;
        },
    };`);
    runtime = factory(...Object.values(dependencies));
    return {
        ...runtime,
        chat,
        oldMessages,
        chatPagingState,
        idShifts,
        getMessageIds: () => domNodes.map(node => Number(node.getAttribute('mesid'))),
    };
}

function loadSaveChatTailRuntime({ responseData = null, responseError = null } = {}) {
    const saveStart = scriptSource.indexOf('async function saveChatTail');
    const saveEnd = scriptSource.indexOf('export async function saveChat', saveStart);
    assert.ok(saveStart >= 0 && saveEnd > saveStart);
    const source = scriptSource.slice(saveStart, saveEnd);
    const chatPagingState = {
        active: true,
        chatId: 'chat-a',
        cursor: 10,
        messageOffset: 10,
        hasMore: true,
        revision: 'revision-a',
        contentHash: 'hash-a',
    };
    const calls = [];
    const dependencies = {
        characters: [{ name: 'Alice', avatar: 'alice.png' }],
        this_chid: 0,
        chatPagingState,
        fetch: async () => ({
            ok: true,
            json: async () => {
                if (responseError) throw responseError;
                return responseData;
            },
        }),
        getRequestHeaders: () => ({}),
        setCachedChatPage: options => calls.push(['cache', options]),
        clearCachedChatPage: options => calls.push(['clear', options]),
        toastr: { error: (...args) => calls.push(['error', ...args]) },
        console: {
            error: (...args) => calls.push(['console-error', ...args]),
            warn: (...args) => calls.push(['console-warn', ...args]),
        },
        t: strings => strings.join(''),
        Popup: { show: { input: async () => null } },
    };
    const names = Object.keys(dependencies);
    const factory = new Function(...names, `${source}\nreturn saveChatTail;`);
    return {
        saveChatTail: factory(...Object.values(dependencies)),
        chatPagingState,
        calls,
    };
}

function loadRenameGroupChatRuntime(groups) {
    const renameStart = groupChatsSource.indexOf('export async function renameGroupChat');
    const renameEnd = groupChatsSource.indexOf('/**\n * Deletes a group chat', renameStart);
    assert.ok(renameStart >= 0 && renameEnd > renameStart);
    const source = groupChatsSource.slice(renameStart, renameEnd).replace('export async function', 'async function');
    const invalidations = [];
    const factory = new Function('groups', 'invalidateCurrentChatContext', `${source}\nreturn renameGroupChat;`);
    return {
        renameGroupChat: factory(groups, () => invalidations.push('invalidated')),
        invalidations,
    };
}

test('group rename client canonicalizes numeric chat IDs and preserves an inactive pointer type', async () => {
    const groups = [
        { id: 'active-group', chats: [123], chat_id: 123 },
        { id: 'inactive-group', chats: [789, 'other-chat', 456], chat_id: 789 },
    ];
    const runtime = loadRenameGroupChatRuntime(groups);

    await runtime.renameGroupChat('active-group', '123', 'active-renamed');
    assert.deepEqual(groups[0], { id: 'active-group', chats: ['active-renamed'], chat_id: 'active-renamed' });
    assert.deepEqual(runtime.invalidations, ['invalidated']);

    await runtime.renameGroupChat('inactive-group', '456', 'inactive-renamed');
    assert.deepEqual(groups[1], { id: 'inactive-group', chats: [789, 'other-chat', 'inactive-renamed'], chat_id: 789 });
    assert.equal(typeof groups[1].chat_id, 'number');
    assert.deepEqual(runtime.invalidations, ['invalidated']);
});

test('local message indices map to absolute source indices', () => {
    assert.equal(getAbsoluteMessageIndex(0, 980), 980);
    assert.equal(getAbsoluteMessageIndex(19, 980), 999);
    assert.equal(getAbsoluteMessageIndex(4, null), null);
    assert.equal(getAbsoluteMessageIndex(4, 0), 4);
    assert.equal(getAbsoluteMessageIndex(-1, 10), null);
    assert.equal(getAbsoluteMessageIndex(1.5, 10), null);
    assert.equal(getAbsoluteMessageIndex(1, -1), null);
});

test('solo branch payload identifies the source and selected swipe without chat data', () => {
    const options = {
        isGroup: false,
        chatId: 'session-a',
        avatarUrl: 'alice.png',
        localMessageIndex: 7,
        messageOffset: 100,
        swipeId: 3,
        expectedRevision: 'revision-a',
        contentHash: 'hash-a',
        idempotencyKey: 'solo-operation',
    };
    const request = createChatBranchRequest(options);

    assert.deepEqual(request, {
        url: '/api/chats/branch',
        body: {
            source: { type: 'solo', avatarUrl: 'alice.png', chatId: 'session-a' },
            absoluteMessageIndex: 107,
            swipeId: 3,
            expectedRevision: 'revision-a',
            expectedContentHash: 'hash-a',
            idempotencyKey: 'solo-operation',
        },
    });
    assert.equal(Object.hasOwn(request.body, 'chat'), false);
    assert.equal(Object.hasOwn(request.body, 'messages'), false);
    assert.equal(createChatBranchRequest({ ...options, avatarUrl: 123 }), null);
});

test('group branch payload canonicalizes numeric group and chat source identities', () => {
    const request = createChatBranchRequest({
        isGroup: true,
        groupId: 123,
        chatId: 456,
        localMessageIndex: 2,
        messageOffset: 500,
        swipeId: 1,
        expectedRevision: 'revision-g',
        contentHash: 'hash-g',
        idempotencyKey: 'group-operation',
    });

    assert.deepEqual(request?.body, {
        source: { type: 'group', groupId: '123', chatId: '456' },
        absoluteMessageIndex: 502,
        swipeId: 1,
        expectedRevision: 'revision-g',
        expectedContentHash: 'hash-g',
        idempotencyKey: 'group-operation',
    });

    const invalidIdentity = {
        isGroup: true,
        groupId: 123,
        chatId: 456,
        localMessageIndex: 2,
        messageOffset: 500,
        swipeId: 1,
        expectedRevision: 'revision-g',
        contentHash: 'hash-g',
        idempotencyKey: 'invalid-group-operation',
    };
    assert.equal(createChatBranchRequest({ ...invalidIdentity, groupId: 1.5 }), null);
    assert.equal(createChatBranchRequest({ ...invalidIdentity, chatId: Number.MAX_SAFE_INTEGER + 1 }), null);
});

test('branch payload forwards a safe preferred destination name', () => {
    const request = createChatBranchRequest({
        isGroup: false,
        chatId: 'session-a',
        avatarUrl: 'alice.png',
        localMessageIndex: 1,
        messageOffset: 10,
        swipeId: 0,
        expectedRevision: 'revision-a',
        contentHash: 'hash-a',
        idempotencyKey: 'preferred-operation',
        preferredName: 'Named Checkpoint - 2025-01-01',
    });

    assert.equal(request?.body.preferredName, 'Named Checkpoint - 2025-01-01');
});

test('selected swipe projection mirrors official and legacy metadata semantics', () => {
    const implicitMessage = {
        mes: 'legacy text',
        send_date: 10,
        gen_started: 11,
        gen_finished: 12,
        extra: { nested: { preserved: true } },
    };
    const implicitPrefix = createSwipeSelectedPrefix([implicitMessage], 0, 0);

    assert.equal(implicitPrefix?.[0].send_date, 10);
    assert.equal(implicitPrefix?.[0].gen_started, 11);
    assert.equal(implicitPrefix?.[0].gen_finished, 12);
    assert.deepEqual(implicitPrefix?.[0].extra, { nested: { preserved: true } });
    assert.deepEqual(implicitMessage, {
        mes: 'legacy text',
        send_date: 10,
        gen_started: 11,
        gen_finished: 12,
        extra: { nested: { preserved: true } },
    });

    const partialInfoPrefix = createSwipeSelectedPrefix([{
        mes: 'first',
        swipes: ['first', 'second'],
        swipe_id: 0,
        swipe_info: [{ send_date: 20, extra: { replacement: true } }],
        send_date: 10,
        gen_started: 11,
        gen_finished: 12,
        extra: { stale: true },
    }], 0, 0);

    assert.equal(partialInfoPrefix?.[0].send_date, 20);
    assert.equal(Object.hasOwn(partialInfoPrefix?.[0], 'gen_started'), true);
    assert.equal(partialInfoPrefix?.[0].gen_started, undefined);
    assert.equal(Object.hasOwn(partialInfoPrefix?.[0], 'gen_finished'), true);
    assert.equal(partialInfoPrefix?.[0].gen_finished, undefined);
    assert.deepEqual(partialInfoPrefix?.[0].extra, { replacement: true });

    const currentWithoutInfo = createSwipeSelectedPrefix([{
        mes: 'first',
        swipes: ['first', 'second'],
        swipe_id: 0,
        send_date: 30,
        gen_started: 31,
        gen_finished: 32,
        extra: { current: true },
    }], 0, 0)?.[0];
    assert.deepEqual(currentWithoutInfo?.extra, { current: true });
    assert.equal(currentWithoutInfo?.gen_started, 31);
    assert.equal(currentWithoutInfo?.gen_finished, 32);

    const noncurrentWithoutInfo = createSwipeSelectedPrefix([{
        mes: 'first',
        swipes: ['first', 'second'],
        swipe_id: 0,
        send_date: 40,
        gen_started: 41,
        gen_finished: 42,
        extra: { attachments: [{ name: 'stale.txt' }], reasoning: 'stale reasoning' },
    }], 0, 1)?.[0];
    assert.equal(noncurrentWithoutInfo?.send_date, 40);
    assert.equal(noncurrentWithoutInfo?.gen_started, undefined);
    assert.equal(noncurrentWithoutInfo?.gen_finished, undefined);
    assert.deepEqual(noncurrentWithoutInfo?.extra, {});
});

test('paged branch integration cannot overwrite a source with a loaded suffix', () => {
    const createBranchBlock = bookmarksSource.slice(
        bookmarksSource.indexOf('export async function createBranch'),
        bookmarksSource.indexOf('export async function createNewBookmark'),
    );
    const createBookmarkBlock = bookmarksSource.slice(
        bookmarksSource.indexOf('export async function createNewBookmark'),
        bookmarksSource.indexOf('export function updateBookmarkDisplay'),
    );
    const groupBookmarkBlock = groupChatsSource.slice(
        groupChatsSource.indexOf('export async function saveGroupBookmarkChat'),
        groupChatsSource.indexOf('function onSendTextareaInput'),
    );
    const soloTailBlock = scriptSource.slice(
        scriptSource.indexOf('async function saveChatTail'),
        scriptSource.indexOf('export async function saveChat'),
    );
    const groupSaveBlock = groupChatsSource.slice(
        groupChatsSource.indexOf('async function saveGroupChat'),
        groupChatsSource.indexOf('export async function renameGroupMember'),
    );

    assert.match(createBranchBlock, /createChatBranchRequest\(/u);
    assert.doesNotMatch(createBranchBlock, /chat\.slice\(/u);
    assert.match(createBranchBlock, /preferredName: name/u);
    assert.match(createBranchBlock, /clearCachedChatPage\(\{ isGroup: source\.isGroup, chatId: source\.mainChat \}\)/u);
    assert.match(createBranchBlock, /expectedIdentity: source\.identity/u);
    assert.doesNotMatch(createBranchBlock, /selected_group|this_chid/u);
    assert.match(createBookmarkBlock, /const requestedName = await getBookmarkName/u);
    assert.match(createBookmarkBlock, /preferredName: requestedName/u);
    assert.match(groupBookmarkBlock, /atomicBranch/u);
    assert.match(groupBookmarkBlock, /createChatBranchRequest\(/u);
    assert.match(groupBookmarkBlock, /chatId: String\(group\.chat_id\)/u);
    assert.match(groupBookmarkBlock, /preferredName: preferredName \?\? name/u);
    assert.doesNotMatch(groupBookmarkBlock, /loadGroupChat\(group\.chat_id/u);
    assert.doesNotMatch(groupBookmarkBlock, /getFullGroupMessageIndex/u);

    assert.match(soloTailBlock, /typeof responseData\?\.contentHash === 'string'/u);
    assert.match(soloTailBlock, /chatPagingState\.revision = responseData\.revision/u);
    assert.doesNotMatch(soloTailBlock, /refreshChatPagingMetadata\(/u);
    assert.match(groupSaveBlock, /revision: responseData\.revision/u);
    assert.match(groupSaveBlock, /contentHash: responseData\.contentHash/u);
    assert.doesNotMatch(groupSaveBlock, /refreshChatPagingMetadata\(/u);
});

test('committed tail save uses response metadata and never reports persistence failure after commit', async () => {
    const directMetadata = loadSaveChatTailRuntime({
        responseData: { revision: 'revision-b', contentHash: 'hash-b' },
    });
    const saved = await directMetadata.saveChatTail({
        fileName: 'chat-a',
        header: { chat_metadata: {} },
        messages: [{ mes: 'saved' }],
    });

    assert.equal(saved, true);
    assert.equal(directMetadata.chatPagingState.revision, 'revision-b');
    assert.equal(directMetadata.chatPagingState.contentHash, 'hash-b');
    assert.ok(directMetadata.calls.some(([name]) => name === 'cache'));

    const malformedMetadata = loadSaveChatTailRuntime({ responseError: new Error('invalid response') });
    const persisted = await malformedMetadata.saveChatTail({
        fileName: 'chat-a',
        header: { chat_metadata: {} },
        messages: [{ mes: 'persisted' }],
    });

    assert.equal(persisted, true);
    assert.ok(malformedMetadata.calls.some(([name]) => name === 'clear'));
    assert.ok(malformedMetadata.calls.some(([name]) => name === 'error'));
});

test('rapid paging remains generation-guarded and keeps branch preconditions current', () => {
    const loadMoreSource = getLoadMoreChatMessagesSource();
    assert.match(scriptSource, /chatHistoryInsertionToken \|\| chatPagingState\.loading/u);
    assert.match(loadMoreSource, /loadGeneration !== chatPagingLoadGeneration/u);
    assert.match(loadMoreSource, /const requestedChatIdentity = getCurrentChatIdentity\(\)/u);
    assert.match(loadMoreSource, /const previousFirstMessage = chat\[0\]/u);
    assert.match(loadMoreSource, /const isSameChatArrayState = getCurrentChatIdentity\(\) === requestedChatIdentity/u);
    assert.match(loadMoreSource, /chatElement\.children\('\.mes'\)\.filter/u);
    assert.match(loadMoreSource, /shiftDisplayedMessageIds\(-offset\)/u);
    assert.match(scriptSource, /chatPagingState\.contentHash = typeof data\.contentHash/u);

    const first = normalizeGroupChatPage({
        messages: [{ mes: 'older' }],
        cursor: 10,
        messageOffset: 10,
        hasMore: true,
        revision: 'revision-1',
        contentHash: 'hash-1',
    });
    const second = normalizeGroupChatPage({
        messages: [{ mes: 'newer' }],
        cursor: 20,
        messageOffset: 20,
        hasMore: true,
        revision: 'revision-2',
        contentHash: 'hash-2',
    });
    assert.equal(first?.messageOffset, 10);
    assert.equal(second?.messageOffset, 20);
    assert.equal(second?.contentHash, 'hash-2');
});

test('cancelled paging rolls back the prepended array, partial DOM, and shifted IDs', async () => {
    const runtime = loadPagingRuntime();

    await runtime.loadMoreChatMessages();

    assert.equal(runtime.chat.length, runtime.oldMessages.length);
    assert.equal(runtime.chat[0], runtime.oldMessages[0]);
    assert.equal(runtime.chat[1], runtime.oldMessages[1]);
    assert.deepEqual(runtime.getMessageIds(), [0, 1]);
    assert.deepEqual(runtime.idShifts, [2, -2]);
    assert.equal(runtime.chatPagingState.loading, false);
});

test('stale A paging cannot delete rapidly switched character B or group C state', async () => {
    const chatB = [{ mes: 'b-1' }, { mes: 'b-2' }];
    const characterSwitch = loadPagingRuntime({
        switchSequence: [{
            chatId: 'chat-b',
            identity: 'character:b:chat-b',
            isGroup: false,
            messages: chatB,
            messageIds: [0, 1],
        }],
    });

    await characterSwitch.loadMoreChatMessages();

    assert.deepEqual(characterSwitch.chat, chatB);
    assert.deepEqual(characterSwitch.getMessageIds(), [0, 1]);
    assert.deepEqual(characterSwitch.idShifts, [2]);

    const groupC = [{ mes: 'c-1' }, { mes: 'c-2' }, { mes: 'c-3' }];
    const rapidSwitch = loadPagingRuntime({
        switchSequence: [
            {
                chatId: 'chat-b',
                identity: 'character:b:chat-b',
                isGroup: false,
                messages: chatB,
                messageIds: [0, 1],
            },
            {
                chatId: 'chat-c',
                identity: 'group:c:chat-c',
                isGroup: true,
                messages: groupC,
                messageIds: [0, 1, 2],
            },
        ],
    });

    await rapidSwitch.loadMoreChatMessages();

    assert.deepEqual(rapidSwitch.chat, groupC);
    assert.deepEqual(rapidSwitch.getMessageIds(), [0, 1, 2]);
    assert.deepEqual(rapidSwitch.idShifts, [2]);
    assert.equal(rapidSwitch.chatPagingState.isGroup, true);
    assert.equal(rapidSwitch.chatPagingState.chatId, 'chat-c');
});

test('swipe deletion snapshots deeply restore message identity and exact tainted state', () => {
    const { createSwipeDeleteSnapshot, restoreSwipeDeleteSnapshot } = loadDeleteSwipeRuntime();
    const message = { mes: 'original', swipes: ['a', 'b'], extra: { nested: true } };
    const metadata = { tainted: { previous: true } };
    const originalIdentity = message;
    const snapshot = createSwipeDeleteSnapshot(message, metadata);

    message.mes = 'changed';
    message.swipes.splice(0, 1);
    message.extra.nested = false;
    message.added = true;
    metadata.tainted.previous = false;
    restoreSwipeDeleteSnapshot(message, metadata, snapshot);

    assert.equal(message, originalIdentity);
    assert.deepEqual(message, { mes: 'original', swipes: ['a', 'b'], extra: { nested: true } });
    assert.deepEqual(metadata, { tainted: { previous: true } });

    const absentTainted = {};
    const absentSnapshot = createSwipeDeleteSnapshot(message, absentTainted);
    absentTainted.tainted = true;
    restoreSwipeDeleteSnapshot(message, absentTainted, absentSnapshot);
    assert.equal(Object.hasOwn(absentTainted, 'tainted'), false);
});

test('picker deletion persists before publishing deletion and swipe events', async () => {
    const runtime = loadDeleteSwipeRuntime({ saveResult: true });
    const controller = new AbortController();

    const result = await runtime.deleteSwipe(0, 0, { message: runtime.message, signal: controller.signal });

    assert.equal(result, 0);
    assert.deepEqual(runtime.message.swipes, ['second']);
    assert.equal(runtime.message.mes, 'second');
    assert.deepEqual(runtime.calls.map(([name, event]) => name === 'emit' ? `${name}:${event}` : name), [
        'swipe',
        'save',
        'emit:deleted',
        'emit:swiped',
    ]);
    assert.equal(runtime.calls[0][1].message, runtime.message);
    assert.equal(runtime.calls[0][1].signal, controller.signal);
    assert.equal(runtime.calls[0][1].emitEvent, false);
    assert.equal(runtime.calls[0][1].scheduleSave, false);
    assert.equal(runtime.calls[1][1].signal, controller.signal);
    assert.match(scriptSource, /onJump: \(\{ messageId, swipeId, direction, source, message, signal \}\)/u);
    assert.match(scriptSource, /persistImmediately: true/u);
});

test('failed picker deletion restores exact message state without publishing events', async () => {
    const runtime = loadDeleteSwipeRuntime();
    const original = structuredClone(runtime.message);

    const result = await runtime.deleteSwipe(0, 0, { message: runtime.message });

    assert.equal(result, undefined);
    assert.deepEqual(runtime.message, original);
    assert.equal(Object.hasOwn(runtime.chat_metadata, 'tainted'), false);
    assert.equal(runtime.calls.some(([name]) => name === 'emit'), false);
    assert.deepEqual(runtime.calls.map(([name]) => name), ['swipe', 'save', 'cancel-save', 'redisplay']);
});

test('deferred picker deletion cannot mutate or publish into a replacement chat', async () => {
    const runtime = loadDeleteSwipeRuntime({ saveResult: true, deferSave: true });
    const controller = new AbortController();
    const pending = runtime.deleteSwipe(0, 0, { message: runtime.message, signal: controller.signal });
    await runtime.saveStarted;

    runtime.switchContext();
    controller.abort('chat-context-invalidated');
    runtime.releaseSave();

    assert.equal(await pending, undefined);
    assert.deepEqual(runtime.chat, [{ mes: 'B', swipe_id: 0, swipes: ['B'], swipe_info: [], extra: {} }]);
    assert.equal(runtime.calls.some(([name]) => name === 'emit'), false);
    assert.deepEqual(runtime.calls.map(([name]) => name), ['swipe', 'save']);
});


function loadOpenCharacterChatRuntime({ deferWait = false, deferClear = false } = {}) {
    const openStart = scriptSource.indexOf('export async function openCharacterChat');
    const openEnd = scriptSource.indexOf('export function changeMainAPI', openStart);
    assert.ok(openStart >= 0 && openEnd > openStart);
    const source = scriptSource.slice(openStart, openEnd)
        .replace('export async function', 'async function')
        .replaceAll('this_chid', 'state.this_chid');
    let releaseWait = () => {};
    let releaseClear = () => {};
    let markClearStarted;
    const waitReady = deferWait ? new Promise(resolve => { releaseWait = resolve; }) : Promise.resolve();
    const clearReady = deferClear ? new Promise(resolve => { releaseClear = resolve; }) : Promise.resolve();
    const clearStarted = new Promise(resolve => { markClearStarted = resolve; });
    const state = { this_chid: 0 };
    const characters = [
        { avatar: 'a.png', chat: 'chat-a' },
        { avatar: 'b.png', chat: 'chat-b' },
    ];
    const chat = [{ mes: 'character A' }];
    const calls = [];
    const getCurrentChatIdentity = () => `character:${state.this_chid}:${characters[state.this_chid]?.chat}`;
    const dependencies = {
        state,
        characters,
        chat,
        chat_metadata: { source: 'A' },
        isChatSaving: false,
        debounce_timeout: { extended: 100 },
        waitUntilCondition: async () => {
            calls.push(['wait']);
            await waitReady;
        },
        clearChat: async () => {
            calls.push(['clear-chat']);
            markClearStarted();
            await clearReady;
        },
        getCurrentChatIdentity,
        getChat: async options => {
            calls.push(['load', options]);
            return true;
        },
        $: () => ({ val: value => calls.push(['selected-chat', value]) }),
        createOrEditCharacter: async () => calls.push(['persist-character']),
        CustomEvent: class CustomEvent {},
    };
    const names = Object.keys(dependencies);
    const factory = new Function(...names, `${source}\nreturn openCharacterChat;`);
    return {
        openCharacterChat: factory(...Object.values(dependencies)),
        characters,
        chat,
        calls,
        currentIdentity: getCurrentChatIdentity,
        switchCharacter(characterId) {
            state.this_chid = characterId;
            chat.splice(0, chat.length, { mes: `character ${characters[characterId].avatar}` });
        },
        releaseWait,
        releaseClear,
        clearStarted,
    };
}

test('solo open stops after a deferred save wait when character identity changes', async () => {
    const runtime = loadOpenCharacterChatRuntime({ deferWait: true });
    const pending = runtime.openCharacterChat('branch-a', { expectedIdentity: runtime.currentIdentity() });

    runtime.switchCharacter(1);
    runtime.releaseWait();
    await pending;

    assert.equal(runtime.characters[0].chat, 'chat-a');
    assert.equal(runtime.characters[1].chat, 'chat-b');
    assert.deepEqual(runtime.chat, [{ mes: 'character b.png' }]);
    assert.deepEqual(runtime.calls, [['wait']]);
});

test('solo open stops after deferred clear without assigning or loading against character B', async () => {
    const runtime = loadOpenCharacterChatRuntime({ deferClear: true });
    const controller = new AbortController();
    const pending = runtime.openCharacterChat('branch-a', {
        signal: controller.signal,
        expectedIdentity: runtime.currentIdentity(),
    });

    await runtime.clearStarted;
    runtime.switchCharacter(1);
    controller.abort('user-navigation');
    runtime.releaseClear();
    await pending;

    assert.equal(runtime.characters[0].chat, 'chat-a');
    assert.equal(runtime.characters[1].chat, 'chat-b');
    assert.deepEqual(runtime.chat, [{ mes: 'character b.png' }]);
    assert.deepEqual(runtime.calls, [['wait'], ['clear-chat']]);
});

test('intended solo open loads its target after its own identity change and supports legacy options', async () => {
    const guarded = loadOpenCharacterChatRuntime();
    const controller = new AbortController();
    await guarded.openCharacterChat('branch-a', {
        signal: controller.signal,
        expectedIdentity: guarded.currentIdentity(),
    });

    assert.equal(guarded.characters[0].chat, 'branch-a');
    assert.deepEqual(guarded.calls.map(([name]) => name), ['wait', 'clear-chat', 'load', 'selected-chat', 'persist-character']);
    assert.equal(guarded.calls[2][1].signal, controller.signal);
    assert.equal(guarded.calls[2][1].isCurrent(), true);

    const legacy = loadOpenCharacterChatRuntime();
    await legacy.openCharacterChat('legacy-chat');
    assert.equal(legacy.characters[0].chat, 'legacy-chat');
    assert.deepEqual(legacy.calls.map(([name]) => name), ['wait', 'clear-chat', 'load', 'selected-chat', 'persist-character']);
});

function loadOpenGroupChatRuntime({ deferWait = false, deferClear = false, abortOnInvalidate = null } = {}) {
    const openStart = groupChatsSource.indexOf('export async function openGroupChat');
    const openEnd = groupChatsSource.indexOf('/**\n * Renames a group chat', openStart);
    assert.ok(openStart >= 0 && openEnd > openStart);
    const source = groupChatsSource.slice(openStart, openEnd).replace('export async function', 'async function');
    let releaseWait = () => {};
    let releaseClear = () => {};
    let markClearStarted;
    const waitReady = deferWait ? new Promise(resolve => { releaseWait = resolve; }) : Promise.resolve();
    const clearReady = deferClear ? new Promise(resolve => { releaseClear = resolve; }) : Promise.resolve();
    const clearStarted = new Promise(resolve => { markClearStarted = resolve; });
    const groups = [
        { id: 'A', chat_id: 'shared-chat', chats: ['shared-chat', 'branch-a'] },
        { id: 'B', chat_id: 'shared-chat', chats: ['shared-chat'] },
    ];
    const chat = [{ mes: 'current context' }];
    const calls = [];
    let selectedGroup = 'A';
    const getCurrentChatIdentity = () => `group:${selectedGroup}:${groups.find(group => group.id === selectedGroup)?.chat_id}`;
    const dependencies = {
        groups,
        chat,
        isChatSaving: false,
        debounce_timeout: { extended: 100 },
        waitUntilCondition: async () => {
            calls.push(['wait']);
            await waitReady;
        },
        clearChat: async () => {
            calls.push(['clear-chat']);
            markClearStarted();
            await clearReady;
        },
        getCurrentChatIdentity,
        invalidateCurrentChatContext: () => {
            calls.push(['invalidate']);
            abortOnInvalidate?.abort('chat-context-invalidated');
        },
        updateChatMetadata: (...args) => calls.push(['metadata', ...args]),
        editGroup: async (...args) => calls.push(['edit', ...args]),
        getGroupChat: async (...args) => calls.push(['load', ...args]),
    };
    const names = Object.keys(dependencies);
    const factory = new Function(...names, `${source}\nreturn openGroupChat;`);
    return {
        openGroupChat: factory(...Object.values(dependencies)),
        groups,
        chat,
        calls,
        currentIdentity: getCurrentChatIdentity,
        switchGroup(groupId) {
            selectedGroup = groupId;
        },
        releaseWait,
        releaseClear,
        clearStarted,
    };
}

test('group open stops after a deferred save wait when identity changes between groups sharing a chat id', async () => {
    const runtime = loadOpenGroupChatRuntime({ deferWait: true });
    const expectedIdentity = runtime.currentIdentity();
    const pending = runtime.openGroupChat('A', 'branch-a', { expectedIdentity });

    runtime.switchGroup('B');
    runtime.releaseWait();
    await pending;

    assert.equal(runtime.currentIdentity(), 'group:B:shared-chat');
    assert.equal(runtime.groups[0].chat_id, 'shared-chat');
    assert.deepEqual(runtime.chat, [{ mes: 'current context' }]);
    assert.deepEqual(runtime.calls, [['wait']]);
});

test('group open stops after deferred clear when its signal and identity become stale', async () => {
    const runtime = loadOpenGroupChatRuntime({ deferClear: true });
    const controller = new AbortController();
    const pending = runtime.openGroupChat('A', 'branch-a', {
        signal: controller.signal,
        expectedIdentity: runtime.currentIdentity(),
    });

    await runtime.clearStarted;
    runtime.switchGroup('B');
    controller.abort('user-navigation');
    runtime.releaseClear();
    await pending;

    assert.equal(runtime.groups[0].chat_id, 'shared-chat');
    assert.deepEqual(runtime.chat, [{ mes: 'current context' }]);
    assert.deepEqual(runtime.calls, [['wait'], ['clear-chat']]);
});

test('intended group open owns its new load after context invalidation aborts the parent signal', async () => {
    const controller = new AbortController();
    const runtime = loadOpenGroupChatRuntime({ abortOnInvalidate: controller });

    await runtime.openGroupChat('A', 'branch-a', {
        signal: controller.signal,
        expectedIdentity: runtime.currentIdentity(),
    });

    assert.equal(controller.signal.aborted, true);
    assert.equal(runtime.groups[0].chat_id, 'branch-a');
    assert.deepEqual(runtime.chat, []);
    assert.deepEqual(runtime.calls.map(([name]) => name), ['wait', 'clear-chat', 'invalidate', 'metadata', 'edit', 'load']);
    assert.deepEqual(runtime.calls.at(-1), ['load', 'A']);
});

function loadBranchRuntime({ isGroup = false, paged = true, openChangesIdentity = false, rangeAvailable = true, missingOffset = false } = {}) {
    const helperStart = bookmarksSource.indexOf('function captureBranchContext');
    const branchStart = bookmarksSource.indexOf('export async function createBranch', helperStart);
    const branchEnd = bookmarksSource.indexOf('/**\n * Creates a new bookmark', branchStart);
    const chatStart = bookmarksSource.indexOf('export async function branchChat');
    const chatEnd = bookmarksSource.indexOf('function registerBookmarksSlashCommands', chatStart);
    assert.ok(helperStart >= 0 && branchStart > helperStart && branchEnd > branchStart && chatStart > branchEnd && chatEnd > chatStart);

    const source = `${bookmarksSource.slice(helperStart, branchEnd)}\n${bookmarksSource.slice(chatStart, chatEnd)}`
        .replaceAll('export async function ', 'async function ');
    let identity = isGroup ? 'group:A:chat-a' : 'character:A:chat-a';
    let releaseResponse;
    const responseReady = new Promise(resolve => { releaseResponse = resolve; });
    const message = { mes: 'source', swipe_id: 0, extra: {} };
    const chat = [message];
    const groups = [{ id: 'A', chat_id: 'chat-a', chats: [] }];
    const calls = [];
    const pagingState = {
        active: paged,
        isGroup,
        chatId: 'chat-a',
        messageOffset: missingOffset ? null : 0,
        revision: 'revision-a',
        contentHash: 'hash-a',
    };
    const dependencies = {
        characters: [{ chat: 'chat-a', avatar: 'a.png' }],
        this_chid: isGroup ? undefined : 0,
        chat,
        groups,
        selected_group: isGroup ? 'A' : null,
        humanizedDateTime: () => 'now',
        getCurrentChatIdentity: () => identity,
        getChatPagingState: () => ({ ...pagingState }),
        fetchChatRange: async options => {
            calls.push(['range', options]);
            return rangeAvailable ? {
                total: 1,
                messageOffset: 0,
                revision: 'revision-a',
                contentHash: 'hash-a',
            } : null;
        },
        createChatBranchRequest,
        saveGroupBookmarkChat: async (_groupId, _name, _metadata, _mesId, options) => {
            calls.push(['group-save', options]);
            await responseReady;
            return { ok: true, status: 201, data: { fileName: 'branch-a', sourceRevision: 'revision-b', sourceContentHash: 'hash-b' } };
        },
        fetch: async (url, options) => {
            calls.push(['fetch', url, options]);
            await responseReady;
            return { ok: true, status: 201, json: async () => ({ fileName: 'branch-a', sourceRevision: 'revision-b', sourceContentHash: 'hash-b' }) };
        },
        getRequestHeaders: () => ({}),
        refreshChatPagingMetadata: async options => {
            calls.push(['refresh', options]);
            return null;
        },
        setChatPagingState: state => calls.push(['state', state]),
        clearCachedChatPage: options => calls.push(['clear', options]),
        reloadCurrentChat: async () => calls.push(['reload']),
        saveChat: async () => true,
        saveItemizedPrompts: async name => calls.push(['prompts', name]),
        openGroupChat: async (...args) => {
            calls.push(['open-group', ...args]);
            if (openChangesIdentity) identity = `group:${args[0]}:${args[1]}`;
        },
        openCharacterChat: async (...args) => {
            calls.push(['open-character', ...args]);
            if (openChangesIdentity) identity = `character:A:${args[0]}`;
        },
        Popup: { show: { confirm: async () => false } },
        toastr: { warning: () => {}, error: () => {}, info: () => {} },
        t: strings => strings.join(''),
    };
    const names = Object.keys(dependencies);
    const factory = new Function(...names, `${source}\nreturn { createBranch, branchChat };`);
    const runtime = factory(...Object.values(dependencies));
    return {
        ...runtime,
        calls,
        message,
        groups,
        switchContext(nextIdentity) {
            identity = nextIdentity;
        },
        releaseResponse,
    };
}

test('branch picker forwards its captured signal and never applies a stale solo response', async () => {
    assert.match(scriptSource, /onBranch: \(\{ messageId, absoluteMessageId, swipeId, signal \}\) => branchChat\(messageId, \{ absoluteMessageId, swipeId, signal, requireAtomic: true \}\)/u);
    assert.match(bookmarksSource, /createBranch\(mesId, \{ swipeId, absoluteMessageId, signal, sourceContext: source, requireAtomic \}\)/u);
    assert.match(groupChatsSource, /signal\?: AbortSignal/u);

    const runtime = loadBranchRuntime();
    const controller = new AbortController();
    const pending = runtime.createBranch(0, { signal: controller.signal, preferredName: 'branch-a' });
    runtime.switchContext('character:B:chat-b');
    controller.abort('chat-context-invalidated');
    runtime.releaseResponse();

    assert.equal(await pending, undefined);
    assert.deepEqual(runtime.message.extra, {});
    assert.deepEqual(runtime.calls.map(([name]) => name), ['fetch']);
    assert.equal(runtime.calls[0][1], '/api/chats/branch');
    assert.equal(runtime.calls[0][2].signal, controller.signal);
});

test('group branch abort leaves server result intact without stale group or cache mutations', async () => {
    const runtime = loadBranchRuntime({ isGroup: true });
    const controller = new AbortController();
    const pending = runtime.createBranch(0, { signal: controller.signal, preferredName: 'branch-a' });
    runtime.switchContext('group:B:chat-a');
    controller.abort('chat-context-invalidated');
    runtime.releaseResponse();

    assert.equal(await pending, undefined);
    assert.deepEqual(runtime.message.extra, {});
    assert.deepEqual(runtime.groups[0].chats, []);
    assert.deepEqual(runtime.calls.map(([name]) => name), ['fetch']);
    assert.equal(runtime.calls[0][1], '/api/chats/branch');
    assert.equal(runtime.calls[0][2].signal, controller.signal);
});

test('group branch rejects a different group with the same chat id without relying on abort', async () => {
    const runtime = loadBranchRuntime({ isGroup: true });
    const pending = runtime.createBranch(0, { preferredName: 'branch-a' });
    runtime.switchContext('group:B:chat-a');
    runtime.releaseResponse();

    assert.equal(await pending, undefined);
    assert.deepEqual(runtime.message.extra, {});
    assert.deepEqual(runtime.groups[0].chats, []);
    assert.deepEqual(runtime.calls.map(([name]) => name), ['fetch']);
});

test('picker branch probes authoritative metadata when paging is inactive and always posts atomically', async () => {
    const runtime = loadBranchRuntime({ paged: false });
    const controller = new AbortController();
    const pending = runtime.branchChat(0, {
        absoluteMessageId: 0,
        swipeId: 0,
        signal: controller.signal,
        requireAtomic: true,
    });
    runtime.releaseResponse();

    assert.equal(await pending, 'branch-a');
    assert.deepEqual(runtime.calls.map(([name]) => name), ['range', 'fetch', 'refresh', 'state', 'clear', 'prompts', 'open-character']);
    assert.equal(runtime.calls[1][1], '/api/chats/branch');
    const request = JSON.parse(runtime.calls[1][2].body);
    assert.equal(request.absoluteMessageIndex, 0);
    assert.equal(request.expectedRevision, 'revision-a');
    assert.equal(request.expectedContentHash, 'hash-a');
    assert.equal(Object.hasOwn(request, 'chat'), false);
});

test('picker branch fails closed when inactive paging cannot provide authoritative metadata', async () => {
    const runtime = loadBranchRuntime({ paged: false, rangeAvailable: false });

    const result = await runtime.branchChat(0, { absoluteMessageId: 0, swipeId: 0, requireAtomic: true });

    assert.equal(result, null);
    assert.deepEqual(runtime.calls.map(([name]) => name), ['range']);
    assert.deepEqual(runtime.message.extra, {});
});

test('picker branch fails closed when active paging has no message offset', async () => {
    const runtime = loadBranchRuntime({ missingOffset: true });

    const result = await runtime.branchChat(0, { absoluteMessageId: 0, swipeId: 0, requireAtomic: true });

    assert.equal(result, null);
    assert.deepEqual(runtime.calls, []);
    assert.deepEqual(runtime.message.extra, {});
});

test('branch without a signal preserves slash-command navigation behavior', async () => {
    const runtime = loadBranchRuntime({ paged: false });
    const result = await runtime.branchChat(0, { absoluteMessageId: null });

    assert.equal(result, 'Branch #0 - now');
    assert.deepEqual(runtime.calls.map(([name]) => name), ['prompts', 'open-character']);
    assert.deepEqual(runtime.calls[1], [
        'open-character',
        'Branch #0 - now',
        { signal: undefined, expectedIdentity: 'character:A:chat-a' },
    ]);
    assert.deepEqual(runtime.message.extra.branches, ['Branch #0 - now']);
});

test('solo branch passes its captured guard and returns its filename after intended navigation changes identity', async () => {
    const runtime = loadBranchRuntime({ paged: false, openChangesIdentity: true });
    const controller = new AbortController();
    const result = await runtime.branchChat(0, { signal: controller.signal });

    assert.equal(result, 'Branch #0 - now');
    assert.deepEqual(runtime.calls.map(([name]) => name), ['prompts', 'open-character']);
    assert.deepEqual(runtime.calls[1], [
        'open-character',
        'Branch #0 - now',
        { signal: controller.signal, expectedIdentity: 'character:A:chat-a' },
    ]);
});

test('group branch passes its captured guard and returns its filename after intended navigation', async () => {
    const runtime = loadBranchRuntime({ isGroup: true, paged: false, openChangesIdentity: true });
    const controller = new AbortController();
    const pending = runtime.branchChat(0, { signal: controller.signal });
    runtime.releaseResponse();
    const result = await pending;

    assert.equal(result, 'Branch #0 - now');
    assert.deepEqual(runtime.calls.map(([name]) => name), ['group-save', 'prompts', 'open-group']);
    assert.deepEqual(runtime.calls[2], [
        'open-group',
        'A',
        'Branch #0 - now',
        { signal: controller.signal, expectedIdentity: 'group:A:chat-a' },
    ]);
});

test('paging metadata refresh rejects a different group with the same chat id', async () => {
    const start = scriptSource.indexOf('export async function refreshChatPagingMetadata');
    const end = scriptSource.indexOf('function shiftDisplayedMessageIds', start);
    assert.ok(start >= 0 && end > start);
    const source = scriptSource.slice(start, end).replace('export async function', 'async function');
    let identity = 'group:A:shared-chat';
    let releaseFetch;
    const fetchReady = new Promise(resolve => { releaseFetch = resolve; });
    const chatPagingState = {
        active: true,
        isGroup: true,
        chatId: 'shared-chat',
        revision: 'revision-a',
        contentHash: 'hash-a',
    };
    const dependencies = {
        chatPagingState,
        getCurrentChatIdentity: () => identity,
        getCurrentChatId: () => 'shared-chat',
        fetchChatRange: async () => {
            await fetchReady;
            return { revision: 'revision-b', contentHash: 'hash-b' };
        },
    };
    const names = Object.keys(dependencies);
    const factory = new Function(...names, `${source}\nreturn refreshChatPagingMetadata;`);
    const refresh = factory(...Object.values(dependencies));
    const pending = refresh({
        isGroup: true,
        chatId: 'shared-chat',
        expectedRevision: 'revision-b',
        expectedIdentity: identity,
    });
    identity = 'group:B:shared-chat';
    releaseFetch();

    assert.equal(await pending, null);
    assert.equal(chatPagingState.revision, 'revision-a');
    assert.equal(chatPagingState.contentHash, 'hash-a');
    assert.match(source, /fetchChatRange\(\{ isGroup, chatId, limit: 1, signal \}\)/u);
});
