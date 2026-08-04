import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { BoundedCache } from './bounded-cache.js';
import { createConcurrencyLimiter } from './concurrency.js';
import { guardOversizedExtensionSettings } from './extension-settings-guard.js';

const DIRECTORY_DEFINITIONS = [
    ['koboldAI_Settings', 'kobold'],
    ['novelAI_Settings', 'novel'],
    ['openAI_Settings', 'openai'],
    ['textGen_Settings', 'textgen'],
    ['worlds', 'worlds'],
    ['themes', 'themes'],
    ['movingUI', 'moving-ui'],
    ['quickreplies', 'quick-replies'],
    ['instruct', 'instruct'],
    ['context', 'context'],
    ['sysprompt', 'sysprompt'],
    ['reasoning', 'reasoning'],
];
const LOCALE_SORT_DIRECTORIES = new Set(['koboldAI_Settings', 'novelAI_Settings', 'openAI_Settings', 'textGen_Settings', 'worlds']);

function safeNotify(callback, value) {
    try {
        callback?.(value);
    } catch {
        // Diagnostics must not change settings correctness.
    }
}

/**
 * Async, bounded and per-user settings payload cache.
 */
export class SettingsCache {
    /**
     * @param {object} [options] Cache options
     * @param {boolean} [options.enabled] Retain completed payloads
     * @param {number} [options.ioConcurrency] Shared file I/O limit
     * @param {number} [options.ttlMs] Payload lifetime
     * @param {number} [options.signatureTtlMs] External-change scan interval
     * @param {number} [options.maxEntries] User capacity
     * @param {number} [options.maxBytes] Approximate cache memory capacity
     * @param {() => number} [options.now] Clock
     */
    constructor({
        enabled = true,
        ioConcurrency = 8,
        ttlMs = 30_000,
        signatureTtlMs = 5_000,
        maxEntries = 100,
        maxBytes = 100 * 1024 * 1024,
        now = Date.now,
    } = {}) {
        this.ioConcurrency = Math.min(64, Math.max(1, Math.floor(Number(ioConcurrency) || 1)));
        this.signatureTtlMs = Math.max(0, Number(signatureTtlMs) || 0);
        this.maxSignatureEntries = Math.max(1, Math.floor(Number(maxEntries) || 1));
        this.now = now;
        this.runIo = createConcurrencyLimiter(this.ioConcurrency);
        this.cache = new BoundedCache({ enabled, ttlMs, maxEntries, maxBytes, now });
        this.signatures = new Map();
        this.signatureGenerations = new Map();
        this.signatureScans = new Map();
        this.signatureEpoch = 0;
    }

    /**
     * Build or retrieve the exact native `/api/settings/get` payload.
     * @param {object} options Request options
     * @param {string} options.userKey Trusted server-side user key
     * @param {object} options.directories Trusted user directories
     * @param {object} options.runtimeConfig Stable server flags included in the response
     * @param {(event: object) => void} [options.onMetric] Content-free build metrics
     * @returns {Promise<{payload: object, state: 'hit'|'miss'|'shared', metrics: object}>}
     */
    async get({ userKey, directories, runtimeConfig, onMetric }) {
        const trustedKey = String(userKey);
        const signature = await this.#getSignature(trustedKey, directories);
        const runtimeSignature = JSON.stringify(runtimeConfig);
        const result = await this.cache.getOrLoad(trustedKey, {
            signature: `${signature.value}:${runtimeSignature}`,
            load: () => this.#buildPayload(trustedKey, directories, runtimeConfig, signature.files, onMetric),
            sizeOf: value => Buffer.byteLength(JSON.stringify(value.payload), 'utf8'),
        });
        return { ...result.value, state: result.state };
    }

    /** Invalidate one user's payload and its short-lived signature. */
    invalidate(userKey) {
        const trustedKey = String(userKey);
        this.signatureGenerations.set(trustedKey, Object.freeze({}));
        this.signatures.delete(trustedKey);
        this.cache.invalidate(trustedKey);
        if (!this.signatureScans.has(trustedKey)) {
            this.signatureGenerations.delete(trustedKey);
        }
    }

    /** Clear all settings payload/signature entries. */
    clear() {
        this.signatures.clear();
        this.signatureGenerations.clear();
        this.signatureScans.clear();
        this.signatureEpoch++;
        this.cache.clear();
    }

    /** @returns {{entries: number, inflight: number, totalBytes: number, generations: number, signatures: number}} Cache status */
    getStatus() {
        return { ...this.cache.getStatus(), signatures: this.signatures.size };
    }

