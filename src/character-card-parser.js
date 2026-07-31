import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { inflateSync } from 'node:zlib';

import encode from './png/encode.js';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';
import { TavernCardValidator } from './validator/TavernCardValidator.js';

const CHARACTER_KEYWORDS = new Set(['chara', 'ccv3']);
const TEXT_CHUNK_NAMES = new Set(['tEXt', 'zTXt', 'iTXt']);
const DEFAULT_MAX_CHARACTER_METADATA_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CHARACTER_METADATA_CHUNKS = 16;

export class CharacterCardPngError extends Error {
    /**
     * @param {string} code Stable error code
     * @param {string} message Error message
     * @param {unknown} [cause] Original error
     */
    constructor(code, message, cause) {
        super(message, cause ? { cause } : undefined);
        this.name = 'CharacterCardPngError';
        this.code = code;
    }
}

/**
 * Reads a null-terminated PNG text field.
 * @param {Uint8Array} data Chunk data
 * @param {number} start Start offset
 * @param {BufferEncoding} encoding Field encoding
 * @returns {{value: string, next: number}}
 */
function readNullTerminatedField(data, start, encoding) {
    const end = data.indexOf(0, start);
    if (end === -1) {
        throw new Error('Malformed PNG text chunk');
    }

    return {
        value: Buffer.from(data.subarray(start, end)).toString(encoding),
        next: end + 1,
    };
}

/**
 * Reads only the keyword so unrelated compressed text is never inflated.
 * @param {{name: string, data: Uint8Array}} chunk PNG text chunk
 * @returns {string}
 */
function getPngTextKeyword(chunk) {
    return readNullTerminatedField(chunk.data, 0, 'latin1').value;
}

/**
 * Decodes tEXt, zTXt, and iTXt PNG chunks into a common shape.
 * @param {{name: string, data: Uint8Array}} chunk PNG chunk
 * @returns {{keyword: string, text: string}}
 */
function decodePngTextChunk(chunk, budget) {
    const consume = (byteLength) => {
        if (byteLength > budget.maxChunkBytes || byteLength > budget.remainingBytes) {
            throw new CharacterCardPngError(
                'metadata_limit_exceeded',
                'PNG character metadata exceeds the configured size limit.',
            );
        }
        budget.remainingBytes -= byteLength;
    };

    const inflate = (compressed, encoding) => {
        const maxOutputLength = Math.min(budget.maxChunkBytes, budget.remainingBytes);
        if (maxOutputLength <= 0) {
            throw new CharacterCardPngError(
                'metadata_limit_exceeded',
                'PNG character metadata exceeds the configured size limit.',
            );
        }

        try {
            const output = inflateSync(compressed, { maxOutputLength });
            consume(output.length);
            return output.toString(encoding);
        } catch (error) {
            if (error instanceof CharacterCardPngError || error?.code === 'ERR_BUFFER_TOO_LARGE') {
                throw new CharacterCardPngError(
                    'metadata_limit_exceeded',
                    'PNG character metadata exceeds the configured size limit.',
                    error,
                );
            }
            throw error;
        }
    };

    if (chunk.name === 'tEXt') {
        const decoded = PNGtext.decode(chunk.data);
        consume(Buffer.byteLength(decoded.text, 'latin1'));
        return decoded;
    }

    const keywordField = readNullTerminatedField(chunk.data, 0, 'latin1');

    if (chunk.name === 'zTXt') {
        const compressionMethod = chunk.data[keywordField.next];
        if (compressionMethod !== 0) {
            throw new Error('Unsupported PNG text compression method');
        }
        const compressed = chunk.data.subarray(keywordField.next + 1);
        const text = inflate(compressed, 'latin1');
        return { keyword: keywordField.value, text };
    }

    if (chunk.name === 'iTXt') {
        const compressionFlag = chunk.data[keywordField.next];
        const compressionMethod = chunk.data[keywordField.next + 1];
        if (![0, 1].includes(compressionFlag) || compressionMethod !== 0) {
            throw new Error('Unsupported PNG international text compression');
        }

        const languageField = readNullTerminatedField(chunk.data, keywordField.next + 2, 'latin1');
        const translatedKeywordField = readNullTerminatedField(chunk.data, languageField.next, 'utf8');
        const textBuffer = Buffer.from(chunk.data.subarray(translatedKeywordField.next));
        const text = compressionFlag === 1
            ? inflate(textBuffer, 'utf8')
            : (() => {
                consume(textBuffer.length);
                return textBuffer.toString('utf8');
            })();
        return { keyword: keywordField.value, text };
    }

    throw new Error(`Unsupported PNG text chunk: ${chunk.name}`);
}

