/**
 * Browser copy of the character list. The full list carries every card's complete data and can
 * be tens of megabytes; the server sends only the cards whose file changed since this browser
 * last saw them (src/character-list-delta.js) and the rest come from here, so the list is the
 * same as the full one. Whenever anything is off, it falls back to the full list.
 *
 * Cards are stored as the exact JSON text the server sent, so later in-memory edits never leak
 * into the copy. Storage is best effort: a failed write only means a full download next time.
 */

const DB_NAME = 'SillyTavern_CharacterList';
const DB_VERSION = 1;
const VERSIONS = 'versions';
const CARDS = 'cards';
const DELTA_FORMAT = 1;
const OPEN_TIMEOUT_MS = 1500;
const VERSIONS_TIMEOUT_MS = 1500;
const CARDS_TIMEOUT_MS = 8000;
/** Libraries larger than this (characters of JSON) are not kept in the browser. */
const MAX_STORED_CHARS = 160 * 1024 * 1024;

/** @type {Promise<IDBDatabase|null>|null} */
let databasePromise = null;

function withTimeout(promise, milliseconds) {
    let timer;
    return Promise.race([
        promise,
        new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds); }),
    ]).finally(() => clearTimeout(timer));
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/** Keys of one user's entries: [user, avatar] for every avatar. */
function userRange(user) {
    return IDBKeyRange.bound([user], [user, []]);
}

/**
 * Opens the database once per page; resolves to null where IndexedDB is missing, blocked or slow.
 * @returns {Promise<IDBDatabase|null>}
 */
function openDatabase() {
    if (databasePromise) {
        return databasePromise;
    }
    databasePromise = new Promise(resolve => {
        let settled = false;
        const finish = database => {
            if (settled) {
                database?.close();
                return;
            }
            settled = true;
            resolve(database);
        };
        const timer = setTimeout(() => finish(null), OPEN_TIMEOUT_MS);
        try {
            if (typeof indexedDB === 'undefined') {
                clearTimeout(timer);
                finish(null);
                return;
            }
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                for (const name of [VERSIONS, CARDS]) {
                    if (!database.objectStoreNames.contains(name)) {
                        database.createObjectStore(name, { keyPath: ['user', 'avatar'] });
                    }
                }
            };
            request.onsuccess = () => {
                clearTimeout(timer);
                const database = request.result;
                database.onversionchange = () => database.close();
                finish(database);
            };
            request.onerror = () => {
                clearTimeout(timer);
                finish(null);
            };
        } catch {
            clearTimeout(timer);
            finish(null);
        }
    });
    return databasePromise;
}

/**
 * @param {IDBDatabase} database
 * @param {string} user
 * @returns {Promise<Map<string, string>>} Avatar to version
 */
async function readVersions(database, user) {
    const store = database.transaction(VERSIONS, 'readonly').objectStore(VERSIONS);
    const records = await requestResult(store.getAll(userRange(user)));
    return new Map(records.map(record => [record.avatar, record.version]));
}

/**
 * @param {IDBDatabase} database
 * @param {string} user
 * @returns {Promise<Map<string, {version: string, json: string}>>} Avatar to stored card
 */
async function readCards(database, user) {
    const store = database.transaction(CARDS, 'readonly').objectStore(CARDS);
    const records = await requestResult(store.getAll(userRange(user)));
    return new Map(records.map(record => [record.avatar, record]));
}

/**
 * Rebuild the full list from a delta response and the stored cards.
 * @param {string} text Delta response body
 * @param {Map<string, {version: string, json: string}>|null} stored Stored cards
 * @returns {{characters: object[], fresh: {avatar: string, version: string, json: string}[], unversioned: string[], avatars: string[], storedChars: number}|null} Null when the list cannot be rebuilt exactly
 */
