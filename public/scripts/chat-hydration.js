/**
 * Chat hydration keeps the whole chat in `chat` (every message, real indices)
 * without holding the bulky fields of old messages in memory.
 *
 * Old messages arrive as a light copy; fields the server omitted (plugin state
 * snapshots, swipe copies, long reasoning...) are fetched synchronously the
 * first time something reads them. Every message tracks its own changes, so a
 * save sends only what changed, and untouched messages are kept on the server
 * by reference.
 */

/** @type {WeakMap<object, FieldState>} */
const STATE = new WeakMap();
/** Prompt copies of messages, so copying them never downloads omitted fields. */
const PROMPT_COPIES = new WeakMap();
/** One shared accessor pair per property name. */
const ACCESSORS = new Map();

const FETCH_BATCH_CHARS = 1024 * 1024;
const FETCH_BATCH_RADIUS = 24;
const FETCH_BATCH_MAX_ITEMS = 300;
const PREFETCH_LIMIT_CHARS = 48 * 1024 * 1024;
/** Removed messages keep their omitted fields (fetched before the save) so they can be re-inserted. */
const MATERIALIZE_REMOVED_LIMIT = 64;

/** Fields `ensureMessageMediaIsArray` moves into arrays, and the arrays it fills. */
const LEGACY_MEDIA_KEYS = ['image', 'file', 'video', 'image_swipes'];
const MIGRATED_MEDIA_KEYS = ['media', 'files', 'media_display', 'media_index'];

let changeVersion = 0;

/**
 * Fingerprint of a JSON string, kept instead of the string itself so loaded
 * history costs no extra memory: length plus two independent 53-bit hashes.
 * @param {string|undefined} json JSON text
 * @returns {string}
 */
function fingerprint(json) {
    if (json === undefined) {
        return 'undefined';
    }
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    let h3 = 0x2f8a7b13;
    let h4 = 0x9e3779b9;
    for (let i = 0; i < json.length; i++) {
        const ch = json.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
        h3 = Math.imul(h3 ^ ch, 2246822507);
        h4 = Math.imul(h4 ^ ch, 3266489909);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    h3 = Math.imul(h3 ^ (h3 >>> 16), 2654435761) ^ Math.imul(h4 ^ (h4 >>> 13), 1597334677);
    h4 = Math.imul(h4 ^ (h4 >>> 16), 2654435761) ^ Math.imul(h3 ^ (h3 >>> 13), 1597334677);
    const a = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    const b = 4294967296 * (2097151 & h4) + (h3 >>> 0);
    return `${json.length}:${a.toString(36)}:${b.toString(36)}`;
}

function isObjectValue(value) {
    return value !== null && typeof value === 'object';
}

/** Enumerable own property; compatibility getters (non-enumerable) are not data. */
function isOwnField(object, key) {
    return Object.prototype.propertyIsEnumerable.call(object, key);
}

function isPlainRecord(value) {
    return isObjectValue(value) && !Array.isArray(value);
}

class FieldState {
    /**
     * @param {ChatHydrationSession} session Owning session
     * @param {object} owner Object these fields belong to
     * @param {FieldState|null} parent Message state, for a nested `extra`
     * @param {string|null} parentKey Key of this object inside the parent
     */
    constructor(session, owner, parent = null, parentKey = null) {
        this.session = session;
        this.owner = owner;
        this.parent = parent;
        this.parentKey = parentKey;
        /** Position on the server, for messages; null until the server has it. */
        this.serverIndex = null;
        /** Must be sent whole on the next save (never confirmed by the server). */
        this.fullDirty = false;
        /** @type {Map<string, any>} */
        this.values = new Map();
        /** @type {Map<string, {hash: string, size: number}>} */
        this.lazy = new Map();
        /** @type {Map<string, string>} */
        this.prefetched = new Map();
        /** @type {Map<string, number>} */
        this.dirty = new Map();
        /** JSON of object values as the server has them. @type {Map<string, string>} */
        this.touched = new Map();
        /** @type {Map<string, object>} */
        this.nested = new Map();
        /** @type {Set<string>} */
        this.deleted = new Set();
    }

    get root() {
        return this.parent ? this.parent.root : this;
    }

    /** @param {string} key */
    path(key) {
        return this.parent ? [...this.parent.path(this.parentKey), key] : [key];
    }

    /** @param {string} key */
    read(key) {
        if (this.lazy.has(key)) {
            const json = this.session.loadLazy(this, key);
            const value = JSON.parse(json);
            this.lazy.delete(key);
            this.values.set(key, value);
            if (isObjectValue(value)) {
                this.touched.set(key, fingerprint(json));
            }
            return value;
        }
        const value = this.values.get(key);
        if (isObjectValue(value) && !this.touched.has(key) && !this.nested.has(key)) {
            // The caller may now change it in place; remember what the server has.
            this.touched.set(key, fingerprint(JSON.stringify(value)));
        }
        return value;
    }

    /** @param {string} key @param {any} value */
    write(key, value) {
        if (!isObjectValue(value) && this.values.has(key) && Object.is(this.values.get(key), value)) {
            // Same primitive value: nothing changed.
            return;
        }
        this.values.set(key, value);
        this.lazy.delete(key);
        this.session.dropPrefetch(this, key);
        this.touched.delete(key);
        this.nested.delete(key);
        this.deleted.delete(key);
        this.dirty.set(key, ++changeVersion);
    }
}

function accessorFor(key) {
    let accessor = ACCESSORS.get(key);
    if (accessor) {
        return accessor;
    }
    accessor = {
        get() {
            const state = STATE.get(this);
            return state ? state.read(key) : undefined;
        },
        set(value) {
            const state = STATE.get(this);
            if (state) {
                state.write(key, value);
            } else {
                Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true });
            }
        },
        enumerable: true,
        configurable: true,
    };
    ACCESSORS.set(key, accessor);
    return accessor;
}

