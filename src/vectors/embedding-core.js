/**
 * How a local transformers.js pipeline turns one text into a vector. Runs inside the
 * embedding worker thread (see embedding-worker.js); kept apart so it can be tested
 * without a model.
 */

/**
 * Attention memory grows with the square of the input length. Models such as jina-v2 accept
 * 8192 tokens, where one embedding takes several GB of native memory (measured with jina-v2:
 * +0.5 GB at 2k tokens, +1.9 GB at 4k, several GB at 8k), and concurrent requests stack.
 * Texts up to this length are embedded exactly as before; longer ones are embedded in windows
 * of at most this many tokens, combined by token count. Windowed vectors differ from
 * whole-text ones, so the limit is high enough that ordinary chat and lorebook chunks never
 * reach it.
 */
export const MAX_WINDOW_TOKENS = 2048;

/**
 * @param {any} pipe
 * @param {string} text
 */
function countTokens(pipe, text) {
    return pipe.tokenizer(text).input_ids.size;
}

/**
 * Splits text into pieces of at most MAX_WINDOW_TOKENS tokens, cutting near the middle at a
 * line break or sentence end when one is close.
 * @param {any} pipe
 * @param {string} text
 * @returns {{ text: string, tokens: number }[]}
 */
export function splitToWindows(pipe, text) {
    const tokens = countTokens(pipe, text);
    if (tokens <= MAX_WINDOW_TOKENS || text.length < 2) {
        return [{ text, tokens }];
    }
    const middle = Math.floor(text.length / 2);
    const reach = Math.floor(text.length / 10);
    let cut = middle;
    for (let offset = 0; offset <= reach; offset++) {
        if (/[\n。！？.!?]/.test(text[middle + offset] ?? '')) { cut = middle + offset + 1; break; }
        if (/[\n。！？.!?]/.test(text[middle - offset] ?? '')) { cut = middle - offset + 1; break; }
    }
    return [...splitToWindows(pipe, text.slice(0, cut)), ...splitToWindows(pipe, text.slice(cut))];
}

/**
 * Gets the vector of a text in form of an array of numbers.
 * @param {any} pipe Feature-extraction pipeline
 * @param {string} text The text to vectorize
 * @returns {Promise<number[]>}
 */
export async function embedText(pipe, text) {
    const windows = splitToWindows(pipe, text);
    if (windows.length === 1) {
        // Same call as before for ordinary texts, so stored vectors stay comparable.
        const result = await pipe(text, { pooling: 'mean', normalize: true });
        return Array.from(result.data);
    }
    let sum = null;
    let total = 0;
    for (const window of windows) {
        const result = await pipe(window.text, { pooling: 'mean', normalize: false });
        const data = result.data;
        sum ??= new Float64Array(data.length);
        for (let i = 0; i < data.length; i++) sum[i] += data[i] * window.tokens;
        total += window.tokens;
    }
    const mean = Array.from(sum, value => value / total);
    const norm = Math.hypot(...mean) || 1;
    return mean.map(value => value / norm);
}
