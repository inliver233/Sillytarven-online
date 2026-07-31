import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { normalizeZipEntryPath, ensureDirectory, clientRelativePath } from './util.js';
import { extractZipArchive } from './bounded-zip.js';
import { DEFAULT_AVATAR_PATH } from './constants.js';
import { detectImageFormat, normalizeImageFileName } from './media-validation.js';

// 'embeded://' is intentional - RisuAI exports use this misspelling
const CHARX_EMBEDDED_URI_PREFIXES = ['embeded://', 'embedded://', '__asset:'];
const CHARX_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng', 'avif', 'bmp', 'jfif']);
const CHARX_SPRITE_TYPES = new Set(['emotion', 'expression']);
const CHARX_BACKGROUND_TYPES = new Set(['background']);

// ZIP local file header signature: PK\x03\x04
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4B, 0x03, 0x04]);

/**
 * Find ZIP data start in buffer (handles SFX/self-extracting archives).
 * @param {Buffer} buffer
 * @returns {Buffer} Buffer starting at ZIP signature, or original if not found
 */
function findZipStart(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const index = buf.indexOf(ZIP_SIGNATURE);
    if (index > 0) {
        return buf.slice(index);
    }
    return buf;
}

/**
 * @typedef {Object} CharXAsset
 * @property {string} type - Asset type (emotion, expression, background, etc.)
 * @property {string} name - Asset name from metadata
 * @property {string} ext - File extension (lowercase, no dot)
 * @property {string} zipPath - Normalized path within the ZIP archive
 * @property {number} order - Original index in assets array
 * @property {string} [storageCategory] - 'sprite' | 'background' | 'misc' (set by mapCharXAssetsForStorage)
 * @property {string} [baseName] - Normalized filename base (set by mapCharXAssetsForStorage)
 */

/**
 * @typedef {Object} CharXParseResult
 * @property {Object} card - Parsed card.json (CCv2 or CCv3 spec)
 * @property {string|Buffer} avatar - Avatar image buffer or DEFAULT_AVATAR_PATH
 * @property {CharXAsset[]} auxiliaryAssets - Assets mapped for storage
 * @property {Map<string, Buffer>} extractedBuffers - Map of zipPath to extracted buffer
 */

export class CharXParser {
    #data;
    #archiveOptions;

    /**
     * @param {ArrayBuffer|Buffer} data
     * @param {object} [archiveOptions] ZIP resource limits
     */
    constructor(data, archiveOptions = {}) {
        // Handle SFX (self-extracting) ZIP archives by finding the actual ZIP start
        this.#data = findZipStart(Buffer.isBuffer(data) ? data : Buffer.from(data));
        this.#archiveOptions = archiveOptions;
    }