/**
 * Collects the changes of one tracked object into field operations.
 * Bookkeeping that must only happen once the server confirms goes to `commits`.
 * @param {FieldState} state Object state
 * @param {object} owner Tracked object
 * @param {object[]} ops Output operations
 * @param {Function[]} commits Output commit actions
 */
function collectChanges(state, owner, ops, commits) {
    const present = new Set(Object.keys(owner));

    // Plain data properties are new since the last save: added, or deleted and
    // set again (a delete removes the tracking accessor).
    for (const key of present) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.configurable) {
            continue;
        }
        state.values.set(key, descriptor.value);
        state.lazy.delete(key);
        state.session.dropPrefetch(state, key);
        state.touched.delete(key);
        state.nested.delete(key);
        state.deleted.delete(key);
        Object.defineProperty(owner, key, accessorFor(key));
        state.dirty.set(key, ++changeVersion);
    }

    // Properties deleted since the last save.
    for (const key of [...state.values.keys(), ...state.lazy.keys()]) {
        if (present.has(key)) {
            continue;
        }
        state.values.delete(key);
        state.lazy.delete(key);
        state.session.dropPrefetch(state, key);
        state.touched.delete(key);
        state.nested.delete(key);
        state.dirty.delete(key);
        state.deleted.add(key);
    }

    for (const key of state.deleted) {
        ops.push({ p: state.path(key), d: 1 });
        commits.push(() => {
            if (!state.values.has(key) && !state.lazy.has(key)) {
                state.deleted.delete(key);
            }
        });
    }

    for (const [key, version] of state.dirty) {
        const value = state.values.get(key);
        const json = JSON.stringify(value);
        ops.push(json === undefined ? { p: state.path(key), d: 1 } : { p: state.path(key), v: value });
        commits.push(() => {
            if (state.dirty.get(key) !== version) {
                return;
            }
            state.dirty.delete(key);
            if (isObjectValue(value) && json !== undefined && state.values.get(key) === value && !state.nested.has(key)) {
                state.touched.set(key, fingerprint(json));
            }
        });
    }

    for (const [key, baseline] of state.touched) {
        if (state.dirty.has(key) || !state.values.has(key)) {
            continue;
        }
        const value = state.values.get(key);
        const json = JSON.stringify(value);
        const current = fingerprint(json);
        if (current === baseline) {
            continue;
        }
        ops.push(json === undefined ? { p: state.path(key), d: 1 } : { p: state.path(key), v: value });
        commits.push(() => {
            if (state.touched.get(key) === baseline) {
                state.touched.set(key, current);
            }
        });
    }

    for (const [key, nestedObject] of state.nested) {
        if (state.values.get(key) !== nestedObject || state.dirty.has(key)) {
            continue;
        }
        collectChanges(STATE.get(nestedObject), nestedObject, ops, commits);
    }
}

