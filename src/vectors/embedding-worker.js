/**
 * Worker thread that holds the local embedding model. Loading, using and especially
 * releasing a model on the server's own thread stalled it for seconds (each release forced
 * full garbage collections of a heap of several GB); here the model lives in a small heap of
 * its own and is released by ending the thread. Started by embedding.js.
 */
import { parentPort, workerData } from 'node:worker_threads';

import { env, pipeline } from '@xenova/transformers';

import { embedText } from './embedding-core.js';

// Same runtime settings as src/transformers.js
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = workerData.onnxWasmPaths;

/** @type {Promise<any>|null} */
let loading = null;

function getPipe() {
    if (!loading) {
        const { task, model, cacheDir, quantized, localOnly } = workerData;
        console.log('Initializing transformers.js pipeline for task', task, 'with model', model, '(worker thread)');
        loading = pipeline(task, model, { cache_dir: cacheDir, quantized, local_files_only: localOnly });
        // A failed load is tried again by the next request
        loading.catch(() => { loading = null; });
    }
    return loading;
}

parentPort.on('message', async ({ id, text }) => {
    try {
        const vector = await embedText(await getPipe(), text);
        parentPort.postMessage({ id, vector });
    } catch (error) {
        parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
});
