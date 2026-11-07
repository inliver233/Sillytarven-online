import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Popular third-party extensions through the static asset CDN (see asset-version.js).
 *
 * An extension is loaded from the CDN only when its folder is a git checkout of one of the
 * configured official repositories and has no changes to tracked files: then its files are
 * exactly those of the checked-out commit, the same for every user on that commit. The CDN
 * pulls /v/e/<commit>/scripts/extensions/third-party/<folder>/<file>, which is answered from
 * the git object store (`git cat-file`), never from the working tree, so it can only ever
 * serve committed files of an allowed repository.
 */

const GIT_TIMEOUT_MS = 10_000;
const CHECK_TTL_MS = 10 * 60 * 1000;
const MAX_CONCURRENT_GIT = 2;
const BLOB_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_BLOB_BYTES = 32 * 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
export const EXTENSION_CDN_PREFIX = '/v/e/';
/** Module scripts are refused without a JavaScript type, which not every MIME table knows for .mjs. */
const CONTENT_TYPES = Object.freeze({
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.cjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
});

/**
 * @typedef {{folder: string, repos: string[]}} AllowedExtension
 * @typedef {{name: string, sha: string}} CdnExtension
 */

/**
 * Normalizes a git remote to host/owner/repo in lower case, through mirror proxies
 * such as https://gh-proxy.org/https://github.com/owner/repo.git.
 * @param {string} url Remote URL
 * @returns {string|null} Repository identity
 */
