import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import sanitize from 'sanitize-filename';
import bmpCodec from '@jimp/js-bmp';
import gifCodec from '@jimp/js-gif';
import jpegCodec from '@jimp/js-jpeg';
import pngCodec from '@jimp/js-png';
import decodeAvif, { init as initAvif } from '@jsquash/avif/decode.js';
import decodeWebp, { init as initWebp } from '@jsquash/webp/decode.js';

const IMAGE_FORMATS = Object.freeze({
    png: { extension: 'png', mimeType: 'image/png' },
    jpg: { extension: 'jpg', mimeType: 'image/jpeg' },
    gif: { extension: 'gif', mimeType: 'image/gif' },
    webp: { extension: 'webp', mimeType: 'image/webp' },
    bmp: { extension: 'bmp', mimeType: 'image/bmp' },
    avif: { extension: 'avif', mimeType: 'image/avif' },
});
const IMAGE_EXTENSIONS = new Set(Object.values(IMAGE_FORMATS).map(format => format.extension));
const MAX_FILE_NAME_BYTES = 255;
const require = createRequire(import.meta.url);
let avifInitialization;
let webpInitialization;

export class ImageValidationError extends Error {
    constructor(status, code, message, cause) {
        super(message, cause ? { cause } : undefined);
        this.name = 'ImageValidationError';
        this.status = status;
        this.code = code;
    }
}

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

function readJpegDimensions(buffer) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xFF) {
            offset += 1;
            continue;
        }
        while (buffer[offset] === 0xFF) offset += 1;
        const marker = buffer[offset++];
        if (marker === 0xD9 || marker === 0xDA) break;
        if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;
        if (offset + 2 > buffer.length) break;
        const segmentLength = buffer.readUInt16BE(offset);
        if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
        const isStartOfFrame = (marker >= 0xC0 && marker <= 0xCF)
            && ![0xC4, 0xC8, 0xCC].includes(marker);
        if (isStartOfFrame && segmentLength >= 7) {
            return {
                width: buffer.readUInt16BE(offset + 5),
                height: buffer.readUInt16BE(offset + 3),
            };
        }
        offset += segmentLength;
    }
    return null;
}

function readWebpDimensions(buffer) {
    const type = buffer.subarray(12, 16).toString('ascii');
    if (type === 'VP8X' && buffer.length >= 30) {
        return {
            width: buffer.readUIntLE(24, 3) + 1,
            height: buffer.readUIntLE(27, 3) + 1,
        };
    }
    if (type === 'VP8 ' && buffer.length >= 30 && buffer.subarray(23, 26).equals(Buffer.from([0x9D, 0x01, 0x2A]))) {
        return {
            width: buffer.readUInt16LE(26) & 0x3FFF,
            height: buffer.readUInt16LE(28) & 0x3FFF,
        };
    }
    if (type === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2F) {
        const bits = buffer.readUInt32LE(21);
        return {
            width: (bits & 0x3FFF) + 1,
            height: ((bits >>> 14) & 0x3FFF) + 1,
        };
    }
    return null;
}

function readAvifDimensions(buffer) {
    let dimensions = null;
    let offset = 0;
    while ((offset = buffer.indexOf('ispe', offset, 'ascii')) !== -1) {
        if (offset + 12 <= buffer.length) {
            const width = buffer.readUInt32BE(offset + 4);
            const height = buffer.readUInt32BE(offset + 8);
            if (width > 0 && height > 0 && (!dimensions || width * height > dimensions.width * dimensions.height)) {
                dimensions = { width, height };
            }
        }
        offset += 4;
    }
    return dimensions;
}

function getImageDimensions(buffer, extension) {
    if (extension === 'png' && buffer.length >= 24 && buffer.subarray(12, 16).toString('ascii') === 'IHDR') {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (extension === 'jpg') {
        return readJpegDimensions(buffer);
    }
    if (extension === 'gif' && buffer.length >= 10) {
        return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (extension === 'webp') {
        return readWebpDimensions(buffer);
    }
    if (extension === 'bmp' && buffer.length >= 26) {
        return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) };
    }
    if (extension === 'avif') {
        return readAvifDimensions(buffer);
    }
    return null;
}

