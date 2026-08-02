import { getExtensionIdentity } from './extension-resolver.js';

export const EXTENSION_LIFECYCLE_STATE = Object.freeze({
    DISCOVERED: 'discovered',
    LOADING: 'loading',
    ACTIVE: 'active',
    INACTIVE: 'inactive',
    RELOAD_REQUIRED: 'reload-required',
    FAILED: 'failed',
});

export const EXTENSION_HOOK_STATUS = Object.freeze({
    OK: 'ok',
    SKIPPED: 'skipped',
    INVALID_HOOK: 'invalid-hook',
    MISSING_EXPORT: 'missing-export',
    REJECTED: 'rejected',
    TIMEOUT: 'timeout',
});

export const EXTENSION_HOOK_TIMEOUT = 5000;

function cloneDescriptor(descriptor) {
    return {
        canonicalName: descriptor.canonicalName,
        shortName: descriptor.shortName,
        type: descriptor.type,
        manifest: structuredClone(descriptor.manifest),
        resourceBaseUrl: descriptor.resourceBaseUrl,
        enabled: descriptor.enabled,
    };
}

function serializeError(error) {
    if (!error) {
        return null;
    }
    return {
        name: String(error.name || 'Error'),
        message: String(error.message || error),
    };
}

function cloneRecord(record) {
    return {
        descriptor: cloneDescriptor(record.descriptor),
        status: record.status,
        error: record.error ? { ...record.error } : null,
        hooks: structuredClone(record.hooks),
    };
}

/**
 * Creates idempotent extension stylesheet and locale loaders.
 * @param {object} dependencies Browser dependencies
 * @param {Document} dependencies.document Document used to insert stylesheets
 * @param {typeof fetch} dependencies.fetch Fetch implementation
 * @param {(value: string) => string} dependencies.sanitizeSelector Selector sanitizer
 * @param {() => string} dependencies.getCurrentLocale Current locale getter
 * @param {(locale: string, data: object) => void} dependencies.addLocaleData Locale registration callback
 * @param {Pick<Console, 'log'>} [dependencies.logger] Logger
 * @returns {{addStyle: (name: string, manifest: object) => Promise<void>, addLocale: (name: string, manifest: object) => Promise<void>}}
 */
export function createExtensionAssetLoader({
    document,
    fetch,
    sanitizeSelector,
    getCurrentLocale,
    addLocaleData,
    logger = console,
}) {
    const loadedStyles = new Set();
    const styleLoads = new Map();
    const loadedLocales = new Set();
    const localeLoads = new Map();

    function addStyle(name, manifest) {
        if (!manifest.css) {
            return Promise.resolve();
        }

        const id = sanitizeSelector(`${name}-css`);
        if (loadedStyles.has(id)) {
            return Promise.resolve();
        }

        const existingLoad = styleLoads.get(id);
        if (existingLoad) {
            return existingLoad;
        }

        const existingLink = document.getElementById(id);
        if (existingLink?.sheet) {
            loadedStyles.add(id);
            return Promise.resolve();
        }

        let load;
        load = new Promise((resolve, reject) => {
            const link = existingLink ?? document.createElement('link');
            link.onload = () => {
                loadedStyles.add(id);
                resolve();
            };
            link.onerror = error => {
                loadedStyles.delete(id);
                if (styleLoads.get(id) === load) {
                    styleLoads.delete(id);
                }
                link.remove();
                reject(error);
            };

            if (!existingLink) {
                link.id = id;
                link.rel = 'stylesheet';
                link.type = 'text/css';
                link.href = `/scripts/extensions/${name}/${manifest.css}`;
                document.head.appendChild(link);
            }
        }).finally(() => {
            if (styleLoads.get(id) === load) {
                styleLoads.delete(id);
            }
        });

        styleLoads.set(id, load);
        return load;
    }

    function addLocale(name, manifest) {
        if (!manifest.i18n || typeof manifest.i18n !== 'object') {
            return Promise.resolve();
        }

        const locale = getCurrentLocale();
        const localeFile = manifest.i18n[locale];
        if (!localeFile) {
            return Promise.resolve();
        }

        const url = `/scripts/extensions/${name}/${localeFile}`;
        if (loadedLocales.has(url)) {
            return Promise.resolve();
        }

        const existingLoad = localeLoads.get(url);
        if (existingLoad) {
            return existingLoad;
        }

        const load = fetch(url)
            .then(async response => {
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const data = await response.json();
                if (data && typeof data === 'object') {
                    addLocaleData(locale, data);
                }
                loadedLocales.add(url);
            })
            .catch(error => {
                logger.log(`Could not load extension locale data for ${name}`, error);
            })
            .finally(() => localeLoads.delete(url));

        localeLoads.set(url, load);
        return load;
    }

    return { addStyle, addLocale };
}