export function normalizeRepository(url) {
    if (typeof url !== 'string') return null;
    const match = /(?:^|[/@])((?:github\.com|gitlab\.com|codeberg\.org|gitee\.com)[/:][^/\s]+\/[^/\s]+?)(?:\.git)?\/*$/i.exec(url.trim());
    return match ? match[1].replace(':', '/').toLowerCase() : null;
}

/**
 * @param {unknown} value Configured list: [{ name, repos: [...] }]
 * @returns {AllowedExtension[]} Valid entries
 */
export function parseAllowedExtensions(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map(entry => ({
            folder: typeof entry?.name === 'string' ? entry.name : '',
            repos: (Array.isArray(entry?.repos) ? entry.repos : []).map(normalizeRepository).filter(Boolean),
        }))
        .filter(entry => /^[\w.-]+$/.test(entry.folder) && !entry.folder.startsWith('.') && entry.repos.length);
}

/**
 * @param {string} file File to read
 * @returns {string} Trimmed contents, or '' when missing
 */
function readText(file) {
    try {
        return fs.readFileSync(file, 'utf8').trim();
    } catch {
        return '';
    }
}

/**
 * The checked-out commit and origin remote of a git folder, read from .git directly.
 * @param {string} directory Extension folder
 * @returns {{sha: string, remote: string|null}|null} Commit and remote, or null when not a git checkout
 */
export function readGitHead(directory) {
    const gitDirectory = path.join(directory, '.git');
    const head = readText(path.join(gitDirectory, 'HEAD'));
    if (!head) return null;
    let sha = head;
    if (head.startsWith('ref:')) {
        const ref = head.slice(4).trim();
        sha = readText(path.join(gitDirectory, ...ref.split('/')));
        if (!sha) {
            const packed = readText(path.join(gitDirectory, 'packed-refs'));
            sha = packed.split('\n').map(line => line.trim().split(' ')).find(([, name]) => name === ref)?.[0] ?? '';
        }
    }
    if (!SHA_PATTERN.test(sha)) return null;
    const config = readText(path.join(gitDirectory, 'config'));
    const origin = /\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/.exec(config)?.[1] ?? '';
    const remote = /^\s*url\s*=\s*(.+)$/m.exec(origin)?.[1]?.trim() ?? null;
    return { sha, remote };
}

/**
 * Runs git with a timeout, without optional locks (no index refresh writes).
 * @param {string} directory Repository
 * @param {string[]} args Arguments
 * @param {object} [options] execFile options
 * @returns {Promise<string|Buffer>} Standard output
 */
function git(directory, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile('git', ['--no-optional-locks', '-C', directory, ...args], {
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: MAX_BLOB_BYTES,
            windowsHide: true,
            ...options,
        }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
}

export class ExtensionCdn {
    /**
     * @param {AllowedExtension[]} allowed Extensions that may use the CDN
     * @param {{git?: typeof git, now?: () => number}} [dependencies] Test hooks
     */
    constructor(allowed, { git: runGit = git, now = Date.now } = {}) {
        this.allowed = new Map(allowed.map(entry => [entry.folder, new Set(entry.repos)]));
        this.git = runGit;
        this.now = now;
        /** @type {Map<string, {key: string, clean: boolean, checkedAt: number}>} folder path -> last check */
        this.checks = new Map();
        /** @type {Map<string, Promise<void>>} */
        this.pending = new Map();
        /** @type {Map<string, string>} "folder@sha" -> a checkout that has the commit */
        this.sources = new Map();
        /** @type {Map<string, Buffer|null>} "sha:file" -> blob (null: not found) */
        this.blobs = new Map();
        this.blobBytes = 0;
        this.running = 0;
        /** @type {(() => void)[]} */
        this.queue = [];
    }

    get enabled() {
        return this.allowed.size > 0;
    }

    /**
     * @param {string} folder Extension folder name
     * @param {{sha: string, remote: string|null}|null} head Git head
     * @returns {boolean} Whether the checkout comes from an allowed repository
     */
    isAllowedCheckout(folder, head) {
        const repos = this.allowed.get(folder);
        return Boolean(repos && head && repos.has(normalizeRepository(head.remote ?? '') ?? ''));
    }

    async #limit(task) {
        if (this.running >= MAX_CONCURRENT_GIT) {
            await new Promise(resolve => this.queue.push(resolve));
        }
        this.running++;
        try {
            return await task();
        } finally {
            this.running--;
            this.queue.shift()?.();
        }
    }

    /**
     * The user's extensions that are loaded from the CDN. Answers from what is already
     * known and checks the rest in the background, so a page is never held up by git:
     * a newly installed or updated extension uses the CDN from the next page load.
     * @param {string} extensionsDirectory The user's extensions folder
     * @returns {CdnExtension[]} Extensions and their commits
     */
    getUserExtensions(extensionsDirectory) {
        if (!this.enabled) return [];
        const result = [];
        for (const folder of this.allowed.keys()) {
            const directory = path.join(extensionsDirectory, folder);
            const head = readGitHead(directory);
            if (!this.isAllowedCheckout(folder, head)) continue;
            let indexStamp = '';
            try {
                const stat = fs.statSync(path.join(directory, '.git', 'index'));
                indexStamp = `${stat.size}:${stat.mtimeMs}`;
            } catch {
                continue;
            }
            const key = `${head.sha}:${indexStamp}`;
            const check = this.checks.get(directory);
            if (check?.key === key && this.now() - check.checkedAt < CHECK_TTL_MS) {
                if (check.clean) {
                    this.sources.set(`${folder}@${head.sha}`, directory);
                    result.push({ name: folder, sha: head.sha });
                }
                continue;
            }
            this.#checkInBackground(directory, key);
        }
        return result;
    }

    /**
     * @param {string} directory Extension folder
     * @param {string} key Head and index stamp the check is for
     */
    #checkInBackground(directory, key) {
        if (this.pending.has(directory)) return;
        const run = this.#limit(async () => {
            let clean = false;
            try {
                const status = await this.git(directory, ['status', '--porcelain', '--untracked-files=no']);
                clean = String(status).trim() === '';
            } catch {
                clean = false;
            }
            this.checks.set(directory, { key, clean, checkedAt: this.now() });
        }).finally(() => this.pending.delete(directory));
        this.pending.set(directory, run);
    }

    /** Waits for background checks (tests). */
    async settle() {
        while (this.pending.size) {
            await Promise.allSettled([...this.pending.values()]);
        }
    }

    /**
     * Finds a checkout of an allowed extension at the given commit.
     * @param {string} folder Extension folder name
     * @param {string} sha Commit
     * @param {() => string[]} listExtensionDirectories All users' extensions folders, for a cold start
     * @returns {string|null} Checkout folder
     */
    #findSource(folder, sha, listExtensionDirectories) {
        const known = this.sources.get(`${folder}@${sha}`);
        if (known && readGitHead(known)?.sha === sha) return known;
        for (const extensionsDirectory of listExtensionDirectories()) {
            const directory = path.join(extensionsDirectory, folder);
            const head = readGitHead(directory);
            if (head?.sha === sha && this.isAllowedCheckout(folder, head)) {
                this.sources.set(`${folder}@${sha}`, directory);
                return directory;
            }
        }
        return null;
    }

    /**
     * A committed file of an allowed extension.
     * @param {string} folder Extension folder name
     * @param {string} sha Commit
     * @param {string} file Path inside the extension
     * @param {() => string[]} listExtensionDirectories All users' extensions folders
     * @returns {Promise<Buffer|null>} File contents, or null when there is no such file
     */
    async readFile(folder, sha, file, listExtensionDirectories) {
        if (!this.allowed.has(folder) || !SHA_PATTERN.test(sha)) return null;
        const parts = file.split('/');
        if (!file || parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) return null;
        const cacheKey = `${sha}:${folder}/${file}`;
        if (this.blobs.has(cacheKey)) {
            const blob = this.blobs.get(cacheKey);
            this.blobs.delete(cacheKey);
            this.blobs.set(cacheKey, blob);
            return blob;
        }
        const directory = this.#findSource(folder, sha, listExtensionDirectories);
        if (!directory) return null;
        let blob = null;
        try {
            const type = String(await this.#limit(() => this.git(directory, ['cat-file', '-t', `${sha}:${file}`]))).trim();
            if (type === 'blob') {
                blob = /** @type {Buffer} */ (await this.#limit(() => this.git(directory, ['cat-file', 'blob', `${sha}:${file}`], { encoding: 'buffer' })));
            }
        } catch {
            blob = null;
        }
        this.#remember(cacheKey, blob);
        return blob;
    }

    /**
     * @param {string} key Cache key
     * @param {Buffer|null} blob Contents
     */
    #remember(key, blob) {
        const size = blob?.length ?? 0;
        if (size > BLOB_CACHE_BYTES / 4) return;
        this.blobs.set(key, blob);
        this.blobBytes += size;
        for (const [oldKey, oldBlob] of this.blobs) {
            if (this.blobBytes <= BLOB_CACHE_BYTES) break;
            this.blobs.delete(oldKey);
            this.blobBytes -= oldBlob?.length ?? 0;
        }
    }
}