export class ChatHydrationSession {
    /**
     * @param {object} options
     * @param {boolean} options.isGroup Group chat
     * @param {object} options.target Request fields that identify the chat file
     * @param {string|null} options.revision Revision of the loaded page
     * @param {() => Record<string, string>} options.getHeaders Request headers
     * @param {(message: object) => void} [options.normalizeMessage] Media normalization for loaded messages
     * @param {() => void} [options.onMissingData] Called when the server no longer has a field
     */
    constructor({ isGroup, target, revision, getHeaders, normalizeMessage = () => { }, onMissingData = () => { } }) {
        this.isGroup = Boolean(isGroup);
        this.target = { ...target };
        this.revision = revision;
        this.knownRevisions = new Set(revision ? [revision] : []);
        this.getHeaders = getHeaders;
        this.normalizeMessage = normalizeMessage;
        this.onMissingData = onMissingData;
        /** Objects in server order, as of the last confirmed save or the hydration. */
        this.serverOrder = [];
        /** History messages added by the hydration, oldest first. */
        this.history = [];
        this.hydrated = false;
        this.failed = false;
        /** Positions a save in flight will give each object, for lookups during it. @type {Map<object, number>|null} */
        this.pendingIndex = null;
        this.prefetchQueue = [];
        this.prefetchChars = 0;
        this.lastMissIndex = null;
        this.scanStreak = 0;
        this.batchRadius = FETCH_BATCH_RADIUS;
        this.queue = Promise.resolve();
        this.ready = Promise.resolve();
    }

    get baseUrl() {
        return this.isGroup ? '/api/chats/group' : '/api/chats';
    }

    /** Runs tasks for this chat one at a time (hydration and saves). */
    enqueue(task) {
        const run = this.queue.then(task, task);
        this.queue = run.catch(() => { });
        return run;
    }

    /** @param {string} revision Revision confirmed by the server */
    noteRevision(revision) {
        if (typeof revision === 'string' && revision) {
            this.revision = revision;
            this.knownRevisions.add(revision);
        }
    }

    /**
     * Loads every message before the loaded page as light, tracked messages.
     * @param {object} options
     * @param {number} options.beforeLine Chunk line where the loaded page starts
     * @param {AbortSignal} [options.signal] Abort signal
     * @returns {Promise<object[]|null>} Messages oldest first, or null if hydration is not possible
     */
    async loadHistory({ beforeLine, signal }) {
        const pages = [];
        let request = { beforeLine };
        let cursor = null;
        for (let guard = 0; guard < 100_000; guard++) {
            const response = await fetch(`${this.baseUrl}/hydrate-page`, {
                method: 'POST',
                headers: this.getHeaders(),
                body: JSON.stringify({ ...this.target, ...request }),
                signal,
            });
            if (!response.ok) {
                return null;
            }
            const data = await response.json();
            if (!this.knownRevisions.has(data?.revision) || !Array.isArray(data.items) || !Number.isInteger(data.start)) {
                return null;
            }
            const end = data.start + data.items.length;
            if (cursor !== null && end !== cursor) {
                return null;
            }
            if (data.items.length === 0 && data.start !== 0) {
                return null;
            }
            pages.unshift(data.items);
            cursor = data.start;
            if (cursor <= 0) {
                break;
            }
            request = { before: cursor };
        }
        if (cursor !== 0) {
            return null;
        }
        const items = pages.flat();
        return items.map((item, index) => this.buildMessage(item, index));
    }

