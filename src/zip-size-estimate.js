import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Download size of a ZIP before it is built, for the size hints shown next to
 * backup and export buttons.
 *
 * Media barely compresses (JPG/WebP/audio/video 100%, PNG ~93%). Text varies a
 * lot: chats full of plugin snapshots compress far better than plain prose, so
 * large text files are measured by compressing a sample of their own content;
 * small ones use ratios measured on real user data (2026-10).
 */
const STORED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.webp', '.gif', '.avif', '.mp3', '.mp4', '.webm', '.ogg', '.m4a', '.wav', '.zip', '.gz', '.woff', '.woff2', '.charx']);
const TEXT_EXTENSIONS = new Set([
    '.json', '.jsonl', '.txt', '.md', '.yaml', '.yml', '.css', '.scss', '.less', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
    '.vue', '.map', '.html', '.htm', '.xml', '.svg', '.log', '.csv', '.ini', '.toml', '.py', '.sh', '.lua',
]);
const DEFAULT_RATIOS = Object.freeze({
    1: { chat: 0.36, text: 0.31 },
    6: { chat: 0.31, text: 0.27 },
});
/** Ratios for files too small to sample, by kind. Card PNGs carry text chunks, so they vary. */
const FALLBACK_RATIOS = Object.freeze({ png: 0.9, other: 0.6, txt: 0.06 });
/** Local header + central directory record per entry, with a typical path length. */
const PER_ENTRY_OVERHEAD = 140;
const SAMPLE_MIN_FILE_BYTES = 64 * 1024;
const SAMPLE_PART_BYTES = 128 * 1024;
const SAMPLE_BUDGET_BYTES = 32 * 1024 * 1024;

/**
 * Plain-text form of chat lines, as the TXT export writes them.
 * @param {string} jsonl Chat lines
 * @returns {string}
 */
export function chatLinesToText(jsonl) {
    let text = '';
    for (const line of jsonl.split('\n')) {
        try {
            const message = JSON.parse(line);
            if (message && typeof message === 'object' && Object.hasOwn(message, 'mes')) {
                text += `${message.name ?? ''}: ${message.mes ?? ''}\n\n`;
            }
        } catch {
            // Partial or header line.
        }
    }
    return text;
}

/**
 * Reads a sample of a file: its start and end (card PNGs keep their data at the
 * end), or only whole lines from the start when the lines will be parsed.
 * @param {string} filePath File
 * @param {boolean} linesOnly Sample whole lines from the start only
 * @returns {Buffer}
 */
function readSample(filePath, linesOnly) {
    if (Array.isArray(filePath)) {
        // Several files (e.g. a chat's first and last chunk): an equal share of each.
        return Buffer.concat(filePath.map(part => readSample(part, linesOnly)));
    }
    const handle = fs.openSync(filePath, 'r');
    try {
        const size = fs.fstatSync(handle).size;
        const read = (position, length) => {
            const buffer = Buffer.alloc(length);
            return buffer.subarray(0, fs.readSync(handle, buffer, 0, length, position));
        };
        if (linesOnly) {
            let sample = read(0, SAMPLE_PART_BYTES * 2);
            if (sample.length === SAMPLE_PART_BYTES * 2) {
                const end = sample.lastIndexOf(0x0A);
                if (end > 0) {
                    sample = sample.subarray(0, end);
                }
            }
            return sample;
        }
        if (size <= SAMPLE_PART_BYTES * 2) {
            return read(0, size);
        }
        return Buffer.concat([read(0, SAMPLE_PART_BYTES), read(size - SAMPLE_PART_BYTES, SAMPLE_PART_BYTES)]);
    } finally {
        fs.closeSync(handle);
    }
}

/**
 * @typedef {object} EstimateEntry
 * @property {string} name Entry name (its extension picks the ratio)
 * @property {number} size Stored bytes of the source
 * @property {string|string[]} [samplePath] File(s) to sample when the entry is large
 * @property {(text: string) => string} [transform] Conversion applied before compressing (e.g. chat to TXT)
 */

/**
 * Estimates the ZIP size of the given entries.
 * @param {EstimateEntry[]} entries Entries
 * @param {1|6} level Deflate level used by the archive
 * @returns {{files: number, rawBytes: number, estimatedBytes: number}}
 */
export function estimateZipBytes(entries, level) {
    const defaults = DEFAULT_RATIOS[level] ?? DEFAULT_RATIOS[6];
    let budget = SAMPLE_BUDGET_BYTES;
    /** Measured ratios per kind, used once the sampling budget runs out. */
    const measured = { text: [0, 0], png: [0, 0], other: [0, 0], txt: [0, 0] };
    let files = 0;
    let rawBytes = 0;
    let estimatedBytes = 22; // end of central directory

    for (const entry of entries) {
        const size = Math.max(0, Number(entry.size) || 0);
        const extension = path.extname(entry.name).toLowerCase();
        files++;
        rawBytes += size;
        if (STORED_EXTENSIONS.has(extension)) {
            estimatedBytes += size + PER_ENTRY_OVERHEAD;
            continue;
        }
        const kind = entry.transform ? 'txt' : extension === '.png' ? 'png' : TEXT_EXTENSIONS.has(extension) ? 'text' : 'other';
        let ratio = null;
        if (entry.samplePath && size >= SAMPLE_MIN_FILE_BYTES && budget > 0) {
            try {
                const sample = readSample(entry.samplePath, Boolean(entry.transform));
                if (sample.length > 0) {
                    budget -= sample.length;
                    const input = entry.transform ? Buffer.from(entry.transform(sample.toString('utf8'))) : sample;
                    const compressed = zlib.deflateRawSync(input, { level }).length;
                    ratio = Math.min(1, compressed / sample.length);
                    measured[kind][0] += sample.length;
                    measured[kind][1] += compressed;
                }
            } catch {
                // Fall back to a typical ratio below.
            }
        }
        if (ratio === null) {
            const [sampledIn, sampledOut] = measured[kind];
            if (size >= SAMPLE_MIN_FILE_BYTES && sampledIn > 0) {
                ratio = sampledOut / sampledIn;
            } else if (kind === 'text') {
                ratio = extension === '.jsonl' ? defaults.chat : defaults.text;
            } else {
                ratio = FALLBACK_RATIOS[kind];
            }
        }
        estimatedBytes += Math.round(size * ratio) + PER_ENTRY_OVERHEAD;
    }
    return { files, rawBytes, estimatedBytes };
}
