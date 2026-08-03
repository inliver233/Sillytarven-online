import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { canonicalJsonStringify, hashCanonicalJson, sha256 } from './canonical-hash.js';
import { canConsumeStorage } from './storage-quota.js';
import { getUniqueName, humanizedDateTime, tryParse } from './util.js';

const CHAT_METADATA_SUFFIX = '.metadata.json';
const CHAT_INDEX_SUFFIX = '.index.json';
const CHAT_REVISION_SUFFIX = '.revision.json';
const CHAT_CHUNK_DIR_SUFFIX = '.chunks';
const IDEMPOTENCY_DIRECTORY = '.chat-branch-idempotency';
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IDEMPOTENCY_MAX_RECORDS = 1000;
const BRANCH_JOURNAL_DIRECTORY = '.chat-branch-journals';
const BRANCH_MANIFEST_FILE = 'manifest.json';
const BRANCH_MANIFEST_VERSION = 3;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TRANSACTION_NAME_PATTERN = /^tx-[A-Za-z0-9]{6}$/;
const FAILED_TRANSACTION_NAME_PATTERN = /^failed-[A-Za-z0-9]{6}$/;
const CLEANUP_TRANSACTION_NAME_PATTERN = /^cleanup-[a-f0-9]{32}$/;
const VALID_TRANSACTION_STATES = new Set(['prepared', 'mutating', 'committed', 'rolled-back']);
const TERMINAL_TRANSACTION_STATES = new Set(['committed', 'rolled-back']);
const WRITE_FILE_ATOMIC_TEMP_SUFFIX_PATTERN = /^\d+$/;
const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set([
    'EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM',
]);
const DESTINATION_NAME_MAX_BYTES = 200;
const activeBranchTransactions = new Set();
const recoveredBranchNamespaces = new Set();
let faultInjector = null;