    /**
     * Builds a tracked message from a hydration item.
     * @param {any[]} item [light, lazySpecs?, keyOrders?]
     * @param {number} serverIndex Message position on the server
     */
    buildMessage(item, serverIndex) {
        const [light, lazySpecs, orders] = item;
        // Legacy media fields are migrated on load; the migration must reach the server.
        const legacyMedia = isPlainRecord(light.extra)
            ? LEGACY_MEDIA_KEYS.filter(key => Object.hasOwn(light.extra, key))
            : [];
        this.normalizeMessage(light);
        const lazyTop = new Map();
        const lazyExtra = new Map();
        for (const [valuePath, hash, size] of Array.isArray(lazySpecs) ? lazySpecs : []) {
            if (valuePath.length === 1) {
                lazyTop.set(valuePath[0], { hash, size });
            } else if (valuePath.length === 2 && valuePath[0] === 'extra') {
                lazyExtra.set(valuePath[1], { hash, size });
            }
        }

        const owner = {};
        const state = new FieldState(this, owner);
        state.serverIndex = serverIndex;
        STATE.set(owner, state);
        const keys = [...new Set([...(orders?.[0] ?? []), ...Object.keys(light), ...lazyTop.keys()])];
        for (const key of keys) {
            if (lazyTop.has(key)) {
                state.lazy.set(key, lazyTop.get(key));
            } else if (key === 'extra' && lazyExtra.size && isPlainRecord(light.extra)) {
                const extra = this.buildNested(light.extra, lazyExtra, orders?.[1], state, 'extra');
                state.values.set(key, extra);
                state.nested.set(key, extra);
            } else if (isOwnField(light, key)) {
                state.values.set(key, light[key]);
            } else {
                continue;
            }
            Object.defineProperty(owner, key, accessorFor(key));
        }
        if (state.nested.has('extra')) {
            // Restores the media compatibility getters on the nested object.
            this.normalizeMessage({ extra: state.values.get('extra') });
        }
        if (legacyMedia.length) {
            const extra = state.values.get('extra');
            const extraState = state.nested.has('extra') ? STATE.get(extra) : null;
            if (extraState) {
                for (const key of legacyMedia) {
                    if (!extraState.values.has(key) && !extraState.lazy.has(key)) {
                        extraState.deleted.add(key);
                    }
                }
                for (const key of MIGRATED_MEDIA_KEYS) {
                    if (extraState.values.has(key)) {
                        extraState.dirty.set(key, ++changeVersion);
                    }
                }
            } else if (state.values.has('extra')) {
                state.dirty.set('extra', ++changeVersion);
            }
        }
        return owner;
    }

    buildNested(light, lazy, order, parent, parentKey) {
        const owner = {};
        const state = new FieldState(this, owner, parent, parentKey);
        STATE.set(owner, state);
        const keys = [...new Set([...(order ?? []), ...Object.keys(light), ...lazy.keys()])];
        for (const key of keys) {
            if (lazy.has(key)) {
                state.lazy.set(key, lazy.get(key));
            } else if (isOwnField(light, key)) {
                state.values.set(key, light[key]);
            } else {
                continue;
            }
            Object.defineProperty(owner, key, accessorFor(key));
        }
        return owner;
    }

    /**
     * Starts tracking a plain message in place, as the server will have it after it is sent.
     * @param {object} owner Message object
     * @returns {FieldState}
     */
    adopt(owner) {
        const existing = STATE.get(owner);
        if (existing && existing.session === this && !existing.parent) {
            // Sent whole: every field becomes what the server has.
            this.resetToCurrent(existing, owner);
            return existing;
        }
        const values = new Map();
        for (const key of Object.keys(owner)) {
            const descriptor = Object.getOwnPropertyDescriptor(owner, key);
            if (!descriptor || !descriptor.configurable) {
                continue;
            }
            values.set(key, owner[key]);
        }
        const state = new FieldState(this, owner);
        for (const [key, value] of values) {
            state.values.set(key, value);
            if (isObjectValue(value)) {
                state.touched.set(key, fingerprint(JSON.stringify(value)));
            }
        }
        STATE.set(owner, state);
        for (const key of values.keys()) {
            Object.defineProperty(owner, key, accessorFor(key));
        }
        return state;
    }

