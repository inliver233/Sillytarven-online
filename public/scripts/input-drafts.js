/**
 * Drafts of the chat input box: one per chat, kept in this browser and synced to the
 * server, so a message started on one device can be finished on another.
 *
 * - The box is mirrored into the local copy on every change; the server copy follows
 *   once typing pauses, and at once when the box is emptied (the message was sent), so
 *   other devices do not offer an already-sent message again.
 * - Opening a chat, coming back to the page or focusing the box fetches the server copy.
 *   It replaces the box only when nothing was typed here since the last sync.
 * - Two different versions are never merged or dropped silently: the one on screen
 *   stays, onConflict offers the other, and typing on keeps the one on screen.
 * - A device that keeps its own version after a conflict tells the server so; the device
 *   whose text it replaced is then asked too, instead of having its box replaced quietly
 *   the next time it syncs (it knows itself by a device id that outlives page reloads).
 *
 * Browser APIs come in as options, so the logic also runs in node tests.
 */

export const DRAFT_PUSH_DELAY = 1000;
/** Chats remembered in this browser. The server keeps more. */
const LOCAL_LIMIT = 50;

/**
 * @typedef {object} LocalDraft
 * @property {string} text What the box holds for this chat
 * @property {number} syncedAt Server version this text is based on (0: none)
 * @property {boolean} dirty Changed here since that version
 * @property {boolean} mine Typed (or kept) on this device rather than taken from another
 * @property {boolean} forced Kept here over another device's version; the next save says so
 */

/**
 * @typedef {{ status: number, data: any } | null} DraftResponse null when the request did not get through
 */

/**
 * @param {{ groupId?: string|null, characterAvatar?: string|null, chatId?: string|null }} chat
 * @returns {string}
 */
export function inputDraftKey({ groupId = null, characterAvatar = null, chatId = null } = {}) {
    if (groupId !== null && groupId !== undefined) return `g:${groupId}:${chatId ?? ''}`;
    if (characterAvatar) return `c:${characterAvatar}:${chatId ?? ''}`;
    return 'none';
}

/**
 * @param {object} options
 * @param {(method: 'GET' | 'POST', body: object, options?: { keepalive?: boolean }) => Promise<DraftResponse>} options.request
 * @param {{ getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void }} options.storage
 * @param {string} options.storageKey Where this browser keeps the drafts
 * @param {string} [options.legacyKey] The single draft older versions kept; it moves into the first chat opened
 * @param {() => string} options.getText Current text of the box
 * @param {(text: string) => void} options.setText Replaces the box
 * @param {(conflict: { text: string, reason: 'differs' | 'replaced', use: () => void }) => void} options.onConflict
 *   Another version exists ('differs'), or another device kept its version over this one ('replaced'); use() switches to it
 * @param {string} options.clientId Unique per page
 * @param {string} options.deviceId Unique per browser, kept across page loads
 * @param {number} [options.pushDelay]
 * @param {() => number} [options.now]
 * @param {typeof setTimeout} [options.setTimer]
 * @param {typeof clearTimeout} [options.clearTimer]
 */
