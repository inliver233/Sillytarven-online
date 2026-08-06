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
    const estimatorSource = extractFunction(tokenizerSource, 'estimateOpenAIMessageTokens');
    const counterSource = extractFunction(tokenizerSource, 'countTokensOpenAIAsync').replace(/^export\s+/, '');

    return Function('dependencies', `
        const {
            getStringHash,
            getTokenCacheObject,
            getTokenizerModel,
        } = dependencies;
        ${estimatorSource}
        ${counterSource}
        return countTokensOpenAIAsync;
    `)(dependencies);
}

test('OpenAI token counting estimates cache misses locally and reuses the chat cache', async () => {
    const model = 'provider/model & revision=latest';
    const cache = {};
    let modelReads = 0;
    const countTokens = createTokenCounter({
        getStringHash: value => value,
        getTokenCacheObject: () => cache,
        getTokenizerModel: () => {
            modelReads++;
            return model;
        },
    });

    const messages = [{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }];
    const firstCount = await countTokens(messages, true);
    const secondCount = await countTokens(messages, true);

    assert.ok(firstCount > 0);
    assert.equal(secondCount, firstCount);
    assert.equal(modelReads, 2);
    assert.equal(Object.keys(cache).length, 2);
    assert.ok(Object.keys(cache).every(key => key.startsWith(`${model}-`)));
});

test('OpenAI local estimates stay conservative for ASCII and multibyte content', () => {
    const estimatorSource = extractFunction(tokenizerSource, 'estimateOpenAIMessageTokens');
    const estimate = Function(`${estimatorSource}\nreturn estimateOpenAIMessageTokens;`)();
    const asciiBody = JSON.stringify([{ role: 'user', content: 'plain text' }]);
    const multibyteBody = JSON.stringify([{ role: 'user', content: '格式错误' }]);

    assert.ok(estimate(asciiBody) > Math.ceil(asciiBody.length / 3.35));
    assert.ok(estimate(multibyteBody) >= 4 + 3);
});

test('OpenAI counters no longer issue tokenizer network requests', () => {
    const syncCounterSource = extractFunction(tokenizerSource, 'countTokensOpenAI');
    const asyncCounterSource = extractFunction(tokenizerSource, 'countTokensOpenAIAsync');

    assert.doesNotMatch(syncCounterSource, /jQuery\.ajax|api\/tokenizers/);
    assert.doesNotMatch(asyncCounterSource, /jQuery\.ajax|api\/tokenizers/);
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
