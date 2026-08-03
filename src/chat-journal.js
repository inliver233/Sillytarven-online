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
const TRANSACTION_PATTERN = /^tx-[A-Za-z0-9]{6}$/;
const FAILED_PATTERN = /^failed-[A-Za-z0-9]{6}$/;
const CLEANUP_PATTERN = /^cleanup-[a-f0-9]{32}$/;
const ATOMIC_MANIFEST_TEMP_PATTERN = /^manifest\.json\.\d+$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const VALID_STATES = new Set(['prepared', 'mutating', 'committed', 'rolled-back']);
const TERMINAL_STATES = new Set(['committed', 'rolled-back']);
const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set([
    'EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM',
]);
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

function prepareNamespace(context) {
    const parent = path.dirname(context.namespace);
    if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent);
        syncDirectory(path.dirname(parent));
        syncDirectory(parent);
    }
    assertDirectoryWithoutSymlink(parent, 'Migration journal parent');
    if (!fs.existsSync(context.namespace)) {
        fs.mkdirSync(context.namespace);
        syncDirectory(parent);
        syncDirectory(context.namespace);
    }
    assertDirectoryWithoutSymlink(context.namespace, 'User migration journal namespace');
}

function syncDirectory(directoryPath) {
    let descriptor;
    try {
        descriptor = fs.openSync(directoryPath, 'r');
        fs.fsyncSync(descriptor);
    } catch (error) {
        if (process.platform !== 'win32' || !DIRECTORY_SYNC_UNSUPPORTED_CODES.has(error?.code)) throw error;
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
}

function syncDirectoryHierarchy(directoryPath, rootPath) {
    const root = path.resolve(rootPath);
    let current = path.resolve(directoryPath);
    const relative = path.relative(root, current);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Directory sync path escapes the exact user root: ${directoryPath}`);
    }
    while (true) {
        if (fs.existsSync(current)) {
            assertDirectoryWithoutSymlink(current, 'Chat storage directory');
            syncDirectory(current);
        }
        if (normalizeForHash(current) === normalizeForHash(root)) break;
        current = path.dirname(current);
    }
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
    syncDirectory(transactionDirectory);
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
        || manifest.userRootHash !== context.rootHash
        || !HASH_PATTERN.test(String(digest ?? ''))) {
        throw new Error(`Invalid or cross-user chat journal manifest: ${manifestPath}`);
    }
    if (hashCanonicalJson(manifest) !== digest) {
        throw new Error(`Chat journal manifest checksum mismatch: ${manifestPath}`);
    }
    const targetPath = fromUserRelativePath(context, manifest.target, 'target');
    for (const artifact of manifest.artifacts) {
        const artifactPath = fromUserRelativePath(context, artifact.path, 'artifact');
        assertArtifactBelongsToTarget(targetPath, artifactPath);
        if (typeof artifact.snapshot !== 'string' || !/^snapshot\/\d{6}$/.test(artifact.snapshot)
            || !Number.isSafeInteger(artifact.size) || artifact.size < 0
            || !HASH_PATTERN.test(String(artifact.sha256 ?? ''))) {
            throw new Error(`Invalid snapshot path in chat journal: ${artifact.snapshot}`);
        }
    }
    return { manifest, targetPath };
}

function inspectJournal(transactionDirectory) {
    const snapshotDirectory = path.join(transactionDirectory, 'snapshot');
    let removedTemporary = false;
    for (const entry of fs.readdirSync(transactionDirectory, { withFileTypes: true })) {
        const entryPath = path.join(transactionDirectory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Unsafe chat journal artifact: ${entryPath}`);
        if (entry.name === MANIFEST_FILE && entry.isFile()) continue;
        if (entry.name === 'snapshot' && entry.isDirectory()) continue;
        if (ATOMIC_MANIFEST_TEMP_PATTERN.test(entry.name) && entry.isFile()) {
            fs.rmSync(entryPath, { force: true });
            removedTemporary = true;
            continue;
        }
        throw new Error(`Unknown chat journal artifact: ${entryPath}`);
    }
    if (removedTemporary) syncDirectory(transactionDirectory);
    if (!fs.existsSync(snapshotDirectory)) return;
    assertDirectoryWithoutSymlink(snapshotDirectory, 'Chat journal snapshot directory');
    for (const entry of fs.readdirSync(snapshotDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || !/^\d{6}$/.test(entry.name)) {
            throw new Error(`Unsafe chat journal snapshot artifact: ${path.join(snapshotDirectory, entry.name)}`);
        }
    }
}

