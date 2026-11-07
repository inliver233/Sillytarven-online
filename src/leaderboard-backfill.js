import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { parentPort, workerData } from 'node:worker_threads';

import { DAILY_CAPS, dayOf, hourOf, parseSendDate } from './leaderboard.js';

/**
 * Worker: counts the chat history of the given accounts once, for what happened before the
 * leaderboard counted live. Every account's result goes back to the server as soon as it is
 * done (the server keeps which accounts are done, so a reload carries on where it stopped).
 *
 * The same rules as live counting where history allows: every swipe was a reply, a chat's
 * greeting is not, system notes are not, a message copied into another chat (branches,
 * checkpoints) counts once, only messages sent while the account existed count, and no day
 * counts more than the daily caps.
 */

const DAY_MS = 864e5;
const MAX_REPLY_CHARS = 20000;
const MAX_CHARACTERS_PER_DAY = 300;
const EARLIEST = Date.UTC(2023, 0, 1);
const CHUNK_SUFFIX = '.chunks';

/** @param {string} value @returns {string} Same as LeaderboardStore.characterKey */
const characterKey = value => crypto.createHmac('sha256', workerData.secret).update(`character:${value}`).digest('hex').slice(0, 10);

/**
 * @param {string} directory
 * @returns {string[]} Chat files (.jsonl) directly in the directory
 */
function chatFilesIn(directory) {
    try {
        return fs.readdirSync(directory, { withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
            .map(entry => path.join(directory, entry.name));
    } catch {
        return [];
    }
}

/**
 * @param {string} chatsDirectory
 * @returns {string[]} Chat files of all characters
 */
function characterChatFiles(chatsDirectory) {
    try {
        return fs.readdirSync(chatsDirectory, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .flatMap(entry => chatFilesIn(path.join(chatsDirectory, entry.name)));
    } catch {
        return [];
    }
}

/**
 * The message lines of a chat: in the file after its header, or in the chunk files.
 * @param {string} file
 * @returns {AsyncGenerator<string>}
 */
async function* messageLines(file) {
    const chunkDirectory = `${file}${CHUNK_SUFFIX}`;
    let shards = null;
    try {
        shards = fs.readdirSync(chunkDirectory).filter(name => name.endsWith('.jsonl')).sort();
    } catch {
        // Not chunked.
    }
    const files = shards ? shards.map(name => path.join(chunkDirectory, name)) : [file];
    for (const source of files) {
        const lines = readline.createInterface({ input: fs.createReadStream(source, { encoding: 'utf8' }), crlfDelay: Infinity });
        let first = true;
        for await (const line of lines) {
            // The single-file layout starts with the header.
            if (first && !shards) {
                first = false;
                continue;
            }
            first = false;
            if (line) yield line;
        }
    }
}

/**
 * @param {{handle: string, created: number, chats: string, groupChats: string}} user
 * @returns {Promise<Record<string, (number|string)[]>>} day -> [ai, chars, user, night, group, online, characters]
 */
async function countUser(user) {
    const from = Math.max(EARLIEST, (Number(user.created) || 0) - DAY_MS);
    const until = Number(workerData.countingSince);
    const seen = new Set();
    /** @type {Map<number, {ai: number, chars: number, user: number, night: number, group: number, cset: Set<string>}>} */
    const days = new Map();
    const dayStats = day => {
        let stats = days.get(day);
        if (!stats) {
            stats = { ai: 0, chars: 0, user: 0, night: 0, group: 0, cset: new Set() };
            days.set(day, stats);
        }
        return stats;
    };
    const countReply = (sent, key, text, name, isGroup) => {
        if (sent === null || sent < from || sent >= until || seen.has(key)) return;
        seen.add(key);
        const stats = dayStats(dayOf(sent));
        stats.ai++;
        stats.chars += Math.min(MAX_REPLY_CHARS, typeof text === 'string' ? text.length : 0);
        if (hourOf(sent) < 5) stats.night++;
        if (isGroup) stats.group++;
        if (name && stats.cset.size < MAX_CHARACTERS_PER_DAY) stats.cset.add(characterKey(name));
    };
    const files = [
        ...characterChatFiles(user.chats).map(file => ({ file, isGroup: false })),
        ...chatFilesIn(user.groupChats).map(file => ({ file, isGroup: true })),
    ];
    for (const { file, isGroup } of files) {
        let index = 0;
        try {
            for await (const line of messageLines(file)) {
                let message;
                try {
                    message = JSON.parse(line);
                } catch {
                    continue;
                }
                if (!message || typeof message !== 'object' || !('mes' in message)) continue;
                const position = index++;
                if (message.is_system || (typeof message.extra?.type === 'string' && message.extra.type)) continue;
                const sent = parseSendDate(message.send_date);
                if (message.is_user) {
                    const key = `u${sent}`;
                    if (sent === null || sent < from || sent >= until || seen.has(key)) continue;
                    seen.add(key);
                    dayStats(dayOf(sent)).user++;
                    continue;
                }
                // The character's greeting (and its alternatives) is not a reply.
                if (position === 0) continue;
                const name = typeof message.name === 'string' ? message.name.trim().slice(0, 100) : '';
                const swipes = Array.isArray(message.swipes) && message.swipes.length > 1 ? message.swipes : null;
                if (!swipes) {
                    countReply(sent, `a${sent}`, message.mes, name, isGroup);
                    continue;
                }
                swipes.forEach((text, swipe) => {
                    if (typeof text !== 'string' || !text) return;
                    const info = Array.isArray(message.swipe_info) ? message.swipe_info[swipe] : null;
                    const own = parseSendDate(info?.send_date);
                    countReply(own ?? sent, own !== null ? `a${own}` : `a${sent}#${swipe}`, text, name, isGroup);
                });
            }
        } catch (error) {
            // A file that cannot be read is left out; the rest still counts.
            if (error?.code !== 'ENOENT') console.warn(`[leaderboard] Skipped ${file}: ${error?.message || error}`);
        }
        // Let the server's own work go first.
        await new Promise(resolve => setImmediate(resolve));
    }
    const result = {};
    for (const [day, stats] of days) {
        const ai = Math.min(stats.ai, DAILY_CAPS.ai);
        result[day] = [ai, Math.min(stats.chars, DAILY_CAPS.chars), Math.min(stats.user, DAILY_CAPS.user),
            Math.min(stats.night, ai), Math.min(stats.group, ai), 0, [...stats.cset].join(',')];
    }
    return result;
}

try {
    // This thread only: the server's own threads keep their priority.
    os.setPriority(19);
} catch {
    // Not allowed here: the scan simply runs at normal priority.
}

for (const user of workerData.users) {
    const days = await countUser(user);
    parentPort?.postMessage({ type: 'user', handle: user.handle, days });
}