    async #buildPayload(userKey, directories, runtimeConfig, files, onMetric) {
        const metrics = { directories: DIRECTORY_DEFINITIONS.length + 1, filesRead: 0, invalidFiles: 0, readBytes: 0, readMs: 0, parseMs: 0 };
        const [
            rawSettings,
            kobold,
            novelai,
            openai,
            textgen,
            themes,
            movingUIPresets,
            quickReplyPresets,
            instruct,
            context,
            sysprompt,
            reasoning,
        ] = await Promise.all([
            this.#readText(path.join(directories.root, 'settings.json'), metrics, onMetric),
            this.#readRawPresets(directories.koboldAI_Settings, files.koboldAI_Settings, metrics, onMetric),
            this.#readRawPresets(directories.novelAI_Settings, files.novelAI_Settings, metrics, onMetric),
            this.#readRawPresets(directories.openAI_Settings, files.openAI_Settings, metrics, onMetric),
            this.#readRawPresets(directories.textGen_Settings, files.textGen_Settings, metrics, onMetric),
            this.#readParsedFiles(directories.themes, files.themes, metrics, onMetric),
            this.#readParsedFiles(directories.movingUI, files.movingUI, metrics, onMetric),
            this.#readParsedFiles(directories.quickreplies, files.quickreplies, metrics, onMetric),
            this.#readParsedFiles(directories.instruct, files.instruct, metrics, onMetric),
            this.#readParsedFiles(directories.context, files.context, metrics, onMetric),
            this.#readParsedFiles(directories.sysprompt, files.sysprompt, metrics, onMetric),
            this.#readParsedFiles(directories.reasoning, files.reasoning, metrics, onMetric),
        ]);

        const guardStartedAt = performance.now();
        const guardedSettings = await guardOversizedExtensionSettings(rawSettings, directories, {
            backupFilePrefix: `settings_${userKey}_extension_migration_`,
        });
        metrics.parseMs += performance.now() - guardStartedAt;
        if (guardedSettings.migrated.length > 0) {
            console.warn('Migrated oversized extension settings', {
                count: guardedSettings.migrated.length,
                bytes: guardedSettings.migrated.reduce((total, item) => total + item.originalBytes, 0),
            });
        }

