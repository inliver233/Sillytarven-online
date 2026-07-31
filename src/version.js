import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { sync as commandExistsSync } from 'command-exists';
import { default as simpleGit } from 'simple-git';

import { serverDirectory } from './server-directory.js';

function safeReadText(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8').trim();
    } catch {
        return '';
    }
}

function safeStatSignature(filePath) {
    try {
        const stats = fs.statSync(filePath);
        return `${stats.size}:${stats.mtimeMs}`;
    } catch {
        return 'missing';
    }
}

function resolveGitDirectory(rootDirectory) {
    const dotGitPath = path.join(rootDirectory, '.git');
    try {
        const stats = fs.statSync(dotGitPath);
        if (stats.isDirectory()) {
            return dotGitPath;
        }
        if (stats.isFile()) {
            const pointer = safeReadText(dotGitPath);
            if (pointer.startsWith('gitdir:')) {
                return path.resolve(rootDirectory, pointer.slice('gitdir:'.length).trim());
            }
        }
    } catch {
        // A source archive or production image may not contain a Git directory.
    }
    return null;
}

function getPackedRef(packedRefs, refName) {
    if (!packedRefs || !refName) {
        return '';
    }
    for (const line of packedRefs.split(/\r?\n/)) {
        if (!line || line.startsWith('#') || line.startsWith('^')) {
            continue;
        }
        const separator = line.indexOf(' ');
        if (separator !== -1 && line.slice(separator + 1).trim() === refName) {
            return line.slice(0, separator).trim();
        }
    }
    return '';
}

/**
 * Complete-version memo with shallow file signatures and concurrent miss coalescing.
 */
export class VersionMemo {
    /**
     * @param {object} [options] Memo options
     * @param {string} [options.rootDirectory] Application root
     * @param {boolean} [options.enabled] Whether completed values are cached
     * @param {number} [options.ttlMs] Maximum cache lifetime
     * @param {() => number} [options.now] Clock for cache expiry
     * @param {() => boolean} [options.hasGit] Git availability probe
     * @param {(rootDirectory: string) => object} [options.createGit] simple-git factory
     */
    constructor({
        rootDirectory = serverDirectory,
        enabled = true,
        ttlMs = 30_000,
        now = Date.now,
        hasGit = () => commandExistsSync('git'),
        createGit = root => simpleGit({ baseDir: root }),
    } = {}) {
        this.rootDirectory = rootDirectory;
        this.enabled = Boolean(enabled);
        this.ttlMs = Math.min(5 * 60_000, Math.max(0, Number(ttlMs) || 0));
        this.now = now;
        this.hasGit = hasGit;
        this.createGit = createGit;
        this.cached = null;
        this.inflight = null;
    }

    /**
     * Get a complete version object, preserving the historical response shape.
     * @param {object} [observers] Optional diagnostics callbacks
     * @param {(state: 'hit'|'miss') => void} [observers.onCacheState] Cache observer
     * @param {(durationMs: number) => void} [observers.onGitDuration] Git duration observer
     * @returns {Promise<{agent: string, pkgVersion: string, gitRevision: string|null, gitBranch: string|null, commitDate: string|null, isLatest: boolean}>}
     */
    async get({ onCacheState, onGitDuration } = {}) {
        const signature = this.#getSignature();
        const now = this.now();
        if (this.enabled && this.cached && this.cached.signature === signature && now < this.cached.expiresAt) {
            this.#notify(onCacheState, 'hit');
            return { ...this.cached.value };
        }

        if (this.inflight && this.inflight.signature === signature) {
            this.#notify(onCacheState, 'hit');
            const value = await this.inflight.promise;
            return { ...value };
        }

        this.#notify(onCacheState, 'miss');
        const promise = this.#load(onGitDuration).then(value => {
            const frozenValue = Object.freeze({ ...value });
            const completedSignature = this.#getSignature();
            if (this.enabled && completedSignature === signature) {
                this.cached = {
                    signature: completedSignature,
                    expiresAt: this.now() + this.ttlMs,
                    value: frozenValue,
                };
            }
            return frozenValue;
        });
        this.inflight = { signature, promise };

        try {
            const value = await promise;
            return { ...value };
        } finally {
            if (this.inflight?.promise === promise) {
                this.inflight = null;
            }
        }
    }

    /** Clear the completed value. An already-running load remains shared. */
    clear() {
        this.cached = null;
    }

    #getSignature() {
        const packagePath = path.join(this.rootDirectory, 'package.json');
        const gitDirectory = resolveGitDirectory(this.rootDirectory);
        if (!gitDirectory) {
            return `package:${safeStatSignature(packagePath)}|git:missing`;
        }

        const headPath = path.join(gitDirectory, 'HEAD');
        const head = safeReadText(headPath);
        const refName = head.startsWith('ref:') ? head.slice('ref:'.length).trim() : '';
        const looseRefPath = refName ? path.join(gitDirectory, ...refName.split('/')) : '';
        const looseRef = looseRefPath ? safeReadText(looseRefPath) : '';
        const packedRefsPath = path.join(gitDirectory, 'packed-refs');
        const packedRefs = looseRef ? '' : safeReadText(packedRefsPath);
        const revision = looseRef || getPackedRef(packedRefs, refName) || (!refName ? head : '');

        return [
            `package:${safeStatSignature(packagePath)}`,
            `head:${safeStatSignature(headPath)}:${head}`,
            `ref:${looseRefPath ? safeStatSignature(looseRefPath) : 'detached'}:${revision}`,
            `packed:${safeStatSignature(packedRefsPath)}`,
        ].join('|');
    }

    async #load(onGitDuration) {
        let pkgVersion = 'UNKNOWN';
        let gitRevision = null;
        let gitBranch = null;
        let commitDate = null;
        let isLatest = true;

        try {
            const packageText = await fs.promises.readFile(path.join(this.rootDirectory, 'package.json'), 'utf8');
            const packageData = JSON.parse(packageText);
            pkgVersion = String(packageData.version || 'UNKNOWN');
        } catch {
            // Preserve the historical UNKNOWN fallback for source archives with a bad/missing package file.
        }

        let gitAvailable = false;
        try {
            gitAvailable = this.hasGit();
        } catch {
            gitAvailable = false;
        }

        if (gitAvailable) {
            const startedAt = performance.now();
            try {
                const git = this.createGit(this.rootDirectory);
                gitRevision = await git.revparse(['--short', 'HEAD']);
                gitBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
                commitDate = await git.show(['-s', '--format=%ci', gitRevision]);
                const trackingBranch = await git.revparse(['--abbrev-ref', '@{u}']);
                const localLatest = await git.revparse(['HEAD']);
                const remoteLatest = await git.revparse([trackingBranch]);
                isLatest = localLatest === remoteLatest;
            } catch {
                // Git metadata is optional. Keep any fields resolved before the failure.
            } finally {
                this.#notify(onGitDuration, performance.now() - startedAt);
            }
        }

        const agent = `SillyTavern:${pkgVersion}:Cohee#1207`;
        return {
            agent,
            pkgVersion,
            gitRevision: gitRevision?.trim() || null,
            gitBranch: gitBranch?.trim() || null,
            commitDate: commitDate?.trim() || null,
            isLatest,
        };
    }

    #notify(callback, value) {
        try {
            callback?.(value);
        } catch {
            // Diagnostics must never affect version correctness.
        }
    }
}
