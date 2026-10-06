import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Character list deltas: the browser keeps the cards it has already downloaded and sends their
 * versions; the server sends only the cards whose file changed since. The browser rebuilds the
 * same list it would have received in full.
 *
 * Response (text/plain), one JSON value per line:
 *   line 1: {"format":1,"list":[[avatar, version, chat_size, date_last_chat, sent], ...]}
 *   then one line per entry with sent = 1, in list order, holding the card exactly as the full list does.
 * JSON.stringify never emits a raw line feed, so splitting on "\n" is safe.
 */
export const CHARACTER_LIST_DELTA_FORMAT = 1;
export const CHARACTER_LIST_DELTA_TYPE = 'text/plain; charset=utf-8';

/** Marks list entries that differ on every read (a card with no saved chat name gets a fresh one); they are always sent. */
export const VOLATILE_CHARACTER = Symbol('volatileCharacter');

const MAX_KNOWN_ENTRIES = 20_000;
const MAX_KEY_LENGTH = 1024;
const MAX_VERSION_LENGTH = 64;

/**
 * Changes whenever the code that builds list entries changes, so browsers drop entries built by
 * older code. If a source cannot be read the tag is random, which only turns reuse off.
 */
const CODE_TAG = (() => {
    const hash = crypto.createHash('sha256');
    for (const file of ['./endpoints/characters.js', './character-card-parser.js']) {
        try {
            hash.update(fs.readFileSync(new URL(file, import.meta.url)));
        } catch {
            hash.update(crypto.randomBytes(16));
        }
    }
    return hash.digest('hex').slice(0, 16);
})();

/**
 * Version of one card file for one user. Any write, restore, replace or rename changes it.
 * @param {string} userKey Trusted user key
 * @param {string} fileName Card file name
 * @param {import('./character-list-cache.js').CharacterFileStats|undefined} stats File stats
 * @returns {string} Version, or '' when unknown (never reused)
 */
export function getCharacterVersion(userKey, fileName, stats) {
    if (!stats) {
        return '';
    }
    return crypto.createHash('sha256')
        .update([CODE_TAG, userKey, fileName, stats.size, stats.mtimeMs, stats.ctimeMs, stats.ino].join('\0'))
        .digest('base64url')
        .slice(0, 22);
}

/**
 * The versions a browser says it holds, or null when the request did not ask for a delta.
 * @param {any} body Request body
 * @returns {Map<string, string>|null} Avatar to version
 */
export function readKnownVersions(body) {
    const cached = body?.cached;
    if (!cached || typeof cached !== 'object' || Array.isArray(cached)) {
        return null;
    }
    const known = new Map();
    for (const [avatar, version] of Object.entries(cached)) {
        if (known.size >= MAX_KNOWN_ENTRIES) {
            break;
        }
        if (avatar.length <= MAX_KEY_LENGTH && typeof version === 'string' && version.length > 0 && version.length <= MAX_VERSION_LENGTH) {
            known.set(avatar, version);
        }
    }
    return known;
}

/**
 * Build a delta response body.
 * @param {object[]} characters Full character list entries
 * @param {Map<string, import('./character-list-cache.js').CharacterFileStats>|undefined} fileStats Stats by file name
 * @param {string} userKey Trusted user key
 * @param {Map<string, string>} known Versions the browser holds
 * @returns {{body: string, sent: number, reused: number}} Response body and counts
 */
export function buildCharacterListDelta(characters, fileStats, userKey, known) {
    const list = [];
    const lines = [];
    let reused = 0;
    for (const character of characters) {
        const avatar = String(character.avatar);
        const version = character[VOLATILE_CHARACTER] ? '' : getCharacterVersion(userKey, avatar, fileStats?.get(avatar));
        const reuse = version !== '' && known.get(avatar) === version;
        list.push([avatar, version, character.chat_size, character.date_last_chat, reuse ? 0 : 1]);
        if (reuse) {
            reused++;
        } else {
            lines.push(JSON.stringify(character));
        }
    }
    const header = JSON.stringify({ format: CHARACTER_LIST_DELTA_FORMAT, list });
    return {
        body: lines.length ? `${header}\n${lines.join('\n')}` : header,
        sent: lines.length,
        reused,
    };
}