function assertJournalChild(transactionDirectory, context, allowCleanup = false) {
    const name = path.basename(transactionDirectory);
    if ((!TRANSACTION_PATTERN.test(name) && !FAILED_PATTERN.test(name)
        && !(allowCleanup && CLEANUP_PATTERN.test(name)))
        || path.resolve(transactionDirectory) !== path.join(context.namespace, name)) {
        throw new Error(`Invalid chat journal transaction path: ${transactionDirectory}`);
    }
    assertDirectoryWithoutSymlink(transactionDirectory, allowCleanup ? 'Chat cleanup tombstone' : 'Chat transaction directory');
    if (normalizeForHash(fs.realpathSync.native(transactionDirectory)) !== normalizeForHash(transactionDirectory)) {
        throw new Error(`Chat journal entry must be an exact real directory: ${transactionDirectory}`);
    }
}

function readVerifiedTransaction(transactionDirectory, context) {
    assertJournalChild(transactionDirectory, context);
    inspectJournal(transactionDirectory);
    const verified = readVerifiedManifest(transactionDirectory, context);
    const snapshotDirectory = path.join(transactionDirectory, 'snapshot');
    if (!fs.existsSync(snapshotDirectory)) throw new Error('Chat journal snapshot directory is missing.');
    const expectedSnapshots = verified.manifest.artifacts.map(artifact => path.basename(artifact.snapshot)).sort();
    if (new Set(expectedSnapshots).size !== expectedSnapshots.length) {
        throw new Error('Duplicate chat journal snapshot artifact.');
    }
    const actualSnapshots = fs.readdirSync(snapshotDirectory).sort();
    if (canonicalJsonStringify(actualSnapshots) !== canonicalJsonStringify(expectedSnapshots)) {
        throw new Error('Unknown or missing chat journal snapshot artifact.');
    }
    for (const artifact of verified.manifest.artifacts) {
        const snapshotPath = path.join(transactionDirectory, ...artifact.snapshot.split('/'));
        const contents = fs.readFileSync(snapshotPath);
        if (contents.length !== artifact.size || sha256(contents) !== artifact.sha256) {
            throw new Error(`Chat journal snapshot checksum mismatch: ${snapshotPath}`);
        }
    }
    return verified;
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
    const { manifest, targetPath } = verified ?? readVerifiedTransaction(transactionDirectory, context);
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
    const { manifest } = readVerifiedTransaction(transactionDirectory, context);
    if (manifest.state !== expectedState) {
        throw new Error(`Invalid chat transaction state transition: ${manifest.state} -> ${nextState}`);
    }
    const nextManifest = { ...manifest, state: nextState };
    writeManifest(transactionDirectory, nextManifest);
    return nextManifest;
}

function syncCurrentChatState(context, targetPath) {
    assertPathComponentsWithoutSymlinks(context.root, targetPath, false);
    const chunkDirectory = `${targetPath}${CHAT_CHUNK_DIR_SUFFIX}`;
    for (const artifactPath of listCurrentChatArtifacts(targetPath)) {
        assertPathComponentsWithoutSymlinks(context.root, artifactPath, true);
        const stats = fs.lstatSync(artifactPath);
        if (!stats.isFile() || stats.isSymbolicLink()) {
            throw new Error(`Chat target artifact must be a regular file: ${artifactPath}`);
        }
        syncFile(artifactPath);
    }
    if (fs.existsSync(chunkDirectory)) syncDirectory(chunkDirectory);
    syncDirectoryHierarchy(path.dirname(targetPath), context.root);
}

function markRolledBack(transactionDirectory, context) {
    const { manifest } = readVerifiedTransaction(transactionDirectory, context);
    if (!['prepared', 'mutating'].includes(manifest.state)) {
        throw new Error(`Invalid chat rollback terminal state: ${manifest.state}`);
    }
    const nextManifest = { ...manifest, state: 'rolled-back' };
    writeManifest(transactionDirectory, nextManifest);
    return nextManifest;
}