class BranchError extends Error {
    constructor(status, code, details = {}) {
        super(code);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

function normalizePath(value) {
    const normalized = path.normalize(path.resolve(value));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathEntryExists(filePath) {
    try {
        fs.lstatSync(filePath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

function isOutside(root, candidate) {
    const relative = path.relative(root, candidate);
    return !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
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

function syncDirectoryHierarchy(root, directoryPath) {
    const exactRoot = path.resolve(root);
    let current = path.resolve(directoryPath);
    const relative = path.relative(exactRoot, current);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Branch storage sync path escapes user root: ${directoryPath}`);
    }
    while (true) {
        if (pathEntryExists(current)) {
            assertRealDirectory(current, exactRoot === current ? null : exactRoot, 'branch storage directory');
            syncDirectory(current);
        }
        if (normalizePath(current) === normalizePath(exactRoot)) break;
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

function writeDurableJson(filePath, value) {
    writeFileAtomicSync(filePath, canonicalJsonStringify(value), 'utf8');
    syncFile(filePath);
}

function toJournalRelative(root, candidate) {
    const absolute = assertSafePath(root, candidate, pathEntryExists(candidate));
    const relative = path.relative(root, absolute);
    if (isOutside(root, absolute)) throw new Error(`Branch journal path escapes user root: ${candidate}`);
    return relative.split(path.sep).join('/');
}

function exactJournalRelative(root, candidate) {
    return path.relative(root, path.resolve(candidate)).split(path.sep).join('/');
}

function fromJournalRelative(root, relative, label) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\')) {
        throw new Error(`Invalid ${label} in branch journal.`);
    }
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) {
        throw new Error(`Invalid ${label} in branch journal.`);
    }
    return assertSafePath(root, path.resolve(root, ...parts));
}

export function getChatBranchJournalNamespace(root, handle, create = true) {
    if (typeof handle !== 'string' || !handle) throw new TypeError('Authenticated user handle is required.');
    const exactRoot = assertRealDirectory(root, null, 'user root');
    const parent = path.join(path.dirname(exactRoot), BRANCH_JOURNAL_DIRECTORY);
    const namespaceKey = sha256(`${handle}\0${normalizePath(exactRoot)}`);
    const directory = path.join(parent, namespaceKey);
    if (pathEntryExists(parent)) {
        assertRealDirectory(parent, null, 'branch journal parent');
    } else if (create) {
        fs.mkdirSync(parent);
        syncDirectory(path.dirname(parent));
        syncDirectory(parent);
        assertRealDirectory(parent, null, 'branch journal parent');
    }
    if (create && !pathEntryExists(directory)) {
        fs.mkdirSync(directory);
        syncDirectory(parent);
        syncDirectory(directory);
    }
    if (pathEntryExists(directory)) assertRealDirectory(directory, parent, 'branch journal namespace');
    return directory;
}

export function getChatBranchUserLockPath(root) {
    return path.resolve(root);
}

function signBranchManifest(manifest) {
    return { ...manifest, digest: hashCanonicalJson(manifest) };
}

function writeBranchManifest(transactionDirectory, manifest) {
    writeDurableJson(path.join(transactionDirectory, BRANCH_MANIFEST_FILE), signBranchManifest(manifest));
    syncDirectory(transactionDirectory);
}

function isWriteFileAtomicTemp(name, targetName) {
    return name.startsWith(`${targetName}.`)
        && WRITE_FILE_ATOMIC_TEMP_SUFFIX_PATTERN.test(name.slice(targetName.length + 1));
}

function inspectTransactionArtifacts(transactionDirectory) {
    const snapshotDirectory = path.join(transactionDirectory, 'snapshot');
    let removedTemporary = false;
    for (const entry of fs.readdirSync(transactionDirectory, { withFileTypes: true })) {
        const entryPath = path.join(transactionDirectory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Unsafe chat branch journal artifact: ${entryPath}`);
        if (isWriteFileAtomicTemp(entry.name, BRANCH_MANIFEST_FILE)) {
            if (!entry.isFile()) throw new Error(`Invalid chat branch journal temporary artifact: ${entryPath}`);
            fs.rmSync(entryPath, { force: true });
            removedTemporary = true;
            continue;
        }
        if (entry.name === BRANCH_MANIFEST_FILE && entry.isFile()) continue;
        if (entry.name === 'snapshot' && entry.isDirectory()) continue;
        throw new Error(`Unknown chat branch journal artifact: ${entryPath}`);
    }
    if (removedTemporary) syncDirectory(transactionDirectory);
    if (!pathEntryExists(snapshotDirectory)) return;
    assertRealDirectory(snapshotDirectory, transactionDirectory, 'branch snapshot directory');
    for (const entry of fs.readdirSync(snapshotDirectory, { withFileTypes: true })) {
        const entryPath = path.join(snapshotDirectory, entry.name);
        if (!entry.isFile() || entry.isSymbolicLink() || !/^\d{6}$/.test(entry.name)) {
            throw new Error(`Chat branch snapshot must be a regular file with a canonical name: ${entryPath}`);
        }
    }
}

function removeWriteFileAtomicTempsForTarget(root, targetPath) {
    if (targetPath === null) return;
    const directory = path.dirname(targetPath);
    if (!pathEntryExists(directory)) return;
    assertRealDirectory(directory, root, 'branch artifact parent');
    const targetName = path.basename(targetPath);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!isWriteFileAtomicTemp(entry.name, targetName)) continue;
        const temporaryPath = path.join(directory, entry.name);
        if (!entry.isFile() || entry.isSymbolicLink()) {
            throw new Error(`Unsafe write-file-atomic temporary artifact: ${temporaryPath}`);
        }
        fs.rmSync(temporaryPath, { force: true });
    }
}

function cleanChatFamilyWriteTemps(root, chatPath) {
    for (const directPath of [
        chatPath,
        `${chatPath}${CHAT_METADATA_SUFFIX}`,
        `${chatPath}${CHAT_INDEX_SUFFIX}`,
        `${chatPath}${CHAT_REVISION_SUFFIX}`,
    ]) removeWriteFileAtomicTempsForTarget(root, directPath);
    const chunkDirectory = `${chatPath}${CHAT_CHUNK_DIR_SUFFIX}`;
    if (!pathEntryExists(chunkDirectory)) return;
    assertRealDirectory(chunkDirectory, root, 'chat branch chunk directory');
    for (const entry of fs.readdirSync(chunkDirectory, { withFileTypes: true })) {
        const match = entry.name.match(/^(\d{6}\.jsonl)\.(\d+)$/);
        if (!match) continue;
        const temporaryPath = path.join(chunkDirectory, entry.name);
        if (!entry.isFile() || entry.isSymbolicLink()) {
            throw new Error(`Unsafe write-file-atomic chunk temporary artifact: ${temporaryPath}`);
        }
        fs.rmSync(temporaryPath, { force: true });
    }
}

function quarantineBranchTransaction(transactionDirectory) {
    const name = path.basename(transactionDirectory);
    if (!TRANSACTION_NAME_PATTERN.test(name)) {
        throw new Error(`Only active transactions can be quarantined: ${transactionDirectory}`);
    }
    const quarantineDirectory = path.join(path.dirname(transactionDirectory), `failed-${name.slice(3)}`);
    if (pathEntryExists(quarantineDirectory)) {
        throw new Error(`Chat branch quarantine already exists: ${quarantineDirectory}`);
    }
    activeBranchTransactions.delete(transactionDirectory);
    fs.renameSync(transactionDirectory, quarantineDirectory);
    syncDirectory(path.dirname(transactionDirectory));
    activeBranchTransactions.add(quarantineDirectory);
    return quarantineDirectory;
}

function syncDirectTarget(filePath, label) {
    if (!filePath) return;
    if (pathEntryExists(filePath)) {
        assertRegularFile(filePath, label);
        syncFile(filePath);
    }
    if (pathEntryExists(path.dirname(filePath))) syncDirectory(path.dirname(filePath));
}

function syncChatFamilyTarget(root, chatPath) {
    assertChatBranchFamilySafe(root, chatPath);
    for (const artifactPath of [
        chatPath,
        `${chatPath}${CHAT_METADATA_SUFFIX}`,
        `${chatPath}${CHAT_INDEX_SUFFIX}`,
        `${chatPath}${CHAT_REVISION_SUFFIX}`,
    ]) {
        if (pathEntryExists(artifactPath)) syncFile(artifactPath);
    }
    const chunkDirectory = `${chatPath}${CHAT_CHUNK_DIR_SUFFIX}`;
    if (pathEntryExists(chunkDirectory)) {
        for (const entry of fs.readdirSync(chunkDirectory, { withFileTypes: true })) {
            const artifactPath = path.join(chunkDirectory, entry.name);
            if (!entry.isFile() || entry.isSymbolicLink()) {
                throw new Error(`Unsafe chat branch target artifact: ${artifactPath}`);
            }
            syncFile(artifactPath);
        }
        syncDirectory(chunkDirectory);
    }
    syncDirectory(path.dirname(chatPath));
}

function syncDurablePostMutationState(root, directories, verified) {
    const { manifest, paths } = verified;
    if (manifest.type === 'chat-branch') {
        syncChatFamilyTarget(root, paths.source);
        syncChatFamilyTarget(root, paths.destination);
        syncDirectTarget(paths.group, 'Group metadata');
        syncDirectTarget(paths.idempotency, 'Idempotency record');
    } else if (manifest.type === 'group-delete') {
        for (const chatPath of paths.chats) syncChatFamilyTarget(root, chatPath);
        syncDirectTarget(paths.group, 'Group metadata');
    } else {
        syncChatFamilyTarget(root, paths.source);
        syncChatFamilyTarget(root, paths.destination);
        syncDirectTarget(paths.group, 'Group metadata');
    }

    const roots = getRecoveryRoots(root, directories);
    for (const storageRoot of [roots.chats, roots.groupChats, roots.groups]) syncDirectory(storageRoot);
    const idempotencyRoot = path.join(root, IDEMPOTENCY_DIRECTORY);
    if (pathEntryExists(idempotencyRoot)) syncDirectory(idempotencyRoot);
    syncDirectoryHierarchy(root, root);
}

function markBranchTransactionForCleanup(transactionDirectory, readTransaction) {
    const namespace = path.dirname(transactionDirectory);
    const name = path.basename(transactionDirectory);
    if (!TRANSACTION_NAME_PATTERN.test(name) && !FAILED_TRANSACTION_NAME_PATTERN.test(name)) {
        throw new Error(`Invalid committed branch transaction path: ${transactionDirectory}`);
    }
    const { manifest } = readTransaction(transactionDirectory);
    if (!TERMINAL_TRANSACTION_STATES.has(manifest.state)) {
        throw new Error(`Cannot clean up nonterminal branch transaction: ${manifest.state}`);
    }
    const cleanupDirectory = path.join(namespace, `cleanup-${crypto.randomBytes(16).toString('hex')}`);
    if (!CLEANUP_TRANSACTION_NAME_PATTERN.test(path.basename(cleanupDirectory)) || pathEntryExists(cleanupDirectory)) {
        throw new Error(`Invalid or duplicate branch cleanup tombstone: ${cleanupDirectory}`);
    }
    fs.renameSync(transactionDirectory, cleanupDirectory);
    syncDirectory(namespace);
    return cleanupDirectory;
}

function createDurableTransactionController({
    transactionDirectory,
    readTransaction,
    restoreTransaction,
    syncTransaction,
    label,
}) {
    activeBranchTransactions.add(transactionDirectory);
    let state = 'prepared';
    const transition = nextState => {
        const { manifest } = readTransaction(transactionDirectory);
        writeBranchManifest(transactionDirectory, { ...manifest, state: nextState });
        state = nextState;
    };
    const cleanup = () => {
        const sourceDirectory = transactionDirectory;
        try {
            transactionDirectory = markBranchTransactionForCleanup(sourceDirectory, readTransaction);
            activeBranchTransactions.delete(sourceDirectory);
            activeBranchTransactions.add(transactionDirectory);
            fs.rmSync(transactionDirectory, { recursive: true, force: true });
            syncDirectory(path.dirname(transactionDirectory));
        } catch (error) {
            activeBranchTransactions.delete(sourceDirectory);
            activeBranchTransactions.delete(transactionDirectory);
            recoveredBranchNamespaces.delete(normalizePath(path.dirname(transactionDirectory)));
            if (!TERMINAL_TRANSACTION_STATES.has(state)) throw error;
        } finally {
            activeBranchTransactions.delete(transactionDirectory);
        }
    };
    return {
        get directory() { return transactionDirectory; },
        markMutating() {
            if (state === 'prepared') transition('mutating');
        },
        markCommitted() {
            if (state !== 'mutating') throw new Error(`${label} transaction is not mutating.`);
            const verified = readTransaction(transactionDirectory);
            syncTransaction(verified);
            transition('committed');
        },
        cleanup,
        rollback() {
            if (TERMINAL_TRANSACTION_STATES.has(state)) {
                cleanup();
                return;
            }
            transactionDirectory = quarantineBranchTransaction(transactionDirectory);
            activeBranchTransactions.add(transactionDirectory);
            try {
                const verified = readTransaction(transactionDirectory);
                restoreTransaction(transactionDirectory, verified);
                syncTransaction(verified);
                transition('rolled-back');
                cleanup();
            } catch (error) {
                activeBranchTransactions.delete(transactionDirectory);
                recoveredBranchNamespaces.delete(normalizePath(path.dirname(transactionDirectory)));
                throw error;
            }
        },
    };
}

function getRecoveryRoots(root, directories) {
    if (!directories || typeof directories !== 'object') {
        throw new TypeError('Authenticated user directories are required for chat branch recovery.');
    }
    return {
        chats: assertRealDirectory(directories.chats, root, 'chats root'),
        groupChats: assertRealDirectory(directories.groupChats, root, 'group chats root'),
        groups: assertRealDirectory(directories.groups, root, 'groups root'),
    };
}

function isChatFamilyArtifact(chatPath, artifactPath) {
    if ([
        chatPath,
        `${chatPath}${CHAT_METADATA_SUFFIX}`,
        `${chatPath}${CHAT_INDEX_SUFFIX}`,
        `${chatPath}${CHAT_REVISION_SUFFIX}`,
    ].includes(artifactPath)) return true;
    const chunkDirectory = `${chatPath}${CHAT_CHUNK_DIR_SUFFIX}`;
    return path.dirname(artifactPath) === chunkDirectory && /^\d{6}\.jsonl$/.test(path.basename(artifactPath));
}

function assertRegularFile(filePath, label) {
    if (!pathEntryExists(filePath)) throw new Error(`${label} is missing: ${filePath}`);
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${filePath}`);
}

function assertRegularFileIfPresent(filePath, label) {
    if (!filePath || !pathEntryExists(filePath)) return;
    assertRegularFile(filePath, label);
}

function assertSnapshotIntegrity(snapshotPath, snapshot, label) {
    assertRegularFile(snapshotPath, label);
    const contents = fs.readFileSync(snapshotPath);
    if (contents.length !== snapshot.size || sha256(contents) !== snapshot.sha256) {
        throw new Error(`${label} checksum mismatch: ${snapshotPath}`);
    }
}

function getStorageFingerprint(root, handle, roots) {
    return hashCanonicalJson({
        root: normalizePath(root),
        chats: normalizePath(roots.chats),
        groupChats: normalizePath(roots.groupChats),
        groups: normalizePath(roots.groups),
        idempotency: normalizePath(path.join(root, IDEMPOTENCY_DIRECTORY)),
        handleHash: sha256(handle),
    });
}

function readBranchManifest(transactionDirectory, root, handle, directories) {
    const expectedNamespace = getChatBranchJournalNamespace(root, handle, false);
    const transactionName = path.basename(transactionDirectory);
    if ((!TRANSACTION_NAME_PATTERN.test(transactionName) && !FAILED_TRANSACTION_NAME_PATTERN.test(transactionName))
        || path.resolve(transactionDirectory) !== path.join(expectedNamespace, transactionName)) {
        throw new Error(`Invalid chat branch journal transaction path: ${transactionDirectory}`);
    }
    assertRealDirectory(transactionDirectory, expectedNamespace, 'branch transaction directory');
    inspectTransactionArtifacts(transactionDirectory);
    const manifestPath = path.join(transactionDirectory, BRANCH_MANIFEST_FILE);
    assertRegularFile(manifestPath, 'Chat branch manifest');
    const signed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const { digest, ...manifest } = signed;
    const roots = getRecoveryRoots(root, directories);
    if (manifest.version !== BRANCH_MANIFEST_VERSION || manifest.type !== 'chat-branch'
        || !VALID_TRANSACTION_STATES.has(manifest.state)
        || manifest.handleHash !== sha256(handle) || manifest.userRootHash !== sha256(normalizePath(root))
        || manifest.storageFingerprint !== getStorageFingerprint(root, handle, roots)
        || !SHA256_PATTERN.test(String(digest ?? '')) || hashCanonicalJson(manifest) !== digest
        || !Array.isArray(manifest.snapshots) || !['solo', 'group'].includes(manifest.family)) {
        throw new Error(`Invalid chat branch journal manifest: ${manifestPath}`);
    }
    const groupRelativePath = manifest.paths?.group;
    const paths = {
        source: fromJournalRelative(root, manifest.paths?.source, 'source path'),
        destination: fromJournalRelative(root, manifest.paths?.destination, 'destination path'),
        group: groupRelativePath === null ? null : fromJournalRelative(root, groupRelativePath, 'group path'),
        idempotency: fromJournalRelative(root, manifest.paths?.idempotency, 'idempotency path'),
    };
    const sourceId = withoutJsonl(manifest.sourceId, 'sourceId');
    const destinationId = withoutJsonl(manifest.destinationId, 'destinationId');
    const idempotencyHash = String(manifest.idempotencyHash ?? '');
    if (!SHA256_PATTERN.test(idempotencyHash) || sourceId === destinationId) {
        throw new Error(`Invalid chat branch journal identity: ${manifestPath}`);
    }
    const groupFamily = manifest.family === 'group';
    const groupId = groupFamily ? safeIdentity(String(manifest.groupId ?? ''), 'groupId') : null;
    const avatarDirectory = groupFamily ? null : safeIdentity(String(manifest.avatarDirectory ?? ''), 'avatarDirectory');
    const expectedSource = groupFamily
        ? path.join(roots.groupChats, `${sourceId}.jsonl`)
        : path.join(roots.chats, avatarDirectory, `${sourceId}.jsonl`);
    const expectedDestination = groupFamily
        ? path.join(roots.groupChats, `${destinationId}.jsonl`)
        : path.join(roots.chats, avatarDirectory, `${destinationId}.jsonl`);
    const expectedGroupPath = groupFamily ? path.join(roots.groups, `${groupId}.json`) : null;
    const expectedIdempotencyPath = path.join(root, IDEMPOTENCY_DIRECTORY, `${idempotencyHash}.json`);
    if (manifest.paths.source !== exactJournalRelative(root, expectedSource)
        || manifest.paths.destination !== exactJournalRelative(root, expectedDestination)
        || manifest.paths.group !== (expectedGroupPath ? exactJournalRelative(root, expectedGroupPath) : null)
        || manifest.paths.idempotency !== exactJournalRelative(root, expectedIdempotencyPath)
        || normalizePath(paths.source) !== normalizePath(expectedSource)
        || normalizePath(paths.destination) !== normalizePath(expectedDestination)
        || normalizePath(paths.group ?? root) !== normalizePath(expectedGroupPath ?? root)
        || normalizePath(paths.idempotency) !== normalizePath(expectedIdempotencyPath)) {
        throw new Error(`Chat branch journal paths do not match authenticated storage roots: ${manifestPath}`);
    }
    for (const familyPath of [paths.source, paths.destination]) {
        cleanChatFamilyWriteTemps(root, familyPath);
        for (const directPath of [
            familyPath,
            `${familyPath}${CHAT_METADATA_SUFFIX}`,
            `${familyPath}${CHAT_INDEX_SUFFIX}`,
            `${familyPath}${CHAT_REVISION_SUFFIX}`,
        ]) assertRegularFileIfPresent(directPath, 'Chat branch artifact');
        const chunkDirectory = `${familyPath}${CHAT_CHUNK_DIR_SUFFIX}`;
        if (pathEntryExists(chunkDirectory)) {
            assertRealDirectory(chunkDirectory, root, 'chat branch chunk directory');
            for (const entry of fs.readdirSync(chunkDirectory, { withFileTypes: true })) {
                if (!entry.isFile() || entry.isSymbolicLink() || !/^\d{6}\.jsonl$/.test(entry.name)) {
                    throw new Error(`Invalid chat branch chunk artifact: ${path.join(chunkDirectory, entry.name)}`);
                }
            }
        }
    }
    removeWriteFileAtomicTempsForTarget(root, paths.group);
    removeWriteFileAtomicTempsForTarget(root, paths.idempotency);
    assertRegularFileIfPresent(paths.group, 'Group metadata');
    assertRegularFileIfPresent(paths.idempotency, 'Idempotency record');
    const allowedSnapshotPaths = filePath => isChatFamilyArtifact(paths.source, filePath)
        || isChatFamilyArtifact(paths.destination, filePath)
        || filePath === paths.group || filePath === paths.idempotency;
    const seenTargets = new Set();
    const seenSnapshots = new Set();
    const snapshots = manifest.snapshots.map((snapshot, index) => {
        const filePath = fromJournalRelative(root, snapshot.path, 'snapshot target');
        if (!allowedSnapshotPaths(filePath) || typeof snapshot.file !== 'string'
            || snapshot.path !== exactJournalRelative(root, filePath)
            || snapshot.file !== `snapshot/${String(index).padStart(6, '0')}`
            || !Number.isSafeInteger(snapshot.size) || snapshot.size < 0
            || !SHA256_PATTERN.test(String(snapshot.sha256 ?? '')) || seenTargets.has(filePath)
            || seenSnapshots.has(snapshot.file)) {
            throw new Error(`Invalid snapshot entry in chat branch journal: ${manifestPath}`);
        }
        seenTargets.add(filePath);
        seenSnapshots.add(snapshot.file);
        const snapshotPath = path.join(transactionDirectory, ...snapshot.file.split('/'));
        if (normalizePath(path.dirname(snapshotPath)) !== normalizePath(path.join(transactionDirectory, 'snapshot'))) {
            throw new Error(`Invalid snapshot location in chat branch journal: ${snapshotPath}`);
        }
        assertSnapshotIntegrity(snapshotPath, snapshot, 'Chat branch journal snapshot');
        return { ...snapshot, filePath, snapshotPath };
    });
    const snapshotEntries = fs.readdirSync(path.join(transactionDirectory, 'snapshot'));
    if (snapshotEntries.length !== seenSnapshots.size
        || snapshotEntries.some(name => !seenSnapshots.has(`snapshot/${name}`))) {
        throw new Error(`Unknown snapshot artifact in chat branch journal: ${manifestPath}`);
    }
    if (!seenTargets.has(paths.source) || (paths.group && !seenTargets.has(paths.group))
        || snapshots.some(snapshot => isChatFamilyArtifact(paths.destination, snapshot.filePath))) {
        throw new Error(`Incomplete chat branch journal snapshots: ${manifestPath}`);
    }
    return { manifest, paths, snapshots };
}

function readGroupDeleteManifest(transactionDirectory, root, handle, directories) {
    const expectedNamespace = getChatBranchJournalNamespace(root, handle, false);
    const transactionName = path.basename(transactionDirectory);
    if ((!TRANSACTION_NAME_PATTERN.test(transactionName) && !FAILED_TRANSACTION_NAME_PATTERN.test(transactionName))
        || path.resolve(transactionDirectory) !== path.join(expectedNamespace, transactionName)) {
        throw new Error(`Invalid group delete journal transaction path: ${transactionDirectory}`);
    }
    assertRealDirectory(transactionDirectory, expectedNamespace, 'group delete transaction directory');
    inspectTransactionArtifacts(transactionDirectory);
    const manifestPath = path.join(transactionDirectory, BRANCH_MANIFEST_FILE);
    assertRegularFile(manifestPath, 'Group delete manifest');
    const signed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const { digest, ...manifest } = signed;
    const roots = getRecoveryRoots(root, directories);
    if (manifest.version !== BRANCH_MANIFEST_VERSION || manifest.type !== 'group-delete'
        || !VALID_TRANSACTION_STATES.has(manifest.state)
        || manifest.handleHash !== sha256(handle) || manifest.userRootHash !== sha256(normalizePath(root))
        || manifest.storageFingerprint !== getStorageFingerprint(root, handle, roots)
        || !SHA256_PATTERN.test(String(digest ?? '')) || hashCanonicalJson(manifest) !== digest
        || !Array.isArray(manifest.chatIds) || !Array.isArray(manifest.snapshots)
        || !Array.isArray(manifest.directorySnapshots)
        || manifest.directorySnapshots.length !== manifest.chatIds.length) {
        throw new Error(`Invalid group delete journal manifest: ${manifestPath}`);
    }
    const groupId = safeIdentity(String(manifest.groupId ?? ''), 'groupId');
    const groupPath = fromJournalRelative(root, manifest.paths?.group, 'group path');
    const expectedGroupPath = path.join(roots.groups, `${groupId}.json`);
    const chatIds = manifest.chatIds.map(chatId => withoutJsonl(chatId, 'chatId'));
    if (new Set(chatIds).size !== chatIds.length || manifest.paths?.chats?.length !== chatIds.length
        || manifest.paths.group !== exactJournalRelative(root, expectedGroupPath)
        || normalizePath(groupPath) !== normalizePath(expectedGroupPath)) {
        throw new Error(`Group delete journal paths do not match authenticated storage roots: ${manifestPath}`);
    }
    const chatPaths = chatIds.map((chatId, index) => {
        const chatPath = fromJournalRelative(root, manifest.paths.chats[index], 'group chat path');
        const expectedChatPath = path.join(roots.groupChats, `${chatId}.jsonl`);
        if (manifest.paths.chats[index] !== exactJournalRelative(root, expectedChatPath)
            || normalizePath(chatPath) !== normalizePath(expectedChatPath)) {
            throw new Error(`Group delete journal chat path does not match authenticated storage roots: ${manifestPath}`);
        }
        cleanChatFamilyWriteTemps(root, chatPath);
        assertChatBranchFamilySafe(root, chatPath);
        return chatPath;
    });
    const directorySnapshots = manifest.directorySnapshots.map((snapshot, index) => {
        const directoryPath = fromJournalRelative(root, snapshot?.path, 'directory snapshot target');
        const expectedDirectoryPath = `${chatPaths[index]}${CHAT_CHUNK_DIR_SUFFIX}`;
        if (typeof snapshot?.existed !== 'boolean'
            || snapshot.path !== exactJournalRelative(root, expectedDirectoryPath)
            || normalizePath(directoryPath) !== normalizePath(expectedDirectoryPath)) {
            throw new Error(`Invalid directory snapshot entry in group delete journal: ${manifestPath}`);
        }
        return { ...snapshot, directoryPath };
    });
    removeWriteFileAtomicTempsForTarget(root, groupPath);
    assertRegularFileIfPresent(groupPath, 'Group metadata');
    const allowedSnapshotPaths = filePath => filePath === groupPath
        || chatPaths.some(chatPath => isChatFamilyArtifact(chatPath, filePath));
    const seenTargets = new Set();
    const snapshots = manifest.snapshots.map((snapshot, index) => {
        const filePath = fromJournalRelative(root, snapshot.path, 'snapshot target');
        if (!allowedSnapshotPaths(filePath) || snapshot.path !== exactJournalRelative(root, filePath)
            || snapshot.file !== `snapshot/${String(index).padStart(6, '0')}`
            || !Number.isSafeInteger(snapshot.size) || snapshot.size < 0
            || !SHA256_PATTERN.test(String(snapshot.sha256 ?? '')) || seenTargets.has(filePath)) {
            throw new Error(`Invalid snapshot entry in group delete journal: ${manifestPath}`);
        }
        seenTargets.add(filePath);
        const snapshotPath = path.join(transactionDirectory, ...snapshot.file.split('/'));
        assertSnapshotIntegrity(snapshotPath, snapshot, 'Group delete journal snapshot');
        return { ...snapshot, filePath, snapshotPath };
    });
    const expectedSnapshotFiles = new Set(snapshots.map(snapshot => path.basename(snapshot.snapshotPath)));
    const snapshotEntries = fs.readdirSync(path.join(transactionDirectory, 'snapshot'));
    if (snapshotEntries.length !== expectedSnapshotFiles.size
        || snapshotEntries.some(name => !expectedSnapshotFiles.has(name))) {
        throw new Error(`Unknown snapshot artifact in group delete journal: ${manifestPath}`);
    }
    if (!seenTargets.has(groupPath)
        || snapshots.some(snapshot => path.dirname(snapshot.filePath).endsWith(CHAT_CHUNK_DIR_SUFFIX)
            && !directorySnapshots.some(directory => directory.existed
                && normalizePath(directory.directoryPath) === normalizePath(path.dirname(snapshot.filePath))))) {
        throw new Error(`Incomplete group delete journal snapshots: ${manifestPath}`);
    }
    return { manifest, paths: { group: groupPath, chats: chatPaths }, snapshots, directorySnapshots };
}

function assertChatFamilyRenamePaths(root, roots, sourcePath, destinationPath) {
    const source = assertSafePath(root, sourcePath);
    const destination = assertSafePath(root, destinationPath);
    const sourceParent = path.dirname(source);
    const destinationParent = path.dirname(destination);
    const isGroup = normalizePath(sourceParent) === normalizePath(roots.groupChats);
    const relativeSoloParent = path.relative(roots.chats, sourceParent);
    const soloParts = relativeSoloParent.split(path.sep);
    const isSolo = relativeSoloParent && !relativeSoloParent.startsWith(`..${path.sep}`)
        && relativeSoloParent !== '..' && !path.isAbsolute(relativeSoloParent)
        && soloParts.length === 1 && safeIdentity(soloParts[0], 'avatarDirectory');
    for (const filePath of [source, destination]) {
        const fileName = path.basename(filePath);
        if (!fileName.endsWith('.jsonl') || sanitize(fileName) !== fileName) {
            throw new Error(`Invalid chat family path in durable transaction: ${filePath}`);
        }
    }
    if ((!isGroup && !isSolo) || normalizePath(sourceParent) !== normalizePath(destinationParent)
        || normalizePath(source) === normalizePath(destination)) {
        throw new Error('Chat family rename paths do not share an authenticated storage directory.');
    }
    return { source, destination, family: isGroup ? 'group' : 'solo' };
}

function readChatFamilyManifest(transactionDirectory, root, handle, directories) {
    const expectedNamespace = getChatBranchJournalNamespace(root, handle, false);
    const transactionName = path.basename(transactionDirectory);
    if ((!TRANSACTION_NAME_PATTERN.test(transactionName) && !FAILED_TRANSACTION_NAME_PATTERN.test(transactionName))
        || path.resolve(transactionDirectory) !== path.join(expectedNamespace, transactionName)) {
        throw new Error(`Invalid chat family journal transaction path: ${transactionDirectory}`);
    }
    assertRealDirectory(transactionDirectory, expectedNamespace, 'chat family transaction directory');
    inspectTransactionArtifacts(transactionDirectory);
    const manifestPath = path.join(transactionDirectory, BRANCH_MANIFEST_FILE);
    assertRegularFile(manifestPath, 'Chat family manifest');
    const signed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const { digest, ...manifest } = signed;
    const roots = getRecoveryRoots(root, directories);
    if (manifest.version !== BRANCH_MANIFEST_VERSION || manifest.type !== 'chat-family'
        || manifest.operation !== 'rename' || !VALID_TRANSACTION_STATES.has(manifest.state)
        || manifest.handleHash !== sha256(handle) || manifest.userRootHash !== sha256(normalizePath(root))
        || manifest.storageFingerprint !== getStorageFingerprint(root, handle, roots)
        || !SHA256_PATTERN.test(String(digest ?? '')) || hashCanonicalJson(manifest) !== digest
        || !Array.isArray(manifest.snapshots) || !Array.isArray(manifest.directorySnapshots)
        || manifest.directorySnapshots.length !== 2) {
        throw new Error(`Invalid chat family journal manifest: ${manifestPath}`);
    }
    const rawSource = fromJournalRelative(root, manifest.paths?.source, 'source path');
    const rawDestination = fromJournalRelative(root, manifest.paths?.destination, 'destination path');
    const paths = assertChatFamilyRenamePaths(root, roots, rawSource, rawDestination);
    const groupId = paths.family === 'group' ? safeIdentity(String(manifest.groupId ?? ''), 'groupId') : null;
    const rawGroup = manifest.paths?.group === null || manifest.paths?.group === undefined
        ? null
        : fromJournalRelative(root, manifest.paths.group, 'group path');
    const groupPath = paths.family === 'group' ? rawGroup : null;
    const expectedGroupPath = groupId ? path.join(roots.groups, `${groupId}.json`) : null;
    if (manifest.family !== paths.family
        || manifest.paths.source !== exactJournalRelative(root, paths.source)
        || manifest.paths.destination !== exactJournalRelative(root, paths.destination)
        || (manifest.paths.group ?? null) !== (expectedGroupPath ? exactJournalRelative(root, expectedGroupPath) : null)
        || normalizePath(groupPath ?? root) !== normalizePath(expectedGroupPath ?? root)) {
        throw new Error(`Chat family journal paths do not match authenticated storage roots: ${manifestPath}`);
    }
    if (groupPath) assertRegularFile(groupPath, 'Group metadata');
    for (const familyPath of [paths.source, paths.destination]) {
        cleanChatFamilyWriteTemps(root, familyPath);
        assertChatBranchFamilySafe(root, familyPath);
    }
    const expectedDirectories = [`${paths.source}${CHAT_CHUNK_DIR_SUFFIX}`, `${paths.destination}${CHAT_CHUNK_DIR_SUFFIX}`];
    const directorySnapshots = manifest.directorySnapshots.map((snapshot, index) => {
        const directoryPath = fromJournalRelative(root, snapshot?.path, 'directory snapshot target');
        if (typeof snapshot?.existed !== 'boolean'
            || snapshot.path !== exactJournalRelative(root, expectedDirectories[index])
            || normalizePath(directoryPath) !== normalizePath(expectedDirectories[index])) {
            throw new Error(`Invalid directory snapshot in chat family journal: ${manifestPath}`);
        }
        return { ...snapshot, directoryPath };
    });
    if (directorySnapshots[1].existed) {
        throw new Error(`Chat family rename destination was not empty when journaled: ${manifestPath}`);
    }
    const allowedSnapshotPaths = filePath => isChatFamilyArtifact(paths.source, filePath)
        || filePath === groupPath;
    const seenTargets = new Set();
    const snapshots = manifest.snapshots.map((snapshot, index) => {
        const filePath = fromJournalRelative(root, snapshot.path, 'snapshot target');
        if (!allowedSnapshotPaths(filePath)
            || snapshot.path !== exactJournalRelative(root, filePath)
            || snapshot.file !== `snapshot/${String(index).padStart(6, '0')}`
            || !Number.isSafeInteger(snapshot.size) || snapshot.size < 0
            || !SHA256_PATTERN.test(String(snapshot.sha256 ?? '')) || seenTargets.has(filePath)) {
            throw new Error(`Invalid snapshot entry in chat family journal: ${manifestPath}`);
        }
        seenTargets.add(filePath);
        const snapshotPath = path.join(transactionDirectory, ...snapshot.file.split('/'));
        assertSnapshotIntegrity(snapshotPath, snapshot, 'Chat family journal snapshot');
        return { ...snapshot, filePath, snapshotPath };
    });
    const expectedSnapshotFiles = new Set(snapshots.map(snapshot => path.basename(snapshot.snapshotPath)));
    const snapshotEntries = fs.readdirSync(path.join(transactionDirectory, 'snapshot'));
    if (!seenTargets.has(paths.source)
        || (groupPath && !seenTargets.has(groupPath))
        || snapshotEntries.length !== expectedSnapshotFiles.size
        || snapshotEntries.some(name => !expectedSnapshotFiles.has(name))
        || snapshots.some(snapshot => path.dirname(snapshot.filePath).endsWith(CHAT_CHUNK_DIR_SUFFIX)
            && !directorySnapshots[0].existed)) {
        throw new Error(`Incomplete chat family journal snapshots: ${manifestPath}`);
    }
    return { manifest, paths: { ...paths, group: groupPath }, snapshots, directorySnapshots };
}

function readAuthenticatedDurableManifest(transactionDirectory, root, handle, directories) {
    const expectedNamespace = getChatBranchJournalNamespace(root, handle, false);
    const transactionName = path.basename(transactionDirectory);
    if ((!TRANSACTION_NAME_PATTERN.test(transactionName)
        && !FAILED_TRANSACTION_NAME_PATTERN.test(transactionName)
        && !CLEANUP_TRANSACTION_NAME_PATTERN.test(transactionName))
        || path.resolve(transactionDirectory) !== path.join(expectedNamespace, transactionName)) {
        throw new Error(`Invalid durable transaction path: ${transactionDirectory}`);
    }
    assertRealDirectory(transactionDirectory, expectedNamespace, 'durable transaction directory');
    const manifestPath = path.join(transactionDirectory, BRANCH_MANIFEST_FILE);
    assertRegularFile(manifestPath, 'Durable transaction manifest');
    const signed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const { digest, ...manifest } = signed;
    const roots = getRecoveryRoots(root, directories);
    const commonValid = manifest.version === BRANCH_MANIFEST_VERSION
        && ['chat-branch', 'group-delete', 'chat-family'].includes(manifest.type)
        && VALID_TRANSACTION_STATES.has(manifest.state)
        && manifest.handleHash === sha256(handle)
        && manifest.userRootHash === sha256(normalizePath(root))
        && manifest.storageFingerprint === getStorageFingerprint(root, handle, roots)
        && SHA256_PATTERN.test(String(digest ?? ''))
        && hashCanonicalJson(manifest) === digest
        && Array.isArray(manifest.snapshots);
    const typeValid = manifest.type === 'chat-branch'
        ? ['solo', 'group'].includes(manifest.family) && manifest.paths && typeof manifest.paths === 'object'
        : manifest.type === 'group-delete'
            ? Array.isArray(manifest.chatIds) && Array.isArray(manifest.directorySnapshots)
                && manifest.paths && typeof manifest.paths === 'object'
            : manifest.operation === 'rename' && ['solo', 'group'].includes(manifest.family)
                && Array.isArray(manifest.directorySnapshots) && manifest.paths && typeof manifest.paths === 'object';
    if (!commonValid || !typeValid) {
        throw new Error(`Invalid, tampered, or cross-user durable transaction manifest: ${manifestPath}`);
    }
    return manifest;
}

function readDurableTransaction(transactionDirectory, root, handle, directories) {
    inspectTransactionArtifacts(transactionDirectory);
    const manifestPath = path.join(transactionDirectory, BRANCH_MANIFEST_FILE);
    assertRegularFile(manifestPath, 'Durable transaction manifest');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.type === 'chat-branch') return readBranchManifest(transactionDirectory, root, handle, directories);
    if (manifest.type === 'group-delete') return readGroupDeleteManifest(transactionDirectory, root, handle, directories);
    if (manifest.type === 'chat-family') return readChatFamilyManifest(transactionDirectory, root, handle, directories);
    throw new Error(`Unknown durable transaction type: ${manifestPath}`);
}

export function assertChatBranchFamilySafe(root, filePath) {
    assertSafePath(root, filePath);
    for (const artifactPath of [
        filePath,
        `${filePath}${CHAT_METADATA_SUFFIX}`,
        `${filePath}${CHAT_INDEX_SUFFIX}`,
        `${filePath}${CHAT_REVISION_SUFFIX}`,
    ]) {
        if (pathEntryExists(artifactPath)) assertRegularFile(assertSafePath(root, artifactPath, true), 'Chat branch artifact');
    }
    const chunkDirectory = `${filePath}${CHAT_CHUNK_DIR_SUFFIX}`;
    if (!pathEntryExists(chunkDirectory)) return;
    assertRealDirectory(chunkDirectory, root, 'chunk directory');
    for (const entry of fs.readdirSync(chunkDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || !/^\d{6}\.jsonl$/.test(entry.name)) {
            throw new Error(`Unsafe chat chunk artifact: ${entry.name}`);
        }
        assertRegularFile(path.join(chunkDirectory, entry.name), 'Chat chunk artifact');
    }
}

export function removeChatBranchFamily(root, filePath) {
    assertChatBranchFamilySafe(root, filePath);
    for (const artifactPath of [
        filePath,
        `${filePath}${CHAT_METADATA_SUFFIX}`,
        `${filePath}${CHAT_INDEX_SUFFIX}`,
        `${filePath}${CHAT_REVISION_SUFFIX}`,
    ]) {
        if (pathEntryExists(artifactPath)) fs.rmSync(artifactPath, { force: true });
    }
    const chunkDirectory = `${filePath}${CHAT_CHUNK_DIR_SUFFIX}`;
    if (pathEntryExists(chunkDirectory)) fs.rmSync(chunkDirectory, { recursive: true, force: true });
}

function verifyRestoredSnapshots(snapshots, label) {
    for (const snapshot of snapshots) {
        assertRegularFile(snapshot.filePath, `${label} restored target`);
        const contents = fs.readFileSync(snapshot.filePath);
        if (contents.length !== snapshot.size || sha256(contents) !== snapshot.sha256) {
            throw new Error(`${label} restored target checksum mismatch: ${snapshot.filePath}`);
        }
    }
}

function restoreBranchTransaction(transactionDirectory, root, handle, directories, verified = null) {
    const { paths, snapshots } = verified ?? readBranchManifest(transactionDirectory, root, handle, directories);
    for (const snapshot of snapshots) {
        const contents = fs.readFileSync(snapshot.snapshotPath);
        if (contents.length !== snapshot.size || sha256(contents) !== snapshot.sha256) {
            throw new Error(`Chat branch journal snapshot checksum mismatch: ${snapshot.snapshotPath}`);
        }
    }
    removeChatBranchFamily(root, paths.source);
    removeChatBranchFamily(root, paths.destination);
    runChatBranchSynchronousFaultPoint('after-rollback-family-removal', { transactionDirectory });
    for (const directPath of [paths.group, paths.idempotency].filter(Boolean)) {
        if (pathEntryExists(directPath)) {
            assertSafePath(root, directPath, true);
            fs.rmSync(directPath, { force: true });
        }
    }
    for (const snapshot of snapshots) {
        fs.mkdirSync(path.dirname(snapshot.filePath), { recursive: true });
        writeFileAtomicSync(snapshot.filePath, fs.readFileSync(snapshot.snapshotPath));
    }
    verifyRestoredSnapshots(snapshots, 'Chat branch');
}

function createBranchTransaction({
    root,
    handle,
    directories,
    sourcePath,
    destinationPath,
    groupPath,
    normalized,
    destinationId,
    idempotencyPath,
}) {
    const namespace = getChatBranchJournalNamespace(root, handle);
    let transactionDirectory = fs.mkdtempSync(path.join(namespace, 'tx-'));
    assertRealDirectory(transactionDirectory, namespace, 'branch transaction directory');
    const snapshotDirectory = path.join(transactionDirectory, 'snapshot');
    fs.mkdirSync(snapshotDirectory);
    assertRealDirectory(snapshotDirectory, transactionDirectory, 'branch snapshot directory');
    const snapshotPaths = [...getArtifacts(sourcePath), ...getArtifacts(destinationPath)];
    if (groupPath) snapshotPaths.push(groupPath);
    if (pathEntryExists(idempotencyPath)) snapshotPaths.push(idempotencyPath);
    try {
        const snapshots = [...new Set(snapshotPaths.map(item => path.resolve(item)))].map((filePath, index) => {
            assertSafePath(root, filePath, true);
            assertRegularFileIfPresent(filePath, 'Chat branch snapshot target');
            const contents = fs.readFileSync(filePath);
            const name = String(index).padStart(6, '0');
            const snapshotPath = path.join(snapshotDirectory, name);
            fs.writeFileSync(snapshotPath, contents, { flag: 'wx' });
            syncFile(snapshotPath);
            return {
                path: toJournalRelative(root, filePath),
                file: `snapshot/${name}`,
                size: contents.length,
                sha256: sha256(contents),
            };
        });
        const roots = getRecoveryRoots(root, directories);
        const idempotencyHash = path.basename(idempotencyPath, '.json');
        const manifest = {
            version: BRANCH_MANIFEST_VERSION,
            type: 'chat-branch',
            id: crypto.randomUUID(),
            state: 'prepared',
            handleHash: sha256(handle),
            userRootHash: sha256(normalizePath(root)),
            storageFingerprint: getStorageFingerprint(root, handle, roots),
            family: normalized.type,
            sourceId: normalized.chatId,
            destinationId,
            avatarDirectory: normalized.avatarDirectory ?? null,
            groupId: normalized.groupId ?? null,
            idempotencyHash,
            paths: {
                source: toJournalRelative(root, sourcePath),
                destination: toJournalRelative(root, destinationPath),
                group: groupPath ? toJournalRelative(root, groupPath) : null,
                idempotency: toJournalRelative(root, idempotencyPath),
            },
            snapshots,
        };
        writeBranchManifest(transactionDirectory, manifest);
        readBranchManifest(transactionDirectory, root, handle, directories);
    } catch (error) {
        fs.rmSync(transactionDirectory, { recursive: true, force: true });
        throw error;
    }

    return createDurableTransactionController({
        transactionDirectory,
        readTransaction: directory => readBranchManifest(directory, root, handle, directories),
        restoreTransaction: (directory, verified) => restoreBranchTransaction(directory, root, handle, directories, verified),
        syncTransaction: verified => syncDurablePostMutationState(root, directories, verified),
        label: 'Branch',
    });
}

function verifyGroupDeleteRestoration(paths, snapshots, directorySnapshots) {
    verifyRestoredSnapshots(snapshots, 'Group delete');
    const expectedFiles = new Set(snapshots.map(snapshot => normalizePath(snapshot.filePath)));
    for (const chatPath of paths.chats) {
        const actualFiles = getArtifacts(chatPath).map(filePath => normalizePath(filePath));
        const expectedChatFiles = [...expectedFiles].filter(filePath => isChatFamilyArtifact(normalizePath(chatPath), filePath));
        if (actualFiles.length !== expectedChatFiles.length
            || actualFiles.some(filePath => !expectedFiles.has(filePath))) {
            throw new Error(`Group delete restored an inexact chat family: ${chatPath}`);
        }
    }
    for (const snapshot of directorySnapshots) {
        if (pathEntryExists(snapshot.directoryPath) !== snapshot.existed) {
            throw new Error(`Group delete restored directory existence mismatch: ${snapshot.directoryPath}`);
        }
        if (snapshot.existed) assertRealDirectory(snapshot.directoryPath, null, 'restored group chat chunk directory');
    }
}

function restoreGroupDeleteTransaction(transactionDirectory, root, handle, directories, verified = null) {
    const { paths, snapshots, directorySnapshots } = verified ?? readGroupDeleteManifest(transactionDirectory, root, handle, directories);
    for (const snapshot of snapshots) {
        const contents = fs.readFileSync(snapshot.snapshotPath);
        if (contents.length !== snapshot.size || sha256(contents) !== snapshot.sha256) {
            throw new Error(`Group delete journal snapshot checksum mismatch: ${snapshot.snapshotPath}`);
        }
    }
    for (const chatPath of paths.chats) removeChatBranchFamily(root, chatPath);
    if (pathEntryExists(paths.group)) fs.rmSync(paths.group, { force: true });
    runChatBranchSynchronousFaultPoint('after-rollback-family-removal', { transactionDirectory, type: 'group-delete' });
    for (const snapshot of snapshots) {
        fs.mkdirSync(path.dirname(snapshot.filePath), { recursive: true });
        writeFileAtomicSync(snapshot.filePath, fs.readFileSync(snapshot.snapshotPath));
    }
    for (const snapshot of directorySnapshots) {
        if (snapshot.existed && !pathEntryExists(snapshot.directoryPath)) fs.mkdirSync(snapshot.directoryPath);
    }
    verifyGroupDeleteRestoration(paths, snapshots, directorySnapshots);
}

function verifyChatFamilyRestoration(paths, snapshots, directorySnapshots) {
    verifyRestoredSnapshots(snapshots, 'Chat family');
    const expectedFiles = new Set(snapshots
        .filter(snapshot => isChatFamilyArtifact(paths.source, snapshot.filePath))
        .map(snapshot => normalizePath(snapshot.filePath)));
    const actualFiles = getArtifacts(paths.source).map(filePath => normalizePath(filePath));
    if (actualFiles.length !== expectedFiles.size || actualFiles.some(filePath => !expectedFiles.has(filePath))) {
        throw new Error(`Chat family restoration was inexact: ${paths.source}`);
    }
    for (const snapshot of directorySnapshots) {
        if (pathEntryExists(snapshot.directoryPath) !== snapshot.existed) {
            throw new Error(`Chat family restored directory existence mismatch: ${snapshot.directoryPath}`);
        }
    }
    if (hasChatBranchFamilyCollision(paths.destination)) {
        throw new Error(`Chat family restoration left destination artifacts: ${paths.destination}`);
    }
}

function restoreChatFamilyTransaction(transactionDirectory, root, handle, directories, verified = null) {
    const { paths, snapshots, directorySnapshots } = verified
        ?? readChatFamilyManifest(transactionDirectory, root, handle, directories);
    for (const snapshot of snapshots) {
        const contents = fs.readFileSync(snapshot.snapshotPath);
        if (contents.length !== snapshot.size || sha256(contents) !== snapshot.sha256) {
            throw new Error(`Chat family journal snapshot checksum mismatch: ${snapshot.snapshotPath}`);
        }
    }
    removeChatBranchFamily(root, paths.source);
    removeChatBranchFamily(root, paths.destination);
    if (paths.group && pathEntryExists(paths.group)) fs.rmSync(paths.group, { force: true });
    runChatBranchSynchronousFaultPoint('after-rollback-family-removal', { transactionDirectory, type: 'chat-family' });
    for (const snapshot of snapshots) {
        fs.mkdirSync(path.dirname(snapshot.filePath), { recursive: true });
        writeFileAtomicSync(snapshot.filePath, fs.readFileSync(snapshot.snapshotPath));
    }
    for (const snapshot of directorySnapshots) {
        if (snapshot.existed && !pathEntryExists(snapshot.directoryPath)) fs.mkdirSync(snapshot.directoryPath);
    }
    verifyChatFamilyRestoration(paths, snapshots, directorySnapshots);
}

export function createDurableChatFamilyTransaction({
    root,
    handle,
    directories,
    operation,
    sourcePath,
    destinationPath,
    groupPath = null,
}) {
    if (operation !== 'rename') throw new TypeError(`Unsupported chat family operation: ${operation}`);
    const roots = getRecoveryRoots(root, directories);
    const paths = assertChatFamilyRenamePaths(root, roots, sourcePath, destinationPath);
    if (paths.family === 'group' && !groupPath) throw new BranchError(400, 'invalid_source');
    if (paths.family === 'solo' && groupPath) throw new BranchError(400, 'invalid_source');
    if (groupPath) {
        assertSafePath(root, groupPath);
        assertRegularFile(groupPath, 'Group metadata');
    }
    assertChatBranchFamilySafe(root, paths.source);
    assertChatBranchFamilySafe(root, paths.destination);
    assertRegularFile(paths.source, 'Chat family rename source');
    if (hasChatBranchFamilyCollision(paths.destination)) {
        throw new BranchError(409, 'destination_conflict');
    }

    const namespace = getChatBranchJournalNamespace(root, handle);
    const transactionDirectory = fs.mkdtempSync(path.join(namespace, 'tx-'));
    assertRealDirectory(transactionDirectory, namespace, 'chat family transaction directory');
    const snapshotDirectory = path.join(transactionDirectory, 'snapshot');
    fs.mkdirSync(snapshotDirectory);
    assertRealDirectory(snapshotDirectory, transactionDirectory, 'chat family snapshot directory');
    try {
        const sourceChunkDirectory = `${paths.source}${CHAT_CHUNK_DIR_SUFFIX}`;
        const destinationChunkDirectory = `${paths.destination}${CHAT_CHUNK_DIR_SUFFIX}`;
        const directorySnapshots = [sourceChunkDirectory, destinationChunkDirectory].map(directoryPath => ({
            path: exactJournalRelative(root, directoryPath),
            existed: pathEntryExists(directoryPath),
        }));
        if (directorySnapshots[1].existed) throw new BranchError(409, 'destination_conflict');
        const snapshots = [
            ...getArtifacts(paths.source),
            ...(groupPath ? [groupPath] : []),
        ].map((filePath, index) => {
            assertSafePath(root, filePath, true);
            const contents = fs.readFileSync(filePath);
            const name = String(index).padStart(6, '0');
            const snapshotPath = path.join(snapshotDirectory, name);
            fs.writeFileSync(snapshotPath, contents, { flag: 'wx' });
            syncFile(snapshotPath);
            return {
                path: toJournalRelative(root, filePath),
                file: `snapshot/${name}`,
                size: contents.length,
                sha256: sha256(contents),
            };
        });
        const manifest = {
            version: BRANCH_MANIFEST_VERSION,
            type: 'chat-family',
            operation,
            id: crypto.randomUUID(),
            state: 'prepared',
            handleHash: sha256(handle),
            userRootHash: sha256(normalizePath(root)),
            storageFingerprint: getStorageFingerprint(root, handle, roots),
            family: paths.family,
            groupId: groupPath ? path.basename(groupPath, '.json') : null,
            paths: {
                source: toJournalRelative(root, paths.source),
                destination: toJournalRelative(root, paths.destination),
                group: groupPath ? toJournalRelative(root, groupPath) : null,
            },
            snapshots,
            directorySnapshots,
        };
        writeBranchManifest(transactionDirectory, manifest);
        readChatFamilyManifest(transactionDirectory, root, handle, directories);
    } catch (error) {
        fs.rmSync(transactionDirectory, { recursive: true, force: true });
        throw error;
    }

    return createDurableTransactionController({
        transactionDirectory,
        readTransaction: directory => readChatFamilyManifest(directory, root, handle, directories),
        restoreTransaction: (directory, verified) => restoreChatFamilyTransaction(directory, root, handle, directories, verified),
        syncTransaction: verified => syncDurablePostMutationState(root, directories, verified),
        label: 'Chat family',
    });
}

export async function updateChatBranchGroupMetadata(groupPath, groupData, oldChatId, newChatId) {
    const oldChatKey = String(oldChatId);
    const newChatKey = String(newChatId);
    if (!groupPath || !groupData || !Array.isArray(groupData.chats)
        || !groupData.chats.some(chatId => String(chatId) === oldChatKey)) {
        throw new BranchError(400, 'invalid_source');
    }
    const updatedGroup = structuredClone(groupData);
    const wasActive = String(updatedGroup.chat_id) === oldChatKey;
    if (wasActive) updatedGroup.chat_id = newChatKey;
    updatedGroup.chats = updatedGroup.chats.map(chatId => String(chatId) === oldChatKey ? newChatKey : chatId);
    writeDurableJson(groupPath, updatedGroup);
    await runChatBranchFaultPoint('after-chat-family-rename-group-write', {
        groupPath,
        oldChatId,
        newChatId,
    });
    const verified = tryParse(fs.readFileSync(groupPath, 'utf8'));
    if (!verified || (wasActive && verified.chat_id !== newChatKey)
        || (!wasActive && verified.chat_id !== groupData.chat_id)
        || !Array.isArray(verified.chats) || !verified.chats.some(chatId => String(chatId) === newChatKey)
        || verified.chats.some(chatId => String(chatId) === oldChatKey)) {
        throw new Error(`Group metadata verification failed: ${groupPath}`);
    }
    return verified;
}

export async function renameChatBranchFamily(root, sourcePath, destinationPath) {
    assertChatBranchFamilySafe(root, sourcePath);
    assertChatBranchFamilySafe(root, destinationPath);
    assertRegularFile(sourcePath, 'Chat family rename source');
    if (hasChatBranchFamilyCollision(destinationPath)) throw new BranchError(409, 'destination_conflict');

    const directSuffixes = ['', CHAT_METADATA_SUFFIX, CHAT_INDEX_SUFFIX, CHAT_REVISION_SUFFIX];
    const expectedDirectArtifacts = directSuffixes
        .filter(suffix => pathEntryExists(`${sourcePath}${suffix}`))
        .map(suffix => ({ suffix, sha256: sha256(fs.readFileSync(`${sourcePath}${suffix}`)) }));
    const sourceChunkDirectory = `${sourcePath}${CHAT_CHUNK_DIR_SUFFIX}`;
    const destinationChunkDirectory = `${destinationPath}${CHAT_CHUNK_DIR_SUFFIX}`;
    const expectedChunkEntries = pathEntryExists(sourceChunkDirectory)
        ? fs.readdirSync(sourceChunkDirectory).sort().map(name => ({
            name,
            sha256: sha256(fs.readFileSync(path.join(sourceChunkDirectory, name))),
        }))
        : null;
    for (const suffix of directSuffixes) {
        const sourceArtifact = `${sourcePath}${suffix}`;
        if (!pathEntryExists(sourceArtifact)) continue;
        const destinationArtifact = `${destinationPath}${suffix}`;
        if (pathEntryExists(destinationArtifact)) throw new BranchError(409, 'destination_conflict');
        fs.renameSync(sourceArtifact, destinationArtifact);
        await runChatBranchFaultPoint('after-chat-family-rename-artifact', {
            sourcePath,
            destinationPath,
            sourceArtifact,
            destinationArtifact,
        });
    }
    if (pathEntryExists(sourceChunkDirectory)) {
        if (pathEntryExists(destinationChunkDirectory)) throw new BranchError(409, 'destination_conflict');
        fs.renameSync(sourceChunkDirectory, destinationChunkDirectory);
        await runChatBranchFaultPoint('after-chat-family-rename-chunk-directory', {
            sourcePath,
            destinationPath,
            sourceArtifact: sourceChunkDirectory,
            destinationArtifact: destinationChunkDirectory,
        });
    }

    assertChatBranchFamilySafe(root, destinationPath);
    const actualDirectArtifacts = directSuffixes
        .filter(suffix => pathEntryExists(`${destinationPath}${suffix}`))
        .map(suffix => ({ suffix, sha256: sha256(fs.readFileSync(`${destinationPath}${suffix}`)) }));
    const actualChunkEntries = pathEntryExists(destinationChunkDirectory)
        ? fs.readdirSync(destinationChunkDirectory).sort().map(name => ({
            name,
            sha256: sha256(fs.readFileSync(path.join(destinationChunkDirectory, name))),
        }))
        : null;
    if (hasChatBranchFamilyCollision(sourcePath)
        || canonicalJsonStringify(expectedDirectArtifacts) !== canonicalJsonStringify(actualDirectArtifacts)
        || canonicalJsonStringify(expectedChunkEntries) !== canonicalJsonStringify(actualChunkEntries)) {
        throw new Error('Chat family rename verification failed.');
    }
}

export function createDurableGroupDeleteTransaction({ root, handle, directories, groupId, groupPath, chatPaths }) {
    const namespace = getChatBranchJournalNamespace(root, handle);
    let transactionDirectory = fs.mkdtempSync(path.join(namespace, 'tx-'));
    assertRealDirectory(transactionDirectory, namespace, 'group delete transaction directory');
    const snapshotDirectory = path.join(transactionDirectory, 'snapshot');
    fs.mkdirSync(snapshotDirectory);
    assertRealDirectory(snapshotDirectory, transactionDirectory, 'group delete snapshot directory');
    const safeGroupId = safeIdentity(String(groupId), 'groupId');
    const safeChatPaths = [...new Set(chatPaths.map(chatPath => path.resolve(chatPath)))];
    try {
        const directorySnapshots = safeChatPaths.map(chatPath => {
            const directoryPath = `${chatPath}${CHAT_CHUNK_DIR_SUFFIX}`;
            const existed = pathEntryExists(directoryPath);
            if (existed) assertRealDirectory(directoryPath, root, 'group delete chunk directory snapshot');
            assertSafePath(root, directoryPath);
            return { path: exactJournalRelative(root, directoryPath), existed };
        });
        const snapshotPaths = [groupPath, ...safeChatPaths.flatMap(chatPath => getArtifacts(chatPath))];
        const snapshots = snapshotPaths.map((filePath, index) => {
            assertSafePath(root, filePath, true);
            assertRegularFile(filePath, 'Group delete snapshot target');
            const contents = fs.readFileSync(filePath);
            const name = String(index).padStart(6, '0');
            const snapshotPath = path.join(snapshotDirectory, name);
            fs.writeFileSync(snapshotPath, contents, { flag: 'wx' });
            syncFile(snapshotPath);
            return {
                path: toJournalRelative(root, filePath),
                file: `snapshot/${name}`,
                size: contents.length,
                sha256: sha256(contents),
            };
        });
        const roots = getRecoveryRoots(root, directories);
        const chatIds = safeChatPaths.map(chatPath => withoutJsonl(path.basename(chatPath), 'chatId'));
        const manifest = {
            version: BRANCH_MANIFEST_VERSION,
            type: 'group-delete',
            id: crypto.randomUUID(),
            state: 'prepared',
            handleHash: sha256(handle),
            userRootHash: sha256(normalizePath(root)),
            storageFingerprint: getStorageFingerprint(root, handle, roots),
            groupId: safeGroupId,
            chatIds,
            paths: {
                group: toJournalRelative(root, groupPath),
                chats: safeChatPaths.map(chatPath => toJournalRelative(root, chatPath)),
            },
            snapshots,
            directorySnapshots,
        };
        writeBranchManifest(transactionDirectory, manifest);
        readGroupDeleteManifest(transactionDirectory, root, handle, directories);
    } catch (error) {
        fs.rmSync(transactionDirectory, { recursive: true, force: true });
        throw error;
    }

    return createDurableTransactionController({
        transactionDirectory,
        readTransaction: directory => readGroupDeleteManifest(directory, root, handle, directories),
        restoreTransaction: (directory, verified) => restoreGroupDeleteTransaction(directory, root, handle, directories, verified),
        syncTransaction: verified => syncDurablePostMutationState(root, directories, verified),
        label: 'Group delete',
    });
}

export function recoverChatBranchTransactions(root, handle, directories) {
    const namespace = getChatBranchJournalNamespace(root, handle, false);
    if (!pathEntryExists(namespace)) return { restored: 0, cleaned: 0 };
    assertRealDirectory(namespace, null, 'branch journal namespace');
    const result = { restored: 0, cleaned: 0 };
    for (const entry of fs.readdirSync(namespace, { withFileTypes: true })) {
        const transactionDirectory = path.join(namespace, entry.name);
        if (entry.isSymbolicLink() || !entry.isDirectory()
            || (!TRANSACTION_NAME_PATTERN.test(entry.name)
                && !FAILED_TRANSACTION_NAME_PATTERN.test(entry.name)
                && !CLEANUP_TRANSACTION_NAME_PATTERN.test(entry.name))) {
            throw new Error(`Unsafe or unknown chat branch journal entry: ${transactionDirectory}`);
        }
        if (activeBranchTransactions.has(transactionDirectory)) continue;
        assertRealDirectory(transactionDirectory, namespace, 'branch transaction directory');
        inspectTransactionArtifacts(transactionDirectory);
        const manifestPath = path.join(transactionDirectory, BRANCH_MANIFEST_FILE);
        if (CLEANUP_TRANSACTION_NAME_PATTERN.test(entry.name)) {
            if (pathEntryExists(manifestPath)) {
                const manifest = readAuthenticatedDurableManifest(transactionDirectory, root, handle, directories);
                if (!TERMINAL_TRANSACTION_STATES.has(manifest.state)) {
                    throw new Error(`Cannot recover forged nonterminal branch cleanup tombstone: ${manifest.state}`);
                }
            }
            fs.rmSync(transactionDirectory, { recursive: true, force: true });
            syncDirectory(namespace);
            result.cleaned++;
            continue;
        }
        if (!pathEntryExists(manifestPath)) {
            throw new Error(`${FAILED_TRANSACTION_NAME_PATTERN.test(entry.name) ? 'Failed transaction' : 'Transaction'} manifest is missing: ${transactionDirectory}`);
        }
        let recoveryDirectory = transactionDirectory;
        let verified = readDurableTransaction(recoveryDirectory, root, handle, directories);
        if (TERMINAL_TRANSACTION_STATES.has(verified.manifest.state)) {
            recoveryDirectory = markBranchTransactionForCleanup(
                recoveryDirectory,
                directory => readDurableTransaction(directory, root, handle, directories),
            );
            fs.rmSync(recoveryDirectory, { recursive: true, force: true });
            syncDirectory(namespace);
            result.cleaned++;
            continue;
        }
        if (TRANSACTION_NAME_PATTERN.test(entry.name)) {
            recoveryDirectory = quarantineBranchTransaction(transactionDirectory);
            verified = readDurableTransaction(recoveryDirectory, root, handle, directories);
        } else {
            activeBranchTransactions.add(recoveryDirectory);
        }
        try {
            if (verified.manifest.type === 'chat-branch') {
                restoreBranchTransaction(recoveryDirectory, root, handle, directories, verified);
            } else if (verified.manifest.type === 'group-delete') {
                restoreGroupDeleteTransaction(recoveryDirectory, root, handle, directories, verified);
            } else {
                restoreChatFamilyTransaction(recoveryDirectory, root, handle, directories, verified);
            }
            syncDurablePostMutationState(root, directories, verified);
            writeBranchManifest(recoveryDirectory, { ...verified.manifest, state: 'rolled-back' });
            const terminalDirectory = recoveryDirectory;
            recoveryDirectory = markBranchTransactionForCleanup(
                terminalDirectory,
                directory => readDurableTransaction(directory, root, handle, directories),
            );
            activeBranchTransactions.delete(terminalDirectory);
            activeBranchTransactions.add(recoveryDirectory);
            fs.rmSync(recoveryDirectory, { recursive: true, force: true });
            syncDirectory(namespace);
            result.restored++;
        } finally {
            activeBranchTransactions.delete(recoveryDirectory);
        }
    }
    return result;
}

export function ensureChatBranchRecovery(root, handle, directories) {
    const namespacePath = getChatBranchJournalNamespace(root, handle, false);
    const namespace = normalizePath(namespacePath);
    if (recoveredBranchNamespaces.has(namespace)
        && (!pathEntryExists(namespacePath) || fs.readdirSync(namespacePath).length === 0)) {
        return { restored: 0, cleaned: 0 };
    }
    recoveredBranchNamespaces.delete(namespace);
    try {
        const result = recoverChatBranchTransactions(root, handle, directories);
        if (!pathEntryExists(namespacePath) || fs.readdirSync(namespacePath).length === 0) {
            recoveredBranchNamespaces.add(namespace);
        } else {
            recoveredBranchNamespaces.delete(namespace);
        }
        return result;
    } catch (error) {
        recoveredBranchNamespaces.delete(namespace);
        throw error;
    }
}

export function resetChatBranchRecoveryForTests() {
    recoveredBranchNamespaces.clear();
    activeBranchTransactions.clear();
}

function assertRealDirectory(directoryPath, root, label) {
    const absolute = path.resolve(directoryPath);
    if (root && isOutside(root, absolute)) throw new BranchError(400, 'invalid_source');
    const stats = fs.lstatSync(absolute);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new BranchError(400, 'unsafe_path', { label });
    if (normalizePath(fs.realpathSync.native(absolute)) !== normalizePath(absolute)) {
        throw new BranchError(400, 'unsafe_path', { label });
    }
    return absolute;
}

function assertSafePath(root, candidate, requireFile = false) {
    const absolute = path.resolve(candidate);
    if (isOutside(root, absolute)) throw new BranchError(400, 'invalid_source');
    let current = root;
    for (const part of path.relative(root, absolute).split(path.sep)) {
        current = path.join(current, part);
        if (!pathEntryExists(current)) break;
        const stats = fs.lstatSync(current);
        if (stats.isSymbolicLink()) throw new BranchError(400, 'unsafe_path');
    }
    if (requireFile) {
        if (!pathEntryExists(absolute)) throw new BranchError(404, 'source_not_found');
        const stats = fs.lstatSync(absolute);
        if (!stats.isFile() || stats.isSymbolicLink()) throw new BranchError(400, 'unsafe_path');
    }
    return absolute;
}

function safeIdentity(value, label) {
    if (typeof value !== 'string' || !value || value === '.' || value === '..'
        || value.includes('/') || value.includes('\\') || sanitize(value) !== value) {
        throw new BranchError(400, 'invalid_source', { field: label });
    }
    return value;
}

function withoutJsonl(value, label) {
    const safe = safeIdentity(String(value ?? ''), label);
    return safe.toLowerCase().endsWith('.jsonl') ? safe.slice(0, -6) : safe;
}

function getArtifacts(filePath) {
    const paths = [
        filePath,
        `${filePath}${CHAT_METADATA_SUFFIX}`,
        `${filePath}${CHAT_INDEX_SUFFIX}`,
        `${filePath}${CHAT_REVISION_SUFFIX}`,
    ].filter(candidate => pathEntryExists(candidate));
    for (const artifactPath of paths) assertRegularFile(artifactPath, 'Chat branch artifact');
    const chunkDirectory = `${filePath}${CHAT_CHUNK_DIR_SUFFIX}`;
    if (pathEntryExists(chunkDirectory)) {
        assertRealDirectory(chunkDirectory, null, 'chat chunk directory');
        for (const entry of fs.readdirSync(chunkDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
            if (!entry.isFile() || entry.isSymbolicLink() || !/^\d{6}\.jsonl$/.test(entry.name)) {
                throw new BranchError(400, 'unsafe_path', { label: 'chat chunk artifact' });
            }
            const artifactPath = path.join(chunkDirectory, entry.name);
            assertRegularFile(artifactPath, 'Chat chunk artifact');
            paths.push(artifactPath);
        }
    }
    return paths;
}

export function hasChatBranchFamilyCollision(filePath) {
    return [
        filePath,
        `${filePath}${CHAT_METADATA_SUFFIX}`,
        `${filePath}${CHAT_INDEX_SUFFIX}`,
        `${filePath}${CHAT_REVISION_SUFFIX}`,
        `${filePath}${CHAT_CHUNK_DIR_SUFFIX}`,
    ].some(candidate => pathEntryExists(candidate));
}

function isChunked(filePath) {
    return pathEntryExists(`${filePath}${CHAT_INDEX_SUFFIX}`) || pathEntryExists(`${filePath}${CHAT_CHUNK_DIR_SUFFIX}`);
}

function readHeader(filePath) {
    const metadataPath = `${filePath}${CHAT_METADATA_SUFFIX}`;
    if (pathEntryExists(metadataPath)) {
        const header = tryParse(fs.readFileSync(metadataPath, 'utf8'));
        if (header && typeof header === 'object') return header;
    }
    const firstLine = fs.readFileSync(filePath, 'utf8').split('\n', 1)[0];
    const header = tryParse(firstLine);
    return header && typeof header === 'object' ? header : null;
}

function isGroupHeader(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && !value.name
        && (value.chat_metadata || (value.user_name && value.character_name)));
}

function isSoloHeader(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value)
        && !Object.hasOwn(value, 'name') && value.user_name && value.character_name);
}

function readCompleteChat(filePath, group) {
    assertSafePath(path.resolve(filePath, '..', '..'), filePath, true);
    const storedHeader = readHeader(filePath);
    const header = group
        ? (isGroupHeader(storedHeader) ? storedHeader : null)
        : (isSoloHeader(storedHeader) ? storedHeader : null);
    if (isChunked(filePath)) {
        const indexPath = `${filePath}${CHAT_INDEX_SUFFIX}`;
        const chunkDirectory = `${filePath}${CHAT_CHUNK_DIR_SUFFIX}`;
        assertRealDirectory(chunkDirectory, null, 'chunk directory');
        const index = tryParse(fs.readFileSync(indexPath, 'utf8'));
        if (!index || !Array.isArray(index.shards)) throw new BranchError(500, 'invalid_chat_index');
        const messages = [];
        for (const shard of index.shards) {
            const shardName = safeIdentity(String(shard?.file ?? ''), 'shard');
            const shardPath = assertSafePath(chunkDirectory, path.join(chunkDirectory, shardName), true);
            const lines = fs.readFileSync(shardPath, 'utf8').split('\n').filter(Boolean);
            if (lines.length !== Number(shard.count)) throw new BranchError(500, 'invalid_chat_index');
            for (const line of lines) {
                const value = tryParse(line.replace(/\r$/, ''));
                if (!value) throw new BranchError(500, 'invalid_chat_data');
                messages.push(value);
            }
        }
        if (messages.length !== Number(index.message_count)) throw new BranchError(500, 'invalid_chat_index');
        const embeddedHeaderCount = (group ? isGroupHeader(messages[0]) : isSoloHeader(messages[0])) ? 1 : 0;
        const embeddedHeader = embeddedHeaderCount ? messages.shift() : null;
        return { header: header ?? embeddedHeader, messages, chunked: true, index, embeddedHeaderCount };
    }
    const values = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map(line => {
        const value = tryParse(line.replace(/\r$/, ''));
        if (!value) throw new BranchError(500, 'invalid_chat_data');
        return value;
    });
    const embeddedHeader = values.length && (group ? isGroupHeader(values[0]) : isSoloHeader(values[0])) ? values.shift() : null;
    return { header: header ?? embeddedHeader, messages: values, chunked: false, index: null, embeddedHeaderCount: embeddedHeader ? 1 : 0 };
}

function computeRevision(filePath) {
    const revisionPath = `${filePath}${CHAT_REVISION_SUFFIX}`;
    if (pathEntryExists(revisionPath)) {
        const sidecar = tryParse(fs.readFileSync(revisionPath, 'utf8'));
        if (sidecar?.version === 1 && typeof sidecar.revision === 'string') return sidecar.revision;
        throw new BranchError(500, 'invalid_chat_revision');
    }
    const hash = crypto.createHash('sha256');
    for (const artifact of getArtifacts(filePath).filter(item => item !== revisionPath)) {
        hash.update(path.relative(path.dirname(filePath), artifact));
        hash.update('\0');
        hash.update(fs.readFileSync(artifact));
        hash.update('\0');
    }
    return `legacy-${hash.digest('hex')}`;
}

function serializeRevision(revision) {
    return JSON.stringify({ version: 1, revision });
}

function writeRevision(filePath, revision, point = null, context = {}) {
    writeFileAtomicSync(`${filePath}${CHAT_REVISION_SUFFIX}`, serializeRevision(revision), 'utf8');
    if (point) runChatBranchSynchronousFaultPoint(point, context);
}

function normalizeSendDate(value, fallback = null) {
    if (value === null || value === undefined) return fallback;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    if (typeof value === 'string') {
        const normalized = value.trim();
        const parsed = Date.parse(normalized);
        if (!Number.isNaN(parsed)) return parsed;
        const humanizedMatch = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s*@(\d{1,2})h\s+(\d{1,2})m\s+(\d{1,2})s\s+(\d{1,3})ms$/);
        if (humanizedMatch) {
            const [, year, month, day, hour, minute, second, millisecond] = humanizedMatch.map(Number);
            const humanizedTime = new Date(year, month - 1, day, hour, minute, second, millisecond).getTime();
            if (!Number.isNaN(humanizedTime)) return humanizedTime;
        }
    }
    return fallback;
}

function updateHeaderMetadata(header, messages) {
    header.chat_metadata ??= {};
    const last = messages.at(-1);
    header.chat_metadata.message_count = messages.length;
    header.chat_metadata.last_mes = normalizeSendDate(last?.send_date, normalizeSendDate(header.chat_metadata.last_mes, null));
    header.chat_metadata.last_message = typeof last?.mes === 'string' ? last.mes : '';
}

function formatShardName(index) {
    return `${String(index).padStart(6, '0')}.jsonl`;
}

function prepareDestinationWrites(filePath, header, messages, source) {
    updateHeaderMetadata(header, messages);
    if (!source.chunked) {
        return {
            chunked: false,
            entries: [
                { filePath, data: [header, ...messages].map(value => JSON.stringify(value)).join('\n'), point: 'after-destination-chat-write' },
                { filePath: `${filePath}${CHAT_METADATA_SUFFIX}`, data: JSON.stringify(header), point: 'after-destination-metadata-write' },
            ],
        };
    }
    const configuredChunkSize = Number(source.index?.chunk_size);
    const finiteChunkSize = Number.isFinite(configuredChunkSize) ? Math.trunc(configuredChunkSize) : 300;
    const chunkSize = Math.max(200, Math.min(finiteChunkSize, 500));
    const chunkDirectory = `${filePath}${CHAT_CHUNK_DIR_SUFFIX}`;
    const index = {
        version: 1,
        chunk_size: chunkSize,
        message_count: messages.length,
        last_mes: normalizeSendDate(messages.at(-1)?.send_date),
        last_message: typeof messages.at(-1)?.mes === 'string' ? messages.at(-1).mes : '',
        total_bytes: 0,
        shards: [],
    };
    const shardEntries = [];
    for (let offset = 0, shardIndex = 0; offset < messages.length; offset += chunkSize, shardIndex++) {
        const values = messages.slice(offset, offset + chunkSize);
        const name = formatShardName(shardIndex);
        const data = values.map(value => JSON.stringify(value)).join('\n');
        const size = Buffer.byteLength(data, 'utf8');
        const last = values.at(-1);
        index.total_bytes += size;
        index.shards.push({
            file: name,
            count: values.length,
            size,
            last_mes: normalizeSendDate(last?.send_date),
            last_message: typeof last?.mes === 'string' ? last.mes : '',
        });
        shardEntries.push({ filePath: path.join(chunkDirectory, name), data, point: 'after-destination-shard-write' });
    }
    return {
        chunked: true,
        chunkDirectory,
        entries: [
            ...shardEntries,
            { filePath, data: JSON.stringify(header), point: 'after-destination-chat-write' },
            { filePath: `${filePath}${CHAT_METADATA_SUFFIX}`, data: JSON.stringify(header), point: 'after-destination-metadata-write' },
            { filePath: `${filePath}${CHAT_INDEX_SUFFIX}`, data: JSON.stringify(index), point: 'after-destination-index-write' },
        ],
    };
}

function writeDestination(prepared, context) {
    const destinationPath = prepared.entries.find(entry => entry.point === 'after-destination-chat-write')?.filePath;
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    if (prepared.chunked) {
        fs.mkdirSync(prepared.chunkDirectory);
        runChatBranchSynchronousFaultPoint('after-destination-chunk-directory', context);
    }
    for (const entry of prepared.entries) {
        writeFileAtomicSync(entry.filePath, entry.data, 'utf8');
        runChatBranchSynchronousFaultPoint(entry.point, context);
    }
}

function prepareSourceUpdate(filePath, absoluteIndex, message, source) {
    if (!source.chunked) {
        const lines = fs.readFileSync(filePath, 'utf8').split('\n');
        let messageIndex = -1;
        let replaced = false;
        let firstValueSeen = false;
        for (let index = 0; index < lines.length; index++) {
            if (!lines[index]) continue;
            const value = tryParse(lines[index].replace(/\r$/, ''));
            if (!value) continue;
            if (!firstValueSeen) {
                firstValueSeen = true;
                if (source.embeddedHeaderCount) continue;
            }
            messageIndex++;
            if (messageIndex === absoluteIndex) {
                lines[index] = JSON.stringify(message);
                replaced = true;
                break;
            }
        }
        if (!replaced) throw new BranchError(500, 'source_update_failed');
        return [{ filePath, data: lines.join('\n'), point: 'after-source-chat-write' }];
    }
    const indexPath = `${filePath}${CHAT_INDEX_SUFFIX}`;
    const index = structuredClone(source.index);
    const storedIndex = absoluteIndex + Number(source.embeddedHeaderCount || 0);
    let offset = 0;
    let target = null;
    for (const shard of index.shards) {
        const end = offset + Number(shard.count);
        if (storedIndex < end) {
            target = { shard, localIndex: storedIndex - offset };
            break;
        }
        offset = end;
    }
    if (!target) throw new BranchError(500, 'source_update_failed');
    const shardPath = path.join(`${filePath}${CHAT_CHUNK_DIR_SUFFIX}`, target.shard.file);
    const lines = fs.readFileSync(shardPath, 'utf8').split('\n').filter(Boolean);
    const oldSize = fs.statSync(shardPath).size;
    lines[target.localIndex] = JSON.stringify(message);
    const shardData = lines.join('\n');
    const newSize = Buffer.byteLength(shardData, 'utf8');
    target.shard.size = newSize;
    index.total_bytes = Number(index.total_bytes) - oldSize + newSize;
    if (target.localIndex === lines.length - 1) {
        target.shard.last_mes = message.send_date ?? target.shard.last_mes;
        target.shard.last_message = typeof message.mes === 'string' ? message.mes : target.shard.last_message;
    }
    return [
        { filePath: shardPath, data: shardData, point: 'after-source-shard-write' },
        { filePath: indexPath, data: JSON.stringify(index), point: 'after-source-index-write' },
    ];
}

function updateSourceMessage(prepared, context) {
    for (const entry of prepared) {
        writeFileAtomicSync(entry.filePath, entry.data, 'utf8');
        runChatBranchSynchronousFaultPoint(entry.point, context);
    }
}

function applySwipe(message, swipeId) {
    const selected = structuredClone(message);
    const hasExplicitSwipes = Array.isArray(selected.swipes);
    const swipes = hasExplicitSwipes ? selected.swipes : [selected.mes];
    if (!Number.isInteger(swipeId) || swipeId < 0 || swipeId >= swipes.length || typeof swipes[swipeId] !== 'string') {
        throw new BranchError(400, 'invalid_swipe');
    }
    const currentSwipeId = Number.isInteger(selected.swipe_id)
        ? selected.swipe_id
        : swipes.findIndex(swipe => swipe === selected.mes);
    selected.swipes = swipes;
    selected.swipe_id = swipeId;
    selected.mes = swipes[swipeId];
    if (!hasExplicitSwipes) return selected;

    const info = Array.isArray(selected.swipe_info) ? selected.swipe_info[swipeId] : null;
    if (info && typeof info === 'object' && !Array.isArray(info)) {
        for (const field of ['send_date', 'gen_started', 'gen_finished']) selected[field] = structuredClone(info[field]);
        selected.extra = structuredClone(info.extra ?? {});
    } else if (swipeId !== currentSwipeId) {
        selected.gen_started = undefined;
        selected.gen_finished = undefined;
        selected.extra = {};
    }
    return selected;
}

function getIdempotencyPath(root, key, createDirectory = true) {
    if (typeof key !== 'string' || key.length < 1 || key.length > 256) throw new BranchError(400, 'invalid_idempotency_key');
    const directory = path.join(root, IDEMPOTENCY_DIRECTORY);
    if (!pathEntryExists(directory)) {
        if (!createDirectory) return path.join(directory, `${hashCanonicalJson(key)}.json`);
        fs.mkdirSync(directory);
    }
    assertRealDirectory(directory, root, 'idempotency directory');
    return path.join(directory, `${hashCanonicalJson(key)}.json`);
}

function readIdempotency(root, key) {
    const filePath = getIdempotencyPath(root, key, false);
    if (!pathEntryExists(filePath)) return null;
    assertSafePath(root, filePath, true);
    const record = tryParse(fs.readFileSync(filePath, 'utf8'));
    if (record?.version !== 1 || typeof record.requestDigest !== 'string' || !record.result
        || !Number.isFinite(record.createdAt)) {
        throw new BranchError(500, 'invalid_idempotency_record');
    }
    if (Date.now() - record.createdAt > IDEMPOTENCY_TTL_MS) return null;
    return { filePath, ...record };
}

function pruneIdempotency(root) {
    const directory = path.join(root, IDEMPOTENCY_DIRECTORY);
    if (!pathEntryExists(directory)) return;
    const records = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => {
            const filePath = path.join(directory, entry.name);
            return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
        }).sort((left, right) => right.mtimeMs - left.mtimeMs);
    const now = Date.now();
    for (let index = 0; index < records.length; index++) {
        if (index >= IDEMPOTENCY_MAX_RECORDS || now - records[index].mtimeMs > IDEMPOTENCY_TTL_MS) {
            fs.rmSync(records[index].filePath, { force: true });
        }
    }
}

function serializeIdempotency(requestDigest, result, createdAt) {
    return JSON.stringify({ version: 1, createdAt, requestDigest, result });
}

function writeIdempotency(root, key, expectedPath, data) {
    const filePath = getIdempotencyPath(root, key);
    if (normalizePath(filePath) !== normalizePath(expectedPath)) throw new Error('Idempotency path changed during branch write.');
    writeFileAtomicSync(filePath, data, 'utf8');
}

function calculateExactStorageGrowth(entries) {
    const seen = new Set();
    let growth = 0;
    for (const entry of entries) {
        const filePath = path.resolve(entry.filePath);
        if (seen.has(filePath)) throw new Error(`Duplicate branch write participant: ${filePath}`);
        seen.add(filePath);
        const finalSize = Buffer.isBuffer(entry.data)
            ? entry.data.length
            : Buffer.byteLength(String(entry.data), 'utf8');
        const currentSize = pathEntryExists(filePath) ? fs.statSync(filePath).size : 0;
        growth += finalSize - currentSize;
    }
    return growth;
}

function normalizeDestinationName(body) {
    const hasDestinationName = Object.hasOwn(body, 'destinationName');
    const hasPreferredName = Object.hasOwn(body, 'preferredName');
    if (!hasDestinationName && !hasPreferredName) return undefined;
    const destinationName = hasDestinationName ? body.destinationName : body.preferredName;
    if (hasDestinationName && hasPreferredName && body.destinationName !== body.preferredName) {
        throw new BranchError(400, 'invalid_destination_name');
    }
    if (typeof destinationName !== 'string' || !destinationName
        || Buffer.byteLength(destinationName, 'utf8') > DESTINATION_NAME_MAX_BYTES
        || destinationName === '.' || destinationName === '..'
        || destinationName.includes('/') || destinationName.includes('\\')
        || sanitize(destinationName) !== destinationName) {
        throw new BranchError(400, 'invalid_destination_name');
    }
    return destinationName;
}

function normalizeRequest(request) {
    const body = request.body ?? {};
    const missing = ['expectedRevision', 'expectedContentHash'].filter(field => !Object.hasOwn(body, field));
    if (missing.length) throw new BranchError(428, 'precondition_required', { missing });
    const source = body.source && typeof body.source === 'object' ? body.source : {};
    const rawType = source.type ?? source.kind ?? (source.isGroup ?? body.isGroup ? 'group' : 'solo');
    const type = rawType === 'group' ? 'group' : ['solo', 'character'].includes(rawType) ? 'solo' : null;
    if (!type) throw new BranchError(400, 'invalid_source');
    const chatId = withoutJsonl(source.chatId ?? source.chat_id ?? source.fileName ?? source.file_name
        ?? body.sourceChatId ?? body.chatId ?? body.id, 'source.chatId');
    const destinationName = normalizeDestinationName(body);
    const normalized = {
        type,
        chatId,
        absoluteMessageIndex: Number(body.absoluteMessageIndex),
        swipeId: Number(body.swipeId),
        expectedRevision: body.expectedRevision,
        expectedContentHash: body.expectedContentHash,
        idempotencyKey: body.idempotencyKey,
    };
    if (destinationName !== undefined) normalized.destinationName = destinationName;
    if (!Number.isInteger(normalized.absoluteMessageIndex) || normalized.absoluteMessageIndex < 0) {
        throw new BranchError(400, 'invalid_message_index');
    }
    if (!Number.isInteger(normalized.swipeId) || normalized.swipeId < 0) throw new BranchError(400, 'invalid_swipe');
    if (typeof normalized.idempotencyKey !== 'string' || !normalized.idempotencyKey) {
        throw new BranchError(400, 'invalid_idempotency_key');
    }
    if (type === 'group') {
        normalized.groupId = safeIdentity(String(source.groupId ?? source.group_id ?? body.groupId ?? ''), 'source.groupId');
    } else {
        const avatar = safeIdentity(String(source.avatarUrl ?? source.avatar_url ?? body.avatarUrl ?? body.avatar_url ?? ''), 'source.avatarUrl');
        normalized.avatarDirectory = avatar.toLowerCase().endsWith('.png') ? avatar.slice(0, -4) : avatar;
    }
    return normalized;
}

function resolveSource(request, normalized) {
    const root = assertRealDirectory(request.user.directories.root, null, 'user root');
    const chatsRoot = assertRealDirectory(request.user.directories.chats, root, 'chats root');
    const groupChatsRoot = assertRealDirectory(request.user.directories.groupChats, root, 'group chats root');
    const groupsRoot = assertRealDirectory(request.user.directories.groups, root, 'groups root');
    if (normalized.type === 'solo') {
        const directory = assertRealDirectory(path.join(chatsRoot, normalized.avatarDirectory), chatsRoot, 'character chats');
        const filePath = assertSafePath(root, path.join(directory, `${normalized.chatId}.jsonl`), true);
        return { root, filePath, destinationRoot: directory, group: false, groupPath: null, groupData: null };
    }
    const filePath = assertSafePath(root, path.join(groupChatsRoot, `${normalized.chatId}.jsonl`), true);
    const groupPath = assertSafePath(root, path.join(groupsRoot, `${normalized.groupId}.json`), true);
    const groupData = tryParse(fs.readFileSync(groupPath, 'utf8'));
    if (!groupData || String(groupData.id) !== normalized.groupId || !Array.isArray(groupData.chats)
        || !groupData.chats.some(chatId => String(chatId) === normalized.chatId)) {
        throw new BranchError(400, 'invalid_source');
    }
    return { root, filePath, destinationRoot: groupChatsRoot, group: true, groupPath, groupData };
}

function makeDestinationId(destinationRoot, absoluteIndex, destinationName) {
    if (destinationName !== undefined) {
        return getUniqueName(destinationName, name => hasChatBranchFamilyCollision(path.join(destinationRoot, `${name}.jsonl`)));
    }
    const base = sanitize(`Branch #${absoluteIndex} - ${humanizedDateTime()}`) || `Branch-${absoluteIndex}`;
    for (let attempt = 0; attempt < 20; attempt++) {
        const id = attempt === 0 ? base : `${base}-${crypto.randomUUID().slice(0, 8)}`;
        if (!hasChatBranchFamilyCollision(path.join(destinationRoot, `${id}.jsonl`))) return id;
    }
    throw new BranchError(409, 'destination_conflict');
}

export function getChatContentHash(header, messages) {
    return hashCanonicalJson([header ?? null, ...(Array.isArray(messages) ? messages : [])]);
}

export async function executeChatBranch(request, hooks = {}) {
    let normalized;
    try {
        normalized = normalizeRequest(request);
        const root = assertRealDirectory(request.user.directories.root, null, 'user root');
        const handle = String(request.user?.profile?.handle ?? '');
        if (!handle) throw new TypeError('Authenticated user handle is required.');
        const requestDigest = hashCanonicalJson(normalized);
        const runWithStorageLocks = hooks.runWithStorageLocks;
        if (typeof runWithStorageLocks !== 'function') {
            throw new TypeError('Chat branch storage lock adapter is required.');
        }
        return await runWithStorageLocks([getChatBranchUserLockPath(root)], async () => {
            ensureChatBranchRecovery(root, handle, request.user.directories);
            const initialSource = resolveSource(request, normalized);
            const destinationId = makeDestinationId(
                initialSource.destinationRoot,
                normalized.absoluteMessageIndex,
                normalized.destinationName,
            );
            const destinationPath = assertSafePath(root, path.join(initialSource.destinationRoot, `${destinationId}.jsonl`));
            const idempotencyPath = getIdempotencyPath(root, normalized.idempotencyKey, false);
            const lockPaths = [initialSource.filePath, destinationPath, idempotencyPath];
            if (initialSource.groupPath) lockPaths.push(initialSource.groupPath);
            return await runWithStorageLocks(lockPaths, async () => {
                const replay = readIdempotency(root, normalized.idempotencyKey);
                if (replay) {
                    if (replay.requestDigest !== requestDigest) throw new BranchError(409, 'idempotency_mismatch');
                    return { status: 200, body: replay.result };
                }
                const source = resolveSource(request, normalized);
                if (normalizePath(source.filePath) !== normalizePath(initialSource.filePath)
                || normalizePath(source.groupPath ?? root) !== normalizePath(initialSource.groupPath ?? root)
                || hasChatBranchFamilyCollision(destinationPath)) {
                    throw new BranchError(409, 'source_or_destination_changed');
                }
                const complete = readCompleteChat(source.filePath, source.group);
                const currentRevision = computeRevision(source.filePath);
                const currentContentHash = getChatContentHash(complete.header, complete.messages);
                if (normalized.expectedRevision !== currentRevision) {
                    throw new BranchError(409, 'revision_conflict', { currentRevision, currentContentHash });
                }
                if (normalized.expectedContentHash !== currentContentHash) {
                    throw new BranchError(409, 'content_conflict', { currentRevision, currentContentHash });
                }
                const sourceMessage = complete.messages[normalized.absoluteMessageIndex];
                if (!sourceMessage) throw new BranchError(400, 'invalid_message_index');
                const destinationMessage = applySwipe(sourceMessage, normalized.swipeId);
                const updatedSourceMessage = structuredClone(sourceMessage);
                updatedSourceMessage.extra = updatedSourceMessage.extra && typeof updatedSourceMessage.extra === 'object'
                    ? structuredClone(updatedSourceMessage.extra)
                    : {};
                const branches = Array.isArray(updatedSourceMessage.extra.branches) ? [...updatedSourceMessage.extra.branches] : [];
                if (!branches.includes(destinationId)) branches.push(destinationId);
                updatedSourceMessage.extra.branches = branches;
                const updatedSourceMessages = complete.messages.map((message, index) => index === normalized.absoluteMessageIndex
                    ? updatedSourceMessage
                    : message);
                const sourceContentHash = getChatContentHash(complete.header, updatedSourceMessages);
                const destinationMessages = complete.messages.slice(0, normalized.absoluteMessageIndex)
                    .map(message => structuredClone(message));
                destinationMessages.push(destinationMessage);
                const destinationHeader = structuredClone(complete.header ?? {
                    user_name: source.group ? 'unused' : request.user.profile.name,
                    character_name: source.group ? 'unused' : normalized.avatarDirectory,
                    chat_metadata: {},
                });
                destinationHeader.chat_metadata ??= {};
                destinationHeader.chat_metadata.main_chat = complete.header?.chat_metadata?.main_chat ?? normalized.chatId;
                updateHeaderMetadata(destinationHeader, destinationMessages);
                const destinationRevision = crypto.randomUUID();
                const destinationContentHash = getChatContentHash(destinationHeader, destinationMessages);
                const sourceRevision = crypto.randomUUID();
                const result = {
                    ok: true,
                    chatId: destinationId,
                    fileName: destinationId,
                    branchChatId: destinationId,
                    groupId: normalized.groupId ?? null,
                    revision: destinationRevision,
                    contentHash: destinationContentHash,
                    sourceRevision,
                    sourceContentHash,
                };
                const destinationWrites = prepareDestinationWrites(destinationPath, destinationHeader, destinationMessages, complete);
                const sourceWrites = prepareSourceUpdate(
                    source.filePath,
                    normalized.absoluteMessageIndex,
                    updatedSourceMessage,
                    complete,
                );
                let groupWrite = null;
                if (source.groupPath) {
                    const latestGroupData = structuredClone(source.groupData);
                    if (!latestGroupData || String(latestGroupData.id) !== normalized.groupId
                        || !Array.isArray(latestGroupData.chats)
                        || !latestGroupData.chats.some(chatId => String(chatId) === normalized.chatId)) {
                        throw new BranchError(409, 'source_or_destination_changed');
                    }
                    if (!latestGroupData.chats.some(chatId => String(chatId) === destinationId)) {
                        latestGroupData.chats.push(destinationId);
                    }
                    groupWrite = { filePath: source.groupPath, data: JSON.stringify(latestGroupData, null, 4) };
                }
                const idempotencyCreatedAt = Date.now();
                const idempotencyData = serializeIdempotency(requestDigest, result, idempotencyCreatedAt);
                const exactGrowth = calculateExactStorageGrowth([
                    ...destinationWrites.entries,
                    { filePath: `${destinationPath}${CHAT_REVISION_SUFFIX}`, data: serializeRevision(destinationRevision) },
                    ...sourceWrites,
                    { filePath: `${source.filePath}${CHAT_REVISION_SUFFIX}`, data: serializeRevision(sourceRevision) },
                    ...(groupWrite ? [groupWrite] : []),
                    { filePath: idempotencyPath, data: idempotencyData },
                ]);
                const quota = await canConsumeStorage(request.user.profile, request.user.directories, exactGrowth);
                if (!quota.allowed) {
                    throw new BranchError(403, 'storage_limit', {
                        message: '存储空间不足，无法创建聊天分支。',
                        usedBytes: quota.usedBytes,
                        limitBytes: quota.limitBytes,
                        remainingBytes: quota.remainingBytes,
                    });
                }
                const transaction = createBranchTransaction({
                    root,
                    handle,
                    directories: request.user.directories,
                    sourcePath: source.filePath,
                    destinationPath,
                    groupPath: source.groupPath,
                    normalized,
                    destinationId,
                    idempotencyPath,
                });
                const faultContext = { source: normalized, destinationPath };
                try {
                    transaction.markMutating();
                    await runChatBranchFaultPoint('after-journal-mutating', faultContext);
                    writeDestination(destinationWrites, faultContext);
                    writeRevision(destinationPath, destinationRevision, 'after-destination-revision-write', faultContext);
                    await runChatBranchFaultPoint('after-destination-publish', faultContext);

                    updateSourceMessage(sourceWrites, faultContext);
                    writeRevision(source.filePath, sourceRevision, 'after-source-revision-write', faultContext);
                    await runChatBranchFaultPoint('after-source-update', faultContext);

                    if (groupWrite) {
                        writeFileAtomicSync(groupWrite.filePath, groupWrite.data, 'utf8');
                        await runChatBranchFaultPoint('after-group-update', faultContext);
                    }
                    writeIdempotency(root, normalized.idempotencyKey, idempotencyPath, idempotencyData);
                    await runChatBranchFaultPoint('after-idempotency-update', faultContext);
                    await runChatBranchFaultPoint('before-commit', faultContext);
                    transaction.markCommitted();
                    await runChatBranchFaultPoint('after-commit-marker', faultContext);
                    transaction.cleanup();
                    try {
                        pruneIdempotency(root);
                    } catch (error) {
                        console.warn('Failed to prune chat branch idempotency records:', error);
                    }
                } catch (error) {
                    transaction.rollback();
                    throw error;
                }
                hooks.onCommitted?.({ sourcePath: source.filePath, destinationPath, result, group: source.group });
                return { status: 201, body: result };
            });
        });
    } catch (error) {
        if (error instanceof BranchError) {
            return { status: error.status, body: { error: error.code, ...error.details } };
        }
        throw error;
    }
}

export async function runChatBranchFaultPoint(point, context = {}) {
    await faultInjector?.(point, context);
}

function runChatBranchSynchronousFaultPoint(point, context = {}) {
    const result = faultInjector?.(point, context);
    if (result && typeof result.catch === 'function') result.catch(() => {});
}

export function setChatBranchFaultInjectorForTests(injector) {
    if (injector !== null && typeof injector !== 'function') throw new TypeError('Fault injector must be a function or null.');
    faultInjector = injector;
}