/**
 * Serves /v/e/<sha>/scripts/extensions/third-party/<folder>/<file> to the CDN.
 * @param {ExtensionCdn} extensionCdn Extension CDN
 * @param {() => string[]} listExtensionDirectories All users' extensions folders
 * @returns {import('express').RequestHandler}
 */
export function createExtensionCdnMiddleware(extensionCdn, listExtensionDirectories) {
    return async (request, response, next) => {
        if (!request.path.startsWith(EXTENSION_CDN_PREFIX)) return next();
        if (request.method !== 'GET' && request.method !== 'HEAD') return response.sendStatus(405);
        const match = /^\/v\/e\/([0-9a-f]{40})\/scripts\/extensions\/third-party\/([^/]+)\/(.+)$/.exec(request.path);
        if (!match || !extensionCdn.enabled) return response.sendStatus(404);
        let file;
        try {
            file = decodeURIComponent(match[3]);
        } catch {
            return response.sendStatus(400);
        }
        const blob = await extensionCdn.readFile(match[2], match[1], file, listExtensionDirectories);
        if (!blob) return response.sendStatus(404);
        const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()];
        if (contentType) {
            response.setHeader('Content-Type', contentType);
        } else {
            response.type(path.extname(file) || 'application/octet-stream');
        }
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        response.setHeader('ETag', `"${crypto.createHash('sha1').update(`${match[1]}:${match[2]}/${file}`).digest('hex')}"`);
        return response.send(blob);
    };
}
