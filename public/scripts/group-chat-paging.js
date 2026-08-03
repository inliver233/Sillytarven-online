/**
 * Normalize the additive group range response without accepting malformed partial data.
 * @param {object} data Raw response body
 * @returns {{header: object|null, messages: object[], cursor: number|null, hasMore: boolean, messageOffset: number|null, revision: string|null, contentHash?: string}|null}
 */
export function normalizeGroupChatPage(data) {
    if (!data || !Array.isArray(data.messages)) {
        return null;
    }

    const page = {
        header: data.header && typeof data.header === 'object' ? data.header : null,
        messages: data.messages,
        cursor: Number.isFinite(data.cursor) ? data.cursor : null,
        hasMore: Boolean(data.hasMore),
        messageOffset: Number.isFinite(data.messageOffset) ? Math.max(0, data.messageOffset) : null,
        revision: typeof data.revision === 'string' ? data.revision : null,
    };
    if (typeof data.contentHash === 'string') {
        page.contentHash = data.contentHash;
    }
    return page;
}

/**
 * Validate metadata returned after a tail save or atomic source update.
 * @param {object|null|undefined} data Range response
 * @param {string|null} [expectedRevision]
 * @returns {{revision: string, contentHash: string}|null}
 */
export function getRefreshedPagingMetadata(data, expectedRevision = null) {
    if (typeof data?.revision !== 'string'
        || typeof data?.contentHash !== 'string'
        || (typeof expectedRevision === 'string' && data.revision !== expectedRevision)) {
        return null;
    }
    return { revision: data.revision, contentHash: data.contentHash };
}

/**
 * Create the immutable portion of a cached chat page.
 * @param {object} options Page values
 * @returns {object}
 */
export function createChatPageCacheEntry({ messages, header, cursor, messageOffset, hasMore, revision, contentHash }) {
    return {
        messages: Array.isArray(messages) ? messages.slice() : [],
        header: header ?? null,
        cursor: Number.isFinite(cursor) ? cursor : null,
        messageOffset: Number.isFinite(messageOffset) ? Math.max(0, messageOffset) : null,
        hasMore: Boolean(hasMore),
        revision: typeof revision === 'string' ? revision : null,
        contentHash: typeof contentHash === 'string' ? contentHash : null,
    };
}

/**
 * Split the compatibility full-chat response without mutating the caller's array.
 * @param {object[]} data Full group chat response
 * @returns {{header: object|null, messages: object[]}}
 */
export function splitGroupChatFile(data) {
    if (!Array.isArray(data)) {
        return { header: null, messages: [] };
    }

    const first = data[0];
    const hasHeader = first
        && typeof first === 'object'
        && Object.hasOwn(first, 'chat_metadata')
        && !Object.hasOwn(first, 'name');
    return {
        header: hasHeader ? first : null,
        messages: hasHeader ? data.slice(1) : data.slice(),
    };
}

/**
 * Build either the native tail request or the unchanged full compatibility request.
 * @param {object} options Request options
 * @param {string} options.chatId Stable group chat ID
 * @param {object} options.header Chat header
 * @param {object[]} options.messages Current contiguous message suffix or full chat
 * @param {object} options.pagingState Shared paging state snapshot
 * @param {boolean} [options.force] Override integrity mismatch
 * @returns {{url: string, body: object, tail: boolean}}
 */
export function createGroupChatSaveRequest({ chatId, header, messages, pagingState, force = false }) {
    const tail = Boolean(
        pagingState?.active
        && pagingState?.isGroup
        && pagingState?.chatId === chatId,
    );
    if (tail) {
        return {
            url: '/api/chats/group/save-tail',
            body: {
                id: chatId,
                header,
                messages,
                before: Number.isFinite(pagingState.cursor) ? pagingState.cursor : 0,
                expectedRevision: typeof pagingState.revision === 'string' ? pagingState.revision : null,
                force,
            },
            tail: true,
        };
    }

    return {
        url: '/api/chats/group/save',
        body: { id: chatId, chat: [header, ...messages], force },
        tail: false,
    };
}

/**
 * Convert a loaded chat-array index into the source file's absolute message index.
 * @param {number} localMessageIndex Index in the loaded suffix
 * @param {number|null|undefined} messageOffset Count of source messages before the loaded suffix
 * @returns {number|null}
 */
export function getAbsoluteMessageIndex(localMessageIndex, messageOffset) {
    const localIndex = Number(localMessageIndex);
    if (!Number.isSafeInteger(localIndex) || localIndex < 0) {
        return null;
    }

    if (messageOffset == null) {
        return null;
    }

    const offset = Number(messageOffset);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + localIndex)) {
        return null;
    }

    return offset + localIndex;
}

/**
 * Build an atomic server-side branch request. No loaded chat messages are included.
 * @param {object} options
 * @param {boolean} options.isGroup
 * @param {string|number} options.chatId Source chat file identity
 * @param {string|null} [options.avatarUrl] Solo character avatar identity
 * @param {string|number|null} [options.groupId] Group identity
 * @param {number} [options.localMessageIndex] Index in the loaded suffix
 * @param {number|null} [options.messageOffset] Count of messages before the loaded suffix
 * @param {number|null} [options.absoluteMessageIndex] Captured source index, preferred after paging prepends
 * @param {number|null} [options.swipeId]
 * @param {string|null} options.expectedRevision
 * @param {string|null} options.contentHash
 * @param {string} options.idempotencyKey
 * @param {string|null} [options.preferredName] Requested destination chat name
 * @returns {{url: string, body: object}|null}
 */
