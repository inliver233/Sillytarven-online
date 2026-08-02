const TYPE_PRIORITY = Object.freeze({
    local: 3,
    global: 2,
    builtin: 1,
});

const PUBLIC_EXTENSION_TYPES = new Set(Object.keys(TYPE_PRIORITY));

function normalizeDirectoryIdentity(name) {
    return String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function normalizeExtensionType(type) {
    return type === 'system' ? 'builtin' : type;
}

/**
 * @typedef {object} ExtensionDescriptor
 * @property {string} canonicalName
 * @property {string} shortName
 * @property {string} type
 * @property {object} manifest
 * @property {string} resourceBaseUrl
 * @property {boolean} enabled
 */

/**
 * Returns the stable internal identity for an extension descriptor.
 * @param {Pick<ExtensionDescriptor, 'type' | 'canonicalName'>} descriptor Extension descriptor
 * @returns {string} Internal identity
 */
export function getExtensionIdentity(descriptor) {
    return `${normalizeExtensionType(descriptor.type)}:${descriptor.canonicalName}`;
}

/**
 * Produces the compatibility short name used by extension commands and macros.
 * @param {string} canonicalName Canonical discovery name
 * @returns {string} Short name
 */
export function getExtensionShortName(canonicalName) {
    return canonicalName.startsWith('third-party/')
        ? canonicalName.slice('third-party/'.length)
        : canonicalName;
}

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

/**
 * Creates canonical extension descriptors from discovery and manifest data.
 * When discovery contains the same canonical extension in local and global storage,
 * the local copy is authoritative, matching the resource-serving route.
 * @param {{name: string, type: string}[]} discoveredExtensions Discovery response
 * @param {Record<string, object>} manifests Manifests keyed by canonical name
 * @param {object} [options] Resolver options
 * @param {string[]|Set<string>} [options.disabledExtensions] Disabled canonical names
 * @returns {ExtensionDescriptor[]} Extension descriptors
 */
export function createExtensionDescriptors(discoveredExtensions, manifests, { disabledExtensions = [] } = {}) {
    if (!Array.isArray(discoveredExtensions)) {
        throw new TypeError('Discovered extensions must be an array.');
    }
    if (!manifests || typeof manifests !== 'object' || Array.isArray(manifests)) {
        throw new TypeError('Extension manifests must be an object.');
    }
    if (!Array.isArray(disabledExtensions) && !(disabledExtensions instanceof Set)) {
        throw new TypeError('Disabled extensions must be an array or Set.');
    }

    const manifestEntries = Object.entries(manifests);
    const disabled = new Set([...disabledExtensions].map(normalizeDirectoryIdentity));
    const byIdentity = new Map();
    for (const extension of discoveredExtensions) {
        const canonicalName = typeof extension?.name === 'string' ? extension.name.trim() : '';
        const type = normalizeExtensionType(typeof extension?.type === 'string' ? extension.type.trim() : '');
        const normalizedCanonicalName = normalizeDirectoryIdentity(canonicalName);
        const manifest = manifestEntries.find(([name]) => normalizeDirectoryIdentity(name) === normalizedCanonicalName)?.[1];
        if (!canonicalName || !PUBLIC_EXTENSION_TYPES.has(type) || !manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
            continue;
        }

        const identity = `${type}:${normalizedCanonicalName}`;
        if (byIdentity.has(identity)) {
            continue;
        }

        byIdentity.set(identity, {
            canonicalName,
            shortName: getExtensionShortName(canonicalName),
            type,
            manifest: structuredClone(manifest),
            resourceBaseUrl: `/scripts/extensions/${canonicalName}`,
            enabled: !disabled.has(normalizedCanonicalName),
        });
    }

    return [...byIdentity.values()].map(cloneDescriptor);
}

/**
 * Resolver for canonical extension names and compatibility aliases.
 */
export class ExtensionResolver {
    /**
     * @param {ExtensionDescriptor[]} descriptors Extension descriptors
     */
    constructor(descriptors) {
        if (!Array.isArray(descriptors)) {
            throw new TypeError('Extension descriptors must be an array.');
        }

        this.byIdentity = new Map();
        this.byCanonicalName = new Map();
        this.byShortName = new Map();

        for (const source of descriptors) {
            const descriptor = cloneDescriptor({ ...source, type: normalizeExtensionType(source.type) });
            if (!PUBLIC_EXTENSION_TYPES.has(descriptor.type)) {
                continue;
            }
            const normalizedIdentity = `${descriptor.type}:${normalizeDirectoryIdentity(descriptor.canonicalName)}`;
            this.byIdentity.set(normalizedIdentity, descriptor);

            const canonicalKey = normalizeDirectoryIdentity(descriptor.canonicalName);
            const exact = this.byCanonicalName.get(canonicalKey);
            if (!exact || TYPE_PRIORITY[exact.type] < TYPE_PRIORITY[descriptor.type]) {
                this.byCanonicalName.set(canonicalKey, descriptor);
            }

            const shortKey = normalizeDirectoryIdentity(descriptor.shortName);
            const aliases = this.byShortName.get(shortKey) ?? [];
            aliases.push(descriptor);
            this.byShortName.set(shortKey, aliases);
        }
    }

    /**
     * Resolves an exact canonical name first, then a short name only when unambiguous.
     * @param {string} name Canonical or short extension name
     * @param {'builtin'|'local'|'global'|null} [type] Optional storage type for exact identity lookup
     * @returns {ExtensionDescriptor|null} Isolated descriptor
     */
    resolve(name, type = null) {
        if (typeof name !== 'string' || !name) {
            return null;
        }

        const identityMatch = name.match(/^(builtin|local|global):(.*)$/s);
        if (identityMatch) {
            type = identityMatch[1];
            name = identityMatch[2];
        }
        const normalizedName = normalizeDirectoryIdentity(name);
        const normalizedType = type === null ? null : normalizeExtensionType(type);
        if (normalizedType !== null) {
            const typedExact = this.byIdentity.get(`${normalizedType}:${normalizedName}`);
            return typedExact ? cloneDescriptor(typedExact) : null;
        }

        const exact = this.byCanonicalName.get(normalizedName);
        if (exact) {
            return cloneDescriptor(exact);
        }

        const aliases = this.byShortName.get(normalizedName) ?? [];
        const canonicalNames = new Set(aliases.map(descriptor => normalizeDirectoryIdentity(descriptor.canonicalName)));
        if (canonicalNames.size !== 1) {
            return null;
        }

        const selected = aliases.reduce((best, descriptor) =>
            !best || TYPE_PRIORITY[descriptor.type] > TYPE_PRIORITY[best.type] ? descriptor : best, null);
        return selected ? cloneDescriptor(selected) : null;
    }

    /**
     * @returns {ExtensionDescriptor[]} Isolated descriptors in discovery order
     */
    list() {
        return [...this.byIdentity.values()].map(cloneDescriptor);
    }
}

/**
 * @param {ExtensionDescriptor[]} descriptors Extension descriptors
 * @returns {ExtensionResolver} Resolver
 */
export function createExtensionResolver(descriptors) {
    return new ExtensionResolver(descriptors);
}

/**
 * Returns a new descriptor list with enabled state changed for every normalized
 * canonical match. Input descriptors and manifests are never mutated.
 * @param {ExtensionDescriptor[]} descriptors Extension descriptors
 * @param {string} name Canonical or unambiguous short name
 * @param {boolean} enabled New enabled state
 * @returns {ExtensionDescriptor[]} Updated descriptor snapshots
 */
export function setExtensionEnabled(descriptors, name, enabled) {
    const resolver = createExtensionResolver(descriptors);
    const selected = resolver.resolve(name);
    if (!selected) {
        return resolver.list();
    }
    const canonicalKey = normalizeDirectoryIdentity(selected.canonicalName);
    return resolver.list().map(descriptor => ({
        ...descriptor,
        manifest: structuredClone(descriptor.manifest),
        enabled: normalizeDirectoryIdentity(descriptor.canonicalName) === canonicalKey ? enabled === true : descriptor.enabled,
    }));
}