    /**
     * Parse the CharX archive and extract card data and assets.
     * @returns {Promise<CharXParseResult>}
     */
    async parse() {
        console.info('Importing from CharX');
        const archiveFiles = await extractZipArchive(this.#data, this.#archiveOptions);
        const cardEntry = [...archiveFiles.entries()].find(([fileName]) => (
            fileName.endsWith('card.json') && !fileName.startsWith('__MACOSX/')
        ));
        const cardBuffer = cardEntry?.[1];

        if (!cardBuffer) {
            throw new Error('Failed to extract card.json from CharX file');
        }

        const card = JSON.parse(cardBuffer.toString());

        if (card.spec === undefined) {
            throw new Error('Invalid CharX card file: missing spec field');
        }

        const embeddedAssets = this.collectCharXAssets(card);
        const iconAsset = this.pickCharXIconAsset(embeddedAssets);
        const auxiliaryAssets = this.mapCharXAssetsForStorage(embeddedAssets);

        const archivePaths = new Set();

        if (iconAsset?.zipPath) {
            archivePaths.add(iconAsset.zipPath);
        }
        for (const asset of auxiliaryAssets) {
            if (asset?.zipPath) {
                archivePaths.add(asset.zipPath);
            }
        }

        const extractedBuffers = new Map(
            [...archiveFiles].filter(([fileName]) => archivePaths.has(fileName)),
        );

        /** @type {string|Buffer} */
        let avatar = DEFAULT_AVATAR_PATH;
        if (iconAsset?.zipPath) {
            const iconBuffer = extractedBuffers.get(iconAsset.zipPath);
            if (iconBuffer) {
                avatar = iconBuffer;
            }
        }

        return { card, avatar, auxiliaryAssets, extractedBuffers };
    }

    getEmbeddedZipPathFromUri(uri) {
        if (typeof uri !== 'string') {
            return null;
        }

        const trimmed = uri.trim();
        if (!trimmed) {
            return null;
        }

        const lower = trimmed.toLowerCase();
        for (const prefix of CHARX_EMBEDDED_URI_PREFIXES) {
            if (lower.startsWith(prefix)) {
                const rawPath = trimmed.slice(prefix.length);
                return normalizeZipEntryPath(rawPath);
            }
        }

        return null;
    }

    /**
     * Normalize extension string: lowercase, strip leading dot.
     * @param {string} ext
     * @returns {string}
     */
    normalizeExtString(ext) {
        if (typeof ext !== 'string') return '';
        return ext.trim().toLowerCase().replace(/^\./, '');
    }

    /**
     * Strip trailing image extension from asset name if present.
     * Handles cases like "image.png" with ext "png" → "image" (avoids "image.png.png")
     * @param {string} name - Asset name that may contain extension
     * @param {string} expectedExt - The expected extension (lowercase, no dot)
     * @returns {string} Name with trailing extension stripped if it matched
     */
    stripTrailingImageExtension(name, expectedExt) {
        if (!name || !expectedExt) return name;
        const lower = name.toLowerCase();
        // Check if name ends with the expected extension
        if (lower.endsWith(`.${expectedExt}`)) {
            return name.slice(0, -(expectedExt.length + 1));
        }
        // Also check for any known image extension at the end
        for (const ext of CHARX_IMAGE_EXTENSIONS) {
            if (lower.endsWith(`.${ext}`)) {
                return name.slice(0, -(ext.length + 1));
            }
        }
        return name;
    }

    deriveCharXAssetExtension(assetExt, zipPath) {
        const metaExt = this.normalizeExtString(assetExt);
        const pathExt = this.normalizeExtString(path.extname(zipPath || ''));
        return metaExt || pathExt;
    }

    collectCharXAssets(card) {
        const assets = _.get(card, 'data.assets');
        if (!Array.isArray(assets)) {
            return [];
        }

        return assets.map((asset, index) => {
            if (!asset) {
                return null;
            }

            const zipPath = this.getEmbeddedZipPathFromUri(asset.uri);
            if (!zipPath) {
                return null;
            }

            const ext = this.deriveCharXAssetExtension(asset.ext, zipPath);
            const type = typeof asset.type === 'string' ? asset.type.toLowerCase() : '';
            const name = typeof asset.name === 'string' ? asset.name : '';

            return {
                type,
                name,
                ext,
                zipPath,
                order: index,
            };
        }).filter(Boolean);
    }

    pickCharXIconAsset(assets) {
        const iconAssets = assets.filter(asset => asset.type === 'icon' && CHARX_IMAGE_EXTENSIONS.has(asset.ext) && asset.zipPath);
        if (iconAssets.length === 0) {
            return null;
        }

        const mainIcon = iconAssets.find(asset => asset.name?.toLowerCase() === 'main');
        return mainIcon || iconAssets[0];
    }

    /**
     * Normalize asset name for filesystem storage.
     * @param {string} name - Original asset name
     * @param {string} fallback - Fallback name if normalization fails
     * @param {boolean} useHyphens - Use hyphens instead of underscores (for sprites)
     * @returns {string} Normalized filename base (without extension)
     */
    getCharXAssetBaseName(name, fallback, useHyphens = false) {
        const cleaned = (String(name ?? '').trim() || '');
        if (!cleaned) {
            return fallback.toLowerCase();
        }

        const separator = useHyphens ? '-' : '_';
        // Convert to lowercase, collapse non-alphanumeric runs to separator, trim edges
        const base = cleaned
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, separator)
            .replace(new RegExp(`^${separator}|${separator}$`, 'g'), '');

        if (!base) {
            return fallback.toLowerCase();
        }

        const sanitized = sanitize(base);
        return (sanitized || fallback).toLowerCase();
    }

