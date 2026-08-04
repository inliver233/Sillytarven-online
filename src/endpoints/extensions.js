import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import dns from 'node:dns/promises';

import express from 'express';
import ipaddr from 'ipaddr.js';
import sanitize from 'sanitize-filename';
import { CheckRepoActions, default as simpleGit } from 'simple-git';

import { PUBLIC_DIRECTORIES } from '../constants.js';
import { canonicalJsonStringify, hashCanonicalJson, sha256 } from '../canonical-hash.js';
import { extensionStorageRouter } from '../extension-storage.js';
import { KeyedMutex } from '../keyed-mutex.js';
import { canConsumeStorage } from '../storage-quota.js';
import { getConfigValue } from '../util.js';

/**
 * @type {Partial<import('simple-git').SimpleGitOptions>}
 */
const OPTIONS = Object.freeze({ timeout: { block: 5 * 60 * 1000 } });
const THIRD_PARTY_PREFIX = 'third-party/';
const THIRD_PARTY_ROUTE_PREFIX = '/scripts/extensions/third-party';
const MANAGED_EXTENSION_TYPES = new Set(['local', 'global']);
const EXTENSION_TRANSACTION_VERSION = 1;
const EXTENSION_TRANSACTION_TYPE = 'extension-directory';
const EXTENSION_TRANSACTION_MANIFEST = 'manifest.json';
const EXTENSION_TRANSACTION_PATTERN = /^tx-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const EXTENSION_TRANSACTION_STATES = new Set(['staging', 'prepared', 'backing-up', 'backed-up', 'applying', 'published', 'rolledback']);
const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set(['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM']);
const extensionMutationMutex = new KeyedMutex();
const extensionQuotaMutex = new KeyedMutex();
const extensionRecoveryMutex = new KeyedMutex();
const activeExtensionTransactions = new Set();
const CLOUD_METADATA_HOSTNAMES = new Set([
    'instance-data',
    'instance-data.ec2.internal',
    'metadata.aws.internal',
    'metadata.azure.internal',
    'metadata.google.internal',
]);

export const EXTENSION_TYPES = Object.freeze({
    BUILTIN: 'builtin',
    LOCAL: 'local',
    GLOBAL: 'global',
});

export class ExtensionResolutionError extends Error {
    /**
     * @param {number} status HTTP status code
     * @param {string} message Error message
     */
    constructor(status, message) {
        super(message);
        this.name = 'ExtensionResolutionError';
        this.status = status;
    }
}

function areExtensionsEnabled(enabled, request) {
    if (typeof enabled === 'function') {
        return Boolean(enabled(request));
    }
    if (typeof enabled === 'boolean') {
        return enabled;
    }
    return Boolean(getConfigValue('extensions.enabled', true, 'boolean'));
}

function isExtensionLifecycleEnabledForRequest(enabled, request) {
    if (typeof enabled === 'function') {
        return Boolean(enabled(request));
    }
    if (typeof enabled === 'boolean') {
        return enabled;
    }
    return Boolean(getConfigValue('featureFlags.extensionLifecycle', false, 'boolean'));
}

/**
 * Creates the official extension feature guard with optional test-time enablement injection.
 * @param {boolean|((request: import('express').Request) => boolean)} [enabled] Enablement override
 * @returns {import('express').RequestHandler} Express request handler
 */
export function createExtensionsEnabledFeatureGuard(enabled) {
    return (request, response, next) => {
        if (!areExtensionsEnabled(enabled, request)) {
            return response.sendStatus(404);
        }
        return next();
    };
}

export const extensionsEnabledFeatureGuard = createExtensionsEnabledFeatureGuard();

/**
 * Identifies requests that must bypass the public static directory and reach
 * the authenticated per-user extension resource route.
 * @param {unknown} requestPath Express request path
 * @returns {boolean} Whether public static handling must be skipped
 */
export function isThirdPartyExtensionPath(requestPath) {
    if (typeof requestPath !== 'string') {
        return false;
    }

    const hasThirdPartyPrefix = value => {
        const normalizedPath = path.posix.normalize(value.replaceAll('\\', '/')).toLowerCase();
        return normalizedPath === THIRD_PARTY_ROUTE_PREFIX || normalizedPath.startsWith(`${THIRD_PARTY_ROUTE_PREFIX}/`);
    };
    if (hasThirdPartyPrefix(requestPath)) {
        return true;
    }

    try {
        return hasThirdPartyPrefix(decodeURIComponent(requestPath));
    } catch {
        return false;
    }
}

/**
 * Produces the stable key used to compare extension-root directory names.
 * @param {string} name Directory name
 * @returns {string} Normalized comparison key
 */
