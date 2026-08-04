import fs from 'node:fs';
import path from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import { SETTINGS_FILE } from './constants.js';
import { KeyedMutex } from './keyed-mutex.js';
import { guardOversizedExtensionSettings } from './extension-settings-guard.js';

const settingsWriteMutex = new KeyedMutex();

function getSettingsWriteFailure(error) {
    if (['ENOSPC', 'EDQUOT'].includes(error?.code)) {
        return {
            status: 507,
            error: 'settings_storage_exhausted',
            message: 'The server does not have enough storage space to save settings.',
        };
    }
    if (['EACCES', 'EPERM'].includes(error?.code)) {
        return {
            status: 500,
            error: 'settings_permission_denied',
            message: 'The server does not have permission to save settings.',
        };
    }
    return {
        status: 500,
        error: 'settings_write_failed',
        message: 'The server could not save settings.',
    };
}

async function defaultWriteSettings(filePath, data) {
    await writeFileAtomic(filePath, data, 'utf8');
}

/**
 * Creates an atomic, per-user settings save handler.
 * @param {object} [options] Handler dependencies
 * @param {(filePath: string, data: string) => Promise<void>|void} [options.writeSettings] Atomic writer
 * @param {(request: import('express').Request) => Promise<void>|void} [options.onSuccess] Post-write cache/backup work
 * @returns {import('express').RequestHandler}
 */
export function createSettingsSaveHandler({ writeSettings = defaultWriteSettings, onSuccess = () => {} } = {}) {
    return async function saveSettingsHandler(request, response) {
        const handle = request.user?.profile?.handle;
        if (typeof handle !== 'string' || !handle) {
            return response.status(500).json({
                error: 'settings_write_failed',
                message: 'The server could not save settings.',
            });
        }

        return await settingsWriteMutex.runExclusive(handle, async () => {
            const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
            let guarded;
            try {
                const requestedSettings = JSON.stringify(request.body, null, 4);
                guarded = await guardOversizedExtensionSettings(requestedSettings, request.user.directories, {
                    updateSettingsFile: false,
                });
                if (guarded.failed.length > 0) {
                    let existingSettings = {};
                    try {
                        existingSettings = JSON.parse(await fs.promises.readFile(pathToSettings, 'utf8'));
                    } catch {
                        // Core settings can still be saved when no previous extension value exists.
                    }
                    for (const { extensionId } of guarded.failed) {
                        const existingValue = existingSettings?.extension_settings?.[extensionId];
                        if (existingValue !== undefined) {
                            guarded.settingsObject.extension_settings[extensionId] = existingValue;
                        }
                    }
                }
                const serializedSettings = JSON.stringify(guarded.settingsObject, null, 4);
                await writeSettings(pathToSettings, serializedSettings);
            } catch (error) {
                const failure = getSettingsWriteFailure(error);
                console.error('Settings write failed', { handle, code: error?.code || 'UNKNOWN' });
                return response.status(failure.status).json({ error: failure.error, message: failure.message });
            }

            try {
                await onSuccess(request);
            } catch (error) {
                // The settings file is already durable. Ancillary work must not turn
                // that successful write into a retryable client failure.
                console.error('Settings post-save work failed', { handle, code: error?.code || 'UNKNOWN' });
            }
            const result = { result: 'ok' };
            if (guarded.migrated.length > 0) {
                result.migratedExtensionSettings = guarded.replacements;
            }
            if (guarded.failed.length > 0) {
                result.rejectedExtensionSettings = guarded.failed;
            }
            return response.json(result);
        });
    };
}