function quarantineTransaction(transactionDirectory, context) {
    const name = path.basename(transactionDirectory);
    if (!TRANSACTION_PATTERN.test(name)) return transactionDirectory;
    const failedDirectory = path.join(context.namespace, `failed-${name.slice(3)}`);
    if (fs.existsSync(failedDirectory)) {
        throw new Error(`Chat recovery quarantine already exists: ${failedDirectory}`);
    }
    activeTransactions.delete(transactionDirectory);
    fs.renameSync(transactionDirectory, failedDirectory);
    syncDirectory(context.namespace);
    return failedDirectory;
}

function markForCleanup(transactionDirectory, context) {
    assertJournalChild(transactionDirectory, context);
    const verified = readVerifiedTransaction(transactionDirectory, context);
    if (!TERMINAL_STATES.has(verified.manifest.state)) {
        throw new Error(`Cannot clean up nonterminal chat transaction: ${verified.manifest.state}`);
    }
    const cleanupDirectory = path.join(context.namespace, `cleanup-${crypto.randomBytes(16).toString('hex')}`);
    if (!CLEANUP_PATTERN.test(path.basename(cleanupDirectory)) || fs.existsSync(cleanupDirectory)) {
        throw new Error(`Invalid or duplicate chat cleanup tombstone: ${cleanupDirectory}`);
    }
    fs.renameSync(transactionDirectory, cleanupDirectory);
    syncDirectory(context.namespace);
    return cleanupDirectory;
}

