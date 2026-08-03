import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { canonicalJsonStringify, hashCanonicalJson, sha256 } from './canonical-hash.js';

const JOURNAL_PARENT = '.character-chat-journals';
const MANIFEST_FILE = 'manifest.json';
const TRANSACTION_PATTERN = /^tx-[A-Za-z0-9]{6}$/;
const FAILED_PATTERN = /^failed-[A-Za-z0-9]{6}$/;
const CLEANUP_PATTERN = /^cleanup-[a-f0-9]{32}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const VALID_STATES = new Set(['prepared', 'mutating', 'committed', 'rolled-back']);
const TERMINAL_STATES = new Set(['committed', 'rolled-back']);
const MAX_TRANSACTION_ENTRIES = 10_000;
const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set([
    'EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM',
]);
const LINK_COPY_FALLBACK_CODES = new Set(['EACCES', 'EINVAL', 'EMLINK', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV']);
const activeTransactions = new Set();

function normalized(value) {
    const result = path.normalize(path.resolve(value));
    return process.platform === 'win32' ? result.toLowerCase() : result;
}

function exists(filePath) {
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

function realDirectory(directoryPath, parent, label) {
    const absolute = path.resolve(directoryPath);
    if (parent && isOutside(parent, absolute)) throw new Error(`${label} is outside the authenticated user root.`);
    const stats = fs.lstatSync(absolute);
    if (!stats.isDirectory() || stats.isSymbolicLink()
        || normalized(fs.realpathSync.native(absolute)) !== normalized(absolute)) {
        throw new Error(`${label} must be an exact real directory without symbolic links.`);
    }
    return absolute;
}

function contextFor(root, handle, directories) {
    if (typeof handle !== 'string' || !handle) throw new TypeError('Authenticated user handle is required.');
    if (!directories || typeof directories !== 'object') throw new TypeError('Authenticated user directories are required.');
    const exactRoot = realDirectory(root, null, 'User root');
    if (directories.root && normalized(directories.root) !== normalized(exactRoot)) {
        throw new Error('Authenticated directory root does not match the exact user root.');
    }
    const characters = realDirectory(directories.characters, exactRoot, 'Characters root');
    const chats = realDirectory(directories.chats, exactRoot, 'Chats root');
    const handleHash = sha256(handle);
    const rootHash = sha256(normalized(exactRoot));
    return {
        root: exactRoot,
        characters,
        chats,
        handleHash,
        rootHash,
        storageHash: hashCanonicalJson({
            root: normalized(exactRoot),
            characters: normalized(characters),
            chats: normalized(chats),
            handleHash,
        }),
        namespace: path.join(
            path.dirname(exactRoot),
            JOURNAL_PARENT,
            sha256(`${handle}\0${normalized(exactRoot)}`),
        ),
    };
}

function prepareNamespace(context) {
    const parent = path.dirname(context.namespace);
    if (!exists(parent)) {
        fs.mkdirSync(parent);
        syncDirectory(path.dirname(parent));
        syncDirectory(parent);
    }
    realDirectory(parent, null, 'Character/chat journal parent');
    if (!exists(context.namespace)) {
        fs.mkdirSync(context.namespace);
        syncDirectory(parent);
        syncDirectory(context.namespace);
    }
    realDirectory(context.namespace, parent, 'Character/chat journal namespace');
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

function syncFile(filePath) {
    const descriptor = fs.openSync(filePath, 'r+');
    try {
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

function writeManifest(transactionDirectory, manifest) {
    const signed = { ...manifest, digest: hashCanonicalJson(manifest) };
    const manifestPath = path.join(transactionDirectory, MANIFEST_FILE);
    writeFileAtomicSync(manifestPath, canonicalJsonStringify(signed), 'utf8');
    syncFile(manifestPath);
    syncDirectory(transactionDirectory);
}

function relativeToRoot(root, candidate) {
    const absolute = path.resolve(candidate);
    if (isOutside(root, absolute)) throw new Error('Character/chat path escapes the exact user root.');
    return path.relative(root, absolute).split(path.sep).join('/');
}

function fromRelative(root, relative, label) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\')) {
        throw new Error(`Invalid ${label} in character/chat journal.`);
    }
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) {
        throw new Error(`Invalid ${label} in character/chat journal.`);
    }
    const absolute = path.resolve(root, ...parts);
    if (isOutside(root, absolute)) throw new Error(`${label} escapes the exact user root.`);
    return absolute;
}

function directTarget(storageRoot, candidate, label) {
    if (candidate === null || candidate === undefined) return null;
    if (typeof candidate !== 'string' || !candidate) throw new TypeError(`${label} must be a path or null.`);
    const absolute = path.resolve(candidate);
    if (normalized(path.dirname(absolute)) !== normalized(storageRoot)) {
        throw new Error(`${label} must be a direct child of its authenticated storage root.`);
    }
    if (exists(absolute) && fs.lstatSync(absolute).isSymbolicLink()) {
        throw new Error(`${label} must not be a symbolic link.`);
    }
    return absolute;
}

function operationPaths(context, operation, supplied) {
    if (!['rename', 'delete'].includes(operation)) throw new TypeError(`Unsupported operation: ${operation}`);
    const paths = {
        oldCard: directTarget(context.characters, supplied.oldCardPath, 'Old card path'),
        newCard: directTarget(context.characters, supplied.newCardPath, 'New card path'),
        oldChats: directTarget(context.chats, supplied.oldChatsPath, 'Old chats path'),
        newChats: directTarget(context.chats, supplied.newChatsPath, 'New chats path'),
    };
    if (!paths.oldCard) throw new TypeError('Old card path is required.');
    if (operation === 'rename' && !paths.newCard) throw new TypeError('New card path is required for rename.');
    if (operation === 'rename' && Boolean(paths.oldChats) !== Boolean(paths.newChats)) {
        throw new TypeError('Rename chat paths must both be provided or both be null.');
    }
    if (operation === 'delete' && (paths.newCard || paths.newChats)) {
        throw new TypeError('Delete transactions cannot have destination paths.');
    }
    if (operation === 'rename' && (exists(paths.newCard) || (paths.newChats && exists(paths.newChats)))) {
        throw new Error('Rename destination paths must be absent when the transaction is created.');
    }
    const keys = Object.values(paths).filter(Boolean).map(normalized);
    if (new Set(keys).size !== keys.length) throw new Error('Character/chat transaction paths must be distinct.');
    return paths;
}

function validateTreePath(value, allowEmpty, label) {
    if (typeof value !== 'string' || value.includes('\\') || (!allowEmpty && !value)) {
        throw new Error(`Invalid ${label} in character/chat journal.`);
    }
    if (!value && allowEmpty) return;
    if (value.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error(`Invalid ${label} in character/chat journal.`);
    }
}

function accountEntries(budget, count = 1) {
    budget.value += count;
    if (budget.value > MAX_TRANSACTION_ENTRIES) {
        throw new Error(`Character/chat transaction has too many filesystem entries (maximum ${MAX_TRANSACTION_ENTRIES}).`);
    }
}

function syncTargetTree(targetPath, expectedKind, budget) {
    accountEntries(budget);
    let rootStats;
    try {
        rootStats = fs.lstatSync(targetPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    if (rootStats.isSymbolicLink()) throw new Error(`Symbolic link rejected: ${targetPath}`);
    if (rootStats.isFile()) {
        if (expectedKind !== 'file') throw new Error(`Chat target must be a directory: ${targetPath}`);
        syncFile(targetPath);
        return;
    }
    if (!rootStats.isDirectory() || expectedKind !== 'directory') {
        throw new Error(`Unsupported character/chat filesystem entry: ${targetPath}`);
    }

    const visit = directoryPath => {
        const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
        accountEntries(budget, entries.length);
        for (const entry of entries) {
            const entryPath = path.join(directoryPath, entry.name);
            const stats = fs.lstatSync(entryPath);
            if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
                throw new Error(`Symbolic link rejected: ${entryPath}`);
            }
            if (stats.isFile()) {
                syncFile(entryPath);
            } else if (stats.isDirectory()) {
                visit(entryPath);
            } else {
                throw new Error(`Only regular files and directories can be synced: ${entryPath}`);
            }
        }
        syncDirectory(directoryPath);
    };
    visit(targetPath);
}

function syncPostMutationState(context, targets) {
    const budget = { value: 0 };
    for (const target of targets) {
        syncTargetTree(target.targetPath, target.rootType === 'characters' ? 'file' : 'directory', budget);
    }
    realDirectory(context.characters, context.root, 'Characters root');
    realDirectory(context.chats, context.root, 'Chats root');
    syncDirectory(context.characters);
    syncDirectory(context.chats);
}

function scanTree(targetPath, expectedKind, budget = { value: 0 }) {
    accountEntries(budget);
    if (!exists(targetPath)) return { kind: 'absent', directories: [], files: [] };
    const rootStats = fs.lstatSync(targetPath);
    if (rootStats.isSymbolicLink()) throw new Error(`Symbolic link rejected: ${targetPath}`);
    if (rootStats.isFile()) {
        if (expectedKind !== 'file') throw new Error(`Chat target must be a directory: ${targetPath}`);
        const contents = fs.readFileSync(targetPath);
        return {
            kind: 'file',
            directories: [],
            files: [{ path: '', mode: rootStats.mode, size: contents.length, sha256: sha256(contents) }],
        };
    }
    if (!rootStats.isDirectory() || expectedKind !== 'directory') {
        throw new Error(`Unsupported character/chat filesystem entry: ${targetPath}`);
    }
    const directories = [{ path: '', mode: rootStats.mode }];
    const files = [];
    const visit = (directoryPath, relativeDirectory) => {
        const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
        accountEntries(budget, entries.length);
        for (const entry of entries) {
            const entryPath = path.join(directoryPath, entry.name);
            const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
            const stats = fs.lstatSync(entryPath);
            if (entry.isSymbolicLink() || stats.isSymbolicLink()) throw new Error(`Symbolic link rejected: ${entryPath}`);
            if (stats.isDirectory()) {
                directories.push({ path: relative, mode: stats.mode });
                visit(entryPath, relative);
            } else if (stats.isFile()) {
                const contents = fs.readFileSync(entryPath);
                files.push({ path: relative, mode: stats.mode, size: contents.length, sha256: sha256(contents) });
            } else {
                throw new Error(`Only regular files and directories can be snapshotted: ${entryPath}`);
            }
        }
    };
    visit(targetPath, '');
    return { kind: 'directory', directories, files };
}

function assertCopySpace(directoryPath, size) {
    let filesystem;
    try {
        filesystem = fs.statfsSync(directoryPath, { bigint: true });
    } catch (error) {
        throw new Error(`Unable to verify free space for character/chat snapshot copy: ${directoryPath}`, { cause: error });
    }
    const available = globalThis.BigInt(filesystem.bavail) * globalThis.BigInt(filesystem.bsize);
    if (available < globalThis.BigInt(size)) {
        const error = new Error(`Insufficient free space for character/chat snapshot copy: ${directoryPath}`);
        error.code = 'ENOSPC';
        throw error;
    }
}

function snapshotFile(source, snapshotPath, size) {
    try {
        fs.linkSync(source, snapshotPath);
    } catch (error) {
        if (!LINK_COPY_FALLBACK_CODES.has(error?.code)) throw error;
        assertCopySpace(path.dirname(snapshotPath), size);
        fs.copyFileSync(source, snapshotPath, fs.constants.COPYFILE_EXCL);
    }
    syncFile(snapshotPath);
}

function snapshotTarget(transactionDirectory, targetPath, role, rootType, sequence, budget) {
    const tree = scanTree(targetPath, rootType === 'characters' ? 'file' : 'directory', budget);
    return {
        role,
        rootType,
        path: targetPath,
        kind: tree.kind,
        directories: tree.directories,
        files: tree.files.map(file => {
            const name = String(sequence.value++).padStart(6, '0');
            const source = file.path ? path.join(targetPath, ...file.path.split('/')) : targetPath;
            const snapshotPath = path.join(transactionDirectory, 'snapshot', name);
            snapshotFile(source, snapshotPath, file.size);
            return { ...file, snapshot: `snapshot/${name}` };
        }),
    };
}

function inspectJournal(transactionDirectory) {
    const snapshotDirectory = path.join(transactionDirectory, 'snapshot');
    let removedTemporary = false;
    for (const entry of fs.readdirSync(transactionDirectory, { withFileTypes: true })) {
        const entryPath = path.join(transactionDirectory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Unsafe journal artifact: ${entryPath}`);
        if (entry.name === MANIFEST_FILE && entry.isFile()) continue;
        if (entry.name === 'snapshot' && entry.isDirectory()) continue;
        if (entry.name.startsWith(`${MANIFEST_FILE}.`)
            && /^\d+$/.test(entry.name.slice(MANIFEST_FILE.length + 1)) && entry.isFile()) {
            fs.rmSync(entryPath, { force: true });
            removedTemporary = true;
            continue;
        }
        throw new Error(`Unknown character/chat journal artifact: ${entryPath}`);
    }
    if (removedTemporary) syncDirectory(transactionDirectory);
    if (!exists(snapshotDirectory)) return;
    realDirectory(snapshotDirectory, transactionDirectory, 'Snapshot directory');
    for (const entry of fs.readdirSync(snapshotDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || !/^\d{6}$/.test(entry.name)) {
            throw new Error(`Unsafe character/chat snapshot artifact: ${entry.name}`);
        }
    }
}

function assertTransactionDirectory(transactionDirectory, context) {
    const name = path.basename(transactionDirectory);
    if ((!TRANSACTION_PATTERN.test(name) && !FAILED_PATTERN.test(name))
        || normalized(path.dirname(transactionDirectory)) !== normalized(context.namespace)) {
        throw new Error('Invalid character/chat transaction directory.');
    }
    realDirectory(transactionDirectory, context.namespace, 'Transaction directory');
}

function assertCleanupDirectory(cleanupDirectory, context) {
    if (!CLEANUP_PATTERN.test(path.basename(cleanupDirectory))
        || normalized(path.dirname(cleanupDirectory)) !== normalized(context.namespace)) {
        throw new Error('Invalid character/chat cleanup tombstone.');
    }
    realDirectory(cleanupDirectory, context.namespace, 'Cleanup tombstone');
}

function readManifest(transactionDirectory, context) {
    if (CLEANUP_PATTERN.test(path.basename(transactionDirectory))) {
        assertCleanupDirectory(transactionDirectory, context);
    } else {
        assertTransactionDirectory(transactionDirectory, context);
    }
    const manifestPath = path.join(transactionDirectory, MANIFEST_FILE);
    const stats = fs.lstatSync(manifestPath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Manifest must be a regular file.');
    const signed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const { digest, ...manifest } = signed;
    if (manifest.version !== 1 || manifest.type !== 'character-chat'
        || !['rename', 'delete'].includes(manifest.operation)
        || !VALID_STATES.has(manifest.state)
        || typeof manifest.id !== 'string' || !manifest.id
        || manifest.handleHash !== context.handleHash || manifest.userRootHash !== context.rootHash
        || manifest.storageHash !== context.storageHash || !HASH_PATTERN.test(String(digest ?? ''))
        || hashCanonicalJson(manifest) !== digest || !manifest.paths || !Array.isArray(manifest.targets)) {
        throw new Error(`Invalid, tampered, or cross-user character/chat manifest: ${manifestPath}`);
    }
    return manifest;
}

function readTransaction(transactionDirectory, context, suppliedManifest = null) {
    const manifest = suppliedManifest ?? readManifest(transactionDirectory, context);
    inspectJournal(transactionDirectory);
    const rolePaths = manifest.paths;
    const roles = manifest.operation === 'rename'
        ? ['oldCard', 'newCard', ...(rolePaths.oldChats === null ? [] : ['oldChats', 'newChats'])]
        : ['oldCard', ...(rolePaths.oldChats === null ? [] : ['oldChats'])];
    if (Object.keys(rolePaths).sort().join(',') !== 'newCard,newChats,oldCard,oldChats'
        || rolePaths.oldCard === null || (manifest.operation === 'rename' && rolePaths.newCard === null)
        || (manifest.operation === 'rename' && Boolean(rolePaths.oldChats) !== Boolean(rolePaths.newChats))
        || (manifest.operation === 'delete' && (rolePaths.newCard !== null || rolePaths.newChats !== null))
        || manifest.targets.length !== roles.length) {
        throw new Error('Invalid operation paths in character/chat manifest.');
    }
    const targetKeys = new Set();
    const snapshotNames = new Set();
    const entryBudget = { value: 0 };
    let snapshotIndex = 0;
    const targets = manifest.targets.map((target, targetIndex) => {
        const role = roles[targetIndex];
        const targetPath = fromRelative(context.root, target.path, role);
        const rootType = role.endsWith('Card') ? 'characters' : 'chats';
        const storageRoot = rootType === 'characters' ? context.characters : context.chats;
        if (target.role !== role || target.rootType !== rootType || rolePaths[role] !== target.path
            || normalized(path.dirname(targetPath)) !== normalized(storageRoot)
            || targetKeys.has(normalized(targetPath)) || !['absent', 'file', 'directory'].includes(target.kind)
            || (rootType === 'characters' && target.kind === 'directory')
            || (rootType === 'chats' && target.kind === 'file')
            || !Array.isArray(target.directories) || !Array.isArray(target.files)) {
            throw new Error('Target does not match authenticated character/chat storage roots.');
        }
        accountEntries(entryBudget, Math.max(1, target.directories.length + target.files.length));
        targetKeys.add(normalized(targetPath));
        const treePaths = new Set();
        const directories = target.directories.map(directory => {
            validateTreePath(directory?.path, true, 'directory path');
            if (!Number.isSafeInteger(directory.mode) || treePaths.has(directory.path)) {
                throw new Error('Invalid directory snapshot in character/chat manifest.');
            }
            treePaths.add(directory.path);
            return directory;
        });
        const files = target.files.map(file => {
            validateTreePath(file?.path, target.kind === 'file', 'file path');
            const expectedSnapshot = `snapshot/${String(snapshotIndex++).padStart(6, '0')}`;
            if (file.snapshot !== expectedSnapshot || snapshotNames.has(file.snapshot)
                || treePaths.has(file.path) || !Number.isSafeInteger(file.mode)
                || !Number.isSafeInteger(file.size) || file.size < 0
                || !HASH_PATTERN.test(String(file.sha256 ?? ''))) {
                throw new Error('Invalid file snapshot in character/chat manifest.');
            }
            snapshotNames.add(file.snapshot);
            treePaths.add(file.path);
            const snapshotPath = path.join(transactionDirectory, ...file.snapshot.split('/'));
            if (!exists(snapshotPath)) throw new Error(`Missing character/chat snapshot artifact: ${snapshotPath}`);
            const snapshotStats = fs.lstatSync(snapshotPath);
            if (!snapshotStats.isFile() || snapshotStats.isSymbolicLink()) throw new Error('Unsafe snapshot file.');
            return { ...file, snapshotPath };
        });
        if ((target.kind === 'absent' && (directories.length || files.length))
            || (target.kind === 'file' && (directories.length || files.length !== 1 || files[0].path !== ''))
            || (target.kind === 'directory' && (!directories.some(item => item.path === '')
                || files.some(item => item.path === '')))) {
            throw new Error('Inconsistent character/chat snapshot tree.');
        }
        return { ...target, targetPath, directories, files };
    });
    const snapshotDirectory = path.join(transactionDirectory, 'snapshot');
    if (!exists(snapshotDirectory)) throw new Error('Character/chat snapshot directory is missing.');
    const actualSnapshots = fs.readdirSync(snapshotDirectory).sort();
    const expectedSnapshots = [...snapshotNames].map(name => path.basename(name)).sort();
    if (canonicalJsonStringify(actualSnapshots) !== canonicalJsonStringify(expectedSnapshots)) {
        throw new Error('Unknown or missing character/chat snapshot artifact.');
    }
    return { manifest, targets };
}

function applyMode(filePath, mode) {
    try {
        fs.chmodSync(filePath, mode);
    } catch (error) {
        if (process.platform !== 'win32') throw error;
    }
}

function temporaryPath(targetPath, id) {
    return `${targetPath}.character-chat-recovery-${id}.tmp`;
}

function removeTemporary(targetPath, id) {
    const temporary = temporaryPath(targetPath, id);
    if (!exists(temporary)) return;
    const stats = fs.lstatSync(temporary);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Unsafe recovery temporary file: ${temporary}`);
    fs.rmSync(temporary, { force: true });
    syncDirectory(path.dirname(temporary));
}

function restoreTarget(target, id) {
    if (target.kind === 'absent') return;
    if (target.kind === 'file') {
        const file = target.files[0];
        const temporary = temporaryPath(target.targetPath, id);
        fs.copyFileSync(file.snapshotPath, temporary, fs.constants.COPYFILE_EXCL);
        applyMode(temporary, file.mode);
        syncFile(temporary);
        fs.renameSync(temporary, target.targetPath);
        syncDirectory(path.dirname(target.targetPath));
        return;
    }
    const directories = [...target.directories].sort((left, right) => {
        const depth = left.path.split('/').length - right.path.split('/').length;
        return depth || left.path.localeCompare(right.path);
    });
    for (const directory of directories) {
        const destination = directory.path
            ? path.join(target.targetPath, ...directory.path.split('/'))
            : target.targetPath;
        fs.mkdirSync(destination);
        applyMode(destination, directory.mode);
        syncDirectory(path.dirname(destination));
        syncDirectory(destination);
    }
    for (const file of target.files) {
        const destination = path.join(target.targetPath, ...file.path.split('/'));
        const temporary = temporaryPath(destination, id);
        fs.copyFileSync(file.snapshotPath, temporary, fs.constants.COPYFILE_EXCL);
        applyMode(temporary, file.mode);
        syncFile(temporary);
        fs.renameSync(temporary, destination);
        syncDirectory(path.dirname(destination));
    }
}

function comparable(tree) {
    return {
        kind: tree.kind,
        directories: tree.directories.map(item => item.path),
        files: tree.files.map(item => ({ path: item.path, size: item.size, sha256: item.sha256 })),
    };
}

function restoreTransaction(transactionDirectory, context, supplied = null) {
    const { manifest, targets } = supplied ?? readTransaction(transactionDirectory, context);
    for (const target of targets) {
        for (const file of target.files) {
            const contents = fs.readFileSync(file.snapshotPath);
            if (contents.length !== file.size || sha256(contents) !== file.sha256) {
                throw new Error(`Snapshot checksum mismatch: ${file.snapshotPath}`);
            }
        }
    }
    for (const target of targets) {
        scanTree(target.targetPath, target.rootType === 'characters' ? 'file' : 'directory');
        removeTemporary(target.targetPath, manifest.id);
    }
    for (const target of targets) {
        if (exists(target.targetPath)) {
            fs.rmSync(target.targetPath, { recursive: true, force: true });
            syncDirectory(path.dirname(target.targetPath));
        }
    }
    for (const target of targets) restoreTarget(target, manifest.id);
    for (const target of targets) {
        const actual = scanTree(target.targetPath, target.rootType === 'characters' ? 'file' : 'directory');
        if (canonicalJsonStringify(comparable(actual)) !== canonicalJsonStringify(comparable(target))) {
            throw new Error(`Character/chat restoration was inexact: ${target.targetPath}`);
        }
    }
}

function transition(transactionDirectory, context, expected, next) {
    const { manifest } = readTransaction(transactionDirectory, context);
    if (manifest.state !== expected) throw new Error(`Invalid transaction transition: ${manifest.state} -> ${next}`);
    writeManifest(transactionDirectory, { ...manifest, state: next });
}

function markRolledBack(transactionDirectory, context) {
    const { manifest } = readTransaction(transactionDirectory, context);
    if (!['prepared', 'mutating'].includes(manifest.state)) {
        throw new Error(`Invalid transaction rollback terminal state: ${manifest.state}`);
    }
    writeManifest(transactionDirectory, { ...manifest, state: 'rolled-back' });
}

function markForCleanup(transactionDirectory, context) {
    assertTransactionDirectory(transactionDirectory, context);
    const { state } = readManifest(transactionDirectory, context);
    if (!TERMINAL_STATES.has(state)) {
        throw new Error(`Cannot clean up nonterminal character/chat transaction: ${state}`);
    }
    const cleanupDirectory = path.join(context.namespace, `cleanup-${crypto.randomBytes(16).toString('hex')}`);
    if (!CLEANUP_PATTERN.test(path.basename(cleanupDirectory)) || exists(cleanupDirectory)) {
        throw new Error('Character/chat cleanup tombstone already exists or is invalid.');
    }
    fs.renameSync(transactionDirectory, cleanupDirectory);
    syncDirectory(context.namespace);
    return cleanupDirectory;
}

function quarantine(transactionDirectory, context) {
    const name = path.basename(transactionDirectory);
    if (!TRANSACTION_PATTERN.test(name)) return transactionDirectory;
    const failedDirectory = path.join(context.namespace, `failed-${name.slice(3)}`);
    if (exists(failedDirectory)) throw new Error('Character/chat recovery quarantine already exists.');
    activeTransactions.delete(transactionDirectory);
    fs.renameSync(transactionDirectory, failedDirectory);
    syncDirectory(context.namespace);
    return failedDirectory;
}

export function getCharacterChatJournalNamespace(root, handle, directories) {
    return contextFor(root, handle, directories).namespace;
}

export function createCharacterChatTransaction({
    root,
    handle,
    directories,
    operation,
    oldCardPath,
    newCardPath = null,
    oldChatsPath = null,
    newChatsPath = null,
}) {
    const context = contextFor(root, handle, directories);
    const paths = operationPaths(context, operation, { oldCardPath, newCardPath, oldChatsPath, newChatsPath });
    prepareNamespace(context);
    let transactionDirectory = fs.mkdtempSync(path.join(context.namespace, 'tx-'));
    syncDirectory(context.namespace);
    syncDirectory(transactionDirectory);
    const snapshotDirectory = path.join(transactionDirectory, 'snapshot');
    fs.mkdirSync(snapshotDirectory);
    syncDirectory(transactionDirectory);
    syncDirectory(snapshotDirectory);
    try {
        const sequence = { value: 0 };
        const entryBudget = { value: 0 };
        const targets = [
            snapshotTarget(transactionDirectory, paths.oldCard, 'oldCard', 'characters', sequence, entryBudget),
            ...(paths.newCard ? [snapshotTarget(transactionDirectory, paths.newCard, 'newCard', 'characters', sequence, entryBudget)] : []),
            ...(paths.oldChats ? [snapshotTarget(transactionDirectory, paths.oldChats, 'oldChats', 'chats', sequence, entryBudget)] : []),
            ...(paths.newChats ? [snapshotTarget(transactionDirectory, paths.newChats, 'newChats', 'chats', sequence, entryBudget)] : []),
        ];
        if (operation === 'rename' && targets.some(target => target.role.startsWith('new') && target.kind !== 'absent')) {
            throw new Error('Rename destination paths must remain absent while the transaction is created.');
        }
        syncDirectory(snapshotDirectory);
        const manifestPaths = Object.fromEntries(Object.entries(paths).map(([key, value]) => [
            key,
            value ? relativeToRoot(context.root, value) : null,
        ]));
        writeManifest(transactionDirectory, {
            version: 1,
            type: 'character-chat',
            id: crypto.randomUUID(),
            operation,
            state: 'prepared',
            handleHash: context.handleHash,
            userRootHash: context.rootHash,
            storageHash: context.storageHash,
            paths: manifestPaths,
            targets: targets.map(target => ({ ...target, path: relativeToRoot(context.root, target.path) })),
        });
        readTransaction(transactionDirectory, context);
    } catch (error) {
        fs.rmSync(transactionDirectory, { recursive: true, force: true });
        syncDirectory(context.namespace);
        throw error;
    }
    activeTransactions.add(transactionDirectory);
    let state = 'prepared';
    const removeJournal = () => {
        const sourceDirectory = transactionDirectory;
        transactionDirectory = markForCleanup(sourceDirectory, context);
        activeTransactions.delete(sourceDirectory);
        activeTransactions.add(transactionDirectory);
        try {
            fs.rmSync(transactionDirectory, { recursive: true, force: true });
            syncDirectory(context.namespace);
        } finally {
            activeTransactions.delete(transactionDirectory);
        }
    };
    const cleanup = () => {
        try {
            removeJournal();
        } catch (error) {
            activeTransactions.delete(transactionDirectory);
            if (!TERMINAL_STATES.has(state)) throw error;
        }
    };
    const markCommitted = () => {
        if (state === 'committed') return;
        if (state !== 'mutating') throw new Error('Transaction must be mutating before commit.');
        const verified = readTransaction(transactionDirectory, context);
        if (verified.manifest.state !== 'mutating') {
            throw new Error(`Invalid transaction transition: ${verified.manifest.state} -> committed`);
        }
        syncPostMutationState(context, verified.targets);
        transition(transactionDirectory, context, 'mutating', 'committed');
        state = 'committed';
    };
    return {
        get directory() { return transactionDirectory; },
        markMutating() {
            if (state !== 'prepared') return;
            transition(transactionDirectory, context, 'prepared', 'mutating');
            state = 'mutating';
        },
        markCommitted,
        cleanup,
        commit() {
            markCommitted();
            cleanup();
        },
        rollback() {
            if (TERMINAL_STATES.has(state)) return cleanup();
            transactionDirectory = quarantine(transactionDirectory, context);
            activeTransactions.add(transactionDirectory);
            try {
                restoreTransaction(transactionDirectory, context);
                markRolledBack(transactionDirectory, context);
                state = 'rolled-back';
                cleanup();
            } catch (error) {
                activeTransactions.delete(transactionDirectory);
                throw error;
            }
        },
    };
}

export function ensureCharacterChatRecovery(root, handle, directories) {
    const context = contextFor(root, handle, directories);
    if (!exists(context.namespace)) return { restored: 0, cleaned: 0 };
    realDirectory(context.namespace, null, 'Character/chat journal namespace');
    const result = { restored: 0, cleaned: 0 };
    for (const entry of fs.readdirSync(context.namespace, { withFileTypes: true })) {
        const transactionDirectory = path.join(context.namespace, entry.name);
        if (entry.isSymbolicLink() || !entry.isDirectory()
            || (!TRANSACTION_PATTERN.test(entry.name)
                && !FAILED_PATTERN.test(entry.name)
                && !CLEANUP_PATTERN.test(entry.name))) {
            throw new Error(`Unsafe or unknown character/chat journal entry: ${transactionDirectory}`);
        }
        if (activeTransactions.has(transactionDirectory)) continue;
        if (CLEANUP_PATTERN.test(entry.name)) {
            assertCleanupDirectory(transactionDirectory, context);
            inspectJournal(transactionDirectory);
            const cleanupManifestPath = path.join(transactionDirectory, MANIFEST_FILE);
            if (exists(cleanupManifestPath)) {
                const cleanupManifest = readManifest(transactionDirectory, context);
                if (!TERMINAL_STATES.has(cleanupManifest.state)) {
                    throw new Error(`Cannot recover forged nonterminal cleanup tombstone: ${cleanupManifest.state}`);
                }
            }
            fs.rmSync(transactionDirectory, { recursive: true, force: true });
            syncDirectory(context.namespace);
            result.cleaned++;
            continue;
        }
        assertTransactionDirectory(transactionDirectory, context);
        const manifestPath = path.join(transactionDirectory, MANIFEST_FILE);
        if (!exists(manifestPath)) {
            throw new Error(`${FAILED_PATTERN.test(entry.name) ? 'Failed transaction' : 'Transaction'} manifest is missing.`);
        }
        let recoveryDirectory = transactionDirectory;
        const manifest = readManifest(recoveryDirectory, context);
        if (TERMINAL_STATES.has(manifest.state)) {
            recoveryDirectory = markForCleanup(recoveryDirectory, context);
            fs.rmSync(recoveryDirectory, { recursive: true, force: true });
            syncDirectory(context.namespace);
            result.cleaned++;
            continue;
        }
        let verified = readTransaction(recoveryDirectory, context, manifest);
        recoveryDirectory = quarantine(recoveryDirectory, context);
        activeTransactions.add(recoveryDirectory);
        try {
            if (recoveryDirectory !== transactionDirectory) verified = readTransaction(recoveryDirectory, context);
            restoreTransaction(recoveryDirectory, context, verified);
            markRolledBack(recoveryDirectory, context);
            const terminalDirectory = recoveryDirectory;
            recoveryDirectory = markForCleanup(terminalDirectory, context);
            activeTransactions.delete(terminalDirectory);
            activeTransactions.add(recoveryDirectory);
            fs.rmSync(recoveryDirectory, { recursive: true, force: true });
            syncDirectory(context.namespace);
            result.restored++;
        } finally {
            activeTransactions.delete(recoveryDirectory);
        }
    }
    return result;
}

export function resetCharacterChatRecoveryForTests() {
    activeTransactions.clear();
}
