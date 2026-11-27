import { Worker } from 'node:worker_threads';

import { createIdleRelease, getPipelineOptions } from '../transformers.js';

const TASK = 'feature-extraction';

/** A model nobody has used for this long is released (its thread ends), and loaded again on next use. */
const IDLE_RELEASE_MS = 10 * 60 * 1000;

/** One text takes seconds (a window of 2048 tokens about one); one that takes this long ends the thread. */
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * @typedef {object} EmbeddingThread
 * @property {Worker} thread
 * @property {string} key Options the thread was started with
 * @property {Record<string, any>} options
 * @property {Map<number, {resolve: (vector: number[]) => void, reject: (error: Error) => void, timer: NodeJS.Timeout}>} pending
 * @property {boolean} ended
 */

/**
 * Embeds texts in a worker thread, started on first use and ended after idleMs without use.
 * Loading, using and especially releasing a model on the server's own thread stalled every
 * request for seconds: a release forced full garbage collections of the whole server heap.
 * A thread that crashes or takes longer than timeoutMs is ended; the next request starts a new one.
 * @param {object} config
 * @param {URL} config.workerUrl Worker script (embedding-worker.js)
 * @param {number} config.idleMs Idle time before the thread ends
 * @param {number} config.timeoutMs Longest time for one request
 */
export function createEmbeddingWorker({ workerUrl, idleMs, timeoutMs }) {
    /** @type {EmbeddingThread|null} */
    let current = null;
    let nextId = 1;

    /**
     * @param {EmbeddingThread} state
     * @param {Error} reason Given to the requests still waiting
     */
    const end = (state, reason) => {
        if (current === state) current = null;
        for (const request of state.pending.values()) {
            clearTimeout(request.timer);
            request.reject(reason);
        }
        state.pending.clear();
        if (!state.ended) {
            state.ended = true;
            void state.thread.terminate();
        }
    };

    const idle = createIdleRelease(idleMs, () => {
        const state = current;
        if (!state || state.pending.size) return;
        console.log('Releasing idle transformers.js pipeline for task', state.options.task, 'with model', state.options.model, '(worker thread)');
        end(state, new Error('The embedding thread was released'));
    });

    /**
     * @param {Record<string, any>} options workerData
     * @returns {EmbeddingThread}
     */
    const start = options => {
        const thread = new Worker(workerUrl, { workerData: options });
        /** @type {EmbeddingThread} */
        const state = { thread, key: JSON.stringify(options), options, pending: new Map(), ended: false };
        thread.on('message', ({ id, vector, error }) => {
            const request = state.pending.get(id);
            if (!request) return;
            state.pending.delete(id);
            clearTimeout(request.timer);
            // An idle thread must not keep the process alive
            if (!state.pending.size) thread.unref();
            if (error) request.reject(new Error(error));
            else request.resolve(vector);
        });
        thread.on('error', error => end(state, error));
        thread.on('exit', code => {
            state.ended = true;
            end(state, new Error(`The embedding thread stopped (exit code ${code})`));
        });
        thread.unref();
        return state;
    };

    return {
        /** Whether a thread is running */
        get running() {
            return Boolean(current);
        },
        /**
         * Embeds one text.
         * @param {Record<string, any>} options Pipeline options (other options restart the thread)
         * @param {string} text Text to embed
         * @returns {Promise<number[]>}
         */
        run(options, text) {
            const key = JSON.stringify(options);
            if (current && current.key !== key) {
                end(current, new Error('The embedding model changed'));
            }
            current ??= start(options);
            const state = current;
            idle.touch();
            return new Promise((resolve, reject) => {
                const id = nextId++;
                const timer = setTimeout(() => end(state, new Error('Local embedding took too long; the embedding thread was ended')), timeoutMs);
                timer.unref();
                state.pending.set(id, { resolve, reject, timer });
                state.thread.ref();
                state.thread.postMessage({ id, text });
            }).finally(() => idle.touch());
        },
        /** Ends the thread now. */
        stop() {
            if (current) end(current, new Error('The embedding thread was stopped'));
        },
    };
}

const embeddingWorker = createEmbeddingWorker({
    workerUrl: new URL('./embedding-worker.js', import.meta.url),
    idleMs: IDLE_RELEASE_MS,
    timeoutMs: REQUEST_TIMEOUT_MS,
});

/** One embedding at a time across all requests, so native memory peaks never add up. */
let queue = Promise.resolve();
function exclusive(work) {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
}

/**
 * Gets the vectorized text in form of an array of numbers.
 * @param {string} text - The text to vectorize
 * @returns {Promise<number[]>} - The vectorized text in form of an array of numbers
 */
export function getTransformersVector(text) {
    return exclusive(async () => embeddingWorker.run(await getPipelineOptions(TASK), text));
}

/**
 * Gets the vectorized texts in form of an array of arrays of numbers.
 * @param {string[]} texts - The texts to vectorize
 * @returns {Promise<number[][]>} - The vectorized texts in form of an array of arrays of numbers
 */
export async function getTransformersBatchVector(texts) {
    const result = [];
    for (const text of texts) {
        result.push(await getTransformersVector(text));
    }
    return result;
}