export function createInputDraftSync({
    request, storage, storageKey, legacyKey, getText, setText, onConflict, clientId, deviceId,
    pushDelay = DRAFT_PUSH_DELAY, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
    /** @type {string | null} */
    let activeKey = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    // Saves and fetches run one at a time, in order.
    /** @type {Promise<void>} */
    let queue = Promise.resolve();

    function readAll() {
        try {
            const data = JSON.parse(storage.getItem(storageKey) || 'null');
            if (data && typeof data.entries === 'object' && data.entries !== null) return data.entries;
        } catch {
            // Unreadable: start over.
        }
        return {};
    }

    /**
     * @param {string} key
     * @returns {LocalDraft}
     */
    function read(key) {
        const entry = readAll()[key];
        return {
            text: typeof entry?.text === 'string' ? entry.text : '',
            syncedAt: Number(entry?.syncedAt) || 0,
            dirty: Boolean(entry?.dirty),
            mine: Boolean(entry?.mine),
            forced: Boolean(entry?.forced),
        };
    }

    /**
     * @param {string} key
     * @param {LocalDraft} draft
     */
    function write(key, draft) {
        // Read-modify-write, so drafts other tabs keep for other chats survive.
        const entries = readAll();
        // An emptied draft still remembers its version, so a sent message is not refilled from elsewhere.
        if (!draft.text && !draft.dirty && !draft.syncedAt) {
            delete entries[key];
        } else {
            entries[key] = { ...draft, touchedAt: now() };
        }
        const keys = Object.keys(entries);
        if (keys.length > LOCAL_LIMIT) {
            keys.filter(other => other !== key)
                .sort((a, b) => (entries[a].touchedAt || 0) - (entries[b].touchedAt || 0))
                .slice(0, keys.length - LOCAL_LIMIT)
                .forEach(other => delete entries[other]);
        }
        try {
            storage.setItem(storageKey, JSON.stringify({ entries }));
        } catch {
            // Storage full or blocked: the server copy still works.
        }
    }

    /** @param {() => Promise<void>} task */
    function enqueue(task) {
        queue = queue.then(task).catch(() => undefined);
        return queue;
    }

    function cancelTimer() {
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
    }

    /**
     * Mirrors the box into the active chat's draft.
     * @returns {boolean} Whether it changed
     */
    function capture() {
        if (activeKey === null) return false;
        const text = getText();
        const local = read(activeKey);
        if (local.text === text) return false;
        write(activeKey, { ...local, text, dirty: true, mine: true });
        return true;
    }

    /**
     * @param {string} key
     * @param {{ text: string, updatedAt: number }} other
     * @param {LocalDraft} local
     * @param {'differs' | 'replaced'} reason
     */
    function settleConflict(key, other, local, reason) {
        // Left that chat already: stays unsaved and is asked about when it is open again.
        if (key !== activeKey) return;
        cancelTimer();
        // From here on the text on screen is based on the other version: typing on replaces it (and the
        // save tells the server so), leaving it alone keeps the other version on the server.
        write(key, { ...local, syncedAt: other.updatedAt, dirty: false, forced: true });
        // Emptied here (the message was sent): nothing to ask, and the other text is not pulled in.
        if (!local.text) return;
        onConflict({
            text: other.text,
            reason,
            use: () => {
                if (key !== activeKey) return;
                const current = read(key);
                if (!current.dirty && current.syncedAt === other.updatedAt) {
                    // The server still holds that version: just show it.
                    write(key, { text: other.text, syncedAt: other.updatedAt, dirty: false, mine: false, forced: false });
                    setText(other.text);
                    return;
                }
                // Saved or typed here since: save the chosen one over that, like typed text.
                write(key, { ...current, forced: false });
                setText(other.text);
                if (capture()) schedule(0);
            },
        });
    }

    /**
     * @param {string} key
     * @param {boolean} keepalive
     */
    async function pushNow(key, keepalive = false) {
        const sent = read(key);
        if (!sent.dirty) return;
        const body = { key, text: sent.text, clientId, deviceId, baseUpdatedAt: sent.syncedAt, overriding: sent.forced };
        const response = await request('POST', body, { keepalive });
        // Not through (offline, node busy, too long): stays dirty and goes again on the next change, focus or reconnect.
        if (!response) return;
        const latest = read(key);
        if (response.status === 200) {
            const updatedAt = Number(response.data?.updatedAt) || sent.syncedAt;
            write(key, { ...latest, syncedAt: updatedAt, dirty: latest.text !== sent.text, forced: false });
        } else if (response.status === 409) {
            settleConflict(key, readRemote(response.data), latest, 'differs');
        }
    }

    /** @param {string} key */
    async function pullNow(key) {
        const response = await request('GET', { key });
        if (!response || response.status !== 200 || key !== activeKey) return;
        const remote = readRemote(response.data);
        capture();
        const local = read(key);
        if (remote.updatedAt <= local.syncedAt) return;
        if (remote.clientId === clientId) {
            // Saved by this page; the answer got lost on the way.
            const same = local.text === remote.text;
            write(key, { ...local, syncedAt: remote.updatedAt, dirty: !same, forced: local.forced && !same });
            return;
        }
        // Another device kept its version over the one typed here: ask, though nothing was typed since.
        const replacedHere = remote.overrode === deviceId && local.mine && Boolean(local.text) && local.text !== remote.text;
        if ((!local.dirty || local.text === remote.text) && !replacedHere) {
            write(key, { text: remote.text, syncedAt: remote.updatedAt, dirty: false, mine: false, forced: false });
            if (getText() !== remote.text) setText(remote.text);
            return;
        }
        settleConflict(key, remote, local, local.dirty ? 'differs' : 'replaced');
    }

    /** @param {any} data */
    function readRemote(data) {
        return {
            text: typeof data?.text === 'string' ? data.text : '',
            updatedAt: Number(data?.updatedAt) || 0,
            clientId: typeof data?.clientId === 'string' ? data.clientId : '',
            overrode: typeof data?.overrode === 'string' ? data.overrode : '',
        };
    }

    /** @param {number} delay */
    function schedule(delay) {
        cancelTimer();
        const key = activeKey;
        if (key === null) return;
        timer = setTimer(() => {
            timer = null;
            void enqueue(() => pushNow(key));
        }, delay);
    }

    /** @param {string} key */
    function sync(key) {
        return enqueue(async () => {
            await pushNow(key);
            await pullNow(key);
        });
    }

    /** @param {string} key */
    function adoptLegacy(key) {
        if (!legacyKey || key === 'none') return;
        const legacy = storage.getItem(legacyKey);
        if (legacy === null) return;
        storage.removeItem(legacyKey);
        if (legacy && !read(key).text) {
            write(key, { text: legacy, syncedAt: 0, dirty: true, mine: true, forced: false });
        }
    }

    return {
        /** The box changed. */
        input() {
            if (capture()) schedule(getText() ? pushDelay : 0);
        },
        /**
         * A chat is open (or none): show its draft and sync it. Calling it for the open chat just syncs.
         * @param {string} key
         */
        switchTo(key) {
            if (key !== activeKey) {
                if (activeKey !== null) {
                    capture();
                    cancelTimer();
                    const previous = activeKey;
                    void enqueue(() => pushNow(previous));
                }
                activeKey = key;
                adoptLegacy(key);
                const local = read(key);
                if (getText() !== local.text) setText(local.text);
            }
            return sync(key);
        },
        /** The page is being hidden or closed: save now, in a request that may outlive the page. */
        hide() {
            if (activeKey === null) return queue;
            capture();
            cancelTimer();
            const key = activeKey;
            return enqueue(() => pushNow(key, true));
        },
        /** Waits for pending saves and fetches (a scheduled save is sent first). */
        flush() {
            if (timer !== null && activeKey !== null) {
                cancelTimer();
                const key = activeKey;
                void enqueue(() => pushNow(key));
            }
            return queue;
        },
        get activeKey() {
            return activeKey;
        },
    };
}
