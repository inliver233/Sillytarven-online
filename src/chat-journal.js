import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { canonicalJsonStringify, hashCanonicalJson, sha256 } from './canonical-hash.js';

const CHAT_METADATA_SUFFIX = '.metadata.json';
const CHAT_INDEX_SUFFIX = '.index.json';
const CHAT_REVISION_SUFFIX = '.revision.json';
const CHAT_CHUNK_DIR_SUFFIX = '.chunks';
const JOURNAL_PARENT_DIRECTORY = '.migration-journals';
const MANIFEST_FILE = 'manifest.json';
const VALID_STATES = new Set(['prepared', 'mutating', 'committed']);
const activeTransactions = new Set();
const recoveredNamespaces = new Set();
const recoveringNamespaces = new Set();

function normalizeForHash(value) {
    const normalized = path.normalize(path.resolve(value));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertHandle(handle) {
    if (typeof handle !== 'string' || handle.length === 0) {
        throw new TypeError('A non-empty user handle is required for durable chat transactions.');
    }
}

function assertDirectoryWithoutSymlink(directoryPath, label) {
    const stats = fs.lstatSync(directoryPath);
    if (stats.isSymbolicLink()) {
        throw new Error(`${label} must not be a symbolic link: ${directoryPath}`);
    }
    if (!stats.isDirectory()) {
        throw new Error(`${label} must be a directory: ${directoryPath}`);
    }
}

function getUserContext(userRoot, handle) {
    assertHandle(handle);
    const root = path.resolve(userRoot);
    assertDirectoryWithoutSymlink(root, 'User root');
    const realRoot = fs.realpathSync.native(root);
    if (normalizeForHash(realRoot) !== normalizeForHash(root)) {
        throw new Error(`User root must not resolve through a link: ${userRoot}`);
    }
    const handleHash = sha256(handle);
    return {
        root,
        handleHash,
        rootHash: sha256(normalizeForHash(root)),
        namespace: path.join(path.dirname(root), JOURNAL_PARENT_DIRECTORY, handleHash),
    };
}

function isOutsideRoot(relativePath) {
    return !relativePath
        || relativePath === '..'
        || relativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativePath);
}

function assertPathComponentsWithoutSymlinks(root, absolutePath, requireLeaf = false) {
    const relativePath = path.relative(root, absolutePath);
    if (isOutsideRoot(relativePath)) {
        throw new Error(`Path is outside the exact user root: ${absolutePath}`);
    }
    let current = root;
    const parts = relativePath.split(path.sep);
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        if (!fs.existsSync(current)) {
            if (requireLeaf) {
                throw new Error(`Required path does not exist: ${current}`);
            }
            break;
        }
        const stats = fs.lstatSync(current);
        if (stats.isSymbolicLink()) {
            throw new Error(`Chat transaction paths must not contain symbolic links: ${current}`);
        }
    }
}

function toUserRelativePath(context, candidate, requireFile = false) {
    const absolutePath = path.resolve(candidate);
    assertPathComponentsWithoutSymlinks(context.root, absolutePath, requireFile);
    if (requireFile && !fs.lstatSync(absolutePath).isFile()) {
        throw new Error(`Chat artifact must be a regular file: ${candidate}`);
    }
    return path.relative(context.root, absolutePath).split(path.sep).join('/');
}

function fromUserRelativePath(context, relativePath, label) {
    if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\')) {
        throw new Error(`Invalid ${label} path in chat journal.`);
    }
    const parts = relativePath.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) {
        throw new Error(`Invalid ${label} path in chat journal: ${relativePath}`);
    }
    const absolutePath = path.resolve(context.root, ...parts);
    const relative = path.relative(context.root, absolutePath);
    if (isOutsideRoot(relative)) {
        throw new Error(`${label} path escapes the exact user root: ${relativePath}`);
    }
    return absolutePath;
}

function assertArtifactBelongsToTarget(targetPath, artifactPath) {
    const baseName = path.basename(targetPath);
    const relativePath = path.relative(path.dirname(targetPath), artifactPath).split(path.sep).join('/');
    const directNames = new Set([
        baseName,
        `${baseName}${CHAT_METADATA_SUFFIX}`,
        `${baseName}${CHAT_INDEX_SUFFIX}`,
        `${baseName}${CHAT_REVISION_SUFFIX}`,
    ]);
    const chunkPrefix = `${baseName}${CHAT_CHUNK_DIR_SUFFIX}/`;
    const validChunk = relativePath.startsWith(chunkPrefix)
        && relativePath.length > chunkPrefix.length
        && !relativePath.slice(chunkPrefix.length).includes('/');
    if (!directNames.has(relativePath) && !validChunk) {
        throw new Error(`Artifact does not belong to the target chat: ${artifactPath}`);
    }
}