function assertPixelLimit(width, height, maxPixels) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
        throw new ImageValidationError(415, 'invalid_image', 'The image dimensions are invalid.');
    }
    if (width > Math.floor(maxPixels / height)) {
        throw new ImageValidationError(413, 'image_pixel_limit_exceeded', 'The image contains too many pixels.');
    }
}

async function initializeWasmDecoder(packagePath, initializer) {
    const wasmBytes = await fs.promises.readFile(require.resolve(packagePath));
    const wasmModule = new globalThis.WebAssembly.Module(wasmBytes);
    await initializer(wasmModule);
}

async function decodeCompleteImage(buffer, extension, maxPixels) {
    if (extension === 'png') {
        return pngCodec().decode(buffer, { checkCRC: true });
    }
    if (extension === 'jpg') {
        return jpegCodec().decode(buffer, {
            formatAsRGBA: true,
            useTArray: true,
            maxResolutionInMP: Math.ceil(maxPixels / 1_000_000),
            maxMemoryUsageInMB: Math.max(32, Math.ceil(maxPixels * 4 / (1024 * 1024))),
        });
    }
    if (extension === 'gif') {
        return gifCodec().decode(buffer);
    }
    if (extension === 'bmp') {
        return bmpCodec().decode(buffer);
    }
    if (extension === 'webp') {
        webpInitialization ??= initializeWasmDecoder('@jsquash/webp/codec/dec/webp_dec.wasm', initWebp);
        await webpInitialization;
        return await decodeWebp(buffer);
    }
    if (extension === 'avif') {
        avifInitialization ??= initializeWasmDecoder('@jsquash/avif/codec/dec/avif_dec.wasm', initAvif);
        await avifInitialization;
        return await decodeAvif(buffer);
    }
    throw new Error(`No image decoder for ${extension}.`);
}

/**
 * Validates the complete image and bounds decoded pixel allocation.
 * @param {Buffer|Uint8Array} input Complete image contents
 * @param {{maxPixels?: number}} [options] Decode limits
 * @returns {Promise<{format: {extension: string, mimeType: string}, width: number, height: number}>}
 */
export async function validateImageBuffer(input, options = {}) {
    const maxPixels = options.maxPixels ?? 100_000_000;
    if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) {
        throw new TypeError('maxPixels must be a positive safe integer.');
    }
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
    const format = detectImageFormat(buffer);
    if (!format) {
        throw new ImageValidationError(415, 'invalid_image', 'The file is not a supported image.');
    }
    const declaredDimensions = getImageDimensions(buffer, format.extension);
    if (!declaredDimensions) {
        throw new ImageValidationError(415, 'invalid_image', 'The image header is incomplete or invalid.');
    }
    assertPixelLimit(declaredDimensions.width, declaredDimensions.height, maxPixels);

    let decoded;
    try {
        decoded = await decodeCompleteImage(buffer, format.extension, maxPixels);
    } catch (error) {
        throw new ImageValidationError(415, 'invalid_image', 'The complete image data could not be decoded.', error);
    }
    assertPixelLimit(decoded.width, decoded.height, maxPixels);
    return { format, width: decoded.width, height: decoded.height };
}

function truncateUtf8(input, maxBytes) {
    let output = '';
    let length = 0;
    for (const character of input) {
        const characterBytes = Buffer.byteLength(character, 'utf8');
        if (length + characterBytes > maxBytes) break;
        output += character;
        length += characterBytes;
    }
    return output;
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

    const extensionBytes = Buffer.byteLength(`.${extension}`, 'utf8');
    baseName = truncateUtf8(baseName, MAX_FILE_NAME_BYTES - extensionBytes).trim();
    if (!baseName) {
        baseName = 'background';
    }

    return `${baseName}.${extension}`;
}