        return {
            payload: {
                settings: guardedSettings.settingsText,
                koboldai_settings: kobold.fileContents,
                koboldai_setting_names: kobold.fileNames,
                world_names: files.worlds.map(item => path.parse(item).name),
                novelai_settings: novelai.fileContents,
                novelai_setting_names: novelai.fileNames,
                openai_settings: openai.fileContents,
                openai_setting_names: openai.fileNames,
                textgenerationwebui_presets: textgen.fileContents,
                textgenerationwebui_preset_names: textgen.fileNames,
                themes,
                movingUIPresets,
                quickReplyPresets,
                instruct,
                context,
                sysprompt,
                reasoning,
                ...runtimeConfig,
            },
            metrics,
        };
    }

    async #readRawPresets(directory, fileNames, metrics, onMetric) {
        const rows = await Promise.all(fileNames.map(async fileName => {
            try {
                const text = await this.#readText(path.join(directory, fileName), metrics, onMetric);
                this.#parseJson(text, metrics, onMetric);
                return { name: path.parse(fileName).name, text };
            } catch (error) {
                metrics.invalidFiles++;
                console.warn(`${fileName} is not a valid JSON`);
                return null;
            }
        }));
        const valid = rows.filter(Boolean);
        return {
            fileContents: valid.map(row => row.text),
            fileNames: valid.map(row => row.name),
        };
    }

    async #readParsedFiles(directory, fileNames, metrics, onMetric) {
        const rows = await Promise.all(fileNames.map(async fileName => {
            try {
                const text = await this.#readText(path.join(directory, fileName), metrics, onMetric);
                return { valid: true, value: this.#parseJson(text, metrics, onMetric) };
            } catch {
                metrics.invalidFiles++;
                return { valid: false };
            }
        }));
        return rows.filter(row => row.valid).map(row => row.value);
    }

    async #readText(filePath, metrics, onMetric) {
        const { text, durationMs } = await this.runIo(async () => {
            const startedAt = performance.now();
            const text = await fs.promises.readFile(filePath, 'utf8');
            return { text, durationMs: performance.now() - startedAt };
        });
        const bytes = Buffer.byteLength(text, 'utf8');
        metrics.filesRead++;
        metrics.readBytes += bytes;
        metrics.readMs += durationMs;
        safeNotify(onMetric, { type: 'read', durationMs, bytes });
        return text;
    }

    #parseJson(text, metrics, onMetric) {
        const startedAt = performance.now();
        try {
            return JSON.parse(text);
        } finally {
            const durationMs = performance.now() - startedAt;
            metrics.parseMs += durationMs;
            safeNotify(onMetric, { type: 'parse', durationMs });
        }
    }

    async #getSignature(userKey, directories) {
        while (true) {
            const cached = this.signatures.get(userKey);
            if (cached && this.now() - cached.checkedAt < this.signatureTtlMs) {
                this.signatures.delete(userKey);
                this.signatures.set(userKey, cached);
                return cached;
            }

            const scan = this.#beginSignatureScan(userKey);
            let result;
            let isCurrent = false;
            try {
                result = await this.#scanSignature(directories);
                isCurrent = scan.epoch === this.signatureEpoch
                    && this.signatureGenerations.get(userKey) === scan.generation;
            } finally {
                this.#endSignatureScan(userKey, scan);
            }
            if (!isCurrent) {
                continue;
            }

            this.signatures.delete(userKey);
            this.signatures.set(userKey, result);
            while (this.signatures.size > this.maxSignatureEntries) {
                this.signatures.delete(this.signatures.keys().next().value);
            }
            return result;
        }
    }

    async #scanSignature(directories) {
        const fileGroups = await Promise.all(DIRECTORY_DEFINITIONS.map(async ([directoryKey]) => {
            const directory = directories[directoryKey];
            try {
                const entries = await this.runIo(() => fs.promises.readdir(directory, { withFileTypes: true }));
                const names = entries
                    .filter(entry => entry.isFile() && (directoryKey === 'worlds'
                        ? path.extname(entry.name).toLowerCase() === '.json'
                        : path.extname(entry.name) === '.json'))
                    .map(entry => entry.name);
                names.sort(LOCALE_SORT_DIRECTORIES.has(directoryKey)
                    ? (left, right) => left.localeCompare(right)
                    : undefined);
                return [directoryKey, names];
            } catch {
                return [directoryKey, []];
            }
        }));
        const files = Object.fromEntries(fileGroups);
        const hash = crypto.createHash('sha256');
        const settingsPath = path.join(directories.root, 'settings.json');
        hash.update(`settings:${await this.#statSignature(settingsPath)}`);

        const signatureGroups = await Promise.all(DIRECTORY_DEFINITIONS.map(async ([directoryKey, label]) => {
            const directory = directories[directoryKey];
            const directorySignature = await this.#statSignature(directory);
            const records = await Promise.all(files[directoryKey].map(async fileName => {
                const filePath = path.join(directory, fileName);
                return `${fileName}:${await this.#statSignature(filePath)}`;
            }));
            return { label, directorySignature, records };
        }));
        for (const { label, directorySignature, records } of signatureGroups) {
            hash.update(`|${label}:${directorySignature}`);
            for (const record of records) {
                hash.update(`|${label}/${record}`);
            }
        }

        return { value: hash.digest('hex'), files, checkedAt: this.now() };
    }

    #beginSignatureScan(userKey) {
        let generation = this.signatureGenerations.get(userKey);
        if (!generation) {
            generation = Object.freeze({});
            this.signatureGenerations.set(userKey, generation);
        }
        const scan = { generation, epoch: this.signatureEpoch };
        const active = this.signatureScans.get(userKey) ?? new Set();
        active.add(scan);
        this.signatureScans.set(userKey, active);
        return scan;
    }

    #endSignatureScan(userKey, scan) {
        const active = this.signatureScans.get(userKey);
        active?.delete(scan);
        if (active && active.size === 0 && this.signatureScans.get(userKey) === active) {
            this.signatureScans.delete(userKey);
            this.signatureGenerations.delete(userKey);
        }
    }

    async #statSignature(targetPath) {
        try {
            const stats = await this.runIo(() => fs.promises.stat(targetPath));
            return `${stats.isDirectory() ? 'd' : 'f'}:${stats.size}:${stats.mtimeMs}`;
        } catch {
            return 'missing';
        }
    }
}

let activeSettingsCache = null;

/** Register the process-wide settings cache used by mutation hooks. */
export function registerSettingsCache(cache) {
    activeSettingsCache = cache;
}

/** Invalidate a trusted user's settings payload. */
export function invalidateSettingsCache(userKey) {
    activeSettingsCache?.invalidate(userKey);
}

/** Clear all settings payloads. */
export function clearSettingsCache() {
    activeSettingsCache?.clear();
}

/** Return aggregate cache status without keys or settings content. */
export function getSettingsCacheStatus() {
    return activeSettingsCache?.getStatus() ?? { entries: 0, inflight: 0, totalBytes: 0, generations: 0, signatures: 0 };
}

const MUTATION_ROUTES = new Set([
    '/api/settings/save',
    '/api/settings/restore-snapshot',
    '/api/presets/save',
    '/api/presets/delete',
    '/api/themes/save',
    '/api/themes/delete',
    '/api/moving-ui/save',
    '/api/quick-replies/save',
    '/api/quick-replies/delete',
    '/api/worldinfo/delete',
    '/api/worldinfo/import',
    '/api/worldinfo/edit',
    '/api/content/importURL',
    '/api/content/importUUID',
]);

/** Express middleware that invalidates settings only after a successful mutation response. */
export function settingsCacheInvalidationMiddleware(request, response, next) {
    const route = `${request.baseUrl}${request.path}`;
    if (request.method === 'POST' && MUTATION_ROUTES.has(route)) {
        response.once('finish', () => {
            const handle = request.user?.profile?.handle;
            if (response.statusCode < 400 && handle) {
                invalidateSettingsCache(handle);
            }
        });
    }
    next();
}