    resetToCurrent(state, owner) {
        const present = new Set(Object.keys(owner));
        for (const key of [...state.values.keys()]) {
            if (!present.has(key)) {
                state.values.delete(key);
            }
        }
        for (const key of present) {
            if (!state.values.has(key) && !state.lazy.has(key)) {
                const descriptor = Object.getOwnPropertyDescriptor(owner, key);
                if (!descriptor || !descriptor.configurable || !('value' in descriptor)) {
                    continue;
                }
                state.values.set(key, descriptor.value);
                Object.defineProperty(owner, key, accessorFor(key));
            }
        }
        state.dirty.clear();
        state.deleted.clear();
        state.touched.clear();
        for (const [key, value] of state.values) {
            if (isObjectValue(value) && !state.nested.has(key)) {
                state.touched.set(key, fingerprint(JSON.stringify(value)));
            }
        }
    }

    /**
     * Builds the save request for the current chat.
     * @param {object[]} snapshot Chat messages, as they are now
     * @param {object} fields Extra request fields (header, force...)
     * @returns {{body: string, commit: (revision: string) => void, rollback: () => void, from: number, items: number}}
     */
    prepareSave(snapshot, fields) {
        const messages = snapshot.slice();
        const count = messages.length;
        const order = this.serverOrder;
        let from = count === order.length ? count : Math.min(count, order.length);
        const commits = [];
        const tracked = new Array(count).fill(false);
        const opsByIndex = new Array(count);

        for (let i = 0; i < count; i++) {
            const owner = messages[i];
            const state = isObjectValue(owner) ? STATE.get(owner) : undefined;
            const isTracked = Boolean(state && state.session === this && !state.parent && state.serverIndex !== null && !state.fullDirty);
            tracked[i] = isTracked;
            if (!isTracked || order[i] !== owner) {
                from = Math.min(from, i);
            }
            if (isTracked) {
                const ops = [];
                collectChanges(state, owner, ops, commits);
                if (ops.length) {
                    opsByIndex[i] = ops;
                    from = Math.min(from, i);
                }
            }
        }

        // Messages leaving the chat take their omitted fields with them.
        const remaining = new Set(messages);
        const removed = order.filter(owner => !remaining.has(owner));
        for (const owner of removed.slice(0, MATERIALIZE_REMOVED_LIMIT)) {
            this.materialize(owner);
        }

        const items = [];
        let run = null;
        for (let i = from; i < count; i++) {
            const owner = messages[i];
            if (tracked[i] && !opsByIndex[i]) {
                const index = STATE.get(owner).serverIndex;
                if (run && index === run[1] + 1) {
                    run[1] = index;
                } else {
                    run = [index, index];
                    items.push({ r: run });
                }
                continue;
            }
            run = null;
            if (tracked[i]) {
                items.push({ p: STATE.get(owner).serverIndex, o: opsByIndex[i] });
                continue;
            }
            const existing = isObjectValue(owner) ? STATE.get(owner) : undefined;
            if (!isObjectValue(owner) || existing?.parent) {
                // Not a message object of its own (e.g. another message's nested
                // object): never take over its tracking, always send it whole.
                items.push({ m: owner });
                continue;
            }
            const state = this.adopt(owner);
            state.fullDirty = true;
            items.push({ m: owner });
        }

        const body = JSON.stringify({
            ...this.target,
            ...fields,
            expectedRevision: this.revision,
            from,
            items,
        });
        const pendingIndex = new Map();
        messages.forEach((owner, index) => {
            if (isObjectValue(owner) && !pendingIndex.has(owner)) {
                pendingIndex.set(owner, index);
            }
        });
        this.pendingIndex = pendingIndex;

        return {
            body,
            from,
            items: items.length,
            commit: (revision) => {
                for (const action of commits) {
                    action();
                }
                messages.forEach((owner, index) => {
                    const state = isObjectValue(owner) ? STATE.get(owner) : undefined;
                    if (state && state.session === this && !state.parent) {
                        state.serverIndex = index;
                        state.fullDirty = false;
                    }
                });
                for (const owner of removed) {
                    const state = STATE.get(owner);
                    if (state && state.session === this && !remaining.has(owner)) {
                        state.serverIndex = null;
                    }
                }
                this.serverOrder = messages;
                this.pendingIndex = null;
                this.noteRevision(revision);
            },
            rollback: () => {
                // Adopted messages stay fullDirty and every change stays pending.
                this.pendingIndex = null;
            },
        };
    }