/**
 * Decodes and validates a character-card metadata payload.
 * Standard cards use Base64, while accepting raw JSON improves compatibility
 * with a small number of exporters that write JSON directly into iTXt.
 * @param {string} text PNG text value
 * @returns {string|null} Valid JSON string, or null
 */
function decodeCharacterPayload(text, keyword, maxPayloadBytes) {
    const input = String(text ?? '').trim();
    if (!input || Buffer.byteLength(input, 'utf8') > maxPayloadBytes) {
        return null;
    }

    const candidates = [];
    const compactBase64 = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (/^[A-Za-z0-9+/]*={0,2}$/.test(compactBase64)) {
        try {
            const decoded = Buffer.from(compactBase64, 'base64');
            if (decoded.length <= maxPayloadBytes) {
                candidates.push(decoded.toString('utf8'));
            }
        } catch {
            // Try the raw JSON form below.
        }
    }
    candidates.push(input);

    for (const candidate of candidates) {
        const normalized = candidate.replace(/^\uFEFF/, '').trim();
        try {
            const parsed = JSON.parse(normalized);
            if (isValidCharacterPayload(parsed, keyword)) {
                return normalized;
            }
        } catch {
            // Continue to the next representation or metadata chunk.
        }
    }

    return null;
}

/**
 * Validates a decoded character payload before it can win keyword precedence.
 * @param {unknown} payload Parsed JSON payload
 * @param {string} keyword PNG character metadata keyword
 * @returns {boolean}
 */
function isValidCharacterPayload(payload, keyword) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return false;
    }

    const validator = new TavernCardValidator(payload);
    if (keyword === 'ccv3') {
        return validator.validateV3()
            && typeof payload.data?.name === 'string'
            && payload.data.name.trim().length > 0;
    }

    const version = validator.validate();
    if (version === 1) {
        return typeof payload.name === 'string' && payload.name.trim().length > 0;
    }
    if (version === 2 || version === 3) {
        return typeof payload.data?.name === 'string' && payload.data.name.trim().length > 0;
    }
    return false;
}

/**
 * Writes V2 (`chara`) and V3 (`ccv3`) character metadata to a PNG image buffer.
 * @param {Buffer} image PNG image buffer
 * @param {string} data Character data to write
 * @returns {Buffer} PNG image buffer with metadata
 */
export const write = (image, data) => {
    const chunks = extract(new Uint8Array(image));
    const textChunks = chunks.filter(chunk => TEXT_CHUNK_NAMES.has(chunk.name));

    // Remove existing character metadata regardless of its PNG text encoding.
    for (const textChunk of textChunks) {
        try {
            if (CHARACTER_KEYWORDS.has(getPngTextKeyword(textChunk).toLowerCase())) {
                chunks.splice(chunks.indexOf(textChunk), 1);
            }
        } catch {
            // Preserve unrelated malformed metadata rather than corrupting the image.
        }
    }

    // Add new v2 chunk before the IEND chunk
    const base64EncodedData = Buffer.from(data, 'utf8').toString('base64');
    chunks.splice(-1, 0, PNGtext.encode('chara', base64EncodedData));

    // Try adding v3 chunk before the IEND chunk
    try {
        //change v2 format to v3
        const v3Data = JSON.parse(data);
        v3Data.spec = 'chara_card_v3';
        v3Data.spec_version = '3.0';

        const base64EncodedData = Buffer.from(JSON.stringify(v3Data), 'utf8').toString('base64');
        chunks.splice(-1, 0, PNGtext.encode('ccv3', base64EncodedData));
    } catch (error) {
        // Ignore errors when adding v3 chunk
    }

    const newBuffer = Buffer.from(encode(chunks));
    return newBuffer;
};