    mapCharXAssetsForStorage(assets) {
        return assets.reduce((acc, asset) => {
            if (!asset?.zipPath) {
                return acc;
            }

            const ext = (asset.ext || '').toLowerCase();
            if (!CHARX_IMAGE_EXTENSIONS.has(ext)) {
                return acc;
            }

            if (asset.type === 'icon' || asset.type === 'user_icon') {
                return acc;
            }

            let storageCategory;
            if (CHARX_SPRITE_TYPES.has(asset.type)) {
                storageCategory = 'sprite';
            } else if (CHARX_BACKGROUND_TYPES.has(asset.type)) {
                storageCategory = 'background';
            } else {
                storageCategory = 'misc';
            }

            // Use hyphens for sprites so ST's expression label extraction works correctly
            // (sprites.js extracts label via regex that splits on dash or dot)
            const useHyphens = storageCategory === 'sprite';
            // Strip trailing extension from name if present (e.g., "image.png" with ext "png")
            const nameWithoutExt = this.stripTrailingImageExtension(asset.name, ext);
            acc.push({
                ...asset,
                ext,
                storageCategory,
                baseName: this.getCharXAssetBaseName(nameWithoutExt, `${storageCategory}-${asset.order ?? 0}`, useHyphens),
            });

            return acc;
        }, []);
    }
}

/**
 * Persist extracted CharX assets to appropriate ST directories.
 * Note: Uses sync writes consistent with ST's existing file handling.
 * @param {Array} assets - Mapped assets from CharXParser
 * @param {Map<string, Buffer>} bufferMap - Extracted file buffers
 * @param {Object} directories - User directories object
 * @param {string|{characterFolder: string, assetFolder?: string, spriteFolder?: string}} characterOptions Character storage names
 * @returns {{sprites: number, backgrounds: number, misc: number, rewrites: Array<{order: number, uri: string, ext: string}>}}
 */
export function persistCharXAssets(assets, bufferMap, directories, characterOptions) {
    const plan = planCharXAssets(assets, bufferMap, directories, characterOptions);
    const targetPaths = new Set([
        ...plan.writes.map(item => item.filePath),
        ...plan.removals,
    ]);
    const snapshots = new Map();
    for (const targetPath of targetPaths) {
        snapshots.set(targetPath, fs.existsSync(targetPath) ? fs.readFileSync(targetPath) : null);
    }

    try {
        for (const write of plan.writes) {
            if (!ensureDirectory(path.dirname(write.filePath))) {
                throw new Error(`Failed to create CharX asset directory: ${path.dirname(write.filePath)}`);
            }
            writeFileAtomicSync(write.filePath, write.buffer);
        }
        for (const removal of plan.removals) {
            fs.rmSync(removal, { force: true });
        }
        return plan.summary;
    } catch (error) {
        for (const [targetPath, snapshot] of snapshots) {
            if (snapshot === null) {
                fs.rmSync(targetPath, { force: true });
            } else {
                ensureDirectory(path.dirname(targetPath));
                writeFileAtomicSync(targetPath, snapshot);
            }
        }
        throw error;
    }
}

