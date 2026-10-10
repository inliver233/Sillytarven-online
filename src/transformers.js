import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import v8 from 'node:v8';
import vm from 'node:vm';
import { Buffer } from 'node:buffer';

import { pipeline, env, RawImage } from '@xenova/transformers';
import { getConfigValue } from './util.js';
import { serverDirectory } from './server-directory.js';

configureTransformers();

function configureTransformers() {
    // Limit the number of threads to 1 to avoid issues on Android
    env.backends.onnx.wasm.numThreads = 1;
    // Keep the JavaScript runtime and its WASM binaries on the same locked
    // onnxruntime-web version. The transformers package also bundles older
    // WASM files; mixing those with the security-updated runtime fails only
    // when the first model is loaded.
    const onnxWasmDirectory = path.join(serverDirectory, 'node_modules', 'onnxruntime-web', 'dist');
    if (!fs.existsSync(onnxWasmDirectory)) {
        throw new Error('The locked onnxruntime-web WASM directory is missing');
    }
    env.backends.onnx.wasm.wasmPaths = onnxWasmDirectory + path.sep;
}

const tasks = {
    'text-classification': {
        defaultModel: 'Cohee/distilbert-base-uncased-go-emotions-onnx',
        pipeline: null,
        configField: 'extensions.models.classification',
        quantized: true,
    },
    'image-to-text': {
        defaultModel: 'Xenova/vit-gpt2-image-captioning',
        pipeline: null,
        configField: 'extensions.models.captioning',
        quantized: true,
    },
    'feature-extraction': {
        defaultModel: 'Xenova/all-mpnet-base-v2',
        pipeline: null,
        configField: 'extensions.models.embedding',
        quantized: true,
    },
    'automatic-speech-recognition': {
        defaultModel: 'Xenova/whisper-small',
        pipeline: null,
        configField: 'extensions.models.speechToText',
        quantized: true,
    },
    'text-to-speech': {
        defaultModel: 'Xenova/speecht5_tts',
        pipeline: null,
        configField: 'extensions.models.textToSpeech',
        quantized: false,
    },
};

/**
 * Gets a RawImage object from a base64-encoded image.
 * @param {string} image Base64-encoded image
 * @returns {Promise<RawImage|null>} Object representing the image
 */
export async function getRawImage(image) {
    try {
        const buffer = Buffer.from(image, 'base64');
        const byteArray = new Uint8Array(buffer);
        const blob = new Blob([byteArray]);

        const rawImage = await RawImage.fromBlob(blob);
        return rawImage;
    } catch {
        return null;
    }
}

/**
 * Gets the model to use for a given transformers.js task.
 * @param {string} task The task to get the model for
 * @returns {string} The model to use for the given task
 */
function getModelForTask(task) {
    const defaultModel = tasks[task].defaultModel;

    try {
        const model = getConfigValue(tasks[task].configField, null);
        return model || defaultModel;
    } catch (error) {
        console.warn('Failed to read config.yaml, using default classification model.');
        return defaultModel;
    }
}

async function migrateCacheToDataDir() {
    const oldCacheDir = path.join(process.cwd(), 'cache');
    const newCacheDir = path.join(globalThis.DATA_ROOT, '_cache');

    if (!fs.existsSync(newCacheDir)) {
        fs.mkdirSync(newCacheDir, { recursive: true });
    }

    if (fs.existsSync(oldCacheDir) && fs.statSync(oldCacheDir).isDirectory()) {
        const files = fs.readdirSync(oldCacheDir);

        if (files.length === 0) {
            return;
        }

        console.log('Migrating model cache files to data directory. Please wait...');

        for (const file of files) {
            try {
                const oldPath = path.join(oldCacheDir, file);
                const newPath = path.join(newCacheDir, file);
                fs.cpSync(oldPath, newPath, { recursive: true, force: true });
                fs.rmSync(oldPath, { recursive: true, force: true });
            } catch (error) {
                console.warn('Failed to migrate cache file. The model will be re-downloaded.', error);
            }
        }
    }
}

