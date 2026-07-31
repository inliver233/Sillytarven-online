import path from 'node:path';

import yauzl from 'yauzl';

export const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
    maxEntries: 1024,
    maxEntryBytes: 128 * 1024 * 1024,
    maxTotalBytes: 256 * 1024 * 1024,
    maxCompressionRatio: 200,
});

export class ArchiveReadError extends Error {
    /**
     * @param {number} status HTTP status
     * @param {string} code Stable error code
     * @param {string} message Safe error message
     * @param {unknown} [cause] Original error
     */
    constructor(status, code, message, cause) {
        super(message, cause ? { cause } : undefined);
        this.name = 'ArchiveReadError';
        this.status = status;
        this.code = code;
    }
}

/**
 * Normalizes a ZIP entry name without allowing it to escape the archive root.
 * @param {string} entryName ZIP entry name
 * @returns {string|null}
 */
export function normalizeArchiveEntryPath(entryName) {
    if (typeof entryName !== 'string' || entryName.includes('\0')) {
        return null;
    }

    const slashNormalized = entryName.replace(/\\/g, '/').trim();
    if (!slashNormalized || slashNormalized.startsWith('/') || /^[A-Za-z]:\//.test(slashNormalized)) {
        return null;
    }

    const normalized = path.posix.normalize(slashNormalized.replace(/^\.\/+/, ''));
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
        return null;
    }
    return normalized;
}

function validateLimits(options) {
    const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...options };
    for (const key of ['maxEntries', 'maxEntryBytes', 'maxTotalBytes']) {
        if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) {
            throw new TypeError(`${key} must be a positive safe integer.`);
        }
    }
    if (!Number.isFinite(limits.maxCompressionRatio) || limits.maxCompressionRatio < 1) {
        throw new TypeError('maxCompressionRatio must be a finite number of at least 1.');
    }
    return limits;
}

function invalidArchive(message, cause) {
    return new ArchiveReadError(400, 'invalid_archive', message, cause);
}

function openZip(archiveBuffer) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(Buffer.from(archiveBuffer), {
            lazyEntries: true,
            autoClose: false,
            decodeStrings: true,
            validateEntrySizes: false,
        }, (error, zipfile) => {
            if (error || !zipfile) {
                reject(invalidArchive('The uploaded file is not a valid ZIP archive.', error));
                return;
            }
            resolve(zipfile);
        });
    });
}

function readCentralDirectory(zipfile) {
    return new Promise((resolve, reject) => {
        const entries = [];
        const onEntry = (entry) => {
            entries.push(entry);
            zipfile.readEntry();
        };
        const cleanup = () => {
            zipfile.off('entry', onEntry);
            zipfile.off('end', onEnd);
            zipfile.off('error', onError);
        };
        const onEnd = () => {
            cleanup();
            resolve(entries);
        };
        const onError = (error) => {
            cleanup();
            reject(invalidArchive('The ZIP central directory is invalid.', error));
        };
        zipfile.on('entry', onEntry);
        zipfile.once('end', onEnd);
        zipfile.once('error', onError);
        zipfile.readEntry();
    });
}

function openEntryStream(zipfile, entry) {
    return new Promise((resolve, reject) => {
        zipfile.openReadStream(entry, (error, stream) => {
            if (error || !stream) {
                reject(invalidArchive(`Could not read ZIP entry: ${entry.fileName}`, error));
                return;
            }
            resolve(stream);
        });
    });
}

/**
 * Extracts a ZIP archive under both declared-size and actual-stream limits.
 * @param {ArrayBufferLike|Buffer} archiveBuffer ZIP archive bytes
 * @param {Partial<typeof DEFAULT_ARCHIVE_LIMITS>} [options] Resource limits
 * @returns {Promise<Map<string, Buffer>>} Normalized entry paths and contents
 */
export async function extractZipArchive(archiveBuffer, options = {}) {
    const limits = validateLimits(options);
    const zipfile = await openZip(archiveBuffer);

    try {
        const entries = await readCentralDirectory(zipfile);
        if (entries.length > limits.maxEntries) {
            throw new ArchiveReadError(413, 'archive_entry_limit_exceeded', 'The archive contains too many entries.');
        }

        const files = [];
        const seenPaths = new Set();
        let declaredTotal = 0;
        for (const entry of entries) {
            if (!Number.isSafeInteger(entry.compressedSize) || !Number.isSafeInteger(entry.uncompressedSize)) {
                throw invalidArchive('The archive contains an entry with an invalid size.');
            }
            if (entry.isEncrypted?.()) {
                throw invalidArchive('Encrypted ZIP entries are not supported.');
            }

            const normalizedPath = normalizeArchiveEntryPath(entry.fileName);
            if (!normalizedPath) {
                throw invalidArchive('The archive contains an unsafe entry path.');
            }
            if (seenPaths.has(normalizedPath)) {
                throw invalidArchive('The archive contains duplicate entry paths.');
            }
            seenPaths.add(normalizedPath);

            if (/\/$/.test(entry.fileName)) {
                continue;
            }
            if (entry.uncompressedSize > limits.maxEntryBytes) {
                throw new ArchiveReadError(413, 'archive_entry_too_large', 'An archive entry exceeds the configured size limit.');
            }
            declaredTotal += entry.uncompressedSize;
            if (!Number.isSafeInteger(declaredTotal) || declaredTotal > limits.maxTotalBytes) {
                throw new ArchiveReadError(413, 'archive_size_limit_exceeded', 'The archive exceeds the configured uncompressed size limit.');
            }

            const ratio = entry.compressedSize === 0
                ? (entry.uncompressedSize === 0 ? 0 : Number.POSITIVE_INFINITY)
                : entry.uncompressedSize / entry.compressedSize;
            if (ratio > limits.maxCompressionRatio) {
                throw new ArchiveReadError(413, 'archive_compression_ratio_exceeded', 'An archive entry exceeds the configured compression ratio.');
            }
            files.push({ entry, normalizedPath });
        }

        const extracted = new Map();
        let actualTotal = 0;
        for (const { entry, normalizedPath } of files) {
            const stream = await openEntryStream(zipfile, entry);
            const chunks = [];
            let actualEntryBytes = 0;
            try {
                for await (const chunk of stream) {
                    actualEntryBytes += chunk.length;
                    actualTotal += chunk.length;
                    if (actualEntryBytes > limits.maxEntryBytes) {
                        stream.destroy();
                        throw new ArchiveReadError(413, 'archive_entry_too_large', 'An archive entry exceeds the configured size limit.');
                    }
                    if (actualTotal > limits.maxTotalBytes) {
                        stream.destroy();
                        throw new ArchiveReadError(413, 'archive_size_limit_exceeded', 'The archive exceeds the configured uncompressed size limit.');
                    }
                    chunks.push(chunk);
                }
            } catch (error) {
                if (error instanceof ArchiveReadError) {
                    throw error;
                }
                throw invalidArchive(`Could not decompress ZIP entry: ${entry.fileName}`, error);
            }

            if (actualEntryBytes !== entry.uncompressedSize) {
                throw invalidArchive(`ZIP entry size does not match the central directory: ${entry.fileName}`);
            }
            extracted.set(normalizedPath, Buffer.concat(chunks, actualEntryBytes));
        }
        return extracted;
    } finally {
        zipfile.close();
    }
}