export function normalizeExtensionDirectoryName(name) {
    return String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Validates and canonicalizes an extension identity without touching the filesystem.
 * @param {unknown} extensionName Extension name from a request or discovery result
 * @param {unknown} type Explicit extension type
 * @returns {{canonicalName: string, shortName: string, type: 'builtin'|'local'|'global'}} Canonical identity
 */
export function getCanonicalExtensionIdentity(extensionName, type) {
    if (typeof extensionName !== 'string' || typeof type !== 'string') {
        throw new ExtensionResolutionError(400, 'Bad Request: A valid extensionName and type are required.');
    }

    if (![EXTENSION_TYPES.BUILTIN, EXTENSION_TYPES.LOCAL, EXTENSION_TYPES.GLOBAL].includes(type)) {
        throw new ExtensionResolutionError(400, 'Bad Request: Invalid extension type.');
    }

    const hasLegacyLeadingSlash = type !== EXTENSION_TYPES.BUILTIN
        && extensionName.startsWith('/')
        && !extensionName.startsWith('//');
    const compatibleName = hasLegacyLeadingSlash ? extensionName.slice(1) : extensionName;
    const hasThirdPartyPrefix = compatibleName.startsWith(THIRD_PARTY_PREFIX);
    const shortName = hasThirdPartyPrefix ? compatibleName.slice(THIRD_PARTY_PREFIX.length) : compatibleName;
    if (!shortName || shortName !== shortName.trim() || shortName === '.' || shortName === '..') {
        throw new ExtensionResolutionError(400, 'Bad Request: A valid extensionName is required in the request body.');
    }
    if (shortName.includes('/') || shortName.includes('\\') || /[\0-\x1f\x7f]/u.test(shortName) || sanitize(shortName) !== shortName) {
        throw new ExtensionResolutionError(400, 'Bad Request: A valid extensionName is required in the request body.');
    }

    if (type === EXTENSION_TYPES.BUILTIN && hasThirdPartyPrefix) {
        throw new ExtensionResolutionError(400, 'Bad Request: Built-in extensions cannot use the third-party prefix.');
    }

    return {
        canonicalName: type === EXTENSION_TYPES.BUILTIN ? shortName : `${THIRD_PARTY_PREFIX}${shortName}`,
        shortName,
        type,
    };
}

/**
 * Converts the existing cloud request contract (`global`) or an explicit type into one type.
 * @param {Record<string, any>} body Request body
 * @returns {'builtin'|'local'|'global'} Requested type
 */
function getRequestedExtensionType(body) {
    if (Object.hasOwn(body, 'global') && typeof body.global !== 'boolean') {
        throw new ExtensionResolutionError(400, 'Bad Request: global must be a boolean.');
    }

    if (Object.hasOwn(body, 'type')) {
        if (typeof body.type !== 'string' || !Object.values(EXTENSION_TYPES).includes(body.type)) {
            throw new ExtensionResolutionError(400, 'Bad Request: Invalid extension type.');
        }
        if (Object.hasOwn(body, 'global') && body.type !== (body.global ? EXTENSION_TYPES.GLOBAL : EXTENSION_TYPES.LOCAL)) {
            throw new ExtensionResolutionError(400, 'Bad Request: Conflicting extension type.');
        }
        return body.type;
    }

    return body.global ? EXTENSION_TYPES.GLOBAL : EXTENSION_TYPES.LOCAL;
}

/**
 * Resolves exactly one typed extension directory. It never searches another type.
 * @param {object} options Resolver options
 * @param {unknown} options.extensionName Extension name
 * @param {unknown} options.type Extension type
 * @param {string} options.localRoot Per-user extension root
 * @param {string} options.globalRoot Global extension root
 * @param {string} options.builtinRoot Built-in extension root
 * @param {boolean} [options.mustExist=true] Whether the extension must exist
 * @param {typeof fs} [options.fsModule=fs] Filesystem implementation
 * @returns {{canonicalName: string, shortName: string, type: 'builtin'|'local'|'global', root: string, extensionPath: string}} Resolved extension
 */
export function resolveTypedExtension({
    extensionName,
    type,
    localRoot,
    globalRoot,
    builtinRoot,
    mustExist = true,
    fsModule = fs,
}) {
    const identity = getCanonicalExtensionIdentity(extensionName, type);
    const roots = {
        [EXTENSION_TYPES.BUILTIN]: builtinRoot,
        [EXTENSION_TYPES.LOCAL]: localRoot,
        [EXTENSION_TYPES.GLOBAL]: globalRoot,
    };
    const root = path.resolve(roots[identity.type]);
    let resolvedIdentity = identity;
    let extensionPath = path.resolve(root, identity.shortName);
    if (path.dirname(extensionPath) !== root) {
        throw new ExtensionResolutionError(403, 'Forbidden: Invalid extension path.');
    }

    if (mustExist) {
        let entries;
        try {
            entries = fsModule.readdirSync(root, { withFileTypes: true });
        } catch (error) {
            if (error?.code === 'ENOENT') {
                throw new ExtensionResolutionError(404, `Directory does not exist at ${extensionPath}`);
            }
            throw error;
        }
        const requestedKey = normalizeExtensionDirectoryName(identity.shortName);
        const matches = entries.filter(entry => normalizeExtensionDirectoryName(entry.name) === requestedKey);
        if (matches.length > 1) {
            throw new ExtensionResolutionError(409, 'Conflicting normalized extension directory names.');
        }
        const exactEntry = matches[0];
        if (!exactEntry) {
            throw new ExtensionResolutionError(404, `Directory does not exist at ${extensionPath}`);
        }
        resolvedIdentity = getCanonicalExtensionIdentity(exactEntry.name, identity.type);
        extensionPath = path.resolve(root, resolvedIdentity.shortName);
        if (path.dirname(extensionPath) !== root) {
            throw new ExtensionResolutionError(403, 'Forbidden: Invalid extension path.');
        }
        const stat = fsModule.lstatSync(extensionPath);
        if (stat.isSymbolicLink()) {
            throw new ExtensionResolutionError(403, 'Forbidden: Symbolic link extensions are not allowed.');
        }
        if (!exactEntry.isDirectory() || !stat.isDirectory()) {
            throw new ExtensionResolutionError(404, `Directory does not exist at ${extensionPath}`);
        }
        const realRoot = fsModule.realpathSync(root);
        const realExtensionPath = fsModule.realpathSync(extensionPath);
        const relative = path.relative(realRoot, realExtensionPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new ExtensionResolutionError(403, 'Forbidden: Invalid extension path.');
        }
    }

    return { ...resolvedIdentity, root, extensionPath };
}

/**
 * Resolves an extension for a management endpoint while preserving the existing request body shape.
 * @param {import('express').Request} request HTTP request
 * @param {object} roots Extension roots
 * @param {boolean} [mustExist=true] Whether the extension must exist
 * @param {typeof fs} [fsModule=fs] Filesystem implementation
 * @returns {{canonicalName: string, shortName: string, type: 'local'|'global', root: string, extensionPath: string}} Resolved extension
 */
export function resolveManagedExtension(request, roots, mustExist = true, fsModule = fs) {
    const type = getRequestedExtensionType(request.body);
    if (!MANAGED_EXTENSION_TYPES.has(type)) {
        throw new ExtensionResolutionError(400, 'Bad Request: Built-in extensions cannot be managed.');
    }
    if (type === EXTENSION_TYPES.GLOBAL && !request.user.profile.admin) {
        throw new ExtensionResolutionError(403, 'Forbidden: No permission to manage global extensions.');
    }

    return resolveTypedExtension({
        extensionName: request.body.extensionName,
        type,
        localRoot: request.user.directories.extensions,
        globalRoot: roots.global,
        builtinRoot: roots.builtin,
        mustExist,
        fsModule,
    });
}

function findNormalizedRootEntry(root, requestedName, fsModule) {
    let entries;
    try {
        entries = fsModule.readdirSync(root, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    const key = normalizeExtensionDirectoryName(requestedName);
    const matches = entries.filter(entry => normalizeExtensionDirectoryName(entry.name) === key);
    if (matches.length > 1) {
        throw new ExtensionResolutionError(409, 'Conflicting normalized extension directory names.');
    }
    return matches[0] ?? null;
}

function isMissingExtensionResourceError(error) {
    return ['ENOENT', 'ENOTDIR'].includes(error?.code);
}

/**
 * Resolves one resource inside an already selected extension directory.
 * @param {object} options Selected resource options
 * @param {string} options.root Selected extension root
 * @param {import('node:fs').Dirent} options.entry Selected extension directory entry
 * @param {string[]} options.segments Resource path segments below the extension directory
 * @param {'local'|'global'} options.type Selected extension type
 * @param {typeof fs} options.fsModule Filesystem implementation
 * @returns {{absolutePath: string, identity: {canonicalName: string, shortName: string, type: 'local'|'global'}}} Resolved resource
 */
function resolveExtensionResourceEntry({ root, entry, segments, type, fsModule }) {
    const extensionPath = path.resolve(root, entry.name);
    let extensionStat;
    try {
        extensionStat = fsModule.lstatSync(extensionPath);
    } catch (error) {
        if (isMissingExtensionResourceError(error)) {
            throw new ExtensionResolutionError(404, 'Extension resource not found.');
        }
        throw error;
    }
    if (extensionStat.isSymbolicLink()) {
        throw new ExtensionResolutionError(403, 'Forbidden: Symbolic link extensions are not allowed.');
    }
    if (!entry.isDirectory() || !extensionStat.isDirectory()) {
        throw new ExtensionResolutionError(404, 'Extension resource not found.');
    }

    let currentPath = extensionPath;
    for (const segment of segments) {
        currentPath = path.resolve(currentPath, segment);
        const relative = path.relative(extensionPath, currentPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new ExtensionResolutionError(403, 'Forbidden: Invalid extension resource path.');
        }
        let stat;
        try {
            stat = fsModule.lstatSync(currentPath);
        } catch (error) {
            if (isMissingExtensionResourceError(error)) {
                throw new ExtensionResolutionError(404, 'Extension resource not found.');
            }
            throw error;
        }
        if (stat.isSymbolicLink()) {
            throw new ExtensionResolutionError(403, 'Forbidden: Symbolic link extension resources are not allowed.');
        }
    }

    let finalStat;
    try {
        finalStat = fsModule.statSync(currentPath);
    } catch (error) {
        if (isMissingExtensionResourceError(error)) {
            throw new ExtensionResolutionError(404, 'Extension resource not found.');
        }
        throw error;
    }
    if (!finalStat.isFile()) {
        throw new ExtensionResolutionError(404, 'Extension resource not found.');
    }
    let realExtensionPath;
    let realResourcePath;
    try {
        realExtensionPath = fsModule.realpathSync(extensionPath);
        realResourcePath = fsModule.realpathSync(currentPath);
    } catch (error) {
        if (isMissingExtensionResourceError(error)) {
            throw new ExtensionResolutionError(404, 'Extension resource not found.');
        }
        throw error;
    }
    const realRelative = path.relative(realExtensionPath, realResourcePath);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        throw new ExtensionResolutionError(403, 'Forbidden: Invalid extension resource path.');
    }

    return {
        absolutePath: currentPath,
        identity: getCanonicalExtensionIdentity(entry.name, type),
    };
}

/**
 * Selects one extension root before resolving a resource. Lifecycle mode shadows the
 * global directory as one unit; legacy mode falls back per file after a local 404.
 * @param {object} options Resource resolver options
 * @param {string} options.localRoot Per-user extension root
 * @param {string} options.globalRoot Global extension root
 * @param {unknown} options.resourcePath URL path below third-party
 * @param {typeof fs} [options.fsModule=fs] Filesystem implementation
 * @param {boolean} [options.allowGlobalFileFallback=false] Preserve legacy per-file fallback
 * @returns {{absolutePath: string, identity: {canonicalName: string, shortName: string, type: 'local'|'global'}}} Resolved resource
 */
export function resolveExtensionResource({
    localRoot,
    globalRoot,
    resourcePath,
    fsModule = fs,
    allowGlobalFileFallback = false,
}) {
    if (typeof resourcePath !== 'string' || !resourcePath) {
        throw new ExtensionResolutionError(404, 'Extension resource not found.');
    }
    if (resourcePath.includes('\\') || /[\0-\x1f\x7f]/u.test(resourcePath)) {
        throw new ExtensionResolutionError(403, 'Forbidden: Invalid extension resource path.');
    }

    const segments = resourcePath.split('/');
    if (segments.length < 2 || segments.some(segment => !segment || segment === '.' || segment === '..')) {
        throw new ExtensionResolutionError(403, 'Forbidden: Invalid extension resource path.');
    }
    const requestedDirectory = segments.shift();
    getCanonicalExtensionIdentity(requestedDirectory, EXTENSION_TYPES.LOCAL);

    const localEntry = findNormalizedRootEntry(localRoot, requestedDirectory, fsModule);
    if (localEntry) {
        try {
            return resolveExtensionResourceEntry({
                root: localRoot,
                entry: localEntry,
                segments,
                type: EXTENSION_TYPES.LOCAL,
                fsModule,
            });
        } catch (error) {
            if (!allowGlobalFileFallback || error?.status !== 404) {
                throw error;
            }
        }
    }

    const globalEntry = findNormalizedRootEntry(globalRoot, requestedDirectory, fsModule);
    if (!globalEntry) {
        throw new ExtensionResolutionError(404, 'Extension resource not found.');
    }
    return resolveExtensionResourceEntry({
        root: globalRoot,
        entry: globalEntry,
        segments,
        type: EXTENSION_TYPES.GLOBAL,
        fsModule,
    });
}

/**
 * Creates a side-effect-free handler for per-user third-party extension resources.
 * @param {(request: import('express').Request) => string} localRootFn Per-user root provider
 * @param {(request: import('express').Request) => string} globalRootFn Global root provider
 * @param {object} [options] Route options
 * @param {boolean|((request: import('express').Request) => boolean)} [options.enabled] Enablement override
 * @param {boolean|((request: import('express').Request) => boolean)} [options.lifecycleEnabled] Lifecycle resolver override
 * @returns {import('express').RequestHandler} Express request handler
 */
export function createExtensionResourceRouteHandler(localRootFn, globalRootFn, options = {}) {
    return async (request, response) => {
        if (!areExtensionsEnabled(options.enabled, request)) {
            return response.sendStatus(404);
        }
        response.vary('Cookie');
        response.set('Cache-Control', 'private, no-cache, must-revalidate');
        let resourcePath;
        try {
            resourcePath = decodeURIComponent(request.params[0]);
        } catch (error) {
            if (error instanceof URIError) {
                return response.sendStatus(400);
            }
            return response.sendStatus(500);
        }
        try {
            const { absolutePath } = resolveExtensionResource({
                localRoot: localRootFn(request),
                globalRoot: globalRootFn(request),
                resourcePath,
                allowGlobalFileFallback: !isExtensionLifecycleEnabledForRequest(options.lifecycleEnabled, request),
            });
            return response.sendFile(absolutePath);
        } catch (error) {
            if (Number.isInteger(error?.status)) {
                return response.sendStatus(error.status);
            }
            return response.sendStatus(500);
        }
    };
}

async function getManifest(extensionPath, fsModule) {
    const manifestPath = path.join(extensionPath, 'manifest.json');
    const manifest = JSON.parse(await fsModule.promises.readFile(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('Manifest is not a valid JSON object.');
    }
    return manifest;
}

async function checkIfRepoIsUpToDate(extensionPath, createGit) {
    const git = createGit({ baseDir: extensionPath, ...OPTIONS });
    await git.fetch('origin');
    const currentBranch = await git.branch();
    const currentCommitHash = await git.revparse(['HEAD']);
    const log = await git.log({ from: currentCommitHash, to: `origin/${currentBranch.current}` });
    const remotes = await git.getRemotes(true);
    if (remotes.length === 0) return { isUpToDate: true, remoteUrl: '' };
    return { isUpToDate: log.total === 0, remoteUrl: remotes[0].refs.fetch };
}

function sendResolutionError(response, error, operation) {
    if (error instanceof ExtensionStorageLimitError) {
        return response.status(403).json({
            error: 'storage_limit',
            message: '存储空间不足，无法保存扩展，请删除文件或使用激活码扩容。',
            usedBytes: error.storage.usedBytes,
            limitBytes: error.storage.limitBytes,
            remainingBytes: error.storage.remainingBytes,
        });
    }
    if (error instanceof ExtensionResolutionError) {
        return response.status(error.status).send(error.message);
    }
    console.error(`${operation} failed`, error);
    return response.status(500).send('Internal Server Error. Check the server logs for more details.');
}

function normalizeHostname(hostname) {
    return String(hostname ?? '').replace(/^\[/u, '').replace(/\]$/u, '').replace(/\.+$/u, '').toLowerCase();
}

function isPublicIpAddress(address) {
    if (!ipaddr.isValid(address)) {
        return false;
    }

    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
        parsed = parsed.toIPv4Address();
    }

    return parsed.range() === 'unicast';
}

async function validateInstallTarget(parsedUrl, dnsLookup) {
    const hostname = normalizeHostname(parsedUrl.hostname);
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || CLOUD_METADATA_HOSTNAMES.has(hostname)) {
        throw new ExtensionResolutionError(400, 'Bad Request: Extension URL targets a private or non-public network address.');
    }

    if (ipaddr.isValid(hostname)) {
        if (!isPublicIpAddress(hostname)) {
            throw new ExtensionResolutionError(400, 'Bad Request: Extension URL targets a private or non-public network address.');
        }
        return null;
    }

    let lookupResult;
    try {
        lookupResult = await dnsLookup(hostname, { all: true, verbatim: true });
    } catch {
        throw new ExtensionResolutionError(400, 'Bad Request: Extension URL hostname could not be resolved.');
    }
    const records = Array.isArray(lookupResult) ? lookupResult : [lookupResult];
    const addresses = records.map(record => typeof record === 'string' ? record : record?.address).filter(Boolean);
    if (addresses.length === 0) {
        throw new ExtensionResolutionError(400, 'Bad Request: Extension URL hostname could not be resolved.');
    }
    if (addresses.some(address => !isPublicIpAddress(address))) {
        throw new ExtensionResolutionError(400, 'Bad Request: Extension URL targets a private or non-public network address.');
    }
    return addresses[0];
}

function getPinnedGitConfig(parsedUrl, address) {
    const config = ['http.followRedirects=false'];
    if (!address) {
        return config;
    }

    const hostname = String(parsedUrl.hostname).replace(/^\[/u, '').replace(/\]$/u, '').toLowerCase();
    const port = parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80');
    const parsedAddress = ipaddr.parse(address);
    const curlAddress = parsedAddress.kind() === 'ipv6' ? `[${address}]` : address;
    config.push(`http.curloptResolve=${hostname}:${port}:${curlAddress}`);
    return config;
}

function validateInstallUrl(value) {
    if (typeof value !== 'string') {
        throw new ExtensionResolutionError(400, 'Bad Request: A valid URL is required in the request body.');
    }
    let parsedUrl;
    try {
        parsedUrl = new URL(value);
    } catch {
        throw new ExtensionResolutionError(400, 'Bad Request: A valid URL is required in the request body.');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new ExtensionResolutionError(400, 'Bad Request: Only HTTP and HTTPS protocols are supported for the Extension URL.');
    }
    return parsedUrl;
}

/**
 * Reduces an extension URL to a bounded origin for diagnostic logging.
 * @param {URL|string} value Extension URL
 * @returns {string} Credential- and path-free URL origin
 */
export function sanitizeExtensionUrlForLog(value) {
    try {
        const parsedUrl = value instanceof URL ? value : new URL(String(value));
        return parsedUrl.origin.slice(0, 256);
    } catch {
        return '[invalid extension URL]';
    }
}

function validateBranch(branch, required = false) {
    if ((branch === undefined || branch === '') && !required) return;
    if (typeof branch !== 'string' || !branch || /[\0\r\n]/u.test(branch)) {
        throw new ExtensionResolutionError(400, 'Bad Request: A valid branch is required in the request body.');
    }
}

class ExtensionStorageLimitError extends Error {
    constructor(storage) {
        super('Extension mutation exceeds the user storage limit.');
        this.name = 'ExtensionStorageLimitError';
        this.storage = storage;
    }
}

function normalizedPath(filePath) {
    const normalized = path.normalize(path.resolve(filePath));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isPathInside(parentPath, childPath) {
    const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathExists(fsModule, filePath) {
    try {
        fsModule.lstatSync(filePath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

function assertExactDirectory(fsModule, directoryPath, label) {
    const absolutePath = path.resolve(directoryPath);
    const stats = fsModule.lstatSync(absolutePath);
    if (!stats.isDirectory() || stats.isSymbolicLink()
        || normalizedPath(fsModule.realpathSync(absolutePath)) !== normalizedPath(absolutePath)) {
        throw new Error(`${label} must be an exact real directory without symbolic links.`);
    }
    return absolutePath;
}

function syncFile(fsModule, filePath) {
    const descriptor = fsModule.openSync(filePath, process.platform === 'win32' ? 'r+' : 'r');
    try {
        fsModule.fsyncSync(descriptor);
    } finally {
        fsModule.closeSync(descriptor);
    }
}

function syncDirectory(fsModule, directoryPath) {
    let descriptor;
    try {
        descriptor = fsModule.openSync(directoryPath, 'r');
        fsModule.fsyncSync(descriptor);
    } catch (error) {
        if (process.platform !== 'win32' || !DIRECTORY_SYNC_UNSUPPORTED_CODES.has(error?.code)) throw error;
    } finally {
        if (descriptor !== undefined) fsModule.closeSync(descriptor);
    }
}

function inspectExtensionTree(fsModule, directoryPath) {
    const root = assertExactDirectory(fsModule, directoryPath, 'Extension directory');
    const entries = [];
    let bytes = 0;

    const visit = (currentPath, relativeParent = '') => {
        const children = fsModule.readdirSync(currentPath, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
            const childPath = path.join(currentPath, child.name);
            const relativePath = path.posix.join(relativeParent, child.name);
            const stats = fsModule.lstatSync(childPath);
            if (stats.isSymbolicLink()) {
                throw new Error(`Extension trees cannot contain symbolic links: ${childPath}`);
            }
            if (stats.isDirectory()) {
                entries.push({ path: `${relativePath}/`, type: 'directory' });
                visit(childPath, relativePath);
                continue;
            }
            if (!stats.isFile()) {
                throw new Error(`Extension trees can contain only regular files and directories: ${childPath}`);
            }
            const contents = fsModule.readFileSync(childPath);
            bytes += contents.length;
            entries.push({ path: relativePath, type: 'file', size: contents.length, sha256: sha256(contents) });
        }
    };

    visit(root);
    return { bytes, entries: entries.length, digest: hashCanonicalJson(entries) };
}

function syncExtensionTree(fsModule, directoryPath) {
    const directories = [];
    const visit = currentPath => {
        directories.push(currentPath);
        for (const entry of fsModule.readdirSync(currentPath, { withFileTypes: true })) {
            const entryPath = path.join(currentPath, entry.name);
            const stats = fsModule.lstatSync(entryPath);
            if (stats.isSymbolicLink()) throw new Error(`Extension trees cannot contain symbolic links: ${entryPath}`);
            if (stats.isDirectory()) visit(entryPath);
            else if (stats.isFile()) syncFile(fsModule, entryPath);
            else throw new Error(`Extension trees can contain only regular files and directories: ${entryPath}`);
        }
    };
    visit(assertExactDirectory(fsModule, directoryPath, 'Extension directory'));
    for (const directory of directories.reverse()) syncDirectory(fsModule, directory);
}

function isValidTreeSummary(summary) {
    return summary && Number.isSafeInteger(summary.bytes) && summary.bytes >= 0
        && Number.isSafeInteger(summary.entries) && summary.entries >= 0
        && typeof summary.digest === 'string' && /^[a-f0-9]{64}$/u.test(summary.digest);
}

function verifyExtensionTree(fsModule, directoryPath, expected, label) {
    const actual = inspectExtensionTree(fsModule, directoryPath);
    if (actual.bytes !== expected.bytes || actual.entries !== expected.entries || actual.digest !== expected.digest) {
        throw new Error(`${label} checksum mismatch: ${directoryPath}`);
    }
}

function writeExtensionTransactionManifest(fsModule, transactionPath, manifest) {
    const unsigned = { ...manifest };
    delete unsigned.checksum;
    const signed = { ...unsigned, checksum: hashCanonicalJson(unsigned) };
    const manifestPath = path.join(transactionPath, EXTENSION_TRANSACTION_MANIFEST);
    const temporaryPath = `${manifestPath}.${crypto.randomUUID()}.tmp`;
    fsModule.writeFileSync(temporaryPath, canonicalJsonStringify(signed), { flag: 'wx', mode: 0o600 });
    syncFile(fsModule, temporaryPath);
    fsModule.renameSync(temporaryPath, manifestPath);
    syncDirectory(fsModule, transactionPath);
    return signed;
}

function readExtensionTransactionManifest(fsModule, transactionPath, context) {
    const manifestPath = path.join(transactionPath, EXTENSION_TRANSACTION_MANIFEST);
    const parsed = JSON.parse(fsModule.readFileSync(manifestPath, 'utf8'));
    const { checksum, ...unsigned } = parsed ?? {};
    if (typeof checksum !== 'string' || checksum !== hashCanonicalJson(unsigned)) {
        throw new Error(`Invalid or tampered extension transaction manifest: ${manifestPath}`);
    }
    if (parsed.version !== EXTENSION_TRANSACTION_VERSION || parsed.type !== EXTENSION_TRANSACTION_TYPE
        || parsed.scopeHash !== context.scopeHash || !EXTENSION_TRANSACTION_STATES.has(parsed.state)
        || !['install', 'update', 'switch', 'delete', 'move-destination', 'move-source'].includes(parsed.operation)
        || typeof parsed.shortName !== 'string') {
        throw new Error(`Invalid extension transaction manifest: ${manifestPath}`);
    }
    const identity = getCanonicalExtensionIdentity(parsed.shortName, context.type);
    if (identity.shortName !== parsed.shortName || parsed.extensionType !== context.type) {
        throw new Error(`Extension transaction identity mismatch: ${manifestPath}`);
    }
    if ((parsed.original !== null && !isValidTreeSummary(parsed.original))
        || (parsed.candidate !== null && !isValidTreeSummary(parsed.candidate))) {
        throw new Error(`Invalid extension transaction tree summary: ${manifestPath}`);
    }
    if ((parsed.original !== null) !== parsed.hadOriginal) {
        throw new Error(`Invalid extension transaction original-state marker: ${manifestPath}`);
    }
    return parsed;
}

function getExtensionUserRoot(request) {
    return path.resolve(request.user.directories.root ?? path.dirname(request.user.directories.extensions));
}

function createExtensionTransactionContext(request, type, roots, stagingRoot, fsModule) {
    const targetRoot = path.resolve(type === EXTENSION_TYPES.LOCAL ? request.user.directories.extensions : roots.global);
    fsModule.mkdirSync(targetRoot, { recursive: true });
    assertExactDirectory(fsModule, targetRoot, 'Extension target root');
    const handle = String(request.user.profile.handle ?? '');
    const scopeHash = sha256(`${type}\0${targetRoot}\0${type === EXTENSION_TYPES.LOCAL ? handle : ''}`);
    const userRoot = getExtensionUserRoot(request);
    const configuredRoot = typeof stagingRoot === 'function'
        ? stagingRoot({ request, type, targetRoot, userRoot })
        : stagingRoot;
    const stagingParent = configuredRoot
        ? path.resolve(configuredRoot)
        : type === EXTENSION_TYPES.LOCAL
            ? path.join(path.dirname(userRoot), '.extension-staging')
            : path.join(path.dirname(path.resolve(roots.builtin)), '.extension-staging');
    const namespace = path.join(stagingParent, type === EXTENSION_TYPES.GLOBAL ? 'global' : `local-${scopeHash}`);
    if (type === EXTENSION_TYPES.LOCAL && isPathInside(userRoot, namespace)) {
        throw new Error('Local extension staging must be outside the user quota root.');
    }
    if (isPathInside(targetRoot, namespace)) {
        throw new Error('Extension staging must be outside the live extension root.');
    }
    fsModule.mkdirSync(namespace, { recursive: true });
    assertExactDirectory(fsModule, namespace, 'Extension transaction namespace');
    if (fsModule.statSync(namespace).dev !== fsModule.statSync(targetRoot).dev) {
        throw new Error('Extension staging and live directories must use the same filesystem for atomic publication.');
    }
    return { type, targetRoot, namespace, scopeHash, userRoot, handle };
}

function extensionTargetPath(context, shortName) {
    const targetPath = path.resolve(context.targetRoot, shortName);
    if (path.dirname(targetPath) !== context.targetRoot) throw new Error('Invalid extension transaction target.');
    return targetPath;
}

function extensionMutationLockKey(context, shortName) {
    return `${context.scopeHash}\0${normalizeExtensionDirectoryName(shortName)}`;
}

function extensionQuotaLockKey(request) {
    return `${String(request.user.profile.handle ?? '')}\0${getExtensionUserRoot(request)}`;
}

async function runWithMutexKeys(mutex, keys, callback) {
    const ordered = [...new Set(keys)].sort();
    const acquire = async index => index >= ordered.length
        ? await callback()
        : await mutex.runExclusive(ordered[index], () => acquire(index + 1));
    return await acquire(0);
}

function beginExtensionTransaction(context, shortName, operation, fsModule) {
    const targetPath = extensionTargetPath(context, shortName);
    const original = pathExists(fsModule, targetPath) ? inspectExtensionTree(fsModule, targetPath) : null;
    const transactionId = `tx-${crypto.randomUUID()}`;
    const transactionPath = path.join(context.namespace, transactionId);
    fsModule.mkdirSync(transactionPath);
    syncDirectory(fsModule, context.namespace);
    let manifest = {
        version: EXTENSION_TRANSACTION_VERSION,
        type: EXTENSION_TRANSACTION_TYPE,
        id: transactionId,
        state: 'staging',
        operation,
        extensionType: context.type,
        shortName,
        scopeHash: context.scopeHash,
        hadOriginal: original !== null,
        original,
        candidate: null,
    };
    try {
        manifest = writeExtensionTransactionManifest(fsModule, transactionPath, manifest);
    } catch (error) {
        fsModule.rmSync(transactionPath, { recursive: true, force: true });
        throw error;
    }
    activeExtensionTransactions.add(normalizedPath(transactionPath));
    return {
        context,
        transactionPath,
        targetPath,
        candidatePath: path.join(transactionPath, 'candidate'),
        backupPath: path.join(transactionPath, 'backup'),
        manifest,
    };
}

function updateExtensionTransactionState(transaction, state, fsModule, additions = {}) {
    transaction.manifest = writeExtensionTransactionManifest(fsModule, transaction.transactionPath, {
        ...transaction.manifest,
        ...additions,
        state,
    });
}

function prepareExtensionCandidate(transaction, fsModule) {
    if (transaction.manifest.state !== 'staging') throw new Error('Extension transaction is not staging.');
    if (transaction.manifest.original) {
        verifyExtensionTree(fsModule, transaction.targetPath, transaction.manifest.original, 'Original extension');
    } else if (pathExists(fsModule, transaction.targetPath)) {
        throw new Error('Extension transaction target appeared during staging.');
    }
    const candidate = inspectExtensionTree(fsModule, transaction.candidatePath);
    updateExtensionTransactionState(transaction, 'prepared', fsModule, { candidate });
    return candidate;
}

function prepareExtensionDeletion(transaction, fsModule) {
    if (transaction.manifest.state !== 'staging' || !transaction.manifest.original) {
        throw new Error('Extension deletion transaction requires an existing source.');
    }
    verifyExtensionTree(fsModule, transaction.targetPath, transaction.manifest.original, 'Original extension');
    updateExtensionTransactionState(transaction, 'prepared', fsModule);
}

async function cleanupExtensionTransaction(transaction, tools) {
    try {
        await tools.removeDirectory(transaction.transactionPath, { recursive: true, force: true });
        syncDirectory(tools.fsModule, transaction.context.namespace);
    } finally {
        activeExtensionTransactions.delete(normalizedPath(transaction.transactionPath));
    }
}

async function rollbackExtensionTransaction(transaction, tools) {
    const { fsModule, renameDirectorySync } = tools;
    transaction.manifest = readExtensionTransactionManifest(fsModule, transaction.transactionPath, transaction.context);
    if (transaction.manifest.state === 'published') {
        await cleanupExtensionTransaction(transaction, tools);
        return;
    }
    const targetExists = pathExists(fsModule, transaction.targetPath);
    const backupExists = pathExists(fsModule, transaction.backupPath);
    const candidateExists = pathExists(fsModule, transaction.candidatePath);

    if (backupExists) {
        verifyExtensionTree(fsModule, transaction.backupPath, transaction.manifest.original, 'Extension backup');
        if (targetExists) {
            if (!transaction.manifest.candidate || candidateExists) {
                throw new Error('Cannot safely roll back conflicting extension transaction artifacts.');
            }
            verifyExtensionTree(fsModule, transaction.targetPath, transaction.manifest.candidate, 'Published extension candidate');
            renameDirectorySync(transaction.targetPath, transaction.candidatePath);
        }
        renameDirectorySync(transaction.backupPath, transaction.targetPath);
        syncDirectory(fsModule, transaction.context.targetRoot);
        verifyExtensionTree(fsModule, transaction.targetPath, transaction.manifest.original, 'Restored extension');
    } else if (transaction.manifest.original) {
        if (!targetExists) throw new Error('Original extension is missing and no backup is available.');
        verifyExtensionTree(fsModule, transaction.targetPath, transaction.manifest.original, 'Unchanged extension');
    } else if (targetExists) {
        if (!transaction.manifest.candidate || candidateExists) {
            throw new Error('Cannot safely roll back a newly published extension.');
        }
        verifyExtensionTree(fsModule, transaction.targetPath, transaction.manifest.candidate, 'Published extension candidate');
        renameDirectorySync(transaction.targetPath, transaction.candidatePath);
        syncDirectory(fsModule, transaction.context.targetRoot);
    }

    updateExtensionTransactionState(transaction, 'rolledback', fsModule);
    await cleanupExtensionTransaction(transaction, tools);
}

async function publishExtensionTransaction(transaction, tools, { deferCleanup = false } = {}) {
    const { fsModule, renameDirectorySync, transactionHook } = tools;
    if (transaction.manifest.state !== 'prepared') throw new Error('Extension transaction is not prepared.');
    if (transaction.manifest.candidate) {
        verifyExtensionTree(fsModule, transaction.candidatePath, transaction.manifest.candidate, 'Extension candidate');
        syncExtensionTree(fsModule, transaction.candidatePath);
        syncDirectory(fsModule, transaction.transactionPath);
    }
    updateExtensionTransactionState(transaction, 'backing-up', fsModule);
    await transactionHook?.('before-backup', transaction);
    if (transaction.manifest.original) {
        verifyExtensionTree(fsModule, transaction.targetPath, transaction.manifest.original, 'Original extension');
        renameDirectorySync(transaction.targetPath, transaction.backupPath);
        syncDirectory(fsModule, transaction.context.targetRoot);
        syncDirectory(fsModule, transaction.transactionPath);
    } else if (pathExists(fsModule, transaction.targetPath)) {
        throw new Error('Extension transaction target appeared before publish.');
    }
    await transactionHook?.('after-backup', transaction);
    updateExtensionTransactionState(transaction, 'backed-up', fsModule);
    updateExtensionTransactionState(transaction, 'applying', fsModule);
    if (transaction.manifest.candidate) {
        renameDirectorySync(transaction.candidatePath, transaction.targetPath);
        syncDirectory(fsModule, transaction.context.targetRoot);
        syncDirectory(fsModule, transaction.transactionPath);
        syncExtensionTree(fsModule, transaction.targetPath);
        verifyExtensionTree(fsModule, transaction.targetPath, transaction.manifest.candidate, 'Published extension');
    } else if (pathExists(fsModule, transaction.targetPath)) {
        throw new Error('Deleted extension target still exists.');
    }
    await transactionHook?.('after-apply', transaction);
    updateExtensionTransactionState(transaction, 'published', fsModule);
    if (deferCleanup) return;
    try {
        await cleanupExtensionTransaction(transaction, tools);
    } catch (error) {
        console.error(`Extension transaction cleanup will be retried from ${transaction.transactionPath}`, error);
    }
}

async function rollbackPublishedNewExtensionTransaction(transaction, tools) {
    const { fsModule, renameDirectorySync } = tools;
    transaction.manifest = readExtensionTransactionManifest(fsModule, transaction.transactionPath, transaction.context);
    if (transaction.manifest.state !== 'published' || transaction.manifest.original || !transaction.manifest.candidate) {
        throw new Error('Only a newly published extension can be rolled back after publication.');
    }
    verifyExtensionTree(fsModule, transaction.targetPath, transaction.manifest.candidate, 'Published extension');
    renameDirectorySync(transaction.targetPath, transaction.candidatePath);
    syncDirectory(fsModule, transaction.context.targetRoot);
    updateExtensionTransactionState(transaction, 'rolledback', fsModule);
    await cleanupExtensionTransaction(transaction, tools);
}

async function recoverExtensionTransactions(context, tools) {
    const { fsModule } = tools;
    if (!pathExists(fsModule, context.namespace)) return { restored: 0, cleaned: 0 };
    assertExactDirectory(fsModule, context.namespace, 'Extension transaction namespace');
    const result = { restored: 0, cleaned: 0 };
    for (const entry of fsModule.readdirSync(context.namespace, { withFileTypes: true })) {
        const transactionPath = path.join(context.namespace, entry.name);
        if (entry.isSymbolicLink() || !entry.isDirectory() || !EXTENSION_TRANSACTION_PATTERN.test(entry.name)) {
            throw new Error(`Unsafe extension transaction journal entry: ${transactionPath}`);
        }
        if (activeExtensionTransactions.has(normalizedPath(transactionPath))) continue;
        for (const artifact of fsModule.readdirSync(transactionPath, { withFileTypes: true })) {
            if (artifact.isFile() && /^manifest\.json\.[a-f0-9-]+\.tmp$/u.test(artifact.name)) {
                fsModule.rmSync(path.join(transactionPath, artifact.name), { force: true });
                continue;
            }
            if (![EXTENSION_TRANSACTION_MANIFEST, 'candidate', 'backup'].includes(artifact.name)
                || artifact.isSymbolicLink()
                || (artifact.name !== EXTENSION_TRANSACTION_MANIFEST && !artifact.isDirectory())) {
                throw new Error(`Unsafe extension transaction artifact: ${path.join(transactionPath, artifact.name)}`);
            }
        }
        const manifestPath = path.join(transactionPath, EXTENSION_TRANSACTION_MANIFEST);
        if (!pathExists(fsModule, manifestPath)) {
            if (pathExists(fsModule, path.join(transactionPath, 'backup'))) {
                throw new Error(`Extension transaction backup has no manifest: ${transactionPath}`);
            }
            await tools.removeDirectory(transactionPath, { recursive: true, force: true });
            result.cleaned += 1;
            continue;
        }
        const manifest = readExtensionTransactionManifest(fsModule, transactionPath, context);
        const transaction = {
            context,
            transactionPath,
            targetPath: extensionTargetPath(context, manifest.shortName),
            candidatePath: path.join(transactionPath, 'candidate'),
            backupPath: path.join(transactionPath, 'backup'),
            manifest,
        };
        if (manifest.state === 'published') {
            if (manifest.candidate) {
                if (!pathExists(fsModule, transaction.targetPath)) throw new Error('Published extension target is missing.');
                verifyExtensionTree(fsModule, transaction.targetPath, manifest.candidate, 'Published extension');
            } else if (pathExists(fsModule, transaction.targetPath)) {
                throw new Error('Published extension deletion target still exists.');
            }
            await cleanupExtensionTransaction(transaction, tools);
            result.cleaned += 1;
        } else if (manifest.state === 'rolledback') {
            if (manifest.original) verifyExtensionTree(fsModule, transaction.targetPath, manifest.original, 'Rolled-back extension');
            else if (pathExists(fsModule, transaction.targetPath)) throw new Error('Rolled-back extension target unexpectedly exists.');
            await cleanupExtensionTransaction(transaction, tools);
            result.cleaned += 1;
        } else {
            await rollbackExtensionTransaction(transaction, tools);
            result.restored += 1;
        }
    }
    syncDirectory(fsModule, context.namespace);
    return result;
}

async function rollbackAfterExtensionFailure(transaction, tools, error) {
    if (!transaction) throw error;
    try {
        await rollbackExtensionTransaction(transaction, tools);
    } catch (rollbackError) {
        activeExtensionTransactions.delete(normalizedPath(transaction.transactionPath));
        throw new globalThis.AggregateError(
            [error, rollbackError],
            'Extension mutation failed and could not be fully rolled back.',
            { cause: error },
        );
    }
    throw error;
}

/**
 * Creates the extension management router. Dependencies are injectable for focused failure tests.
 * @param {object} [dependencies] Router dependencies
 * @returns {import('express').Router} Express router
 */
export function createExtensionsRouter(dependencies = {}) {
    const fsModule = dependencies.fsModule ?? fs;
    const createGit = dependencies.createGit ?? (options => simpleGit(options));
    const dnsLookup = dependencies.dnsLookup ?? ((hostname, options) => dns.lookup(hostname, options));
    const removeDirectory = dependencies.removeDirectory ?? ((target, options) => fsModule.promises.rm(target, options));
    const copyDirectorySync = dependencies.copyDirectorySync ?? ((source, destination, options) => fsModule.cpSync(source, destination, options));
    const renameDirectorySync = dependencies.renameDirectorySync ?? ((source, destination) => fsModule.renameSync(source, destination));
    const storageCapacity = dependencies.canConsumeStorage ?? canConsumeStorage;
    const mutationMutex = dependencies.mutationMutex ?? extensionMutationMutex;
    const quotaMutex = dependencies.quotaMutex ?? extensionQuotaMutex;
    const recoveryMutex = dependencies.recoveryMutex ?? extensionRecoveryMutex;
    const roots = {
        global: dependencies.globalRoot ?? PUBLIC_DIRECTORIES.globalExtensions,
        builtin: dependencies.builtinRoot ?? PUBLIC_DIRECTORIES.extensions,
    };
    const transactionTools = {
        fsModule,
        removeDirectory,
        renameDirectorySync,
        transactionHook: dependencies.transactionHook,
    };

    const recoverContexts = async (request, contexts) => {
        const contextList = [...contexts.values()];
        const recover = async () => {
            for (const context of contextList) await recoverExtensionTransactions(context, transactionTools);
        };
        return await runWithMutexKeys(recoveryMutex, contextList.map(context => context.scopeHash), async () => (
            contextList.some(context => context.type === EXTENSION_TYPES.LOCAL)
                ? await quotaMutex.runExclusive(extensionQuotaLockKey(request), recover)
                : await recover()
        ));
    };

    const withMutationLocks = async (request, identities, callback) => {
        const contexts = new Map();
        for (const { type } of identities) {
            if (!contexts.has(type)) {
                contexts.set(type, createExtensionTransactionContext(
                    request,
                    type,
                    roots,
                    dependencies.stagingRoot,
                    fsModule,
                ));
            }
        }
        const keys = identities.map(({ type, shortName }) => extensionMutationLockKey(contexts.get(type), shortName));
        return await runWithMutexKeys(mutationMutex, keys, async () => {
            await recoverContexts(request, contexts);
            return await callback(contexts);
        });
    };

    const ensureLocalTransactionCapacity = async (request, transaction) => {
        if (transaction.context.type !== EXTENSION_TYPES.LOCAL || !transaction.manifest.candidate) return;
        const additionalBytes = Math.max(
            0,
            transaction.manifest.candidate.bytes - (transaction.manifest.original?.bytes ?? 0),
        );
        const result = await storageCapacity(request.user.profile, request.user.directories, additionalBytes);
        if (!result.allowed) throw new ExtensionStorageLimitError(result);
    };

    const publishWithQuota = async (request, transaction, options) => {
        const publish = async () => {
            await ensureLocalTransactionCapacity(request, transaction);
            await publishExtensionTransaction(transaction, transactionTools, options);
        };
        return transaction.context.type === EXTENSION_TYPES.LOCAL
            ? await quotaMutex.runExclusive(extensionQuotaLockKey(request), publish)
            : await publish();
    };
    const extensionsRouter = express.Router();
    extensionsRouter.use(createExtensionsEnabledFeatureGuard(dependencies.enabled));
    extensionsRouter.use('/:extensionId/storage', extensionStorageRouter);

    extensionsRouter.post('/install', async (request, response) => {
        try {
            const { global = false, branch } = request.body;
            if (typeof global !== 'boolean') {
                throw new ExtensionResolutionError(400, 'Bad Request: global must be a boolean.');
            }
            if (global && !request.user.profile.admin) {
                throw new ExtensionResolutionError(403, 'Forbidden: No permission to install global extensions.');
            }
            validateBranch(branch);
            const parsedUrl = validateInstallUrl(request.body.url);
            let urlName;
            try {
                urlName = decodeURIComponent(path.posix.basename(parsedUrl.pathname)).replace(/\.git$/iu, '');
            } catch {
                throw new ExtensionResolutionError(400, 'Could not determine the extension name from the URL. Please provide a valid git repository URL.');
            }
            const type = global ? EXTENSION_TYPES.GLOBAL : EXTENSION_TYPES.LOCAL;
            const identity = getCanonicalExtensionIdentity(urlName, type);
            const resolvedAddress = await validateInstallTarget(parsedUrl, dnsLookup);
            const result = await withMutationLocks(request, [identity], async contexts => {
                const context = contexts.get(type);
                const extensionPath = extensionTargetPath(context, identity.shortName);
                if (findNormalizedRootEntry(context.targetRoot, identity.shortName, fsModule)) {
                    throw new ExtensionResolutionError(409, `Directory already exists at ${extensionPath}`);
                }

                let transaction;
                try {
                    transaction = beginExtensionTransaction(context, identity.shortName, 'install', fsModule);
                    const git = createGit({
                        ...OPTIONS,
                        config: getPinnedGitConfig(parsedUrl, resolvedAddress),
                    });
                    const cloneOptions = { '--depth': 1 };
                    if (branch) cloneOptions['--branch'] = branch;
                    await git.clone(parsedUrl.href, transaction.candidatePath, cloneOptions);
                    const manifest = await getManifest(transaction.candidatePath, fsModule);
                    prepareExtensionCandidate(transaction, fsModule);
                    await publishWithQuota(request, transaction);
                    const { version, author, display_name } = manifest;
                    return { version, author, display_name, extensionPath, folderName: identity.shortName };
                } catch (error) {
                    return await rollbackAfterExtensionFailure(transaction, transactionTools, error);
                }
            });
            console.info(`Extension has been cloned to ${result.extensionPath} from ${sanitizeExtensionUrlForLog(parsedUrl)}`);
            return response.send(result);
        } catch (error) {
            return sendResolutionError(response, error, 'Importing extension');
        }
    });

    extensionsRouter.post('/update', async (request, response) => {
        try {
            const identity = resolveManagedExtension(request, roots, false, fsModule);
            const result = await withMutationLocks(request, [identity], async contexts => {
                const resolved = resolveManagedExtension(request, roots, true, fsModule);
                let transaction;
                try {
                    transaction = beginExtensionTransaction(contexts.get(resolved.type), resolved.shortName, 'update', fsModule);
                    copyDirectorySync(resolved.extensionPath, transaction.candidatePath, {
                        recursive: true,
                        force: false,
                        errorOnExist: true,
                    });
                    const { isUpToDate, remoteUrl } = await checkIfRepoIsUpToDate(transaction.candidatePath, createGit);
                    const git = createGit({ baseDir: transaction.candidatePath, ...OPTIONS });
                    if (!await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT)) {
                        throw new Error(`Directory is not a Git repository at ${resolved.extensionPath}`);
                    }
                    const currentBranch = await git.branch();
                    if (!isUpToDate) await git.pull('origin', currentBranch.current);
                    await git.fetch('origin');
                    const fullCommitHash = await git.revparse(['HEAD']);
                    prepareExtensionCandidate(transaction, fsModule);
                    await publishWithQuota(request, transaction);
                    return {
                        shortCommitHash: fullCommitHash.slice(0, 7),
                        extensionPath: resolved.extensionPath,
                        isUpToDate,
                        remoteUrl,
                    };
                } catch (error) {
                    return await rollbackAfterExtensionFailure(transaction, transactionTools, error);
                }
            });
            return response.send(result);
        } catch (error) {
            return sendResolutionError(response, error, 'Updating extension');
        }
    });

    extensionsRouter.post('/branches', async (request, response) => {
        try {
            const resolved = resolveManagedExtension(request, roots, true, fsModule);
            const git = createGit({ baseDir: resolved.extensionPath, ...OPTIONS });
            if (await git.revparse(['--is-shallow-repository']) === 'true') await git.fetch('origin', ['--unshallow']);
            await git.remote(['set-branches', 'origin', '*']);
            await git.fetch('origin');
            const localBranches = await git.branchLocal();
            const remoteBranches = await git.branch(['-r', '--list', 'origin/*']);
            const result = [...Object.values(localBranches.branches), ...Object.values(remoteBranches.branches)]
                .map(branch => ({ current: branch.current, commit: branch.commit, name: branch.name, label: branch.label }));
            return response.send(result);
        } catch (error) {
            return sendResolutionError(response, error, 'Getting branches');
        }
    });

    extensionsRouter.post('/switch', async (request, response) => {
        try {
            validateBranch(request.body.branch, true);
            const branch = request.body.branch;
            const identity = resolveManagedExtension(request, roots, false, fsModule);
            await withMutationLocks(request, [identity], async contexts => {
                const resolved = resolveManagedExtension(request, roots, true, fsModule);
                let transaction;
                try {
                    transaction = beginExtensionTransaction(contexts.get(resolved.type), resolved.shortName, 'switch', fsModule);
                    copyDirectorySync(resolved.extensionPath, transaction.candidatePath, {
                        recursive: true,
                        force: false,
                        errorOnExist: true,
                    });
                    const git = createGit({ baseDir: transaction.candidatePath, ...OPTIONS });
                    const branches = await git.branchLocal();
                    if (branch.startsWith('origin/')) {
                        const localBranch = branch.slice('origin/'.length);
                        if (!localBranch) {
                            throw new ExtensionResolutionError(400, 'Bad Request: A valid branch is required in the request body.');
                        }
                        if (branches.all.includes(localBranch)) await git.checkout(localBranch);
                        else await git.checkoutBranch(localBranch, branch);
                    } else {
                        if (!branches.all.includes(branch)) {
                            throw new ExtensionResolutionError(404, `Branch ${branch} does not exist locally`);
                        }
                        const currentBranch = await git.branch();
                        if (currentBranch.current !== branch) await git.checkout(branch);
                    }
                    prepareExtensionCandidate(transaction, fsModule);
                    await publishWithQuota(request, transaction);
                } catch (error) {
                    return await rollbackAfterExtensionFailure(transaction, transactionTools, error);
                }
            });
            return response.sendStatus(204);
        } catch (error) {
            return sendResolutionError(response, error, 'Switching branches');
        }
    });

    extensionsRouter.post('/move', async (request, response) => {
        try {
            if (!request.user.profile.admin) {
                throw new ExtensionResolutionError(403, 'Forbidden: No permission to move extensions.');
            }
            const { source, destination } = request.body;
            if (!MANAGED_EXTENSION_TYPES.has(source) || !MANAGED_EXTENSION_TYPES.has(destination)) {
                throw new ExtensionResolutionError(400, 'Bad Request: source and destination must be local or global.');
            }
            if (source === destination) {
                throw new ExtensionResolutionError(409, 'Source and destination directories are the same.');
            }
            const sourceRequest = { user: request.user, body: { extensionName: request.body.extensionName, type: source } };
            const sourceIdentity = resolveManagedExtension(sourceRequest, roots, false, fsModule);
            const destinationRequest = { user: request.user, body: { extensionName: sourceIdentity.shortName, type: destination } };
            const destinationIdentity = resolveManagedExtension(destinationRequest, roots, false, fsModule);
            await withMutationLocks(request, [sourceIdentity, destinationIdentity], async contexts => {
                const sourceResolved = resolveManagedExtension(sourceRequest, roots, true, fsModule);
                const destinationRoot = contexts.get(destination).targetRoot;
                if (findNormalizedRootEntry(destinationRoot, sourceResolved.shortName, fsModule)) {
                    throw new ExtensionResolutionError(409, 'Destination directory already exists.');
                }

                let destinationTransaction;
                try {
                    destinationTransaction = beginExtensionTransaction(
                        contexts.get(destination),
                        sourceResolved.shortName,
                        'move-destination',
                        fsModule,
                    );
                    copyDirectorySync(sourceResolved.extensionPath, destinationTransaction.candidatePath, {
                        recursive: true,
                        force: false,
                        errorOnExist: true,
                    });
                    prepareExtensionCandidate(destinationTransaction, fsModule);
                    await publishWithQuota(request, destinationTransaction, { deferCleanup: true });
                } catch (error) {
                    return await rollbackAfterExtensionFailure(destinationTransaction, transactionTools, error);
                }

                let sourceTransaction;
                try {
                    sourceTransaction = beginExtensionTransaction(
                        contexts.get(source),
                        sourceResolved.shortName,
                        'move-source',
                        fsModule,
                    );
                    prepareExtensionDeletion(sourceTransaction, fsModule);
                    await publishWithQuota(request, sourceTransaction);
                } catch (error) {
                    const rollbackErrors = [];
                    if (sourceTransaction) {
                        try {
                            await rollbackExtensionTransaction(sourceTransaction, transactionTools);
                        } catch (rollbackError) {
                            rollbackErrors.push(rollbackError);
                        }
                    }
                    try {
                        await rollbackPublishedNewExtensionTransaction(destinationTransaction, transactionTools);
                    } catch (rollbackError) {
                        rollbackErrors.push(rollbackError);
                    }
                    if (rollbackErrors.length > 0) {
                        throw new globalThis.AggregateError(
                            [error, ...rollbackErrors],
                            'Moving extension failed and could not be fully rolled back.',
                            { cause: error },
                        );
                    }
                    throw error;
                }
                try {
                    await cleanupExtensionTransaction(destinationTransaction, transactionTools);
                } catch (error) {
                    console.error(`Extension transaction cleanup will be retried from ${destinationTransaction.transactionPath}`, error);
                }
            });
            return response.sendStatus(204);
        } catch (error) {
            return sendResolutionError(response, error, 'Moving extension');
        }
    });

    extensionsRouter.post('/version', async (request, response) => {
        try {
            const resolved = resolveManagedExtension(request, roots, true, fsModule);
            const git = createGit({ baseDir: resolved.extensionPath, ...OPTIONS });
            let currentCommitHash;
            try {
                if (!await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT)) throw new Error('Not a repository');
                currentCommitHash = await git.revparse(['HEAD']);
            } catch {
                return response.send({ currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '' });
            }
            const currentBranch = await git.branch();
            const currentBranchName = currentBranch.current;
            await git.fetch('origin');
            const { isUpToDate, remoteUrl } = await checkIfRepoIsUpToDate(resolved.extensionPath, createGit);
            return response.send({ currentBranchName, currentCommitHash, isUpToDate, remoteUrl });
        } catch (error) {
            return sendResolutionError(response, error, 'Getting extension version');
        }
    });

    extensionsRouter.post('/delete', async (request, response) => {
        try {
            const identity = resolveManagedExtension(request, roots, false, fsModule);
            const extensionPath = await withMutationLocks(request, [identity], async contexts => {
                const resolved = resolveManagedExtension(request, roots, true, fsModule);
                let transaction;
                try {
                    transaction = beginExtensionTransaction(contexts.get(resolved.type), resolved.shortName, 'delete', fsModule);
                    prepareExtensionDeletion(transaction, fsModule);
                    await publishWithQuota(request, transaction);
                    return resolved.extensionPath;
                } catch (error) {
                    return await rollbackAfterExtensionFailure(transaction, transactionTools, error);
                }
            });
            return response.send(`Extension has been deleted at ${extensionPath}`);
        } catch (error) {
            return sendResolutionError(response, error, 'Deleting extension');
        }
    });

    extensionsRouter.get('/discover', async (request, response) => {
        try {
            const localRoot = request.user.directories.extensions;
            fsModule.mkdirSync(localRoot, { recursive: true });
            fsModule.mkdirSync(roots.global, { recursive: true });
            const contexts = new Map([EXTENSION_TYPES.LOCAL, EXTENSION_TYPES.GLOBAL]
                .map(type => [type, createExtensionTransactionContext(request, type, roots, dependencies.stagingRoot, fsModule)]));
            await recoverContexts(request, contexts);
            const listDirectories = root => fsModule.readdirSync(root, { withFileTypes: true })
                .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
                .map(entry => entry.name);
            const builtInExtensions = listDirectories(roots.builtin)
                .filter(name => name !== 'third-party')
                .map(name => ({ type: 'system', name }));
            const localNames = listDirectories(localRoot);
            const localKeys = new Set(localNames.map(normalizeExtensionDirectoryName));
            const userExtensions = localNames.map(name => ({ type: 'local', name: `${THIRD_PARTY_PREFIX}${name}` }));
            const globalExtensions = listDirectories(roots.global)
                .filter(name => !localKeys.has(normalizeExtensionDirectoryName(name)))
                .map(name => ({ type: 'global', name: `${THIRD_PARTY_PREFIX}${name}` }));
            return response.send([...builtInExtensions, ...userExtensions, ...globalExtensions]);
        } catch (error) {
            return sendResolutionError(response, error, 'Discovering extensions');
        }
    });

    return extensionsRouter;
}

export const router = createExtensionsRouter();
