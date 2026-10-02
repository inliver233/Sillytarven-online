import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import archiver from 'archiver';

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const PARTIAL_FILE_RETENTION_MS = 60 * 60 * 1000;
const MINIMUM_FREE_SPACE_BYTES = 512 * 1024 * 1024;

export class BackupJobError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'BackupJobError';
        this.code = code;
    }
}

/**
 * Creates resumable, disk-backed user backup jobs.
 */
export class UserBackupManager {
    /** @type {Map<string, any>} */
    jobs = new Map();

    /** @type {number} */
    activeJobs = 0;

    /** @type {NodeJS.Timeout} */
    cleanupTimer;

    /**
     * @param {{directory: string, retentionMs?: number, maxConcurrent?: number, writeEntries?: (archive: import('archiver').Archiver, job: {handle: string, rootPath: string, includeSecrets: boolean, isCancelled: () => boolean}) => Promise<void>}} options Options.
     *   writeEntries adds the backed up files to the archive; by default the user root is copied as-is.
     */
    constructor({ directory, retentionMs = DEFAULT_RETENTION_MS, maxConcurrent = 2, writeEntries }) {
        this.directory = path.resolve(directory);
        this.writeEntries = typeof writeEntries === 'function'
            ? writeEntries
            : async (archive, job) => {
                archive.directory(job.rootPath, false);
            };
        this.retentionMs = retentionMs;
        this.maxConcurrent = maxConcurrent;
        fs.mkdirSync(this.directory, { recursive: true });

        void this.cleanupOrphanedFiles().catch(error => {
            console.error('Failed to clean orphaned backup files:', error);
        });
        this.cleanupTimer = setInterval(() => {
            void this.cleanupExpiredJobs()
                .then(() => this.cleanupOrphanedFiles())
                .catch(error => console.error('Failed to clean expired backup files:', error));
        }, 60 * 60 * 1000);
        this.cleanupTimer.unref?.();
    }

    /**
     * Returns the queued or running job for the same requester and target, if any.
     * @param {string} handle Target user
     * @param {string} requestedBy Requesting user
     * @param {boolean} [includeSecrets] Whether the backup includes API keys
     * @returns {object|null} Public job status
     */
    findActiveJob(handle, requestedBy, includeSecrets = false) {
        for (const job of this.jobs.values()) {
            if (job.handle === handle && job.requestedBy === requestedBy && job.includeSecrets === Boolean(includeSecrets) &&
                ['queued', 'running'].includes(job.status)) {
                return { ...this.toPublicJob(job), reused: true };
            }
        }
        return null;
    }

    /**
     * Starts a backup or returns the already running job for the same request.
     * @param {{handle: string, requestedBy: string, rootPath: string, includeSecrets?: boolean, onSettled?: (status: string) => void}} options Job options.
     *   onSettled is called once with the final status of a newly started job ('ready', 'failed' or 'cancelled').
     * @returns {Promise<object>} Public job status
     */
    /**
     * Backups being built, and finished ones still kept for download, for the admin panel.
     * @returns {{active: object[], stored: {files: number, bytes: number}}}
     */
    describeJobs() {
        const active = [];
        const stored = { files: 0, bytes: 0 };
        for (const job of this.jobs.values()) {
            if (['queued', 'running'].includes(job.status)) {
                active.push({ kind: 'full', handle: job.handle, state: job.status, startedAt: job.createdAt, processedBytes: job.processedBytes, archiveBytes: job.archiveBytes });
            } else if (job.status === 'ready') {
                stored.files++;
                stored.bytes += Number(job.size) || 0;
            }
        }
        return { active, stored };
    }