export function createChatBranchRequest({
    isGroup,
    chatId,
    avatarUrl = null,
    groupId = null,
    localMessageIndex,
    messageOffset,
    absoluteMessageIndex: capturedAbsoluteMessageIndex = null,
    swipeId,
    expectedRevision,
    contentHash,
    idempotencyKey,
    preferredName = null,
}) {
    const normalizedChatId = typeof chatId === 'number' && Number.isSafeInteger(chatId) ? String(chatId) : chatId;
    const normalizedGroupId = typeof groupId === 'number' && Number.isSafeInteger(groupId) ? String(groupId) : groupId;
    const mappedMessageIndex = getAbsoluteMessageIndex(localMessageIndex, messageOffset);
    const absoluteMessageIndex = Number.isSafeInteger(capturedAbsoluteMessageIndex) && capturedAbsoluteMessageIndex >= 0
        ? capturedAbsoluteMessageIndex
        : mappedMessageIndex;
    const normalizedSwipeId = swipeId == null ? null : Number(swipeId);
    if (absoluteMessageIndex === null
        || typeof normalizedChatId !== 'string' || !normalizedChatId
        || typeof idempotencyKey !== 'string' || !idempotencyKey
        || !Number.isSafeInteger(normalizedSwipeId) || normalizedSwipeId < 0
        || (isGroup && (typeof normalizedGroupId !== 'string' || !normalizedGroupId))
        || (!isGroup && (typeof avatarUrl !== 'string' || !avatarUrl))) {
        return null;
    }

    return {
        url: '/api/chats/branch',
        body: {
            source: isGroup
                ? { type: 'group', groupId: normalizedGroupId, chatId: normalizedChatId }
                : { type: 'solo', avatarUrl, chatId: normalizedChatId },
            absoluteMessageIndex,
            swipeId: normalizedSwipeId,
            expectedRevision: typeof expectedRevision === 'string' ? expectedRevision : null,
            expectedContentHash: typeof contentHash === 'string' ? contentHash : null,
            idempotencyKey,
            ...(typeof preferredName === 'string' && preferredName ? { preferredName } : {}),
        },
    };
}

/**
 * Clone a source prefix and apply the requested swipe to its final message.
 * @param {object[]} messages Full or safely loaded source messages
 * @param {number} messageIndex Last message to include
 * @param {number} swipeId Swipe to make active in the destination
 * @returns {object[]|null}
 */
export function createSwipeSelectedPrefix(messages, messageIndex, swipeId) {
    const index = Number(messageIndex);
    const selectedSwipeId = Number(swipeId);
    if (!Array.isArray(messages)
        || !Number.isSafeInteger(index) || index < 0 || index >= messages.length
        || !Number.isSafeInteger(selectedSwipeId) || selectedSwipeId < 0) {
        return null;
    }

    const prefix = structuredClone(messages.slice(0, index + 1));
    const selected = prefix.at(-1);
    const hasExplicitSwipes = Array.isArray(selected?.swipes);
    const swipes = hasExplicitSwipes ? selected.swipes : [selected?.mes];
    if (typeof swipes[selectedSwipeId] !== 'string') {
        return null;
    }

    const currentSwipeId = Number.isInteger(selected.swipe_id)
        ? selected.swipe_id
        : swipes.findIndex(swipe => swipe === selected.mes);
    selected.swipes = swipes;
    selected.swipe_id = selectedSwipeId;
    selected.mes = swipes[selectedSwipeId];
    if (!hasExplicitSwipes) return prefix;

    const swipeInfo = Array.isArray(selected.swipe_info) ? selected.swipe_info[selectedSwipeId] : null;
    if (swipeInfo && typeof swipeInfo === 'object' && !Array.isArray(swipeInfo)) {
        for (const field of ['send_date', 'gen_started', 'gen_finished']) selected[field] = structuredClone(swipeInfo[field]);
        selected.extra = structuredClone(swipeInfo.extra ?? {});
    } else if (selectedSwipeId !== currentSwipeId) {
        selected.gen_started = undefined;
        selected.gen_finished = undefined;
        selected.extra = {};
    }
    return prefix;
}

/**
 * Translate a rendered-page message id into the full chat index for explicit compatibility work.
 * @param {number} localMessageId Message index in the loaded suffix
 * @param {number|null} messageOffset Number of older messages not loaded
 * @param {object[]} fullMessages Full server chat, used only as a safe fallback
 * @param {object[]} loadedMessages Current loaded suffix
 * @returns {number}
 */
export function getFullGroupMessageIndex(localMessageId, messageOffset, fullMessages, loadedMessages) {
    const localIndex = Math.max(0, Math.trunc(Number(localMessageId) || 0));
    if (Number.isFinite(messageOffset)) {
        return Math.min(fullMessages.length - 1, Math.max(0, messageOffset + localIndex));
    }

    const selected = loadedMessages[localIndex];
    if (selected) {
        const serialized = JSON.stringify(selected);
        for (let index = fullMessages.length - 1; index >= 0; index--) {
            if (JSON.stringify(fullMessages[index]) === serialized) {
                return index;
            }
        }
    }

    const inferredOffset = Math.max(0, fullMessages.length - loadedMessages.length);
    return Math.min(fullMessages.length - 1, inferredOffset + localIndex);
}
