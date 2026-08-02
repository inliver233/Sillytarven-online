import path from 'node:path';
import fs from 'node:fs';
import dns from 'node:dns/promises';

import express from 'express';
import ipaddr from 'ipaddr.js';
import sanitize from 'sanitize-filename';
import { CheckRepoActions, default as simpleGit } from 'simple-git';

import { PUBLIC_DIRECTORIES } from '../constants.js';
import { getConfigValue } from '../util.js';

/**
 * @type {Partial<import('simple-git').SimpleGitOptions>}
 */
const OPTIONS = Object.freeze({ timeout: { block: 5 * 60 * 1000 } });
const THIRD_PARTY_PREFIX = 'third-party/';
const THIRD_PARTY_ROUTE_PREFIX = '/scripts/extensions/third-party';
const MANAGED_EXTENSION_TYPES = new Set(['local', 'global']);
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

/**
 * Selects one extension root before resolving a resource. A local directory shadows the
 * normalized global directory for every file, including files missing locally.
 * @param {object} options Resource resolver options
 * @param {string} options.localRoot Per-user extension root
 * @param {string} options.globalRoot Global extension root
 * @param {unknown} options.resourcePath URL path below third-party
 * @param {typeof fs} [options.fsModule=fs] Filesystem implementation
 * @returns {{absolutePath: string, identity: {canonicalName: string, shortName: string, type: 'local'|'global'}}} Resolved resource
 */
export function resolveExtensionResource({ localRoot, globalRoot, resourcePath, fsModule = fs }) {
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
    const globalEntry = localEntry ? null : findNormalizedRootEntry(globalRoot, requestedDirectory, fsModule);
    const selectedEntry = localEntry ?? globalEntry;
    const type = localEntry ? EXTENSION_TYPES.LOCAL : EXTENSION_TYPES.GLOBAL;
    const selectedRoot = localEntry ? localRoot : globalRoot;
    if (!selectedEntry) {
        throw new ExtensionResolutionError(404, 'Extension resource not found.');
    }

    const extensionPath = path.resolve(selectedRoot, selectedEntry.name);
    const extensionStat = fsModule.lstatSync(extensionPath);
    if (extensionStat.isSymbolicLink()) {
        throw new ExtensionResolutionError(403, 'Forbidden: Symbolic link extensions are not allowed.');
    }
    if (!selectedEntry.isDirectory() || !extensionStat.isDirectory()) {
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
            if (error?.code === 'ENOENT') {
                throw new ExtensionResolutionError(404, 'Extension resource not found.');
            }
            throw error;
        }
        if (stat.isSymbolicLink()) {
            throw new ExtensionResolutionError(403, 'Forbidden: Symbolic link extension resources are not allowed.');
        }
    }

    const finalStat = fsModule.statSync(currentPath);
    if (!finalStat.isFile()) {
        throw new ExtensionResolutionError(404, 'Extension resource not found.');
    }
    const realExtensionPath = fsModule.realpathSync(extensionPath);
    const realResourcePath = fsModule.realpathSync(currentPath);
    const realRelative = path.relative(realExtensionPath, realResourcePath);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        throw new ExtensionResolutionError(403, 'Forbidden: Invalid extension resource path.');
    }

    return {
        absolutePath: currentPath,
        identity: getCanonicalExtensionIdentity(selectedEntry.name, type),
    };
}