function findExistingByBaseName(dirPath, baseName) {
    try {
        return fs.readdirSync(dirPath, { withFileTypes: true })
            .filter(entry => entry.isFile() && path.parse(entry.name).name === baseName)
            .map(entry => path.join(dirPath, entry.name));
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

/**
 * Builds the complete CharX asset write plan without modifying disk.
 * @param {Array} assets Mapped assets from CharXParser
 * @param {Map<string, Buffer>} bufferMap Extracted archive buffers
 * @param {Object} directories User directories
 * @param {string|{characterFolder: string, assetFolder?: string, spriteFolder?: string}} characterOptions Character storage names
 * @returns {{summary: {sprites: number, backgrounds: number, misc: number, rewrites: Array<{order: number, uri: string, ext: string}>}, writes: Array<{filePath: string, buffer: Buffer}>, removals: string[]}}
 */
export function planCharXAssets(assets, bufferMap, directories, characterOptions) {
    const summary = { sprites: 0, backgrounds: 0, misc: 0, rewrites: [] };
    const writes = [];
    const removals = new Set();
    if (!Array.isArray(assets) || assets.length === 0) {
        return { summary, writes, removals: [] };
    }

    const rawCharacterFolder = typeof characterOptions === 'string' ? characterOptions : characterOptions?.characterFolder;
    const rawAssetFolder = typeof characterOptions === 'string' ? characterOptions : characterOptions?.assetFolder;
    const rawSpriteFolder = typeof characterOptions === 'string' ? characterOptions : characterOptions?.spriteFolder;
    const characterFolder = sanitize(String(rawCharacterFolder || 'Character')) || 'Character';
    const assetFolder = sanitize(String(rawAssetFolder || characterFolder)) || characterFolder;
    const spriteFolder = sanitize(String(rawSpriteFolder || characterFolder)) || characterFolder;

    for (const asset of assets) {
        const buffer = asset?.zipPath ? bufferMap.get(asset.zipPath) : null;
        if (!buffer) {
            console.warn(`CharX: Asset ${asset?.zipPath || '(unknown)'} missing or unsupported, skipping.`);
            continue;
        }
        const detectedFormat = detectImageFormat(buffer);
        if (!detectedFormat) {
            console.warn(`CharX: Asset ${asset.zipPath} is not a supported image, skipping.`);
            continue;
        }

        let filePath;
        if (asset.storageCategory === 'sprite') {
            filePath = path.join(directories.characters, spriteFolder, `${asset.baseName}.${detectedFormat.extension}`);
            summary.sprites += 1;
        } else if (asset.storageCategory === 'background') {
            const fileName = normalizeImageFileName(`${assetFolder}_${asset.baseName}`, detectedFormat.extension);
            filePath = path.join(directories.backgrounds, fileName);
            summary.backgrounds += 1;
        } else if (asset.storageCategory === 'misc') {
            filePath = path.join(directories.userImages, assetFolder, `${asset.baseName}.${detectedFormat.extension}`);
            summary.misc += 1;
        } else {
            continue;
        }

        for (const existingPath of findExistingByBaseName(path.dirname(filePath), path.parse(filePath).name)) {
            if (path.resolve(existingPath) !== path.resolve(filePath)) {
                removals.add(existingPath);
            }
        }
        writes.push({ filePath, buffer });
        summary.rewrites.push({
            order: asset.order,
            uri: clientRelativePath(directories.root, filePath),
            ext: detectedFormat.extension,
        });
    }

    return { summary, writes, removals: [...removals] };
}

/**
 * Replaces embedded CharX URIs with paths that the client can fetch.
 * Only successfully persisted assets are rewritten.
 * @param {object} card Character card object
 * @param {Array<{order: number, uri: string, ext?: string}>} rewrites Persisted asset locations
 * @returns {object} The mutated card
 */
export function applyCharXAssetRewrites(card, rewrites) {
    const assets = _.get(card, 'data.assets');
    if (!Array.isArray(assets) || !Array.isArray(rewrites)) {
        return card;
    }

    for (const rewrite of rewrites) {
        const asset = assets[rewrite?.order];
        if (!asset || typeof rewrite?.uri !== 'string') {
            continue;
        }
        asset.uri = rewrite.uri;
        if (rewrite.ext) {
            asset.ext = rewrite.ext;
        }
    }

    return card;
}
