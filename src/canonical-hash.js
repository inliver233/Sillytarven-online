import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Recursively sorts JSON object keys while preserving array order and JSON semantics.
 * @param {unknown} value Value to canonicalize
 * @returns {unknown} Canonical JSON-compatible value
 */
function sortJsonValue(value) {
    if (Array.isArray(value)) {
        return value.map(sortJsonValue);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJsonValue(value[key])]));
    }
    return value;
}

/**
 * Serializes a value as canonical JSON with recursively sorted object keys.
 * @param {unknown} value Value to serialize
 * @returns {string} Canonical JSON
 */
export function canonicalJsonStringify(value) {
    const json = JSON.stringify(value);
    if (json === undefined) {
        throw new TypeError('Value is not JSON serializable.');
    }
    return JSON.stringify(sortJsonValue(JSON.parse(json)));
}

/**
 * Calculates a SHA-256 digest.
 * @param {string|NodeJS.ArrayBufferView} value Bytes to hash
 * @returns {string} Lowercase hexadecimal digest
 */
export function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Calculates a SHA-256 digest of canonical JSON.
 * @param {unknown} value JSON-compatible value
 * @returns {string} Lowercase hexadecimal digest
 */
export function hashCanonicalJson(value) {
    return sha256(canonicalJsonStringify(value));
}

/**
 * Builds a deterministic byte manifest for files below a common directory.
 * @param {string} baseDirectory Common parent directory
 * @param {string[]} filePaths Files to include
 * @returns {{version: number, algorithm: string, files: {path: string, size: number, sha256: string}[], digest: string}}
 */
export function createCanonicalFileManifest(baseDirectory, filePaths) {
    const root = path.resolve(baseDirectory);
    const files = filePaths.map(filePath => {
        const absolutePath = path.resolve(filePath);
        const relativePath = path.relative(root, absolutePath);
        if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
            throw new Error(`Manifest file is outside its base directory: ${filePath}`);
        }
        const contents = fs.readFileSync(absolutePath);
        return {
            path: relativePath.split(path.sep).join('/'),
            size: contents.length,
            sha256: sha256(contents),
        };
    }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const manifest = { version: 1, algorithm: 'sha256', files };
    return { ...manifest, digest: hashCanonicalJson(manifest) };
}

/**
 * Verifies a canonical file manifest against disk.
 * @param {string} baseDirectory Common parent directory
 * @param {{version: number, algorithm: string, files: {path: string, size: number, sha256: string}[], digest: string}} manifest Manifest to verify
 * @returns {boolean} Whether the manifest and every file match
 */
export function verifyCanonicalFileManifest(baseDirectory, manifest) {
    if (!manifest || manifest.version !== 1 || manifest.algorithm !== 'sha256' || !Array.isArray(manifest.files)) {
        return false;
    }
    const unsigned = { version: manifest.version, algorithm: manifest.algorithm, files: manifest.files };
    if (hashCanonicalJson(unsigned) !== manifest.digest) {
        return false;
    }
    try {
        const actual = createCanonicalFileManifest(
            baseDirectory,
            manifest.files.map(entry => path.join(baseDirectory, ...entry.path.split('/'))),
        );
        return actual.digest === manifest.digest;
    } catch {
        return false;
    }
}

function normalizeDryRunPath(inputPath, label) {
    if (typeof inputPath !== 'string' || !inputPath || inputPath.includes('\\') || path.posix.isAbsolute(inputPath)) {
        throw new Error(`Invalid ${label} path: ${inputPath}`);
    }
    const normalized = path.posix.normalize(inputPath);
    if (normalized !== inputPath || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error(`Invalid ${label} path: ${inputPath}`);
    }
    return normalized;
}

/**
 * Creates an in-memory canonical snapshot suitable for migration dry runs.
 * No filesystem writes are performed.
 * @param {{json: unknown, artifacts?: {path: string, contents: string|NodeJS.ArrayBufferView}[], directories?: string[]}} options Snapshot inputs
 * @returns {{version: number, json: {canonical: string, sha256: string}, artifacts: {version: number, algorithm: string, files: {path: string, size: number, sha256: string}[], directories: string[], digest: string}, digest: string}}
 */
export function createCanonicalDryRunSnapshot({ json, artifacts = [], directories = [] }) {
    const canonical = canonicalJsonStringify(json);
    const seenPaths = new Set();
    const files = artifacts.map(artifact => {
        const artifactPath = normalizeDryRunPath(artifact.path, 'artifact');
        if (seenPaths.has(artifactPath)) {
            throw new Error(`Duplicate dry-run artifact path: ${artifactPath}`);
        }
        seenPaths.add(artifactPath);
        const contents = typeof artifact.contents === 'string'
            ? Buffer.from(artifact.contents)
            : Buffer.from(artifact.contents.buffer, artifact.contents.byteOffset, artifact.contents.byteLength);
        return { path: artifactPath, size: contents.length, sha256: sha256(contents) };
    }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const normalizedDirectories = [...new Set(directories.map(directory => normalizeDryRunPath(directory, 'directory')))].sort();
    const artifactManifest = { version: 1, algorithm: 'sha256', files, directories: normalizedDirectories };
    const snapshot = {
        version: 1,
        json: { canonical, sha256: sha256(canonical) },
        artifacts: { ...artifactManifest, digest: hashCanonicalJson(artifactManifest) },
    };
    return { ...snapshot, digest: hashCanonicalJson(snapshot) };
}

/**
 * Diffs two canonical dry-run snapshots without mutating either snapshot or disk.
 * @param {ReturnType<typeof createCanonicalDryRunSnapshot>} before Before snapshot
 * @param {ReturnType<typeof createCanonicalDryRunSnapshot>} after After snapshot
 * @returns {{changed: boolean, canonicalJsonChanged: boolean, addedFiles: string[], removedFiles: string[], changedFiles: string[], addedDirectories: string[], removedDirectories: string[]}}
 */
export function diffCanonicalSnapshots(before, after) {
    const beforeFiles = new Map(before.artifacts.files.map(file => [file.path, file]));
    const afterFiles = new Map(after.artifacts.files.map(file => [file.path, file]));
    const addedFiles = [...afterFiles.keys()].filter(filePath => !beforeFiles.has(filePath)).sort();
    const removedFiles = [...beforeFiles.keys()].filter(filePath => !afterFiles.has(filePath)).sort();
    const changedFiles = [...beforeFiles.keys()].filter(filePath => {
        const afterFile = afterFiles.get(filePath);
        const beforeFile = beforeFiles.get(filePath);
        return afterFile && (afterFile.size !== beforeFile.size || afterFile.sha256 !== beforeFile.sha256);
    }).sort();
    const beforeDirectories = new Set(before.artifacts.directories);
    const afterDirectories = new Set(after.artifacts.directories);
    const addedDirectories = [...afterDirectories].filter(directory => !beforeDirectories.has(directory)).sort();
    const removedDirectories = [...beforeDirectories].filter(directory => !afterDirectories.has(directory)).sort();
    const canonicalJsonChanged = before.json.sha256 !== after.json.sha256;
    return {
        changed: canonicalJsonChanged
            || addedFiles.length > 0
            || removedFiles.length > 0
            || changedFiles.length > 0
            || addedDirectories.length > 0
            || removedDirectories.length > 0,
        canonicalJsonChanged,
        addedFiles,
        removedFiles,
        changedFiles,
        addedDirectories,
        removedDirectories,
    };
}