/**
 * Creates a side-effect-free handler for per-user third-party extension resources.
 * @param {(request: import('express').Request) => string} localRootFn Per-user root provider
 * @param {(request: import('express').Request) => string} globalRootFn Global root provider
 * @param {object} [options] Route options
 * @param {boolean|((request: import('express').Request) => boolean)} [options.enabled] Enablement override
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

function validateBranch(branch, required = false) {
    if (branch === undefined && !required) return;
    if (typeof branch !== 'string' || !branch || /[\0\r\n]/u.test(branch)) {
        throw new ExtensionResolutionError(400, 'Bad Request: A valid branch is required in the request body.');
    }
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
    const removeDirectorySync = dependencies.removeDirectorySync ?? ((target, options) => fsModule.rmSync(target, options));
    const roots = {
        global: dependencies.globalRoot ?? PUBLIC_DIRECTORIES.globalExtensions,
        builtin: dependencies.builtinRoot ?? PUBLIC_DIRECTORIES.extensions,
    };
    const extensionsRouter = express.Router();
    extensionsRouter.use(createExtensionsEnabledFeatureGuard(dependencies.enabled));

    extensionsRouter.post('/install', async (request, response) => {
        let extensionPath = null;
        let shouldCleanup = false;
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
            const basePath = path.resolve(global ? roots.global : request.user.directories.extensions);
            fsModule.mkdirSync(basePath, { recursive: true });
            extensionPath = path.resolve(basePath, identity.shortName);
            if (path.dirname(extensionPath) !== basePath) {
                throw new ExtensionResolutionError(403, 'Forbidden: Invalid extension path.');
            }
            if (findNormalizedRootEntry(basePath, identity.shortName, fsModule)) {
                return response.status(409).send(`Directory already exists at ${extensionPath}`);
            }

            const resolvedAddress = await validateInstallTarget(parsedUrl, dnsLookup);
            shouldCleanup = true;
            const git = createGit({
                ...OPTIONS,
                config: getPinnedGitConfig(parsedUrl, resolvedAddress),
            });
            const cloneOptions = { '--depth': 1 };
            if (branch) cloneOptions['--branch'] = branch;
            await git.clone(parsedUrl.href, extensionPath, cloneOptions);
            const manifest = await getManifest(extensionPath, fsModule);
            const { version, author, display_name } = manifest;
            const folderName = path.basename(extensionPath);
            shouldCleanup = false;
            console.info(`Extension has been cloned to ${extensionPath} from ${parsedUrl.href} at ${branch || '(default)'} branch`);
            return response.send({ version, author, display_name, extensionPath, folderName });
        } catch (error) {
            if (shouldCleanup && extensionPath) {
                try {
                    await removeDirectory(extensionPath, { recursive: true, force: true });
                } catch (cleanupError) {
                    console.error(`Failed to clean incomplete extension clone at ${extensionPath}`, cleanupError);
                }
            }
            return sendResolutionError(response, error, 'Importing extension');
        }
    });

    extensionsRouter.post('/update', async (request, response) => {
        try {
            const resolved = resolveManagedExtension(request, roots, true, fsModule);
            const { isUpToDate, remoteUrl } = await checkIfRepoIsUpToDate(resolved.extensionPath, createGit);
            const git = createGit({ baseDir: resolved.extensionPath, ...OPTIONS });
            if (!await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT)) {
                throw new Error(`Directory is not a Git repository at ${resolved.extensionPath}`);
            }
            const currentBranch = await git.branch();
            if (!isUpToDate) await git.pull('origin', currentBranch.current);
            await git.fetch('origin');
            const fullCommitHash = await git.revparse(['HEAD']);
            return response.send({ shortCommitHash: fullCommitHash.slice(0, 7), extensionPath: resolved.extensionPath, isUpToDate, remoteUrl });
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
            const resolved = resolveManagedExtension(request, roots, true, fsModule);
            const branch = request.body.branch;
            const git = createGit({ baseDir: resolved.extensionPath, ...OPTIONS });
            const branches = await git.branchLocal();
            if (branch.startsWith('origin/')) {
                const localBranch = branch.slice('origin/'.length);
                if (!localBranch) throw new ExtensionResolutionError(400, 'Bad Request: A valid branch is required in the request body.');
                if (branches.all.includes(localBranch)) await git.checkout(localBranch);
                else await git.checkoutBranch(localBranch, branch);
                return response.sendStatus(204);
            }
            if (!branches.all.includes(branch)) return response.status(404).send(`Branch ${branch} does not exist locally`);
            const currentBranch = await git.branch();
            if (currentBranch.current !== branch) await git.checkout(branch);
            return response.sendStatus(204);
        } catch (error) {
            return sendResolutionError(response, error, 'Switching branches');
        }
    });

    extensionsRouter.post('/move', async (request, response) => {
        let destinationPath = null;
        let destinationCreated = false;
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
            const sourceResolved = resolveManagedExtension(sourceRequest, roots, true, fsModule);
            const destinationRoot = destination === EXTENSION_TYPES.GLOBAL ? roots.global : request.user.directories.extensions;
            fsModule.mkdirSync(destinationRoot, { recursive: true });
            if (findNormalizedRootEntry(destinationRoot, sourceResolved.shortName, fsModule)) {
                return response.status(409).send('Destination directory already exists.');
            }
            const destinationRequest = { user: request.user, body: { extensionName: sourceResolved.shortName, type: destination } };
            const destinationResolved = resolveManagedExtension(destinationRequest, roots, false, fsModule);
            destinationPath = destinationResolved.extensionPath;

            destinationCreated = true;
            copyDirectorySync(sourceResolved.extensionPath, destinationPath, { recursive: true, force: false, errorOnExist: true });
            removeDirectorySync(sourceResolved.extensionPath, { recursive: true, force: false });
            destinationCreated = false;
            return response.sendStatus(204);
        } catch (error) {
            if (destinationCreated && destinationPath) {
                try {
                    removeDirectorySync(destinationPath, { recursive: true, force: true });
                } catch (cleanupError) {
                    console.error(`Failed to roll back extension move to ${destinationPath}`, cleanupError);
                }
            }
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
            const resolved = resolveManagedExtension(request, roots, true, fsModule);
            await removeDirectory(resolved.extensionPath, { recursive: true, force: false });
            return response.send(`Extension has been deleted at ${resolved.extensionPath}`);
        } catch (error) {
            return sendResolutionError(response, error, 'Deleting extension');
        }
    });

    extensionsRouter.get('/discover', (request, response) => {
        try {
            const localRoot = request.user.directories.extensions;
            fsModule.mkdirSync(localRoot, { recursive: true });
            fsModule.mkdirSync(roots.global, { recursive: true });
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