    /**
     * Cancels every backup being built and waits briefly for them to stop.
     * Used when this server is replaced: its jobs cannot be reached any more.
     * @param {number} [timeoutMs] Longest wait
     * @returns {Promise<void>}
     */
    async cancelActiveJobs(timeoutMs = 3000) {
        for (const job of this.jobs.values()) {
            if (['queued', 'running'].includes(job.status)) {
                job.status = 'cancelled';
                job.updatedAt = Date.now();
                job.archive?.abort();
                job.output?.destroy();
            }
        }
        const deadline = Date.now() + timeoutMs;
        while (this.activeJobs > 0 && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        // Let the settle callbacks give their quota back before state is handed over.
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    /**
     * Whether a new job would be refused right now because all slots are taken.
     * @returns {boolean}
     */
    isBusy() {
        return this.activeJobs >= this.maxConcurrent;
    }

    async startJob({ handle, requestedBy, rootPath, includeSecrets = false, onSettled }) {
        await this.cleanupExpiredJobs();

        const activeJob = this.findActiveJob(handle, requestedBy, includeSecrets);
        if (activeJob) {
            return activeJob;
        }

        if (this.activeJobs >= this.maxConcurrent) {
            throw new BackupJobError('BACKUP_BUSY', '服务器正在处理其他备份，请稍后重试');
        }

        const resolvedRoot = path.resolve(rootPath);
        const rootStats = await fs.promises.stat(resolvedRoot).catch(() => null);
        if (!rootStats?.isDirectory()) {
            throw new BackupJobError('BACKUP_SOURCE_MISSING', '用户数据目录不存在');
        }

        if (typeof fs.promises.statfs === 'function') {
            const disk = await fs.promises.statfs(this.directory);
            const availableBytes = Number(disk.bavail) * Number(disk.bsize);
            if (Number.isFinite(availableBytes) && availableBytes < MINIMUM_FREE_SPACE_BYTES) {
                throw new BackupJobError('BACKUP_DISK_FULL', '服务器可用空间不足，暂时无法生成备份');
            }
        }

        // Keep at most one completed on-disk export for this requester/target.
        for (const job of this.jobs.values()) {
            if (job.handle === handle && job.requestedBy === requestedBy && ['ready', 'failed', 'cancelled'].includes(job.status)) {
                await this.removeJobFiles(job);
                this.jobs.delete(job.id);
            }
        }

        const id = crypto.randomUUID();
        const createdAt = Date.now();
        const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
        const job = {
            id,
            handle,
            requestedBy,
            rootPath: resolvedRoot,
            includeSecrets: Boolean(includeSecrets),
            status: 'queued',
            createdAt,
            updatedAt: createdAt,
            processedBytes: 0,
            archiveBytes: 0,
            size: null,
            error: null,
            filename: `${handle}-${timestamp}.zip`,
            partialPath: path.join(this.directory, `${id}.part`),
            filePath: path.join(this.directory, `${id}.zip`),
            archive: null,
            output: null,
            onSettled: typeof onSettled === 'function' ? onSettled : null,
        };

        this.jobs.set(id, job);
        this.activeJobs++;
        void this.runJob(job);
        return this.toPublicJob(job);
    }

    /**
     * @param {any} job Internal job
     * @returns {Promise<void>}
     */
    async runJob(job) {
        job.status = 'running';
        job.updatedAt = Date.now();

        try {
            const output = fs.createWriteStream(job.partialPath, { flags: 'wx' });
            const archive = archiver('zip', { zlib: { level: 1 } });
            job.archive = archive;
            job.output = output;

            archive.on('progress', progress => {
                job.processedBytes = Number(progress?.fs?.processedBytes) || 0;
                job.archiveBytes = archive.pointer();
                job.updatedAt = Date.now();
            });

            await new Promise((resolve, reject) => {
                output.once('close', resolve);
                output.once('error', reject);
                archive.once('error', reject);
                archive.on('warning', warning => {
                    if (warning.code !== 'ENOENT') {
                        reject(warning);
                    }
                });

                archive.pipe(output);
                Promise.resolve()
                    .then(() => this.writeEntries(archive, {
                        handle: job.handle,
                        rootPath: job.rootPath,
                        includeSecrets: job.includeSecrets,
                        isCancelled: () => job.status === 'cancelled',
                    }))
                    .then(() => archive.finalize())
                    .catch(reject);
            });

            if (job.status === 'cancelled') {
                return;
            }

            await fs.promises.rename(job.partialPath, job.filePath);
            const stats = await fs.promises.stat(job.filePath);
            job.size = stats.size;
            job.archiveBytes = stats.size;
            job.status = 'ready';
            job.updatedAt = Date.now();
            console.info(`Backup ready for ${job.handle}: ${job.size} bytes`);
        } catch (error) {
            if (job.status !== 'cancelled' && error?.name !== 'ArchiveCancelledError') {
                job.status = 'failed';
                job.error = '备份生成失败，请稍后重试';
                job.updatedAt = Date.now();
                console.error(`Backup job failed for ${job.handle}:`, error);
            }
            await this.removeJobFiles(job);
        } finally {
            job.archive = null;
            job.output = null;
            this.activeJobs = Math.max(0, this.activeJobs - 1);
            const onSettled = job.onSettled;
            job.onSettled = null;
            try {
                onSettled?.(job.status, this.toPublicJob(job));
            } catch (error) {
                console.error('Backup job settle callback failed:', error);
            }
        }
    }

    /**
     * Returns a job only when the requester is allowed to access it.
     * @param {string} id Job ID
     * @param {string} requestedBy Current user
     * @param {boolean} isAdmin Whether current user is an admin
     * @returns {any|null} Internal job
     */
    getAuthorizedJob(id, requestedBy, isAdmin) {
        const job = this.jobs.get(id);
        if (!job || (!isAdmin && job.requestedBy !== requestedBy)) {
            return null;
        }
        return job;
    }

    getStatus(id, requestedBy, isAdmin) {
        const job = this.getAuthorizedJob(id, requestedBy, isAdmin);
        return job ? this.toPublicJob(job) : null;
    }

    getDownload(id, requestedBy, isAdmin) {
        const job = this.getAuthorizedJob(id, requestedBy, isAdmin);
        if (!job || job.status !== 'ready' || !fs.existsSync(job.filePath)) {
            return null;
        }

        return {
            filePath: job.filePath,
            filename: job.filename,
            size: job.size,
        };
    }

    async cancelJob(id, requestedBy, isAdmin) {
        const job = this.getAuthorizedJob(id, requestedBy, isAdmin);
        if (!job) {
            return false;
        }

        if (['queued', 'running'].includes(job.status)) {
            job.status = 'cancelled';
            job.updatedAt = Date.now();
            job.archive?.abort();
            job.output?.destroy();
        }

        await this.removeJobFiles(job);
        return true;
    }

    toPublicJob(job) {
        return {
            id: job.id,
            handle: job.handle,
            status: job.status,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            processedBytes: job.processedBytes,
            archiveBytes: job.archiveBytes,
            size: job.size,
            filename: job.status === 'ready' ? job.filename : null,
            includeSecrets: job.includeSecrets,
            error: job.error,
            expiresAt: job.status === 'ready' ? job.updatedAt + this.retentionMs : null,
        };
    }

    async removeJobFiles(job) {
        await Promise.all([job.partialPath, job.filePath].map(filePath =>
            fs.promises.rm(filePath, { force: true }).catch(() => undefined),
        ));
    }

    async cleanupExpiredJobs() {
        const now = Date.now();
        for (const job of this.jobs.values()) {
            if (['queued', 'running'].includes(job.status)) {
                continue;
            }
            if (now - job.updatedAt >= this.retentionMs) {
                await this.removeJobFiles(job);
                this.jobs.delete(job.id);
            }
        }
    }

    async cleanupOrphanedFiles() {
        const now = Date.now();
        const managedFiles = new Set();
        for (const job of this.jobs.values()) {
            managedFiles.add(job.partialPath);
            managedFiles.add(job.filePath);
        }
        const entries = await fs.promises.readdir(this.directory, { withFileTypes: true }).catch(() => []);
        await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
            const filePath = path.join(this.directory, entry.name);
            if (managedFiles.has(filePath)) {
                return;
            }
            const stats = await fs.promises.stat(filePath).catch(() => null);
            if (!stats) {
                return;
            }

            const maxAge = entry.name.endsWith('.part') ? PARTIAL_FILE_RETENTION_MS : this.retentionMs;
            if (now - stats.mtimeMs >= maxAge) {
                await fs.promises.rm(filePath, { force: true });
            }
        }));
    }

    async destroy() {
        clearInterval(this.cleanupTimer);
        const cancellations = [];
        for (const job of this.jobs.values()) {
            if (['queued', 'running'].includes(job.status)) {
                cancellations.push(this.cancelJob(job.id, job.requestedBy, true));
            }
        }
        await Promise.all(cancellations);
    }
}