/**
 * Reads Character metadata from a PNG image buffer.
 * Supports both V2 (chara) and V3 (ccv3). V3 (ccv3) takes precedence.
 * @param {Buffer} image PNG image buffer
 * @param {{maxChunkBytes?: number, maxMetadataBytes?: number, maxMetadataChunks?: number}} [options] Resource limits
 * @returns {string} Character data
 */
export const read = (image, options = {}) => {
    const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHARACTER_METADATA_BYTES;
    const maxMetadataBytes = options.maxMetadataBytes ?? DEFAULT_MAX_CHARACTER_METADATA_BYTES;
    const maxMetadataChunks = options.maxMetadataChunks ?? DEFAULT_MAX_CHARACTER_METADATA_CHUNKS;
    if (![maxChunkBytes, maxMetadataBytes, maxMetadataChunks].every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new TypeError('PNG character metadata limits must be positive safe integers.');
    }

    let chunks;
    try {
        chunks = extract(new Uint8Array(image));
    } catch (error) {
        throw new CharacterCardPngError('invalid_png', 'The uploaded file is not a valid PNG image.', error);
    }

    /** @type {{keyword: string, chunk: {name: string, data: Uint8Array}}[]} */
    const characterChunks = [];
    let sawCharacterKeyword = false;
    for (const chunk of chunks.filter(chunk => TEXT_CHUNK_NAMES.has(chunk.name))) {
        try {
            const keyword = getPngTextKeyword(chunk).toLowerCase();
            if (!CHARACTER_KEYWORDS.has(keyword)) {
                continue;
            }
            sawCharacterKeyword = true;
            characterChunks.push({ keyword, chunk });
            if (characterChunks.length > maxMetadataChunks) {
                throw new CharacterCardPngError(
                    'metadata_chunk_limit_exceeded',
                    'PNG contains too many character metadata chunks.',
                );
            }
        } catch (error) {
            if (error instanceof CharacterCardPngError) {
                throw error;
            }
            // A malformed non-character text chunk must not block a valid card chunk.
        }
    }

    const budget = {
        maxChunkBytes,
        remainingBytes: maxMetadataBytes,
    };

    // Prefer V3, but validate every candidate and fall back to V2 when a broken
    // or stale ccv3 chunk coexists with a valid chara chunk.
    for (const keyword of ['ccv3', 'chara']) {
        for (const chunk of characterChunks.filter(chunk => chunk.keyword.toLowerCase() === keyword)) {
            try {
                const decodedChunk = decodePngTextChunk(chunk.chunk, budget);
                const decoded = decodeCharacterPayload(decodedChunk.text, keyword, maxChunkBytes);
                if (decoded) {
                    return decoded;
                }
            } catch (error) {
                if (error instanceof CharacterCardPngError) {
                    throw error;
                }
                // Continue past malformed candidates while preserving the shared budget.
            }
        }
    }

    if (sawCharacterKeyword) {
        throw new CharacterCardPngError('invalid_character_metadata', 'PNG character metadata is not valid JSON.');
    }

    throw new CharacterCardPngError('missing_character_metadata', 'PNG does not contain character metadata.');
};

/**
 * Parses a card image and returns the character metadata.
 * @param {string} cardUrl Path to the card image
 * @param {string} format File format
 * @returns {Promise<string>} Character data
 */
export const parse = async (cardUrl, format) => {
    let fileFormat = format === undefined ? 'png' : format;

    switch (fileFormat) {
        case 'png': {
            const buffer = fs.readFileSync(cardUrl);
            return read(buffer);
        }
    }

    throw new Error('Unsupported format');
};

