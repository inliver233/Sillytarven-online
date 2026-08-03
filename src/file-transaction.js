import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJsonStringify, hashCanonicalJson, sha256 } from './canonical-hash.js';

const JOURNAL_PARENT = '.file-transactions';
const MANIFEST_FILE = 'manifest.json';
const TRANSACTION_PATTERN = /^tx-[A-Za-z0-9]{6}$/;
const CLEANUP_PATTERN = /^cleanup-(tx-[A-Za-z0-9]{6})-(discarded|committed|rolledback)-([a-f0-9]{64})-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const CLEANUP_MARKER_SUFFIX = '.terminal';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const activeTransactions = new Set();

function normalized(filePath) {
    const result = path.normalize(path.resolve(filePath));
    return process.platform === 'win32' ? result.toLowerCase() : result;
}

function pathKey(filePath) {
    return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function isOutside(root, candidate) {
    const relative = path.relative(root, candidate);
    return !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function exists(filePath) {
    try {
        await fs.promises.lstat(filePath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

async function assertRealDirectory(directoryPath, parent = null, label = 'Directory') {
    const absolute = path.resolve(directoryPath);
    if (parent && isOutside(parent, absolute)) throw new Error(`${label} is outside its expected parent.`);
    const stats = await fs.promises.lstat(absolute);
    if (!stats.isDirectory() || stats.isSymbolicLink()
        || normalized(await fs.promises.realpath(absolute)) !== normalized(absolute)) {
        throw new Error(`${label} must be an exact real directory without symbolic links.`);
    }
    return absolute;
}

async function statRegularFile(filePath, label = 'Transaction target') {
    try {
        const stats = await fs.promises.lstat(filePath);
        if (!stats.isFile() || stats.isSymbolicLink()) {
            throw new Error(`${label} is not a regular file: ${filePath}`);
        }
        return stats;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

async function fileRecord(filePath, label) {
    const stats = await statRegularFile(filePath, label);
    if (!stats) return null;
    const contents = await fs.promises.readFile(filePath);
    return { size: contents.length, sha256: sha256(contents) };
}

async function assertFileRecord(filePath, expected, label) {
    const actual = await fileRecord(filePath, label);
    if (!actual || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
        throw new Error(`${label} checksum mismatch: ${filePath}`);
    }
}

async function syncFile(filePath) {
    const handle = await fs.promises.open(filePath, 'r+');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function syncDirectory(directoryPath) {
    let handle;
    try {
        handle = await fs.promises.open(directoryPath, 'r');
        await handle.sync();
    } catch (error) {
        if (process.platform !== 'win32' || !['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'EPERM'].includes(error?.code)) {
            throw error;
        }
    } finally {
        await handle?.close();
    }
}

function contextFor(rootPath, handle = '') {
    if (typeof handle !== 'string') throw new TypeError('File transaction handle must be a string.');
    const root = path.resolve(rootPath);
    const rootHash = sha256(normalized(root));
    const handleHash = sha256(handle);
    const namespace = path.join(path.dirname(root), JOURNAL_PARENT, sha256(`${handleHash}\0${rootHash}`));
    return { root, rootHash, handleHash, namespace };
}

async function prepareNamespace(context) {
    await assertRealDirectory(path.dirname(context.root), null, 'User root parent');
    const journalParent = path.dirname(context.namespace);
    if (!await exists(journalParent)) {
        await fs.promises.mkdir(journalParent);
        await syncDirectory(path.dirname(journalParent));
    }
    await assertRealDirectory(journalParent, path.dirname(context.root), 'File transaction journal parent');
    if (!await exists(context.namespace)) {
        await fs.promises.mkdir(context.namespace);
        await syncDirectory(journalParent);
    }
    await assertRealDirectory(context.namespace, journalParent, 'File transaction user namespace');
}

function targetRelative(root, targetPath) {
    const absolute = path.resolve(targetPath);
    if (isOutside(root, absolute)) throw new Error(`File target is outside transaction root: ${targetPath}`);
    return path.relative(root, absolute).split(path.sep).join('/');
}

function resolveRelative(root, relative, label) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.posix.isAbsolute(relative)) {
        throw new Error(`Invalid ${label} in file transaction manifest.`);
    }
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '.' || part === '..') || path.posix.normalize(relative) !== relative) {
        throw new Error(`Invalid ${label} in file transaction manifest.`);
    }
    const absolute = path.resolve(root, ...parts);
    if (isOutside(root, absolute) || targetRelative(root, absolute) !== relative) {
        throw new Error(`${label} escapes or does not exactly match the transaction root.`);
    }
    return absolute;
}

async function assertTargetParents(root, targetPath) {
    await assertRealDirectory(root, null, 'File transaction root');
    const relativeParent = path.relative(root, path.dirname(targetPath));
    if (!relativeParent) return;
    let current = root;
    for (const part of relativeParent.split(path.sep)) {
        current = path.join(current, part);
        if (!await exists(current)) return;
        await assertRealDirectory(current, root, 'File transaction target directory');
    }
}

async function writeManifest(transactionPath, manifest) {
    const signed = { ...manifest, digest: hashCanonicalJson(manifest) };
    const temporaryPath = path.join(transactionPath, `${MANIFEST_FILE}.${crypto.randomUUID()}.tmp`);
    const manifestPath = path.join(transactionPath, MANIFEST_FILE);
    const fileHandle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    try {
        await fileHandle.writeFile(canonicalJsonStringify(signed), 'utf8');
        await fileHandle.sync();
    } finally {
        await fileHandle.close();
    }
    await fs.promises.rename(temporaryPath, manifestPath);
    await syncDirectory(transactionPath);
}

function journalEntryIdentity(transactionPath, context) {
    if (normalized(path.dirname(transactionPath)) !== normalized(context.namespace)) {
        throw new Error('Invalid file transaction directory.');
    }
    const name = path.basename(transactionPath);
    if (TRANSACTION_PATTERN.test(name)) return { transactionId: name, cleanup: false };
    const cleanupMatch = CLEANUP_PATTERN.exec(name);
    if (cleanupMatch) {
        return {
            transactionId: cleanupMatch[1],
            cleanup: true,
            state: cleanupMatch[2],
            digest: cleanupMatch[3],
            cleanupName: name,
        };
    }
    throw new Error('Invalid file transaction directory.');
}

function cleanupMarkerPath(cleanupPath) {
    return `${cleanupPath}${CLEANUP_MARKER_SUFFIX}`;
}

async function inspectTransactionDirectory(transactionPath, context) {
    journalEntryIdentity(transactionPath, context);
    await assertRealDirectory(transactionPath, context.namespace, 'File transaction directory');
    const allowedFiles = new Set([MANIFEST_FILE]);
    for (const entry of await fs.promises.readdir(transactionPath, { withFileTypes: true })) {
        const entryPath = path.join(transactionPath, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Unsafe file transaction artifact: ${entryPath}`);
        if (entry.name === 'new' || entry.name === 'backup') {
            if (!entry.isDirectory()) throw new Error(`Unsafe file transaction artifact: ${entryPath}`);
            await assertRealDirectory(entryPath, transactionPath, 'File transaction artifact directory');
            for (const artifact of await fs.promises.readdir(entryPath, { withFileTypes: true })) {
                if (!artifact.isFile() || artifact.isSymbolicLink() || !/^\d{8}$/.test(artifact.name)) {
                    throw new Error(`Unsafe file transaction artifact: ${path.join(entryPath, artifact.name)}`);
                }
            }
            continue;
        }
        if (allowedFiles.has(entry.name) && entry.isFile()) continue;
        if (entry.isFile() && new RegExp(`^${MANIFEST_FILE.replace('.', '\\.')}\\.[a-f0-9-]+\\.tmp$`).test(entry.name)) {
            await fs.promises.rm(entryPath, { force: true });
            continue;
        }
        throw new Error(`Unknown file transaction artifact: ${entryPath}`);
    }
}

async function readSignedManifestFile(manifestPath, transactionPath, transactionId, context) {
    const stats = await fs.promises.lstat(manifestPath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('File transaction manifest must be a regular file.');
    let signed;
    try {
        signed = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    } catch (error) {
        throw new Error(`Invalid or malformed file transaction manifest: ${manifestPath}`, { cause: error });
    }
    if (!signed || typeof signed !== 'object' || Array.isArray(signed)) {
        throw new Error(`Invalid, tampered, or cross-user file transaction manifest: ${manifestPath}`);
    }
    const { digest, ...manifest } = signed;
    if (manifest.version !== 1 || manifest.type !== 'file-transaction'
        || !TRANSACTION_PATTERN.test(manifest.id)
        || manifest.id !== transactionId
        || !['prepared', 'backing-up', 'applying', 'discarded', 'committed', 'rolledback'].includes(manifest.state)
        || manifest.rootHash !== context.rootHash || manifest.handleHash !== context.handleHash
        || !HASH_PATTERN.test(String(digest ?? '')) || hashCanonicalJson(manifest) !== digest
        || !Array.isArray(manifest.operations) || !Array.isArray(manifest.createdDirectories)) {
        throw new Error(`Invalid, tampered, or cross-user file transaction manifest: ${manifestPath}`);
    }

    const targetKeys = new Set();
    const operations = [];
    for (let index = 0; index < manifest.operations.length; index++) {
        const operation = manifest.operations[index];
        const targetPath = resolveRelative(context.root, operation?.target, 'target path');
        await assertTargetParents(context.root, targetPath);
        const key = pathKey(targetPath);
        const expectedArtifact = String(index).padStart(8, '0');
        const expectedStagePath = operation.staged === null ? null : `new/${expectedArtifact}`;
        if (targetKeys.has(key) || operation.stagedPath !== expectedStagePath
            || typeof operation.original !== 'object' || operation.original === null
            || typeof operation.original.exists !== 'boolean') {
            throw new Error('Invalid operation in file transaction manifest.');
        }
        targetKeys.add(key);
        for (const record of [operation.original.exists ? operation.original : null, operation.staged]) {
            if (record && (!Number.isSafeInteger(record.size) || record.size < 0
                || !HASH_PATTERN.test(String(record.sha256 ?? '')))) {
                throw new Error('Invalid checksum record in file transaction manifest.');
            }
        }
        if ((!operation.original.exists && Object.keys(operation.original).length !== 1)
            || (operation.staged === null && operation.stagedPath !== null)
            || (operation.staged !== null && operation.stagedPath !== expectedStagePath)) {
            throw new Error('Inconsistent operation in file transaction manifest.');
        }
        operations.push({
            ...operation,
            targetPath,
            artifact: expectedArtifact,
            stagedPath: path.join(transactionPath, 'new', expectedArtifact),
            backupPath: path.join(transactionPath, 'backup', expectedArtifact),
        });
    }

    const createdDirectoryKeys = new Set();
    const createdDirectories = manifest.createdDirectories.map(relative => {
        const directoryPath = resolveRelative(context.root, relative, 'created directory');
        const key = pathKey(directoryPath);
        if (createdDirectoryKeys.has(key) || !operations.some(operation => !isOutside(directoryPath, operation.targetPath))) {
            throw new Error('Invalid created directory in file transaction manifest.');
        }
        createdDirectoryKeys.add(key);
        return directoryPath;
    });
    const sortedDirectories = [...createdDirectories]
        .sort((left, right) => left.length - right.length || left.localeCompare(right));
    if (createdDirectories.some((directory, index) => directory !== sortedDirectories[index])) {
        throw new Error('Created directories are not in canonical order.');
    }
    return { manifest, operations, createdDirectories };
}

async function readSignedManifest(transactionPath, context) {
    const { transactionId } = journalEntryIdentity(transactionPath, context);
    await assertRealDirectory(transactionPath, context.namespace, 'File transaction directory');
    return await readSignedManifestFile(
        path.join(transactionPath, MANIFEST_FILE),
        transactionPath,
        transactionId,
        context,
    );
}

async function readTerminalMarker(markerPath, identity, context) {
    const transaction = await readSignedManifestFile(
        markerPath,
        markerPath.slice(0, -CLEANUP_MARKER_SUFFIX.length),
        identity.transactionId,
        context,
    );
    const digest = hashCanonicalJson(transaction.manifest);
    if (transaction.manifest.state !== identity.state || digest !== identity.digest) {
        throw new Error(`Invalid or tampered file transaction terminal marker: ${markerPath}`);
    }
    return transaction;
}

async function readManifest(transactionPath, context, signedManifest = null) {
    const transaction = signedManifest ?? await readSignedManifest(transactionPath, context);
    if (['discarded', 'committed', 'rolledback'].includes(transaction.manifest.state)) return transaction;

    await inspectTransactionDirectory(transactionPath, context);
    const { manifest, operations } = transaction;
    const newDirectory = path.join(transactionPath, 'new');
    const backupDirectory = path.join(transactionPath, 'backup');
    const actualNew = new Set(await fs.promises.readdir(newDirectory));
    const actualBackups = new Set(await fs.promises.readdir(backupDirectory));
    for (const operation of operations) {
        if (actualNew.has(operation.artifact)) {
            if (operation.staged === null) throw new Error('Unexpected staged file in file transaction journal.');
            await assertFileRecord(operation.stagedPath, operation.staged, 'Staged file');
            actualNew.delete(operation.artifact);
        } else if (operation.staged !== null && manifest.state !== 'applying') {
            throw new Error('Staged file is missing from incomplete file transaction.');
        }
        if (actualBackups.has(operation.artifact)) {
            if (!operation.original.exists) throw new Error('Unexpected backup in file transaction journal.');
            await assertFileRecord(operation.backupPath, operation.original, 'Backup file');
            actualBackups.delete(operation.artifact);
        } else if (operation.original.exists && manifest.state === 'applying') {
            await assertFileRecord(operation.targetPath, operation.original, 'Restored target without backup');
        }
    }
    if (actualNew.size || actualBackups.size) throw new Error('Unknown file transaction artifact.');
    return transaction;
}

async function transition(transactionPath, context, expected, next) {
    const verified = await readManifest(transactionPath, context);
    if (verified.manifest.state !== expected) {
        throw new Error(`Invalid file transaction transition: ${verified.manifest.state} -> ${next}`);
    }
    const manifest = { ...verified.manifest, state: next };
    await writeManifest(transactionPath, manifest);
    return { ...verified, manifest };
}

async function removeTargetFile(targetPath) {
    const stats = await statRegularFile(targetPath);
    if (!stats) return;
    await fs.promises.rm(targetPath);
    await syncDirectory(path.dirname(targetPath));
}

async function restoreTransaction(transactionPath, context, verified = null) {
    const transaction = verified ?? await readManifest(transactionPath, context);
    const { manifest, operations, createdDirectories } = transaction;
    if (manifest.state === 'prepared') {
        for (const operation of operations) {
            if (operation.original.exists) await assertFileRecord(operation.targetPath, operation.original, 'Original target');
            else if (await exists(operation.targetPath)) throw new Error('Prepared transaction target was unexpectedly created.');
        }
        return transaction;
    }

    for (const operation of operations) {
        const hasBackup = await exists(operation.backupPath);
        if (operation.original.exists && hasBackup) {
            await removeTargetFile(operation.targetPath);
            await fs.promises.rename(operation.backupPath, operation.targetPath);
            await syncFile(operation.targetPath);
            await syncDirectory(path.dirname(operation.targetPath));
            await syncDirectory(path.dirname(operation.backupPath));
            await assertFileRecord(operation.targetPath, operation.original, 'Restored target');
        } else if (operation.original.exists) {
            await assertFileRecord(operation.targetPath, operation.original, 'Unmoved original target');
        } else {
            await removeTargetFile(operation.targetPath);
        }
    }
    for (const directory of [...createdDirectories].sort((left, right) => right.length - left.length)) {
        try {
            await fs.promises.rmdir(directory);
            await syncDirectory(path.dirname(directory));
        } catch (error) {
            if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error;
        }
    }
    return transaction;
}

async function verifyCommittedTargets(operations) {
    for (const operation of operations) {
        if (operation.staged === null) {
            if (await exists(operation.targetPath)) throw new Error('Committed removal target still exists.');
        } else {
            await assertFileRecord(operation.targetPath, operation.staged, 'Committed target');
        }
    }
}

async function verifyRolledBackTargets(operations) {
    for (const operation of operations) {
        if (operation.original.exists) {
            await assertFileRecord(operation.targetPath, operation.original, 'Rolled-back target');
        } else if (await exists(operation.targetPath)) {
            throw new Error('Rolled-back newly-created target still exists.');
        }
    }
}

async function verifyTerminalTargets(transaction) {
    if (transaction.manifest.state === 'committed') {
        await verifyCommittedTargets(transaction.operations);
    } else {
        await verifyRolledBackTargets(transaction.operations);
    }
}

async function terminalizeForCleanup(transactionPath, context) {
    const identity = journalEntryIdentity(transactionPath, context);
    if (identity.cleanup) throw new Error('File transaction cleanup tombstone is already renamed.');
    const manifestPath = path.join(transactionPath, MANIFEST_FILE);
    let transaction;
    if (await exists(manifestPath)) {
        transaction = await readSignedManifest(transactionPath, context);
        if (!['discarded', 'committed', 'rolledback'].includes(transaction.manifest.state)) {
            if (transaction.manifest.state !== 'prepared') {
                throw new Error(`Cannot discard file transaction in state ${transaction.manifest.state}.`);
            }
            await writeManifest(transactionPath, { ...transaction.manifest, state: 'discarded' });
            transaction = await readSignedManifest(transactionPath, context);
        }
    } else {
        await writeManifest(transactionPath, {
            version: 1,
            type: 'file-transaction',
            id: identity.transactionId,
            state: 'discarded',
            rootHash: context.rootHash,
            handleHash: context.handleHash,
            createdDirectories: [],
            operations: [],
        });
        transaction = await readSignedManifest(transactionPath, context);
    }
    return transaction;
}

async function assertMatchingTerminalManifest(transactionPath, identity, context) {
    const transaction = await readSignedManifest(transactionPath, context);
    if (transaction.manifest.state !== identity.state
        || hashCanonicalJson(transaction.manifest) !== identity.digest) {
        throw new Error(`Invalid or tampered file transaction cleanup tombstone: ${transactionPath}`);
    }
    return transaction;
}

async function finishCleanupTombstone(markerPath, identity, markerTransaction, context) {
    const cleanupPath = markerPath.slice(0, -CLEANUP_MARKER_SUFFIX.length);
    const transactionPath = path.join(context.namespace, identity.transactionId);
    const cleanupExists = await exists(cleanupPath);
    const transactionExists = await exists(transactionPath);
    if (cleanupExists && transactionExists) {
        throw new Error(`Conflicting file transaction cleanup entries: ${cleanupPath}`);
    }
    if (transactionExists) {
        await inspectTransactionDirectory(transactionPath, context);
        await assertMatchingTerminalManifest(transactionPath, identity, context);
        await fs.promises.rename(transactionPath, cleanupPath);
        await syncDirectory(context.namespace);
    }
    await verifyTerminalTargets(markerTransaction);
    if (cleanupExists || transactionExists) {
        await assertRealDirectory(cleanupPath, context.namespace, 'File transaction cleanup directory');
        await inspectTransactionDirectory(cleanupPath, context);
        if (await exists(path.join(cleanupPath, MANIFEST_FILE))) {
            await assertMatchingTerminalManifest(cleanupPath, identity, context);
        }
        await fs.promises.rm(cleanupPath, { recursive: true, force: true });
        await syncDirectory(context.namespace);
    }
    await fs.promises.rm(markerPath);
    await syncDirectory(context.namespace);
}

async function cleanupTransaction(transactionPath, context) {
    activeTransactions.delete(normalized(transactionPath));
    const transaction = await terminalizeForCleanup(transactionPath, context);
    const identity = journalEntryIdentity(transactionPath, context);
    const digest = hashCanonicalJson(transaction.manifest);
    const cleanupName = `cleanup-${identity.transactionId}-${transaction.manifest.state}-${digest}-${crypto.randomUUID()}`;
    const cleanupPath = path.join(context.namespace, cleanupName);
    const markerPath = cleanupMarkerPath(cleanupPath);
    await fs.promises.link(path.join(transactionPath, MANIFEST_FILE), markerPath);
    await syncDirectory(context.namespace);
    await fs.promises.rename(transactionPath, cleanupPath);
    await syncDirectory(context.namespace);
    await fs.promises.rm(cleanupPath, { recursive: true, force: true });
    await syncDirectory(context.namespace);
    await fs.promises.rm(markerPath);
    await syncDirectory(context.namespace);
}

export function getFileTransactionNamespace(rootPath, handle = '') {
    return contextFor(rootPath, handle).namespace;
}

export async function ensureFileTransactionRecovery(rootPath, handle = '') {
    const context = contextFor(rootPath, handle);
    if (!await exists(context.namespace)) return { restored: 0, cleaned: 0 };
    await assertRealDirectory(context.root, null, 'File transaction root');
    await assertRealDirectory(context.namespace, path.dirname(context.namespace), 'File transaction user namespace');
    const result = { restored: 0, cleaned: 0 };
    const directories = [];
    const markers = [];
    const markerNames = new Set();
    for (const entry of await fs.promises.readdir(context.namespace, { withFileTypes: true })) {
        const entryPath = path.join(context.namespace, entry.name);
        if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(CLEANUP_MARKER_SUFFIX)) {
            const cleanupName = entry.name.slice(0, -CLEANUP_MARKER_SUFFIX.length);
            let identity;
            try {
                identity = journalEntryIdentity(path.join(context.namespace, cleanupName), context);
            } catch {
                throw new Error(`Unsafe or unknown file transaction journal entry: ${entryPath}`);
            }
            if (!identity.cleanup) throw new Error(`Unsafe or unknown file transaction journal entry: ${entryPath}`);
            markers.push({ markerPath: entryPath, identity });
            markerNames.add(cleanupName);
            continue;
        }
        let identity;
        try {
            identity = journalEntryIdentity(entryPath, context);
        } catch {
            throw new Error(`Unsafe or unknown file transaction journal entry: ${entryPath}`);
        }
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
            throw new Error(`Unsafe or unknown file transaction journal entry: ${entryPath}`);
        }
        directories.push({ transactionPath: entryPath, identity });
    }
    for (const { transactionPath, identity } of directories) {
        if (identity.cleanup && !markerNames.has(identity.cleanupName)) {
            throw new Error(`Unauthenticated file transaction cleanup tombstone: ${transactionPath}`);
        }
    }

    const markerTransactionIds = new Set();
    for (const { markerPath, identity } of markers) {
        const markerTransaction = await readTerminalMarker(markerPath, identity, context);
        markerTransactionIds.add(identity.transactionId);
        await finishCleanupTombstone(markerPath, identity, markerTransaction, context);
        result.cleaned += 1;
    }

    for (const { transactionPath, identity } of directories) {
        if (identity.cleanup || markerTransactionIds.has(identity.transactionId)) continue;
        if (activeTransactions.has(normalized(transactionPath))) continue;
        const manifestPath = path.join(transactionPath, MANIFEST_FILE);
        if (!await exists(manifestPath)) {
            throw new Error(`File transaction manifest is missing from nonterminal journal: ${transactionPath}`);
        }

        const signed = await readSignedManifest(transactionPath, context);
        if (['discarded', 'committed', 'rolledback'].includes(signed.manifest.state)) {
            await verifyTerminalTargets(signed);
            await cleanupTransaction(transactionPath, context);
            result.cleaned += 1;
            continue;
        }

        const verified = await readManifest(transactionPath, context, signed);
        const restored = await restoreTransaction(transactionPath, context, verified);
        await writeManifest(transactionPath, { ...restored.manifest, state: 'rolledback' });
        await cleanupTransaction(transactionPath, context);
        result.restored += 1;
    }
    return result;
}

export class FileTransaction {
    #context;
    #transactionPath = null;
    #operations = new Map();
    #nextStageId = 0;
    #closed = false;
    #beforeBackup;
    #afterBackup;
    #beforeApply;
    #afterApply;
    #afterCommit;

    /**
     * @param {string} rootPath Root containing every transaction target
     * @param {{handle?: string, beforeBackup?: Function, afterBackup?: Function, beforeApply?: Function, afterApply?: Function, afterCommit?: Function}} [options]
     */
    constructor(rootPath, options = {}) {
        this.#context = contextFor(rootPath, options.handle);
        this.#beforeBackup = options.beforeBackup;
        this.#afterBackup = options.afterBackup;
        this.#beforeApply = options.beforeApply;
        this.#afterApply = options.afterApply;
        this.#afterCommit = options.afterCommit;
    }

    #assertOpen() {
        if (this.#closed) throw new Error('File transaction is already closed.');
    }

    #resolveTarget(targetPath) {
        const resolved = path.resolve(targetPath);
        targetRelative(this.#context.root, resolved);
        return resolved;
    }

    async #ensureStagingDirectory() {
        if (this.#transactionPath) return this.#transactionPath;
        await prepareNamespace(this.#context);
        this.#transactionPath = await fs.promises.mkdtemp(path.join(this.#context.namespace, 'tx-'));
        activeTransactions.add(normalized(this.#transactionPath));
        await fs.promises.mkdir(path.join(this.#transactionPath, 'new'));
        await fs.promises.mkdir(path.join(this.#transactionPath, 'backup'));
        await syncDirectory(this.#transactionPath);
        await syncDirectory(this.#context.namespace);
        return this.#transactionPath;
    }

    async stageFile(targetPath, data) {
        this.#assertOpen();
        const target = this.#resolveTarget(targetPath);
        const key = pathKey(target);
        if (this.#operations.has(key)) throw new Error(`Duplicate file transaction target: ${target}`);
        const transactionPath = await this.#ensureStagingDirectory();
        const artifact = String(this.#nextStageId++).padStart(8, '0');
        const stagedPath = path.join(transactionPath, 'new', artifact);
        await fs.promises.writeFile(stagedPath, data, { flag: 'wx', mode: 0o600 });
        await syncFile(stagedPath);
        await syncDirectory(path.dirname(stagedPath));
        const staged = await fileRecord(stagedPath, 'Staged file');
        this.#operations.set(key, { targetPath: target, stagedPath, staged, size: staged.size, artifact });
    }

    removeFile(targetPath) {
        this.#assertOpen();
        const target = this.#resolveTarget(targetPath);
        const key = pathKey(target);
        if (this.#operations.has(key)) throw new Error(`Duplicate file transaction target: ${target}`);
        const artifact = String(this.#nextStageId++).padStart(8, '0');
        this.#operations.set(key, { targetPath: target, stagedPath: null, staged: null, size: 0, artifact });
    }

    async getAdditionalBytes() {
        this.#assertOpen();
        let delta = 0;
        for (const operation of this.#operations.values()) {
            const oldStats = await statRegularFile(operation.targetPath);
            delta += operation.size - (oldStats?.size ?? 0);
        }
        return Math.max(0, delta);
    }

    async #prepare(operations, transactionPath) {
        await assertRealDirectory(this.#context.root, null, 'File transaction root');
        const missing = new Set();
        const manifestOperations = [];
        for (const operation of operations) {
            await assertTargetParents(this.#context.root, operation.targetPath);
            const originalRecord = await fileRecord(operation.targetPath, 'Transaction target');
            if (operation.staged) await assertFileRecord(operation.stagedPath, operation.staged, 'Staged file');
            let current = path.dirname(operation.targetPath);
            while (current !== this.#context.root && !await exists(current)) {
                missing.add(current);
                current = path.dirname(current);
            }
            manifestOperations.push({
                target: targetRelative(this.#context.root, operation.targetPath),
                original: originalRecord ? { exists: true, ...originalRecord } : { exists: false },
                stagedPath: operation.staged ? `new/${operation.artifact}` : null,
                staged: operation.staged,
            });
        }
        const createdDirectories = [...missing]
            .sort((left, right) => left.length - right.length || left.localeCompare(right))
            .map(directory => targetRelative(this.#context.root, directory));
        const manifest = {
            version: 1,
            type: 'file-transaction',
            id: path.basename(transactionPath),
            state: 'prepared',
            rootHash: this.#context.rootHash,
            handleHash: this.#context.handleHash,
            createdDirectories,
            operations: manifestOperations,
        };
        await writeManifest(transactionPath, manifest);
        return await readManifest(transactionPath, this.#context);
    }

    async #createTargetDirectories(directories) {
        for (const directory of directories) {
            await fs.promises.mkdir(directory);
            await syncDirectory(directory);
            await syncDirectory(path.dirname(directory));
        }
    }

    async commit() {
        this.#assertOpen();
        const operations = [...this.#operations.values()];
        if (operations.length === 0) {
            this.#closed = true;
            return;
        }
        const transactionPath = await this.#ensureStagingDirectory();
        let rootMutationStarted = false;
        let committed = false;
        let cleanup = false;
        let failure = null;
        try {
            await this.#prepare(operations, transactionPath);
            let verified = await transition(transactionPath, this.#context, 'prepared', 'backing-up');
            rootMutationStarted = true;
            await this.#createTargetDirectories(verified.createdDirectories);
            for (let index = 0; index < verified.operations.length; index++) {
                const operation = verified.operations[index];
                if (!operation.original.exists) continue;
                await this.#beforeBackup?.({ index, targetPath: operation.targetPath });
                await assertFileRecord(operation.targetPath, operation.original, 'Transaction target');
                await fs.promises.rename(operation.targetPath, operation.backupPath);
                await syncFile(operation.backupPath);
                await syncDirectory(path.dirname(operation.targetPath));
                await syncDirectory(path.dirname(operation.backupPath));
                await this.#afterBackup?.({ index, targetPath: operation.targetPath });
            }
            verified = await transition(transactionPath, this.#context, 'backing-up', 'applying');
            let applyIndex = 0;
            for (const operation of verified.operations) {
                if (operation.staged === null) continue;
                await this.#beforeApply?.({ index: applyIndex, targetPath: operation.targetPath });
                await assertFileRecord(operation.stagedPath, operation.staged, 'Staged file');
                await fs.promises.rename(operation.stagedPath, operation.targetPath);
                await syncDirectory(path.dirname(operation.stagedPath));
                await syncDirectory(path.dirname(operation.targetPath));
                await this.#afterApply?.({ index: applyIndex, targetPath: operation.targetPath });
                applyIndex += 1;
            }
            await transition(transactionPath, this.#context, 'applying', 'committed');
            committed = true;
            await this.#afterCommit?.();
            cleanup = true;
        } catch (error) {
            const rollbackErrors = [];
            if (committed) {
                cleanup = true;
            } else if (rootMutationStarted) {
                try {
                    const restored = await restoreTransaction(transactionPath, this.#context);
                    await writeManifest(transactionPath, { ...restored.manifest, state: 'rolledback' });
                    cleanup = true;
                } catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            } else {
                cleanup = true;
            }
            if (rollbackErrors.length) {
                activeTransactions.delete(normalized(transactionPath));
                this.#transactionPath = null;
                failure = new globalThis.AggregateError(
                    [error, ...rollbackErrors],
                    'File transaction failed and could not be fully rolled back.',
                    { cause: error },
                );
                failure.code = 'TRANSACTION_ROLLBACK_FAILED';
            } else {
                failure = error;
            }
        }

        this.#closed = true;
        if (cleanup) {
            try {
                await cleanupTransaction(transactionPath, this.#context);
                this.#transactionPath = null;
            } catch (cleanupError) {
                activeTransactions.delete(normalized(transactionPath));
                this.#transactionPath = null;
                if (committed) {
                    console.warn('Committed file transaction journal cleanup failed; recovery will retry it.', cleanupError);
                } else if (failure) {
                    failure = new globalThis.AggregateError(
                        [failure, cleanupError],
                        'File transaction failed and its journal could not be cleaned.',
                        { cause: failure },
                    );
                    failure.code = 'TRANSACTION_CLEANUP_FAILED';
                } else {
                    failure = cleanupError;
                }
            }
        }
        if (failure) throw failure;
    }

    async #cleanup() {
        if (!this.#transactionPath) return;
        const transactionPath = this.#transactionPath;
        this.#transactionPath = null;
        await cleanupTransaction(transactionPath, this.#context);
    }

    async dispose() {
        this.#closed = true;
        await this.#cleanup();
    }
}
