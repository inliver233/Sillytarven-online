import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Backup ZIPs are uploaded for restoring in chunks, because Cloudflare rejects
 * request bodies over 100 MB, and restored in the background, because it also
 * drops responses that take longer than 100 seconds.
 *
 * Every uploaded file is temporary: it is deleted once its restore finishes,
 * fails or is cancelled, when its upload stalls, and on startup.
 */
export const RESTORE_UPLOAD_DEFAULTS = Object.freeze({
    chunkBytes: 8 * 1024 * 1024,
    /** Uploads in progress across the server, bounding the temporary disk use. */
    maxActiveUploads: 8,
    /**
     * Restores running at once; further ones wait their turn. Restoring holds
     * a whole chat in memory several times over, so huge chats go one by one.
     */
    maxConcurrentRestores: 1,
    /** An upload that receives nothing for this long is abandoned. */
    idleMs: 15 * 60 * 1000,
    /** How long a finished restore's result stays available to the page. */
    resultRetentionMs: 30 * 60 * 1000,
    minFreeBytes: 512 * 1024 * 1024,
});

const SMALLEST_ZIP_BYTES = 22;

export class RestoreUploadError extends Error {
    /**
     * @param {number} status HTTP status
     * @param {string} code Stable error code
     * @param {string} message User-facing message
     * @param {object} [details] Extra response fields
     */
    constructor(status, code, message, details = {}) {
        super(message);
        this.name = 'RestoreUploadError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

/** @param {RestoreUpload} upload */
function settle(upload) {
    const onSettled = upload.onSettled;
    upload.onSettled = undefined;
    try {
        onSettled?.();
    } catch (error) {
        console.error('Restore settle callback failed:', error);
    }
}

const notFound = () => new RestoreUploadError(404, 'restore_upload_not_found', '上传已失效（可能已超时或服务器重启），请重新选择文件恢复');

/**
 * @typedef {object} RestoreUpload
 * @property {string} id
 * @property {string} handle
 * @property {number} size
 * @property {number} received
 * @property {string} filePath
 * @property {'uploading'|'queued'|'restoring'|'done'|'failed'} state
 * @property {boolean} writing A chunk is being written
 * @property {number} lastActivityAt
 * @property {any} [summary]
 * @property {{status: number, code: string, message: string}} [error]
 * @property {(filePath: string) => Promise<any>} [run] Throws RestoreUploadError for user-facing failures
 * @property {() => void} [onSettled] Called once when the queued restore ends or is dropped
 */

export class RestoreUploadManager {
    /** @type {Map<string, RestoreUpload>} */
    uploads = new Map();
    /** @type {RestoreUpload[]} */
    queue = [];
    runningRestores = 0;

    /**
     * @param {object} options Options
     * @param {string} options.directory Directory for the temporary uploads (owned by this manager)
     * @param {number} options.maxFileBytes Largest accepted ZIP
     * @param {Partial<typeof RESTORE_UPLOAD_DEFAULTS>} [options.limits] Overrides
     */
    constructor({ directory, maxFileBytes, limits = {} }) {
        this.directory = path.resolve(directory);
        this.maxFileBytes = maxFileBytes;
        this.limits = { ...RESTORE_UPLOAD_DEFAULTS, ...limits };
        fs.mkdirSync(this.directory, { recursive: true });
        // Files left by a previous process can never be finished.
        for (const name of fs.readdirSync(this.directory)) {
            fs.rmSync(path.join(this.directory, name), { force: true, recursive: true });
        }
        this.cleanupTimer = setInterval(() => void this.cleanup(), 60 * 1000);
        this.cleanupTimer.unref?.();
    }

    /**
     * @param {string} handle User
     * @param {string} id Upload id
     * @returns {RestoreUpload}
     */
    get(handle, id) {
        const upload = this.uploads.get(String(id));
        if (!upload || upload.handle !== handle) {
            throw notFound();
        }
        return upload;
    }

    /**
     * Starts an upload, replacing the user's previous unfinished one.
     * @param {string} handle User
     * @param {number} size ZIP size in bytes
     * @returns {Promise<{id: string, chunkBytes: number}>}
     */
    async start(handle, size) {
        if (!Number.isSafeInteger(size) || size < SMALLEST_ZIP_BYTES) {
            throw new RestoreUploadError(400, 'invalid_size', '文件大小无效');
        }
        if (size > this.maxFileBytes) {
            throw new RestoreUploadError(413, 'upload_file_too_large', `文件超过服务器允许的上传大小（${Math.floor(this.maxFileBytes / 1024 / 1024)} MB）`);
        }
        for (const upload of this.uploads.values()) {
            if (upload.handle !== handle) continue;
            if (upload.state === 'queued' || upload.state === 'restoring') {
                throw new RestoreUploadError(409, 'restore_in_progress', '上一次恢复还在进行中，请等它完成后再试');
            }
            await this.discard(upload);
        }
        const active = [...this.uploads.values()].filter(upload => upload.state === 'uploading');
        if (active.length >= this.limits.maxActiveUploads) {
            throw new RestoreUploadError(429, 'restore_busy', '服务器正在处理其他恢复，请稍后重试');
        }
        if (typeof fs.promises.statfs === 'function') {
            const disk = await fs.promises.statfs(this.directory);
            const reserved = [...this.uploads.values()].reduce((total, upload) => total + upload.size - upload.received, 0);
            if (Number(disk.bavail) * Number(disk.bsize) - reserved - size < this.limits.minFreeBytes) {
                throw new RestoreUploadError(507, 'disk_full', '服务器可用空间不足，暂时无法恢复，请稍后重试');
            }
        }

        const id = crypto.randomUUID();
        const filePath = path.join(this.directory, `${id}.zip`);
        await fs.promises.writeFile(filePath, '');
        this.uploads.set(id, { id, handle, size, received: 0, filePath, state: 'uploading', writing: false, lastActivityAt: Date.now() });
        return { id, chunkBytes: this.limits.chunkBytes };
    }

    /**
     * Writes one chunk. Chunks arrive in order; a chunk that was already
     * received (a retry whose response was lost) is accepted again.
     * @param {string} handle User
     * @param {string} id Upload id
     * @param {number} offset Position of the chunk
     * @param {number} length Declared chunk length (Content-Length)
     * @param {import('node:stream').Readable} body Chunk bytes
     * @returns {Promise<{received: number}>}
     */
    async writeChunk(handle, id, offset, length, body) {
        const upload = this.get(handle, id);
        if (upload.state !== 'uploading') {
            throw new RestoreUploadError(409, 'upload_finished', '文件已上传完成');
        }
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 ||
            length > this.limits.chunkBytes || offset + length > upload.size) {
            throw new RestoreUploadError(400, 'invalid_chunk', '分片无效');
        }
        if (offset > upload.received) {
            throw new RestoreUploadError(409, 'chunk_out_of_order', '分片顺序错误', { received: upload.received });
        }
        if (upload.writing) {
            throw new RestoreUploadError(409, 'chunk_in_progress', '上一个分片还在写入', { received: upload.received });
        }
        upload.writing = true;
        upload.lastActivityAt = Date.now();
        try {
            let written = 0;
            const counter = new Transform({
                transform(data, _encoding, callback) {
                    written += data.length;
                    callback(written > length ? new RestoreUploadError(400, 'invalid_chunk', '分片长度不符') : null, data);
                },
            });
            await pipeline(body, counter, fs.createWriteStream(upload.filePath, { flags: 'r+', start: offset }));
            if (written !== length) {
                throw new RestoreUploadError(400, 'invalid_chunk', '分片不完整');
            }
            // The upload may have been cancelled or replaced while this chunk was written.
            if (this.uploads.get(upload.id) !== upload) {
                throw notFound();
            }
            upload.received = Math.max(upload.received, offset + length);
            upload.lastActivityAt = Date.now();
            return { received: upload.received };
        } finally {
            upload.writing = false;
        }
    }

    /**
     * Queues the restore of a fully uploaded file.
     * @param {string} handle User
     * @param {string} id Upload id
     * @param {(filePath: string) => Promise<any>} run Restores the file and returns the summary
     * @param {() => void} [onSettled] Called exactly once when the restore ends or is cancelled before it ran
     * @returns {object} Status
     */
    finish(handle, id, run, onSettled) {
        const upload = this.get(handle, id);
        if (upload.state !== 'uploading') {
            return this.describe(upload);
        }
        if (upload.writing || upload.received !== upload.size) {
            throw new RestoreUploadError(409, 'upload_incomplete', '文件还没有上传完整', { received: upload.received });
        }
        upload.state = 'queued';
        upload.run = run;
        upload.onSettled = onSettled;
        upload.lastActivityAt = Date.now();
        this.queue.push(upload);
        this.pump();
        return this.describe(upload);
    }

    /**
     * @param {string} handle User
     * @param {string} id Upload id
     */
    status(handle, id) {
        return this.describe(this.get(handle, id));
    }

    /**
     * Cancels an upload that has not started restoring.
     * @param {string} handle User
     * @param {string} id Upload id
     */
    async cancel(handle, id) {
        const upload = this.get(handle, id);
        if (upload.state === 'restoring') {
            throw new RestoreUploadError(409, 'restore_in_progress', '正在恢复，无法取消');
        }
        await this.discard(upload);
    }

    /** @param {RestoreUpload} upload */
    describe(upload) {
        const position = upload.state === 'queued' ? this.queue.indexOf(upload) + 1 : 0;
        return {
            id: upload.id,
            state: upload.state,
            size: upload.size,
            received: upload.received,
            ...(position > 0 ? { queuePosition: position } : {}),
            ...(upload.summary ? { summary: upload.summary } : {}),
            ...(upload.error ? { error: upload.error } : {}),
        };
    }

    /** Starts queued restores while there is room. */
    pump() {
        while (this.runningRestores < this.limits.maxConcurrentRestores && this.queue.length > 0) {
            const upload = this.queue.shift();
            this.runningRestores++;
            void this.restore(upload).finally(() => {
                this.runningRestores--;
                this.pump();
            });
        }
    }

    /** @param {RestoreUpload} upload */
    async restore(upload) {
        upload.state = 'restoring';
        try {
            upload.summary = await upload.run(upload.filePath);
            upload.state = 'done';
        } catch (error) {
            upload.state = 'failed';
            if (error instanceof RestoreUploadError) {
                upload.error = { status: error.status, code: error.code, message: error.message };
            } else {
                console.error('Background chat restore failed:', error);
                upload.error = { status: 500, code: 'chat_restore_failed', message: '服务器处理失败，请稍后重试' };
            }
        } finally {
            upload.run = undefined;
            upload.lastActivityAt = Date.now();
            settle(upload);
            await fs.promises.rm(upload.filePath, { force: true }).catch(() => undefined);
        }
    }

    /**
     * Removes an upload that is not restoring, and its file.
     * @param {RestoreUpload} upload
     */
    async discard(upload) {
        this.uploads.delete(upload.id);
        const queued = this.queue.indexOf(upload);
        if (queued >= 0) {
            this.queue.splice(queued, 1);
        }
        settle(upload);
        await fs.promises.rm(upload.filePath, { force: true }).catch(() => undefined);
    }

    /** Drops stalled uploads and old results. */
    async cleanup(now = Date.now()) {
        for (const upload of [...this.uploads.values()]) {
            const idle = now - upload.lastActivityAt;
            if (upload.state === 'uploading' && !upload.writing && idle > this.limits.idleMs) {
                await this.discard(upload);
            } else if ((upload.state === 'done' || upload.state === 'failed') && idle > this.limits.resultRetentionMs) {
                this.uploads.delete(upload.id);
            }
        }
    }

    destroy() {
        clearInterval(this.cleanupTimer);
    }
}