    /** Loads every omitted field of a message (and its nested objects). */
    materialize(owner) {
        const state = STATE.get(owner);
        if (!state || state.session !== this || state.serverIndex === null) {
            return;
        }
        for (const key of [...state.lazy.keys()]) {
            void owner[key];
        }
        for (const nested of state.nested.values()) {
            const nestedState = STATE.get(nested);
            for (const key of [...(nestedState?.lazy.keys() ?? [])]) {
                void nested[key];
            }
        }
    }

    /**
     * Loads an omitted field synchronously; fetches nearby omitted fields along with it.
     * @param {FieldState} state Field owner
     * @param {string} key Field name
     * @returns {string} Field JSON
     */
    loadLazy(state, key) {
        const prefetched = state.prefetched.get(key);
        if (prefetched !== undefined) {
            this.dropPrefetch(state, key);
            return prefetched;
        }
        const batch = this.collectBatch(state, key);
        const values = this.fetchFields(batch);
        let result = null;
        batch.forEach((entry, index) => {
            const json = values[index];
            if (entry.state === state && entry.key === key) {
                result = json;
            } else if (typeof json === 'string' && entry.state.lazy.has(entry.key) && !entry.state.prefetched.has(entry.key)) {
                this.storePrefetch(entry.state, entry.key, json);
            }
        });
        if (typeof result !== 'string') {
            this.onMissingData();
            throw new Error(`Chat history field "${state.path(key).join('.')}" is no longer on the server.`);
        }
        return result;
    }

    collectBatch(state, key) {
        const requested = { state, key, spec: state.lazy.get(key) };
        if (state.root.serverIndex === null) {
            throw new Error('This message is no longer part of the saved chat.');
        }
        const center = state.root.serverIndex;
        // Something walking through history misses again close to the last miss:
        // grow the batch so a full scan takes a few requests instead of hundreds.
        const scanning = this.lastMissIndex !== null && Math.abs(center - this.lastMissIndex) <= this.batchRadius * 2 + 1;
        this.scanStreak = scanning ? Math.min(this.scanStreak + 1, 4) : 0;
        this.lastMissIndex = center;
        const batchChars = FETCH_BATCH_CHARS * (2 ** this.scanStreak);
        const batchItems = FETCH_BATCH_MAX_ITEMS * (2 ** this.scanStreak);
        this.batchRadius = FETCH_BATCH_RADIUS * (2 ** this.scanStreak);
        const batch = [requested];
        let chars = requested.spec?.size ?? 0;
        const visit = (owner) => {
            const rootState = isObjectValue(owner) ? STATE.get(owner) : undefined;
            if (!rootState || rootState.session !== this || rootState.serverIndex === null) {
                return true;
            }
            const states = [rootState, ...[...rootState.nested.values()].map(nested => STATE.get(nested)).filter(Boolean)];
            for (const candidate of states) {
                for (const [lazyKey, spec] of candidate.lazy) {
                    if ((candidate === state && lazyKey === key) || candidate.prefetched.has(lazyKey)) {
                        continue;
                    }
                    if (chars + spec.size > batchChars || batch.length >= batchItems) {
                        return false;
                    }
                    batch.push({ state: candidate, key: lazyKey, spec });
                    chars += spec.size;
                }
            }
            return true;
        };
        // Same message first, then outwards.
        if (!visit(state.root.owner)) {
            return batch;
        }
        for (let offset = 1; offset <= this.batchRadius; offset++) {
            const after = this.serverOrder[center + offset];
            const before = this.serverOrder[center - offset];
            if ((after && !visit(after)) || (before && !visit(before))) {
                break;
            }
        }
        return batch;
    }

