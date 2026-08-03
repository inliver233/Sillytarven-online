import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relativePath => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const tokenizerSource = read('public/scripts/tokenizers.js');
const openaiSource = read('public/scripts/openai.js');

function extractFunction(source, name) {
    const match = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
    assert.ok(match, `${name} must exist`);
    const parametersStart = source.indexOf('(', match.index);
    let parameterDepth = 0;
    let bodyStart = -1;

    for (let index = parametersStart; index < source.length; index++) {
        if (source[index] === '(') parameterDepth++;
        if (source[index] === ')' && --parameterDepth === 0) {
            bodyStart = source.indexOf('{', index);
            break;
        }
    }

    assert.notEqual(bodyStart, -1, `${name} body must exist`);
    let depth = 0;

    for (let index = bodyStart; index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}' && --depth === 0) return source.slice(match.index, index + 1);
    }

    throw new Error(`Could not extract ${name}`);
}

function createTokenCounter(dependencies) {
    const abortErrorSource = extractFunction(tokenizerSource, 'getTokenizerAbortError');
    const abortGuardSource = extractFunction(tokenizerSource, 'throwIfTokenizerAborted');
    const validatorSource = extractFunction(tokenizerSource, 'getValidOpenAITokenCount');
    const estimatorSource = extractFunction(tokenizerSource, 'estimateOpenAIMessageTokens');
    const counterSource = extractFunction(tokenizerSource, 'countTokensOpenAIAsync').replace(/^export\s+/, '');

    return Function('dependencies', `
        const {
            CHARACTERS_PER_TOKEN_RATIO,
            URLSearchParams,
            getStringHash,
            getTokenCacheObject,
            getTokenizerModel,
            jQuery,
        } = dependencies;
        ${abortErrorSource}
        ${abortGuardSource}
        ${validatorSource}
        ${estimatorSource}
        ${counterSource}
        return countTokensOpenAIAsync;
    `)(dependencies);
}

test('OpenAI token counting snapshots and URL-encodes one tokenizer model', async () => {
    const model = 'provider/model & revision=latest';
    const cache = {};
    const requests = [];
    let modelReads = 0;
    const countTokens = createTokenCounter({
        CHARACTERS_PER_TOKEN_RATIO: 3.35,
        URLSearchParams,
        getStringHash: value => value,
        getTokenCacheObject: () => cache,
        getTokenizerModel: () => (++modelReads === 1 ? model : 'changed-model'),
        jQuery: {
            ajax(options) {
                requests.push(options);
                return Promise.resolve({ token_count: 7 });
            },
        },
    });

    assert.equal(await countTokens([{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }], true), 13);
    assert.equal(modelReads, 1);
    assert.equal(requests.length, 2);
    const expectedQuery = new URLSearchParams({ model }).toString();
    assert.ok(requests.every(request => request.url === `/api/tokenizers/openai/count?${expectedQuery}`));
    assert.ok(Object.keys(cache).every(key => key.startsWith(`${model}-`)));
});

test('OpenAI token response validation accepts only finite nonnegative numbers', () => {
    const validatorSource = extractFunction(tokenizerSource, 'getValidOpenAITokenCount');
    const validate = Function(`${validatorSource}\nreturn getValidOpenAITokenCount;`)();

    assert.equal(validate({ token_count: 0 }), 0);
    assert.equal(validate({ token_count: 42 }), 42);
    assert.equal(validate({ token_count: -1 }), null);
    assert.equal(validate({ token_count: Number.NaN }), null);
    assert.equal(validate({ token_count: Number.POSITIVE_INFINITY }), null);
    assert.equal(validate({ token_count: '42' }), null);
    assert.equal(validate(null), null);
});

test('OpenAI local estimates stay conservative for ASCII and multibyte content', () => {
    const estimatorSource = extractFunction(tokenizerSource, 'estimateOpenAIMessageTokens');
    const estimate = Function('CHARACTERS_PER_TOKEN_RATIO', `${estimatorSource}\nreturn estimateOpenAIMessageTokens;`)(3.35);
    const asciiBody = JSON.stringify([{ role: 'user', content: 'plain text' }]);
    const multibyteBody = JSON.stringify([{ role: 'user', content: '格式错误' }]);

    assert.ok(estimate(asciiBody) > Math.ceil(asciiBody.length / 3.35));
    assert.ok(estimate(multibyteBody) >= 4 + 3);
});

test('OpenAI token request and malformed-response failures use uncached local estimates', async t => {
    const cache = {};
    const warnings = [];
    const responses = [
        Promise.reject({ status: 503 }),
        Promise.resolve({ token_count: Number.NaN }),
        Promise.resolve({ token_count: 5 }),
    ];
    const originalWarn = console.warn;
    console.warn = message => warnings.push(message);
    t.after(() => { console.warn = originalWarn; });

    const countTokens = createTokenCounter({
        CHARACTERS_PER_TOKEN_RATIO: 3.35,
        URLSearchParams,
        getStringHash: value => value,
        getTokenCacheObject: () => cache,
        getTokenizerModel: () => 'gpt-4o',
        jQuery: { ajax: () => responses.shift() },
    });

    const messages = [
        { role: 'user', content: 'temporary outage' },
        { role: 'assistant', content: '格式错误' },
        { role: 'user', content: 'valid' },
    ];
    const tokenCount = await countTokens(messages, true);

    assert.ok(Number.isFinite(tokenCount) && tokenCount > 5);
    assert.equal(Object.keys(cache).length, 1);
    assert.ok(Object.keys(cache)[0].includes('"valid"'));
    assert.deepEqual(warnings, [
        'OpenAI token count failed (HTTP 503); using local estimate.',
        'OpenAI token count failed (invalid response); using local estimate.',
    ]);
});

test('OpenAI token counter preserves synchronous programming errors', async () => {
    const expectedError = new TypeError('ajax setup failed');
    const countTokens = createTokenCounter({
        CHARACTERS_PER_TOKEN_RATIO: 3.35,
        URLSearchParams,
        getStringHash: value => value,
        getTokenCacheObject: () => ({}),
        getTokenizerModel: () => 'gpt-4o',
        jQuery: { ajax: () => { throw expectedError; } },
    });

    await assert.rejects(countTokens({ role: 'user', content: 'hello' }, true), error => error === expectedError);
});

test('prompt preparation reports accurate deduplicated errors and records failed state', () => {
    const prepareSource = extractFunction(openaiSource, 'prepareOpenAIMessages');

    assert.match(prepareSource, /console\.error\('Failed to prepare OpenAI prompt:', error\)/);
    assert.doesNotMatch(prepareSource, /unknown error occurred while counting tokens/i);
    assert.doesNotMatch(prepareSource, /error occurred while counting tokens/i);
    assert.match(prepareSource, /unexpected error occurred while preparing the prompt/i);
    assert.equal((prepareSource.match(/preventDuplicates:\s*true/g) || []).length, 3);
    assert.match(prepareSource, /else\s*{[\s\S]*?promptManagerError\s*=\s*t`The prompt could not be prepared\./);
});
