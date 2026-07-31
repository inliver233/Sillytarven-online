/**
 * Normalize the additive group range response without accepting malformed partial data.
 * @param {object} data Raw response body
 * @returns {{header: object|null, messages: object[], cursor: number|null, hasMore: boolean, messageOffset: number|null, revision: string|null}|null}
 */
export function normalizeGroupChatPage(data) {
    if (!data || !Array.isArray(data.messages)) {
        return null;
    }

    return {
        header: data.header && typeof data.header === 'object' ? data.header : null,
        messages: data.messages,
        cursor: Number.isFinite(data.cursor) ? data.cursor : null,
        hasMore: Boolean(data.hasMore),
        messageOffset: Number.isFinite(data.messageOffset) ? Math.max(0, data.messageOffset) : null,
        revision: typeof data.revision === 'string' ? data.revision : null,
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
