import fs from 'node:fs';
import path from 'node:path';

function pathKey(filePath) {
    return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

async function statFile(filePath) {
    try {
        const stats = await fs.promises.stat(filePath);
        if (!stats.isFile()) {
            throw new Error(`Transaction target is not a file: ${filePath}`);
        }
        return stats;
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

export class FileTransaction {
    #root;
    #stagingParent;
    #transactionPath = null;
    #operations = new Map();
    #nextStageId = 0;
    #closed = false;
    #beforeApply;

    /**
     * @param {string} rootPath Root containing every transaction target
     * @param {{beforeApply?: (operation: {index: number, targetPath: string}) => void|Promise<void>}} [options]
     */
    constructor(rootPath, options = {}) {
        this.#root = path.resolve(rootPath);
        this.#stagingParent = path.join(path.dirname(this.#root), '.import-staging');
        this.#beforeApply = options.beforeApply;
    }

    #assertOpen() {
        if (this.#closed) {
            throw new Error('File transaction is already closed.');
        }
    }

    #resolveTarget(targetPath) {
        const resolved = path.resolve(targetPath);
        const relative = path.relative(this.#root, resolved);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(`File target is outside transaction root: ${targetPath}`);
        }
        return resolved;
    }

    async #ensureStagingDirectory() {
        if (this.#transactionPath) {
            return this.#transactionPath;
        }
        await fs.promises.mkdir(this.#stagingParent, { recursive: true });
        this.#transactionPath = await fs.promises.mkdtemp(path.join(this.#stagingParent, 'tx-'));
        await Promise.all([
            fs.promises.mkdir(path.join(this.#transactionPath, 'new'), { recursive: true }),
            fs.promises.mkdir(path.join(this.#transactionPath, 'backup'), { recursive: true }),
        ]);
        return this.#transactionPath;
    }

    /**
     * Stages a complete replacement file.
     * @param {string} targetPath Final path under the transaction root
     * @param {string|Buffer|Uint8Array} data File contents
     */
    async stageFile(targetPath, data) {
        this.#assertOpen();
        const target = this.#resolveTarget(targetPath);
        const key = pathKey(target);
        if (this.#operations.has(key)) {
            throw new Error(`Duplicate file transaction target: ${target}`);
        }

        const transactionPath = await this.#ensureStagingDirectory();
        const stagedPath = path.join(transactionPath, 'new', String(this.#nextStageId++).padStart(8, '0'));
        await fs.promises.writeFile(stagedPath, data);
        const stats = await fs.promises.stat(stagedPath);
        this.#operations.set(key, { targetPath: target, stagedPath, size: stats.size });
    }

    /**
     * Schedules an existing file for deletion on commit.
     * @param {string} targetPath File under the transaction root
     */
    removeFile(targetPath) {
        this.#assertOpen();
        const target = this.#resolveTarget(targetPath);
        const key = pathKey(target);
        if (this.#operations.has(key)) {
            throw new Error(`Duplicate file transaction target: ${target}`);
        }
        this.#operations.set(key, { targetPath: target, stagedPath: null, size: 0 });
    }

    /**
     * Calculates the positive final storage delta, excluding temporary staging.
     * @returns {Promise<number>}
     */
    async getAdditionalBytes() {
        this.#assertOpen();
        let delta = 0;
        for (const operation of this.#operations.values()) {
            const oldStats = await statFile(operation.targetPath);
            delta += operation.size - (oldStats?.size ?? 0);
        }
        return Math.max(0, delta);
    }

    async #createTargetDirectories(operations) {
        const missing = new Set();
        for (const operation of operations.filter(item => item.stagedPath)) {
            let current = path.dirname(operation.targetPath);
            while (current !== this.#root && !fs.existsSync(current)) {
                missing.add(current);
                current = path.dirname(current);
            }
        }
        const ordered = [...missing].sort((a, b) => a.length - b.length);
        for (const directory of ordered) {
            await fs.promises.mkdir(directory);
        }
        return ordered;
    }

    /**
     * Atomically applies each staged file and rolls the whole set back on error.
     */
    async commit() {
        this.#assertOpen();
        const operations = [...this.#operations.values()];
        if (operations.length === 0) {
            this.#closed = true;
            return;
        }
        const transactionPath = await this.#ensureStagingDirectory();
        const backups = [];
        const applied = [];
        let createdDirectories = [];

        try {
            createdDirectories = await this.#createTargetDirectories(operations);
            for (let index = 0; index < operations.length; index++) {
                const operation = operations[index];
                const oldStats = await statFile(operation.targetPath);
                if (!oldStats) {
                    continue;
                }
                const backupPath = path.join(transactionPath, 'backup', String(index).padStart(8, '0'));
                await fs.promises.rename(operation.targetPath, backupPath);
                backups.push({ targetPath: operation.targetPath, backupPath });
            }

            let applyIndex = 0;
            for (const operation of operations) {
                if (!operation.stagedPath) {
                    continue;
                }
                await this.#beforeApply?.({ index: applyIndex, targetPath: operation.targetPath });
                await fs.promises.rename(operation.stagedPath, operation.targetPath);
                applied.push(operation.targetPath);
                applyIndex += 1;
            }
        } catch (error) {
            const rollbackErrors = [];
            for (const targetPath of applied.reverse()) {
                try {
                    await fs.promises.rm(targetPath, { force: true });
                } catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            }
            for (const backup of backups.reverse()) {
                try {
                    await fs.promises.rm(backup.targetPath, { force: true });
                    await fs.promises.rename(backup.backupPath, backup.targetPath);
                } catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            }
            for (const directory of createdDirectories.sort((a, b) => b.length - a.length)) {
                try {
                    await fs.promises.rmdir(directory);
                } catch (rollbackError) {
                    if (!['ENOENT', 'ENOTEMPTY'].includes(rollbackError?.code)) {
                        rollbackErrors.push(rollbackError);
                    }
                }
            }
            if (rollbackErrors.length > 0) {
                const rollbackFailure = new globalThis.AggregateError(
                    [error, ...rollbackErrors],
                    'File transaction failed and could not be fully rolled back.',
                    { cause: error },
                );
                rollbackFailure.code = 'TRANSACTION_ROLLBACK_FAILED';
                throw rollbackFailure;
            }
            throw error;
        } finally {
            this.#closed = true;
            await this.#cleanup();
        }
    }

    async #cleanup() {
        if (!this.#transactionPath) {
            return;
        }
        const transactionPath = this.#transactionPath;
        this.#transactionPath = null;
        await fs.promises.rm(transactionPath, { recursive: true, force: true });
    }

    /** Cleans staged data when a transaction is abandoned. */
    async dispose() {
        this.#closed = true;
        await this.#cleanup();
    }
}