export function rebuildCharacterList(text, stored) {
    const lines = text.split('\n');
    const header = JSON.parse(lines[0]);
    if (header?.format !== DELTA_FORMAT || !Array.isArray(header.list)) {
        return null;
    }
    const characters = [];
    const fresh = [];
    const unversioned = [];
    let next = 1;
    let storedChars = 0;
    for (const [avatar, version, chatSize, dateLastChat, sent] of header.list) {
        if (sent) {
            const json = lines[next++];
            if (json === undefined) {
                return null;
            }
            characters.push(JSON.parse(json));
            if (version) {
                fresh.push({ avatar, version, json });
            } else {
                unversioned.push(avatar);
            }
            storedChars += json.length;
        } else {
            const card = stored?.get(avatar);
            if (!card || card.version !== version) {
                return null;
            }
            const character = JSON.parse(card.json);
            // Chat statistics come from the chat folder, not the card file.
            character.chat_size = chatSize;
            character.date_last_chat = dateLastChat;
            characters.push(character);
            storedChars += card.json.length;
        }
    }
    if (next !== lines.length) {
        return null;
    }
    return { characters, fresh, unversioned, avatars: header.list.map(entry => entry[0]), storedChars };
}

/**
 * Store new cards and drop deleted ones, in one transaction.
 * @param {IDBDatabase} database
 * @param {string} user
 * @param {ReturnType<typeof rebuildCharacterList>} result
 * @param {Iterable<string>} previousAvatars Avatars stored before this load
 */
function saveCards(database, user, result, previousAvatars) {
    try {
        const transaction = database.transaction([VERSIONS, CARDS], 'readwrite');
        const versions = transaction.objectStore(VERSIONS);
        const cards = transaction.objectStore(CARDS);
        if (result.storedChars > MAX_STORED_CHARS) {
            versions.delete(userRange(user));
            cards.delete(userRange(user));
            return;
        }
        // Drop deleted cards and cards the server no longer lets the browser keep.
        const keep = new Set(result.avatars);
        result.unversioned.forEach(avatar => keep.delete(avatar));
        for (const avatar of previousAvatars) {
            if (!keep.has(avatar)) {
                versions.delete([user, avatar]);
                cards.delete([user, avatar]);
            }
        }
        for (const { avatar, version, json } of result.fresh) {
            versions.put({ user, avatar, version });
            cards.put({ user, avatar, version, json });
        }
    } catch (error) {
        console.debug('Character list copy not saved', error);
    }
}

async function fetchFullList(getHeaders) {
    const response = await fetch('/api/characters/all', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({}),
    });
    return { response, characters: response.ok ? await response.json() : null };
}

/**
 * Fetch the character list, reusing the cards this browser already holds.
 * @param {object} options
 * @param {() => Record<string, string>} options.getHeaders Request headers
 * @param {string} options.user Current user handle
 * @returns {Promise<{response: Response, characters: object[]|null}>} characters is null when the response is not OK
 */
export async function fetchCharacterList({ getHeaders, user }) {
    const database = await openDatabase();
    const known = database ? await withTimeout(readVersions(database, user).catch(() => null), VERSIONS_TIMEOUT_MS) : null;
    if (!database || !known) {
        return fetchFullList(getHeaders);
    }

    // Read the stored cards while the request is on the wire.
    const storedPromise = known.size
        ? withTimeout(readCards(database, user).catch(() => null), CARDS_TIMEOUT_MS)
        : Promise.resolve(new Map());
    const response = await fetch('/api/characters/all', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ cached: Object.fromEntries(known) }),
    });
    if (!response.ok) {
        return { response, characters: null };
    }
    if (!String(response.headers.get('content-type')).startsWith('text/plain')) {
        // A server without deltas (or with lazy loading) sends the plain list.
        return { response, characters: await response.json() };
    }

    const text = await response.text();
    let result = null;
    try {
        result = rebuildCharacterList(text, await storedPromise);
    } catch (error) {
        console.warn('Character list copy unusable, loading the full list', error);
    }
    if (!result) {
        return fetchFullList(getHeaders);
    }
    saveCards(database, user, result, known.keys());
    return { response, characters: result.characters };
}

/**
 * Forget one user's stored cards (on logout).
 * @param {string} user User handle
 */
export async function clearCharacterListStore(user) {
    const database = await openDatabase();
    if (!database) {
        return;
    }
    try {
        const transaction = database.transaction([VERSIONS, CARDS], 'readwrite');
        transaction.objectStore(VERSIONS).delete(userRange(user));
        transaction.objectStore(CARDS).delete(userRange(user));
        await withTimeout(new Promise(resolve => {
            transaction.oncomplete = transaction.onerror = transaction.onabort = resolve;
        }), 1000);
    } catch {
        // Nothing stored or storage unavailable.
    }
}

// Open early so the first character load does not wait for it.
void openDatabase();
