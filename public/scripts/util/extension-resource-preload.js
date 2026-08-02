const DEFAULT_MAX_PRELOADS = 64;
const TYPE_PRIORITY = Object.freeze({ local: 3, global: 2, builtin: 1 });

function normalizeName(name) {
    return String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function normalizeDescriptors(input) {
    if (Array.isArray(input)) {
        return input;
    }
    if (input && typeof input === 'object') {
        return Object.entries(input).map(([canonicalName, manifest]) => ({
            canonicalName,
            shortName: canonicalName.startsWith('third-party/') ? canonicalName.slice('third-party/'.length) : canonicalName,
            type: 'builtin',
            manifest,
            resourceBaseUrl: `/scripts/extensions/${canonicalName}`,
            enabled: true,
        }));
    }
    throw new TypeError('Extension descriptors must be an array or manifest object.');
}

function createDisposer(links) {
    let disposed = false;
    return () => {
        if (disposed) {
            return;
        }
        disposed = true;
        for (const link of links.splice(0)) {
            try {
                link?.remove?.();
            } catch {
                // Resource hints are disposable and must not affect extension activation.
            }
        }
    };
}

/**
 * Add passive preload hints for extension JavaScript and styles without executing either resource.
 * @param {import('./extension-resolver.js').ExtensionDescriptor[]|Record<string, object>} descriptorInput Extension descriptors or legacy manifest map
 * @param {object} [options] Preload options
 * @param {string[]|Set<string>} [options.excludedExtensions] Extensions that must not be preloaded
 * @param {string[]|Set<string>} [options.eligibleExtensions] Extensions that passed activation eligibility
 * @param {number} [options.maxPreloads] Maximum number of resource hints to add
 * @param {Document} [options.documentRef] Document used to create resource hints
 * @returns {{count: number, dispose: () => void}} Preload count and idempotent cleanup callback
 */
export function preloadExtensionResources(descriptorInput, {
    excludedExtensions = [],
    eligibleExtensions = null,
    maxPreloads = DEFAULT_MAX_PRELOADS,
    documentRef = globalThis.document,
} = {}) {
    const descriptors = normalizeDescriptors(descriptorInput);
    if (!Array.isArray(excludedExtensions) && !(excludedExtensions instanceof Set)) {
        throw new TypeError('Excluded extensions must be an array or Set.');
    }
    if (eligibleExtensions !== null && !Array.isArray(eligibleExtensions) && !(eligibleExtensions instanceof Set)) {
        throw new TypeError('Eligible extensions must be an array or Set.');
    }

    const requestedLimit = Number(maxPreloads);
    if (!Number.isFinite(requestedLimit) || requestedLimit < 0) {
        throw new TypeError('maxPreloads must be a non-negative finite number.');
    }
    if (typeof documentRef?.createElement !== 'function' || typeof documentRef?.head?.appendChild !== 'function') {
        throw new TypeError('A document with a writable head is required.');
    }

    const excluded = new Set([...excludedExtensions].map(normalizeName));
    const eligible = eligibleExtensions === null ? null : new Set([...eligibleExtensions].map(normalizeName));
    const limit = Math.floor(requestedLimit);
    const links = [];
    const dispose = createDisposer(links);

    try {
        const authoritative = new Map();
        for (const descriptor of descriptors) {
            if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
                continue;
            }
            const key = normalizeName(descriptor.canonicalName);
            const existing = authoritative.get(key);
            if (!existing || (TYPE_PRIORITY[descriptor.type] ?? 0) > (TYPE_PRIORITY[existing.type] ?? 0)) {
                authoritative.set(key, descriptor);
            }
        }

        const entries = [...authoritative.values()].sort((left, right) => {
            const order = parseInt(left.manifest?.loading_order) - parseInt(right.manifest?.loading_order);
            return order || String(left.manifest?.display_name || left.canonicalName)
                .localeCompare(String(right.manifest?.display_name || right.canonicalName));
        });
        for (const descriptor of entries) {
            if (links.length >= limit) {
                break;
            }
            const nameKey = normalizeName(descriptor.canonicalName);
            const manifest = descriptor.manifest;
            if (!descriptor.enabled
                || excluded.has(nameKey)
                || (eligible && !eligible.has(nameKey))
                || !manifest
                || typeof manifest !== 'object'
                || Array.isArray(manifest)) {
                continue;
            }

            const resources = [
                { file: manifest.js, rel: 'modulepreload' },
                { file: manifest.css, rel: 'preload', as: 'style' },
            ];
            for (const resource of resources) {
                if (links.length >= limit) {
                    break;
                }
                if (typeof resource.file !== 'string' || resource.file.trim().length === 0) {
                    continue;
                }

                const link = documentRef.createElement('link');
                link.rel = resource.rel;
                if (resource.as) {
                    link.as = resource.as;
                }
                link.href = `${descriptor.resourceBaseUrl}/${resource.file}`;
                documentRef.head.appendChild(link);
                links.push(link);
            }
        }
    } catch (error) {
        dispose();
        throw error;
    }

    return { count: links.length, dispose };
}
