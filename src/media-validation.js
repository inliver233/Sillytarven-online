import path from 'node:path';

import sanitize from 'sanitize-filename';

const IMAGE_FORMATS = Object.freeze({
    png: { extension: 'png', mimeType: 'image/png' },
    jpg: { extension: 'jpg', mimeType: 'image/jpeg' },
    gif: { extension: 'gif', mimeType: 'image/gif' },
    webp: { extension: 'webp', mimeType: 'image/webp' },
    bmp: { extension: 'bmp', mimeType: 'image/bmp' },
    avif: { extension: 'avif', mimeType: 'image/avif' },
});
const IMAGE_EXTENSIONS = new Set(Object.values(IMAGE_FORMATS).map(format => format.extension));

/**
 * Detects a browser-compatible raster image by its file signature.
 * @param {Buffer|Uint8Array} input File bytes (at least the first 32 bytes)
 * @returns {{extension: string, mimeType: string}|null}
 */
export function detectImageFormat(input) {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
    if (buffer.length < 2) {
        return null;
    }

    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
        return IMAGE_FORMATS.png;
    }
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return IMAGE_FORMATS.jpg;
    }
    if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) {
        return IMAGE_FORMATS.gif;
    }
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
        return IMAGE_FORMATS.webp;
    }
    if (buffer.subarray(0, 2).toString('ascii') === 'BM') {
        return IMAGE_FORMATS.bmp;
    }
    if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
        const brand = buffer.subarray(8, 12).toString('ascii').toLowerCase();
        if (['avif', 'avis'].includes(brand)) {
            return IMAGE_FORMATS.avif;
        }
    }

    return null;
}

/**
 * Sanitizes an uploaded image name and makes its extension match detected bytes.
 * @param {string} originalName Browser-provided file name
 * @param {string} extension Canonical detected extension
 * @returns {string}
 */
export function normalizeImageFileName(originalName, extension) {
    extension = String(extension || '').toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) {
        throw new TypeError(`Unsupported image extension: ${extension || '(empty)'}`);
    }
    const fileName = sanitize(path.basename(String(originalName || '')));
    const parsed = path.parse(fileName);
    let baseName = parsed.name.startsWith('.') ? '' : sanitize(parsed.name).replace(/^\.+/, '').trim();
    if (!baseName) {
        baseName = 'background';
    }

    return `${baseName}.${extension}`;
}