function assertJournalDirectory(directoryPath, label) {
    if (!fs.existsSync(directoryPath)) {
        fs.mkdirSync(directoryPath, { recursive: true });
    }
    assertDirectoryWithoutSymlink(directoryPath, label);
}

function prepareNamespace(context) {
    const parent = path.dirname(context.namespace);
    assertJournalDirectory(parent, 'Migration journal parent');
    assertJournalDirectory(context.namespace, 'User migration journal namespace');
}

function syncFile(filePath) {
    const descriptor = fs.openSync(filePath, 'r+');
    try {
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

function writeAndSync(filePath, contents) {
    writeFileAtomicSync(filePath, contents, 'utf8');
    syncFile(filePath);
}

function signManifest(unsigned) {
    return { ...unsigned, digest: hashCanonicalJson(unsigned) };
}

function writeManifest(transactionDirectory, manifest) {
    writeAndSync(path.join(transactionDirectory, MANIFEST_FILE), canonicalJsonStringify(signManifest(manifest)));
}

function readVerifiedManifest(transactionDirectory, context) {
    const manifestPath = path.join(transactionDirectory, MANIFEST_FILE);
    const manifestStats = fs.lstatSync(manifestPath);
    if (manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
        throw new Error(`Chat journal manifest must be a regular file: ${manifestPath}`);
    }
    const signedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const { digest, ...manifest } = signedManifest;
    if (manifest.version !== 2
        || manifest.type !== 'chat-write'
        || !VALID_STATES.has(manifest.state)
        || !Array.isArray(manifest.artifacts)
        || manifest.handleHash !== context.handleHash
        || manifest.userRootHash !== context.rootHash) {
        throw new Error(`Invalid or cross-user chat journal manifest: ${manifestPath}`);
    }
    if (hashCanonicalJson(manifest) !== digest) {
        throw new Error(`Chat journal manifest checksum mismatch: ${manifestPath}`);
    }
    const targetPath = fromUserRelativePath(context, manifest.target, 'target');
    for (const artifact of manifest.artifacts) {
        const artifactPath = fromUserRelativePath(context, artifact.path, 'artifact');
        assertArtifactBelongsToTarget(targetPath, artifactPath);
        if (typeof artifact.snapshot !== 'string' || !/^snapshot\/\d{6}$/.test(artifact.snapshot)) {
            throw new Error(`Invalid snapshot path in chat journal: ${artifact.snapshot}`);
        }
    }
    return { manifest, targetPath };
}

function listCurrentChatArtifacts(filePath) {
    const artifacts = [
        filePath,
        `${filePath}${CHAT_METADATA_SUFFIX}`,
        `${filePath}${CHAT_INDEX_SUFFIX}`,
        `${filePath}${CHAT_REVISION_SUFFIX}`,
    ].filter(candidate => fs.existsSync(candidate));
    const chunkDirectory = `${filePath}${CHAT_CHUNK_DIR_SUFFIX}`;
    if (fs.existsSync(chunkDirectory)) {
        assertDirectoryWithoutSymlink(chunkDirectory, 'Chat chunk directory');
        artifacts.push(...fs.readdirSync(chunkDirectory).sort().map(name => path.join(chunkDirectory, name)));
    }
    return artifacts;
}

function removeCurrentChatArtifacts(context, filePath) {
    for (const artifactPath of [
        filePath,
        `${filePath}${CHAT_METADATA_SUFFIX}`,
        `${filePath}${CHAT_INDEX_SUFFIX}`,
        `${filePath}${CHAT_REVISION_SUFFIX}`,
    ]) {
        if (fs.existsSync(artifactPath)) {
            assertPathComponentsWithoutSymlinks(context.root, artifactPath, true);
            fs.rmSync(artifactPath, { force: true });
        }
    }
    const chunkDirectory = `${filePath}${CHAT_CHUNK_DIR_SUFFIX}`;
    if (fs.existsSync(chunkDirectory)) {
        assertPathComponentsWithoutSymlinks(context.root, chunkDirectory, true);
        assertDirectoryWithoutSymlink(chunkDirectory, 'Chat chunk directory');
        for (const name of fs.readdirSync(chunkDirectory)) {
            const shardPath = path.join(chunkDirectory, name);
            assertPathComponentsWithoutSymlinks(context.root, shardPath, true);
            if (!fs.lstatSync(shardPath).isFile()) {
                throw new Error(`Chat chunk artifact must be a regular file: ${shardPath}`);
            }
        }
        fs.rmSync(chunkDirectory, { recursive: true, force: true });
    }
}

function restoreTransaction(transactionDirectory, context, verified = null) {
    const { manifest, targetPath } = verified ?? readVerifiedManifest(transactionDirectory, context);
    assertDirectoryWithoutSymlink(path.join(transactionDirectory, 'snapshot'), 'Chat journal snapshot directory');
    for (const artifact of manifest.artifacts) {
        const snapshotPath = path.join(transactionDirectory, ...artifact.snapshot.split('/'));
        const snapshotStats = fs.lstatSync(snapshotPath);
        if (snapshotStats.isSymbolicLink() || !snapshotStats.isFile()) {
            throw new Error(`Chat journal snapshot must be a regular file: ${snapshotPath}`);
        }
        const contents = fs.readFileSync(snapshotPath);
        if (contents.length !== artifact.size || sha256(contents) !== artifact.sha256) {
            throw new Error(`Chat journal snapshot checksum mismatch: ${snapshotPath}`);
        }
    }

    removeCurrentChatArtifacts(context, targetPath);
    for (const artifact of manifest.artifacts) {
        const snapshotPath = path.join(transactionDirectory, ...artifact.snapshot.split('/'));
        const destination = fromUserRelativePath(context, artifact.path, 'artifact');
        assertArtifactBelongsToTarget(targetPath, destination);
        assertPathComponentsWithoutSymlinks(context.root, destination, false);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const temporaryPath = `${destination}.recovery-${manifest.id}.tmp`;
        fs.copyFileSync(snapshotPath, temporaryPath);
        syncFile(temporaryPath);
        fs.renameSync(temporaryPath, destination);
    }
    if (manifest.chunkDirectoryExisted) {
        const chunkDirectory = `${targetPath}${CHAT_CHUNK_DIR_SUFFIX}`;
        assertPathComponentsWithoutSymlinks(context.root, chunkDirectory, false);
        fs.mkdirSync(chunkDirectory, { recursive: true });
    }
}

function transitionState(transactionDirectory, context, expectedState, nextState) {
    const { manifest } = readVerifiedManifest(transactionDirectory, context);
    if (manifest.state !== expectedState) {
        throw new Error(`Invalid chat transaction state transition: ${manifest.state} -> ${nextState}`);
    }
    const nextManifest = { ...manifest, state: nextState };
    writeManifest(transactionDirectory, nextManifest);
    return nextManifest;
}

/**
 * Gets the isolated journal namespace for a user.
 * @param {string} userRoot Exact user root
 * @param {string} handle User handle
 * @returns {string} Per-handle sibling journal namespace
 */
export function getChatJournalNamespace(userRoot, handle) {
    return getUserContext(userRoot, handle).namespace;
}

/**
 * Creates a durable rollback point before a chat artifact transaction starts.
 * @param {{filePath: string, artifactPaths?: string[], userRoot: string, handle: string, hooks?: {afterCommitMarker?: () => void}}} options Transaction options
 * @returns {{markMutating: () => void, commit: () => void, rollback: () => void, directory: string}}
 */
export function createDurableChatTransaction({
    filePath,
    artifactPaths = listCurrentChatArtifacts(filePath),
    userRoot,
    handle,
    hooks = {},
}) {
    const context = getUserContext(userRoot, handle);
    const targetPath = path.resolve(filePath);
    const target = toUserRelativePath(context, targetPath, fs.existsSync(targetPath));
    prepareNamespace(context);
    const id = crypto.randomUUID();
    const transactionDirectory = fs.mkdtempSync(path.join(context.namespace, 'tx-'));
    const snapshotDirectory = path.join(transactionDirectory, 'snapshot');
    fs.mkdirSync(snapshotDirectory);

    try {
        const artifacts = artifactPaths.map((artifactPath, index) => {
            const absolutePath = path.resolve(artifactPath);
            const relativePath = toUserRelativePath(context, absolutePath, true);
            assertArtifactBelongsToTarget(targetPath, absolutePath);
            const snapshotName = String(index).padStart(6, '0');
            const snapshotPath = path.join(snapshotDirectory, snapshotName);
            fs.copyFileSync(absolutePath, snapshotPath, fs.constants.COPYFILE_EXCL);
            syncFile(snapshotPath);
            const contents = fs.readFileSync(snapshotPath);
            return {
                path: relativePath,
                snapshot: `snapshot/${snapshotName}`,
                size: contents.length,
                sha256: sha256(contents),
            };
        }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
        const chunkDirectory = `${targetPath}${CHAT_CHUNK_DIR_SUFFIX}`;
        const chunkDirectoryExisted = fs.existsSync(chunkDirectory);
        if (chunkDirectoryExisted) {
            assertPathComponentsWithoutSymlinks(context.root, chunkDirectory, true);
            assertDirectoryWithoutSymlink(chunkDirectory, 'Chat chunk directory');
        }
        writeManifest(transactionDirectory, {
            version: 2,
            type: 'chat-write',
            id,
            createdAt: new Date().toISOString(),
            state: 'prepared',
            handleHash: context.handleHash,
            userRootHash: context.rootHash,
            target,
            chunkDirectoryExisted,
            artifacts,
        });
    } catch (error) {
        fs.rmSync(transactionDirectory, { recursive: true, force: true });
        throw error;
    }

    activeTransactions.add(transactionDirectory);
    let state = 'prepared';
    const cleanup = () => {
        activeTransactions.delete(transactionDirectory);
        fs.rmSync(transactionDirectory, { recursive: true, force: true });
    };
    return {
        directory: transactionDirectory,
        markMutating() {
            if (state !== 'prepared') return;
            transitionState(transactionDirectory, context, 'prepared', 'mutating');
            state = 'mutating';
        },
        commit() {
            if (state === 'committed') return;
            if (state !== 'mutating') {
                throw new Error('Chat transaction must be marked mutating before commit.');
            }
            transitionState(transactionDirectory, context, 'mutating', 'committed');
            state = 'committed';
            activeTransactions.delete(transactionDirectory);
            hooks.afterCommitMarker?.();
            fs.rmSync(transactionDirectory, { recursive: true, force: true });
        },
        rollback() {
            if (state === 'committed') {
                cleanup();
                return;
            }
            restoreTransaction(transactionDirectory, context);
            cleanup();
            state = 'committed';
        },
    };
}

/**
 * Recovers incomplete chat writes for exactly one user namespace.
 * @param {string} userRoot Exact user root
 * @param {string} handle User handle
 * @returns {{restored: number, cleaned: number}} Recovery counts
 */
export function recoverDurableChatTransactions(userRoot, handle) {
    const context = getUserContext(userRoot, handle);
    if (!fs.existsSync(context.namespace)) return { restored: 0, cleaned: 0 };
    assertDirectoryWithoutSymlink(context.namespace, 'User migration journal namespace');
    const result = { restored: 0, cleaned: 0 };
    for (const entry of fs.readdirSync(context.namespace, { withFileTypes: true })) {
        const transactionDirectory = path.join(context.namespace, entry.name);
        if (entry.isSymbolicLink()) {
            throw new Error(`Chat journal entries must not be symbolic links: ${transactionDirectory}`);
        }
        if (!entry.isDirectory() || activeTransactions.has(transactionDirectory)) continue;
        const manifestPath = path.join(transactionDirectory, MANIFEST_FILE);
        if (!fs.existsSync(manifestPath)) {
            fs.rmSync(transactionDirectory, { recursive: true, force: true });
            continue;
        }
        const verified = readVerifiedManifest(transactionDirectory, context);
        if (verified.manifest.state === 'committed') {
            fs.rmSync(transactionDirectory, { recursive: true, force: true });
            result.cleaned++;
            continue;
        }
        restoreTransaction(transactionDirectory, context, verified);
        fs.rmSync(transactionDirectory, { recursive: true, force: true });
        result.restored++;
    }
    return result;
}

/**
 * Performs concurrency-safe recovery once for one authenticated user namespace.
 * @param {string} userRoot Exact user root
 * @param {string} handle User handle
 * @returns {{restored: number, cleaned: number}} Recovery counts
 */
export function ensureDurableChatRecovery(userRoot, handle) {
    const context = getUserContext(userRoot, handle);
    const key = normalizeForHash(context.namespace);
    if (recoveredNamespaces.has(key)) return { restored: 0, cleaned: 0 };
    if (recoveringNamespaces.has(key)) {
        throw new Error(`Concurrent chat journal recovery attempted for ${handle}.`);
    }
    recoveringNamespaces.add(key);
    try {
        const result = recoverDurableChatTransactions(userRoot, handle);
        recoveredNamespaces.add(key);
        return result;
    } finally {
        recoveringNamespaces.delete(key);
    }
}

/** Test-only reset for isolated router instances. */
export function resetDurableChatRecoveryForTests() {
    recoveredNamespaces.clear();
    recoveringNamespaces.clear();
}