/**
 * Runs extension module hooks while maintaining deterministic client lifecycle state.
 */
export class ExtensionLifecycle {
    /**
     * @param {object} [options] Lifecycle dependencies
     * @param {(url: string) => Promise<object>} [options.importModule] Module importer
     * @param {number} [options.hookTimeout] Hook timeout in milliseconds
     * @param {typeof setTimeout} [options.setTimeoutImpl] Timer implementation
     * @param {typeof clearTimeout} [options.clearTimeoutImpl] Timer cleanup implementation
     */
    constructor({
        importModule = url => import(url),
        hookTimeout = EXTENSION_HOOK_TIMEOUT,
        setTimeoutImpl = globalThis.setTimeout.bind(globalThis),
        clearTimeoutImpl = globalThis.clearTimeout.bind(globalThis),
    } = {}) {
        this.importModule = importModule;
        this.hookTimeout = hookTimeout;
        this.setTimeoutImpl = setTimeoutImpl;
        this.clearTimeoutImpl = clearTimeoutImpl;
        this.records = new Map();
        this.namespaces = new Map();
        this.operationTails = new Map();
    }

    /**
     * Registers discovered extensions without importing their modules.
     * @param {import('./extension-resolver.js').ExtensionDescriptor[]} descriptors Extension descriptors
     */
    discover(descriptors) {
        for (const descriptor of descriptors) {
            const identity = getExtensionIdentity(descriptor);
            const existing = this.records.get(identity);
            this.records.set(identity, {
                descriptor: cloneDescriptor(descriptor),
                status: existing?.status ?? EXTENSION_LIFECYCLE_STATE.DISCOVERED,
                error: existing?.error ?? null,
                hooks: existing?.hooks ?? {},
            });
        }
    }

    /**
     * Marks an extension eligible or inactive without loading it.
     * @param {import('./extension-resolver.js').ExtensionDescriptor} descriptor Extension descriptor
     * @param {boolean} eligible Eligibility result
     */
    setEligibility(descriptor, eligible) {
        const record = this.#ensureRecord(descriptor);
        record.descriptor = cloneDescriptor(descriptor);
        if (!eligible) {
            record.status = EXTENSION_LIFECYCLE_STATE.INACTIVE;
            record.error = null;
        } else if (record.status === EXTENSION_LIFECYCLE_STATE.INACTIVE) {
            record.status = EXTENSION_LIFECYCLE_STATE.DISCOVERED;
        }
    }

