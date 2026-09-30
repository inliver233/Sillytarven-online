import crypto from 'node:crypto';
import { getConfigValue } from './util.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/**
 * Discord public pages (linked roles, terms, privacy) are site specific, so
 * they live outside the statically served public directory.
 */
export const DISCORD_PUBLIC_PAGES = Object.freeze({
    '/discord/linked-roles': 'discord-linked-roles.html',
    '/terms': 'terms.html',
    '/privacy': 'privacy.html',
});

function getConfiguredPublicKeyHex() {
    return String(getConfigValue('discord.applicationPublicKey', '') || '').trim();
}

/**
 * The Discord application integration is opt-in: it is only mounted when a
 * valid application public key is configured.
 * @returns {boolean}
 */
export function isDiscordApplicationEnabled() {
    return /^[0-9a-f]{64}$/i.test(getConfiguredPublicKeyHex());
}

function getDiscordPublicKey() {
    const publicKeyHex = getConfiguredPublicKeyHex();
    if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) {
        throw new Error('discord.applicationPublicKey must be a 32-byte hexadecimal Ed25519 public key');
    }

    return crypto.createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
        format: 'der',
        type: 'spki',
    });
}

/**
 * Handles Discord's signed interaction requests. The route is intentionally
 * public, but every request must carry a valid Ed25519 signature.
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 */
export function handleDiscordInteraction(request, response) {
    try {
        const signatureHex = String(request.get('x-signature-ed25519') || '');
        const timestamp = String(request.get('x-signature-timestamp') || '');
        const timestampMs = Number(timestamp) * 1000;
        const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);

        if (!/^[0-9a-f]{128}$/i.test(signatureHex) || !/^\d+$/.test(timestamp) ||
            !Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_TIMESTAMP_SKEW_MS) {
            return response.sendStatus(401);
        }

        const message = Buffer.concat([Buffer.from(timestamp), rawBody]);
        const verified = crypto.verify(
            null,
            message,
            getDiscordPublicKey(),
            Buffer.from(signatureHex, 'hex'),
        );
        if (!verified) {
            return response.sendStatus(401);
        }

        const interaction = JSON.parse(rawBody.toString('utf8'));
        if (interaction?.type === 1) {
            return response.json({ type: 1 });
        }

        return response.status(501).json({ error: 'No Discord application commands are configured.' });
    } catch (error) {
        console.error('Discord interaction verification failed:', error?.message || error);
        return response.sendStatus(401);
    }
}