function removeCleanupTombstone(cleanupDirectory, context) {
    fs.rmSync(cleanupDirectory, { recursive: true, force: true });
    syncDirectory(context.namespace);
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
    let transactionDirectory = fs.mkdtempSync(path.join(context.namespace, 'tx-'));
    syncDirectory(context.namespace);
    syncDirectory(transactionDirectory);
    const snapshotDirectory = path.join(transactionDirectory, 'snapshot');
    fs.mkdirSync(snapshotDirectory);
    syncDirectory(transactionDirectory);
    syncDirectory(snapshotDirectory);

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
        syncDirectory(snapshotDirectory);
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
        syncDirectory(context.namespace);
        throw error;
    }

    activeTransactions.add(transactionDirectory);
    let state = 'prepared';
    const cleanup = () => {
        const sourceDirectory = transactionDirectory;
        try {
            transactionDirectory = markForCleanup(sourceDirectory, context);
            activeTransactions.delete(sourceDirectory);
            activeTransactions.add(transactionDirectory);
            removeCleanupTombstone(transactionDirectory, context);
        } catch (error) {
            activeTransactions.delete(sourceDirectory);
            activeTransactions.delete(transactionDirectory);
            recoveredNamespaces.delete(normalizeForHash(context.namespace));
            if (!TERMINAL_STATES.has(state)) throw error;
        } finally {
            activeTransactions.delete(transactionDirectory);
        }
    };
    return {
        get directory() { return transactionDirectory; },
        markMutating() {
            if (state !== 'prepared') return;
            transitionState(transactionDirectory, context, 'prepared', 'mutating');
            state = 'mutating';
        },
        commit() {
            if (state === 'committed') return cleanup();
            if (state !== 'mutating') {
                throw new Error('Chat transaction must be marked mutating before commit.');
            }
            const verified = readVerifiedTransaction(transactionDirectory, context);
            syncCurrentChatState(context, verified.targetPath);
            transitionState(transactionDirectory, context, 'mutating', 'committed');
            state = 'committed';
            hooks.afterCommitMarker?.();
            cleanup();
        },
        rollback() {
            if (TERMINAL_STATES.has(state)) {
                cleanup();
                return;
            }
            const namespaceKey = normalizeForHash(context.namespace);
            transactionDirectory = quarantineTransaction(transactionDirectory, context);
            activeTransactions.add(transactionDirectory);
            try {
                const verified = readVerifiedTransaction(transactionDirectory, context);
                restoreTransaction(transactionDirectory, context, verified);
                syncCurrentChatState(context, verified.targetPath);
                markRolledBack(transactionDirectory, context);
                state = 'rolled-back';
                cleanup();
            } catch (error) {
                activeTransactions.delete(transactionDirectory);
                recoveredNamespaces.delete(namespaceKey);
                recoveringNamespaces.delete(namespaceKey);
                throw error;
            }
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
    if (normalizeForHash(fs.realpathSync.native(context.namespace)) !== normalizeForHash(context.namespace)) {
        throw new Error('User migration journal namespace must be an exact real directory.');
    }
    const result = { restored: 0, cleaned: 0 };
    for (const entry of fs.readdirSync(context.namespace, { withFileTypes: true })) {
        const transactionDirectory = path.join(context.namespace, entry.name);
        if (entry.isSymbolicLink() || !entry.isDirectory()
            || (!TRANSACTION_PATTERN.test(entry.name) && !FAILED_PATTERN.test(entry.name)
                && !CLEANUP_PATTERN.test(entry.name))) {
            throw new Error(`Unsafe or unknown chat journal entry: ${transactionDirectory}`);
        }
        if (activeTransactions.has(transactionDirectory)) continue;
        assertJournalChild(transactionDirectory, context, CLEANUP_PATTERN.test(entry.name));
        inspectJournal(transactionDirectory);
        const manifestPath = path.join(transactionDirectory, MANIFEST_FILE);
        if (CLEANUP_PATTERN.test(entry.name)) {
            if (fs.existsSync(manifestPath)) {
                const verified = readVerifiedManifest(transactionDirectory, context);
                if (!TERMINAL_STATES.has(verified.manifest.state)) {
                    throw new Error(`Cannot recover forged nonterminal chat cleanup tombstone: ${verified.manifest.state}`);
                }
            }
            removeCleanupTombstone(transactionDirectory, context);
            result.cleaned++;
            continue;
        }
        if (!fs.existsSync(manifestPath)) {
            throw new Error(`Transaction manifest is missing: ${transactionDirectory}`);
        }
        const verified = readVerifiedTransaction(transactionDirectory, context);
        if (TERMINAL_STATES.has(verified.manifest.state)) {
            const cleanupDirectory = markForCleanup(transactionDirectory, context);
            removeCleanupTombstone(cleanupDirectory, context);
            result.cleaned++;
            continue;
        }
        let recoveryDirectory = transactionDirectory;
        let recoveryVerified = verified;
        if (TRANSACTION_PATTERN.test(entry.name)) {
            recoveryDirectory = quarantineTransaction(transactionDirectory, context);
            recoveryVerified = readVerifiedTransaction(recoveryDirectory, context);
        }
        activeTransactions.add(recoveryDirectory);
        try {
            restoreTransaction(recoveryDirectory, context, recoveryVerified);
            syncCurrentChatState(context, recoveryVerified.targetPath);
            markRolledBack(recoveryDirectory, context);
            const terminalDirectory = recoveryDirectory;
            recoveryDirectory = markForCleanup(terminalDirectory, context);
            activeTransactions.delete(terminalDirectory);
            activeTransactions.add(recoveryDirectory);
            removeCleanupTombstone(recoveryDirectory, context);
            result.restored++;
        } finally {
            activeTransactions.delete(recoveryDirectory);
        }
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
    if (recoveredNamespaces.has(key)
        && (!fs.existsSync(context.namespace) || fs.readdirSync(context.namespace).length === 0)) {
        return { restored: 0, cleaned: 0 };
    }
    recoveredNamespaces.delete(key);
    if (recoveringNamespaces.has(key)) {
        throw new Error(`Concurrent chat journal recovery attempted for ${handle}.`);
    }
    recoveringNamespaces.add(key);
    try {
        const result = recoverDurableChatTransactions(userRoot, handle);
        if (!fs.existsSync(context.namespace) || fs.readdirSync(context.namespace).length === 0) {
            recoveredNamespaces.add(key);
        } else {
            recoveredNamespaces.delete(key);
        }
        return result;
    } catch (error) {
        recoveredNamespaces.delete(key);
        throw error;
    } finally {
        recoveringNamespaces.delete(key);
    }
}

/** Test-only reset for isolated router instances. */
export function resetDurableChatRecoveryForTests() {
    recoveredNamespaces.clear();
    recoveringNamespaces.clear();
}