    fetchFields(batch) {
        const items = batch.map(({ state, key, spec }) => {
            const root = state.root;
            const item = [root.serverIndex, state.path(key), spec.hash];
            const pending = this.pendingIndex?.get(root.owner);
            if (Number.isInteger(pending) && pending !== root.serverIndex) {
                item.push(pending);
            }
            return item;
        });
        const body = JSON.stringify({ ...this.target, items });
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const request = new XMLHttpRequest();
                request.open('POST', `${this.baseUrl}/hydrate-fields`, false);
                for (const [name, value] of Object.entries(this.getHeaders())) {
                    request.setRequestHeader(name, value);
                }
                request.send(body);
                if (request.status === 200) {
                    const data = JSON.parse(request.responseText);
                    if (Array.isArray(data?.values) && data.values.length === items.length) {
                        return data.values;
                    }
                }
                lastError = new Error(`Chat history request failed (${request.status})`);
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError ?? new Error('Chat history request failed');
    }

    storePrefetch(state, key, json) {
        state.prefetched.set(key, json);
        // The queue only orders evictions; the text lives in the map until it is read.
        this.prefetchQueue.push({ state, key });
        this.prefetchChars += json.length;
        while (this.prefetchChars > PREFETCH_LIMIT_CHARS && this.prefetchQueue.length) {
            const oldest = this.prefetchQueue.shift();
            this.dropPrefetch(oldest.state, oldest.key);
        }
        if (this.prefetchQueue.length > 4 * FETCH_BATCH_MAX_ITEMS && this.prefetchQueue.length > 2 * this.prefetchCount()) {
            this.prefetchQueue = this.prefetchQueue.filter(entry => entry.state.prefetched.has(entry.key));
        }
    }

    prefetchCount() {
        return this.prefetchQueue.reduce((total, entry) => total + Number(entry.state.prefetched.has(entry.key)), 0);
    }

    dropPrefetch(state, key) {
        const json = state.prefetched.get(key);
        if (json !== undefined) {
            state.prefetched.delete(key);
            this.prefetchChars -= json.length;
        }
    }
}

/**
 * Whether reading this field of a message would download it.
 * @param {object} owner Message or prompt copy
 * @param {string} key Field name
 */
function isDeferredField(owner, key) {
    const state = STATE.get(owner);
    if (state) {
        return state.lazy.has(key);
    }
    const copy = PROMPT_COPIES.get(owner);
    if (copy?.deferred.has(key)) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        return Boolean(descriptor?.get) && isDeferredField(copy.source, key);
    }
    return false;
}

function hasDeferredFields(owner) {
    const state = STATE.get(owner);
    if (state) {
        return state.lazy.size > 0;
    }
    return Boolean(PROMPT_COPIES.get(owner)?.deferred.size);
}

/**
 * Shallow copy of a message with some fields replaced, like `{...message, ...overrides}`,
 * except that omitted history fields stay omitted until something reads them.
 * @param {object} source Message
 * @param {object} overrides Replaced fields
 * @returns {object}
 */
export function copyMessageForPrompt(source, overrides) {
    if (!isObjectValue(source) || !hasDeferredFields(source)) {
        return { ...source, ...overrides };
    }
    const copy = {};
    const deferred = new Set();
    for (const key of Object.keys(source)) {
        if (!isDeferredField(source, key)) {
            copy[key] = source[key];
            continue;
        }
        deferred.add(key);
        Object.defineProperty(copy, key, {
            get() {
                return source[key];
            },
            set(value) {
                Object.defineProperty(copy, key, { value, writable: true, enumerable: true, configurable: true });
                deferred.delete(key);
            },
            enumerable: true,
            configurable: true,
        });
    }
    PROMPT_COPIES.set(copy, { source, deferred });
    return Object.assign(copy, overrides);
}

/**
 * Whether a message came from hydration (or was adopted by a session).
 * @param {object} owner Message
 */
export function isTrackedMessage(owner) {
    return isObjectValue(owner) && STATE.has(owner);
}