    /**
     * Runs the post-install hook after discovery has supplied a descriptor and manifest.
     * @param {import('./extension-resolver.js').ExtensionDescriptor} descriptor Extension descriptor
     * @returns {Promise<object>} Explicit lifecycle result
     */
    install(descriptor) {
        return this.#schedule(descriptor, 'install', async () => {
            const record = this.#ensureRecord(descriptor);
            record.descriptor = cloneDescriptor(descriptor);
            const previousStatus = record.status;
            const previousError = record.error;
            const hookResult = await this.#callOptionalHook(record, 'install');
            record.hooks.install = hookResult;
            if (!this.#isHookSuccess(hookResult)) {
                return this.#fail(record, hookResult.error, hookResult.status);
            }

            record.status = previousStatus;
            record.error = previousError;
            return this.#result(record, hookResult.status);
        });
    }

    /**
     * Runs the enable hook and activation as one serialized operation.
     * @param {import('./extension-resolver.js').ExtensionDescriptor} descriptor Extension descriptor
     * @returns {Promise<object>} Explicit lifecycle result
     */
    enable(descriptor) {
        return this.#schedule(descriptor, 'enable', async () => {
            const enabledDescriptor = { ...descriptor, enabled: true };
            const record = this.#ensureRecord(enabledDescriptor);
            record.descriptor = cloneDescriptor(enabledDescriptor);
            record.error = null;

            const hookResult = await this.#callOptionalHook(record, 'enable');
            record.hooks.enable = hookResult;
            if (!this.#isHookSuccess(hookResult)) {
                return this.#fail(record, hookResult.error, hookResult.status);
            }

            return this.#activateRecord(record, enabledDescriptor);
        });
    }

    /**
     * Imports and activates an extension. Concurrent calls share one identity/phase operation.
     * @param {import('./extension-resolver.js').ExtensionDescriptor} descriptor Extension descriptor
     * @returns {Promise<object>} Explicit lifecycle result
     */
    activate(descriptor) {
        return this.#schedule(descriptor, 'activate', async () => {
            const record = this.#ensureRecord(descriptor);
            return this.#activateRecord(record, descriptor);
        });
    }

    /**
     * Deactivates a loaded extension. A missing hook cannot undo module side effects and requires reload.
     * @param {import('./extension-resolver.js').ExtensionDescriptor} descriptor Extension descriptor
     * @returns {Promise<object>} Explicit lifecycle result
     */
    deactivate(descriptor) {
        return this.#schedule(descriptor, 'deactivate', async () => {
            const record = this.#ensureRecord(descriptor);
            record.descriptor = cloneDescriptor({ ...descriptor, enabled: false });
            const namespace = this.namespaces.get(getExtensionIdentity(descriptor));
            if (!namespace || record.status !== EXTENSION_LIFECYCLE_STATE.ACTIVE) {
                record.status = EXTENSION_LIFECYCLE_STATE.INACTIVE;
                record.error = null;
                return this.#result(record, EXTENSION_HOOK_STATUS.SKIPPED);
            }

            const hookResult = await this.#callHook(record, namespace, 'disable', ['deactivate']);
            record.hooks.disable = hookResult;
            if (hookResult.status === EXTENSION_HOOK_STATUS.OK) {
                record.status = EXTENSION_LIFECYCLE_STATE.INACTIVE;
                record.error = null;
            } else if (hookResult.status === EXTENSION_HOOK_STATUS.SKIPPED) {
                record.status = EXTENSION_LIFECYCLE_STATE.RELOAD_REQUIRED;
                record.error = null;
            } else {
                return this.#fail(record, hookResult.error, hookResult.status);
            }
            return this.#result(record, hookResult.status);
        });
    }

    /**
     * Official naming alias for deactivate().
     * @param {import('./extension-resolver.js').ExtensionDescriptor} descriptor Extension descriptor
     * @returns {Promise<object>} Explicit lifecycle result
     */
    disable(descriptor) {
        return this.deactivate(descriptor);
    }

    /**
     * Pulls an extension update. Active extensions reuse their existing namespace for the
     * update hook and then require reload; inactive extensions are never imported.
     * @param {import('./extension-resolver.js').ExtensionDescriptor} descriptor Extension descriptor
     * @param {() => Promise<object>} pullUpdate Performs the server update
     * @returns {Promise<object>} Explicit lifecycle result with update response
     */
    update(descriptor, pullUpdate) {
        return this.#schedule(descriptor, 'update', async () => {
            const record = this.#ensureRecord(descriptor);
            let updateResponse;
            try {
                updateResponse = await pullUpdate();
            } catch (error) {
                return { ...this.#fail(record, error, EXTENSION_HOOK_STATUS.REJECTED), updateResponse: null };
            }

            const changed = updateResponse?.isUpToDate === false;
            if (!changed) {
                return { ...this.#result(record, EXTENSION_HOOK_STATUS.SKIPPED), updateResponse };
            }

            const identity = getExtensionIdentity(descriptor);
            const namespace = this.namespaces.get(identity);
            if (!namespace || record.status !== EXTENSION_LIFECYCLE_STATE.ACTIVE) {
                record.status = EXTENSION_LIFECYCLE_STATE.INACTIVE;
                record.error = null;
                return { ...this.#result(record, EXTENSION_HOOK_STATUS.SKIPPED), updateResponse };
            }

            const hookResult = await this.#callHook(record, namespace, 'update');
            record.hooks.update = hookResult;
            if (!this.#isHookSuccess(hookResult)) {
                return { ...this.#fail(record, hookResult.error, hookResult.status), updateResponse };
            }

            record.status = EXTENSION_LIFECYCLE_STATE.RELOAD_REQUIRED;
            record.error = null;
            return { ...this.#result(record, hookResult.status), updateResponse };
        });
    }

    /**
     * Runs an explicitly requested data-clean hook and requires reload on success.
     * @param {import('./extension-resolver.js').ExtensionDescriptor} descriptor Extension descriptor
     * @returns {Promise<object>} Explicit lifecycle result
     */
    clean(descriptor) {
        return this.#schedule(descriptor, 'clean', async () => {
            const record = this.#ensureRecord(descriptor);
            record.descriptor = cloneDescriptor(descriptor);
            record.error = null;
            const hookResult = await this.#callOptionalHook(record, 'clean');
            record.hooks.clean = hookResult;
            if (!this.#isHookSuccess(hookResult)) {
                return this.#fail(record, hookResult.error, hookResult.status);
            }
            if (hookResult.status === EXTENSION_HOOK_STATUS.OK) {
                record.status = EXTENSION_LIFECYCLE_STATE.RELOAD_REQUIRED;
            }
            return this.#result(record, hookResult.status);
        });
    }

    /**
     * Runs optional clean and delete hooks before the server deletion.
     * @param {import('./extension-resolver.js').ExtensionDescriptor} descriptor Extension descriptor
     * @param {() => Promise<object>} removeExtension Performs the server deletion
     * @param {object} [options] Delete options
     * @param {boolean} [options.clean=false] Run the clean hook before delete
     * @returns {Promise<object>} Explicit lifecycle result with delete response
     */
    delete(descriptor, removeExtension, { clean = false } = {}) {
        return this.#schedule(descriptor, 'delete', async () => {
            const record = this.#ensureRecord(descriptor);
            record.descriptor = cloneDescriptor({ ...descriptor, enabled: false });
            record.error = null;
            let hookResult = { status: EXTENSION_HOOK_STATUS.SKIPPED, exportName: null, error: null };

            if (clean) {
                hookResult = await this.#callOptionalHook(record, 'clean');
                record.hooks.clean = hookResult;
                if (!this.#isHookSuccess(hookResult)) {
                    return { ...this.#fail(record, hookResult.error, hookResult.status), deleteResponse: null };
                }
            }

            hookResult = await this.#callOptionalHook(record, 'delete');
            record.hooks.delete = hookResult;
            if (!this.#isHookSuccess(hookResult)) {
                return { ...this.#fail(record, hookResult.error, hookResult.status), deleteResponse: null };
            }

            let deleteResponse;
            try {
                deleteResponse = await removeExtension();
            } catch (error) {
                return { ...this.#fail(record, error, EXTENSION_HOOK_STATUS.REJECTED), deleteResponse: null };
            }

            const identity = getExtensionIdentity(descriptor);
            this.namespaces.delete(identity);
            record.status = EXTENSION_LIFECYCLE_STATE.INACTIVE;
            record.error = null;
            return { ...this.#result(record, hookResult.status), deleteResponse };
        });
    }

    /**
     * @param {import('./extension-resolver.js').ExtensionDescriptor|string} descriptorOrIdentity Descriptor or internal identity
     * @returns {object|null} Isolated lifecycle record
     */
    getStatus(descriptorOrIdentity) {
        const identity = typeof descriptorOrIdentity === 'string'
            ? descriptorOrIdentity
            : getExtensionIdentity(descriptorOrIdentity);
        const record = this.records.get(identity);
        return record ? cloneRecord(record) : null;
    }

    /**
     * @returns {object[]} Isolated lifecycle records
     */
    listStatuses() {
        return [...this.records.values()].map(cloneRecord);
    }

    #ensureRecord(descriptor) {
        const identity = getExtensionIdentity(descriptor);
        let record = this.records.get(identity);
        if (!record) {
            record = {
                descriptor: cloneDescriptor(descriptor),
                status: EXTENSION_LIFECYCLE_STATE.DISCOVERED,
                error: null,
                hooks: {},
            };
            this.records.set(identity, record);
        }
        return record;
    }

    #schedule(descriptor, phase, operation) {
        const identity = getExtensionIdentity(descriptor);
        const tail = this.operationTails.get(identity);
        if (tail?.phase === phase) {
            return tail.promise;
        }

        const previous = tail?.promise ?? Promise.resolve();
        const promise = previous.catch(() => undefined).then(operation);
        this.operationTails.set(identity, { phase, promise });

        const cleanup = () => {
            if (this.operationTails.get(identity)?.promise === promise) {
                this.operationTails.delete(identity);
            }
        };
        promise.then(cleanup, cleanup);
        return promise;
    }

    async #activateRecord(record, descriptor) {
        record.descriptor = cloneDescriptor(descriptor);
        record.error = null;

        if (!descriptor.enabled) {
            record.status = EXTENSION_LIFECYCLE_STATE.INACTIVE;
            return this.#result(record, EXTENSION_HOOK_STATUS.SKIPPED);
        }
        if (record.status === EXTENSION_LIFECYCLE_STATE.RELOAD_REQUIRED) {
            return this.#result(record, EXTENSION_HOOK_STATUS.SKIPPED);
        }
        if (record.status === EXTENSION_LIFECYCLE_STATE.ACTIVE) {
            return this.#result(record, EXTENSION_HOOK_STATUS.OK);
        }

        record.status = EXTENSION_LIFECYCLE_STATE.LOADING;
        let namespace;
        try {
            namespace = await this.#loadNamespace(record);
        } catch (error) {
            return this.#fail(record, error, EXTENSION_HOOK_STATUS.REJECTED);
        }

        const hookResult = await this.#callHook(record, namespace, 'activate');
        record.hooks.activate = hookResult;
        if (!this.#isHookSuccess(hookResult)) {
            return this.#fail(record, hookResult.error, hookResult.status);
        }

        record.status = EXTENSION_LIFECYCLE_STATE.ACTIVE;
        record.error = null;
        return this.#result(record, hookResult.status);
    }

    async #loadNamespace(record) {
        const identity = getExtensionIdentity(record.descriptor);
        if (this.namespaces.has(identity)) {
            return this.namespaces.get(identity);
        }

        const file = record.descriptor.manifest?.js;
        const namespace = typeof file === 'string' && file
            ? await this.importModule(`${record.descriptor.resourceBaseUrl}/${file}`)
            : {};
        this.namespaces.set(identity, namespace ?? {});
        return namespace ?? {};
    }

    async #callOptionalHook(record, hookName, fallbacks = []) {
        const configuration = this.#getHookConfiguration(record, hookName, fallbacks);
        if (configuration.result) {
            return configuration.result;
        }

        let namespace;
        try {
            namespace = await this.#loadNamespace(record);
        } catch (error) {
            return { status: EXTENSION_HOOK_STATUS.REJECTED, exportName: configuration.exportName, error };
        }
        return this.#invokeHook(record, namespace, hookName, configuration.exportName);
    }

    async #callHook(record, namespace, hookName, fallbacks = []) {
        const configuration = this.#getHookConfiguration(record, hookName, fallbacks);
        if (configuration.result) {
            return configuration.result;
        }
        return this.#invokeHook(record, namespace, hookName, configuration.exportName);
    }

    #getHookConfiguration(record, hookName, fallbacks) {
        const hooks = record.descriptor.manifest?.hooks;
        if (hooks === undefined) {
            return { result: { status: EXTENSION_HOOK_STATUS.SKIPPED, exportName: null, error: null } };
        }
        if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
            const error = new TypeError('Lifecycle hooks must be an object.');
            return { result: { status: EXTENSION_HOOK_STATUS.INVALID_HOOK, exportName: null, error } };
        }

        const configuredHook = [hookName, ...fallbacks].find(name => Object.hasOwn(hooks, name));
        if (!configuredHook) {
            return { result: { status: EXTENSION_HOOK_STATUS.SKIPPED, exportName: null, error: null } };
        }
        const exportName = hooks[configuredHook];
        if (typeof exportName !== 'string' || !exportName) {
            const error = new TypeError(`Lifecycle hook "${configuredHook}" must name a module export.`);
            return { result: { status: EXTENSION_HOOK_STATUS.INVALID_HOOK, exportName: null, error } };
        }
        return { exportName };
    }

    async #invokeHook(record, namespace, hookName, configuredName) {
        const hook = namespace?.[configuredName];
        if (typeof hook !== 'function') {
            const error = new Error(`Lifecycle hook "${hookName}" references missing export "${configuredName}".`);
            return { status: EXTENSION_HOOK_STATUS.MISSING_EXPORT, exportName: configuredName, error };
        }

        const controller = new AbortController();
        let timer;
        const observedHook = Promise.resolve()
            .then(() => hook({ signal: controller.signal, descriptor: cloneDescriptor(record.descriptor) }))
            .then(
                () => ({ status: EXTENSION_HOOK_STATUS.OK, exportName: configuredName, error: null }),
                error => ({ status: EXTENSION_HOOK_STATUS.REJECTED, exportName: configuredName, error }),
            );
        const timeout = new Promise(resolve => {
            timer = this.setTimeoutImpl(() => {
                const error = new Error(`Lifecycle hook "${hookName}" timed out after ${this.hookTimeout}ms.`);
                error.name = 'TimeoutError';
                controller.abort(error);
                resolve({ status: EXTENSION_HOOK_STATUS.TIMEOUT, exportName: configuredName, error });
            }, this.hookTimeout);
        });

        const result = await Promise.race([observedHook, timeout]);
        this.clearTimeoutImpl(timer);
        return result;
    }

    #isHookSuccess(hookResult) {
        return [EXTENSION_HOOK_STATUS.OK, EXTENSION_HOOK_STATUS.SKIPPED].includes(hookResult.status);
    }

    #fail(record, error, hookStatus) {
        record.status = EXTENSION_LIFECYCLE_STATE.FAILED;
        record.error = serializeError(error);
        return this.#result(record, hookStatus);
    }

    #result(record, hookStatus) {
        return {
            status: record.status,
            hookStatus,
            error: record.error ? { ...record.error } : null,
        };
    }
}

/**
 * @param {ConstructorParameters<typeof ExtensionLifecycle>[0]} [options] Lifecycle dependencies
 * @returns {ExtensionLifecycle} Lifecycle manager
 */
export function createExtensionLifecycle(options) {
    return new ExtensionLifecycle(options);
}