/**
 * Gets the transformers.js pipeline for a given task.
 * @param {import('@xenova/transformers').PipelineType} task The task to get the pipeline for
 * @param {string} forceModel The model to use for the pipeline, if any
 * @returns {Promise<import('@xenova/transformers').Pipeline>} The transformers.js pipeline
 */
export async function getPipeline(task, forceModel = '') {
    await migrateCacheToDataDir();

    if (tasks[task].pipeline) {
        if (forceModel === '' || tasks[task].currentModel === forceModel) {
            touchPipeline(task);
            return tasks[task].pipeline;
        }
        console.log('Disposing transformers.js pipeline for for task', task, 'with model', tasks[task].currentModel);
        await tasks[task].pipeline.dispose();
    }

    const cacheDir = path.join(globalThis.DATA_ROOT, '_cache');
    const model = forceModel || getModelForTask(task);
    const localOnly = !getConfigValue('extensions.models.autoDownload', true, 'boolean');
    console.log('Initializing transformers.js pipeline for task', task, 'with model', model);
    const instance = await pipeline(task, model, { cache_dir: cacheDir, quantized: tasks[task].quantized ?? true, local_files_only: localOnly });
    tasks[task].pipeline = instance;
    tasks[task].currentModel = model;
    touchPipeline(task);
    // @ts-ignore
    return instance;
}

/** A model nobody has used for this long is released, and loaded again on next use. */
const PIPELINE_IDLE_RELEASE_MS = 10 * 60 * 1000;

/** @type {Record<string, {touch: () => void}>} */
const idleReleases = {};

/**
 * Calls `release` once `touch` has not been called for `delayMs`.
 * @param {number} delayMs Idle time before releasing
 * @param {() => unknown} release Release callback
 * @returns {{touch: () => void}} Call `touch` on every use
 */
export function createIdleRelease(delayMs, release) {
    /** @type {NodeJS.Timeout|null} */
    let timer = null;
    return {
        touch() {
            if (timer) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => {
                timer = null;
                release();
            }, delayMs);
            // An idle model must not keep a process (or a script) alive.
            timer.unref();
        },
    };
}

function touchPipeline(task) {
    idleReleases[task] ??= createIdleRelease(PIPELINE_IDLE_RELEASE_MS, () => releasePipeline(task));
    idleReleases[task].touch();
}

/** @type {(() => void)|null} */
let collectGarbageNow = null;

/**
 * Runs a few full garbage collections, letting native finalizers run in between.
 * onnxruntime-node 1.14 cannot release a session itself (dispose() does nothing): the
 * native session and its memory arena, which grows with the longest input seen (GBs
 * for long texts), are freed only when V8 collects the session's JS wrapper. V8 cannot
 * see that native memory, so on its own it may never collect it.
 */
async function collectGarbage() {
    if (!collectGarbageNow) {
        if (typeof globalThis.gc === 'function') {
            collectGarbageNow = globalThis.gc;
        } else {
            v8.setFlagsFromString('--expose-gc');
            collectGarbageNow = vm.runInNewContext('gc');
            v8.setFlagsFromString('--no-expose-gc');
        }
    }
    for (let i = 0; i < 4; i++) {
        collectGarbageNow();
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

/**
 * Releases a task's pipeline and the native memory of its model.
 * @param {string} task Pipeline task
 * @returns {Promise<void>}
 */
export async function releasePipeline(task) {
    let instance = tasks[task]?.pipeline;
    if (!instance) {
        return;
    }
    tasks[task].pipeline = null;
    console.log('Releasing idle transformers.js pipeline for task', task, 'with model', tasks[task].currentModel);
    try {
        await instance.dispose();
        // This suspended function would otherwise keep the model reachable during the collections.
        instance = null;
        await collectGarbage();
    } catch (error) {
        console.warn('Failed to release transformers.js pipeline', error);
    }
}

export default {
    getRawImage,
    getPipeline,
};
