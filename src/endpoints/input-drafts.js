import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import writeFileAtomic from 'write-file-atomic';

import { KeyedMutex } from '../keyed-mutex.js';

/**
 * Unsent text of the chat input box, one draft per chat, so a message started on
 * one device can be finished on another. The browser keeps its own copy and only
 * syncs through here; this file is never the only place a draft lives.
 *
 * Reads are GET so the controller's activity tracker does not count them as writes.
 * Saves carry the version the client last saw: a save made on top of an older
 * version than the stored one, by another tab or device, is refused with 409 and the
 * stored draft, so the client can ask instead of overwriting it.
 *
 * A client that, after such a refusal, keeps its own text saves with `overriding`. The new
 * version then names the device whose text it replaced (`overrode`), and keeps naming it while
 * that same device saves on, so that device asks its user instead of quietly taking the text.
 * A save from any other device is based on what it was shown and clears the mark.
 */

export const INPUT_DRAFTS_FILE = 'input-drafts.json';
export const MAX_DRAFT_LENGTH = 100_000;
export const MAX_DRAFTS = 200;
export const MAX_TOTAL_LENGTH = 1_000_000;
const MAX_KEY_LENGTH = 600;
const MAX_ID_LENGTH = 64;
/** An emptied draft is kept this long, so devices that still show the old text learn it was sent. */
const CLEARED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const fileLocks = new KeyedMutex();

/**
 * @typedef {object} StoredDraft
 * @property {string} text
 * @property {number} updatedAt Version, strictly increasing per draft
 * @property {string} clientId Page that saved it
 * @property {string} deviceId Browser that saved it
 * @property {string} [overrode] Device whose different text this version replaced after a conflict
 */

/**
 * @param {string} file
 * @returns {Promise<Record<string, StoredDraft>>}
 */
async function readDrafts(file) {
    try {
        const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        if (data && typeof data.drafts === 'object' && data.drafts !== null) {
            return data.drafts;
        }
    } catch {
        // Missing or unreadable: no drafts.
    }
    return {};
}

/**
 * Drops cleared drafts after a while and the oldest drafts beyond the limits.
 * @param {Record<string, StoredDraft>} drafts
 * @param {string} keep Key that was just written
 * @param {number} now
 */
export function pruneDrafts(drafts, keep, now) {
    for (const [key, draft] of Object.entries(drafts)) {
        if (key !== keep && !draft.text && now - draft.updatedAt > CLEARED_KEEP_MS) {
            delete drafts[key];
        }
    }
    const oldestFirst = Object.entries(drafts)
        .filter(([key, draft]) => key !== keep && draft.text)
        .sort(([, a], [, b]) => a.updatedAt - b.updatedAt);
    let count = Object.values(drafts).filter(draft => draft.text).length;
    let total = Object.values(drafts).reduce((sum, draft) => sum + draft.text.length, 0);
    for (const [key, draft] of oldestFirst) {
        if (count <= MAX_DRAFTS && total <= MAX_TOTAL_LENGTH) break;
        delete drafts[key];
        count -= 1;
        total -= draft.text.length;
    }
}

/**
 * Applies one save to the stored drafts.
 * @param {Record<string, StoredDraft>} drafts Modified in place
 * @param {{ key: string, text: string, clientId: string, deviceId: string, baseUpdatedAt: number, overriding?: boolean }} save
 * @param {number} now
 * @returns {{ updatedAt: number } | { conflict: StoredDraft }}
 */
export function applyDraftSave(drafts, { key, text, clientId, deviceId, baseUpdatedAt, overriding = false }, now) {
    const current = drafts[key];
    if (current && current.updatedAt > baseUpdatedAt && current.text !== text && current.clientId !== clientId) {
        return { conflict: current };
    }
    let overrode;
    if (overriding && current?.text && current.text !== text && current.deviceId !== deviceId) {
        overrode = current.deviceId;
    } else if (current?.overrode && current.deviceId === deviceId) {
        overrode = current.overrode;
    }
    // Strictly increasing, so a version is never mistaken for the one before it.
    const updatedAt = Math.max(now, (current?.updatedAt ?? 0) + 1);
    drafts[key] = { text, updatedAt, clientId, deviceId, ...(overrode ? { overrode } : {}) };
    pruneDrafts(drafts, key, now);
    return { updatedAt };
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function validKey(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_LENGTH ? value : null;
}

/**
 * @param {import('express').Request} request
 */
function draftsFile(request) {
    return path.join(request.user.directories.root, INPUT_DRAFTS_FILE);
}

export const router = express.Router();

router.get('/', async (request, response) => {
    const key = validKey(request.query.key);
    if (!key) {
        return response.status(400).json({ error: 'invalid_key' });
    }
    const draft = (await readDrafts(draftsFile(request)))[key];
    response.set('Cache-Control', 'no-store');
    return response.json(draft ?? { text: '', updatedAt: 0, clientId: '', deviceId: '' });
});

router.post('/', async (request, response) => {
    const key = validKey(request.body?.key);
    const { text, clientId, deviceId } = request.body ?? {};
    const baseUpdatedAt = Number(request.body?.baseUpdatedAt ?? 0);
    const overriding = request.body?.overriding === true;
    const validId = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
    if (!key || typeof text !== 'string' || !validId(clientId) || !validId(deviceId) || !Number.isFinite(baseUpdatedAt)) {
        return response.status(400).json({ error: 'invalid_draft' });
    }
    if (text.length > MAX_DRAFT_LENGTH) {
        return response.status(413).json({ error: 'draft_too_long' });
    }
    const file = draftsFile(request);
    try {
        const result = await fileLocks.runExclusive(file, async () => {
            const drafts = await readDrafts(file);
            const outcome = applyDraftSave(drafts, { key, text, clientId, deviceId, baseUpdatedAt, overriding }, Date.now());
            if ('updatedAt' in outcome) {
                await writeFileAtomic(file, JSON.stringify({ version: 1, drafts }), 'utf8');
            }
            return outcome;
        });
        if ('conflict' in result) {
            return response.status(409).json(result.conflict);
        }
        return response.json({ updatedAt: result.updatedAt });
    } catch (error) {
        console.warn('[input-drafts] save failed', error?.message);
        return response.status(500).json({ error: 'draft_save_failed' });
    }
});
