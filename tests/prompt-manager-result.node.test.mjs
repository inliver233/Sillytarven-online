import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromptManagerContextIdentity } from '../public/scripts/util/prompt-manager-context.js';
import { commitPromptManagerResult, createPromptManagerResult } from '../public/scripts/util/prompt-manager-result.js';

test('prompt manager result preserves completion identity and normalizes errors', () => {
    const chatCompletion = { id: 'latest' };
    const result = createPromptManagerResult(chatCompletion, undefined);

    assert.equal(result.chatCompletion, chatCompletion);
    assert.equal(result.error, null);
    assert.equal(Object.isFrozen(result), true);
});

test('prompt manager result commits error state before completion state', () => {
    const calls = [];
    const promptManager = {
        error: 'old',
        setChatCompletion(chatCompletion) {
            calls.push({ chatCompletion, error: this.error });
        },
    };
    const chatCompletion = { id: 'version-4' };

    assert.equal(commitPromptManagerResult(promptManager, createPromptManagerResult(chatCompletion, 'new error')), true);
    assert.deepEqual(calls, [{ chatCompletion, error: 'new error' }]);
});

test('prompt manager result rejects incomplete targets and results', () => {
    assert.equal(commitPromptManagerResult(null, null), false);
    assert.equal(commitPromptManagerResult({}, { chatCompletion: {} }), false);
    assert.equal(commitPromptManagerResult({ setChatCompletion() {} }, null), false);
});

test('prompt manager dry-run identity covers chat, character, API source, model, and switch state', () => {
    const base = {
        chatIdentity: 'character:a|group:|chat:first',
        activeCharacterId: 'a',
        mainApi: 'openai',
        backgroundTokensEnabled: true,
        serviceSettings: {
            chat_completion_source: 'openrouter',
            openrouter_model: 'model-a',
            openai_model: 'unused-model',
        },
    };
    const identity = createPromptManagerContextIdentity(base);

    for (const changed of [
        { chatIdentity: 'character:b|group:|chat:second' },
        { activeCharacterId: 'b' },
        { mainApi: 'textgenerationwebui' },
        { backgroundTokensEnabled: false },
        { serviceSettings: { ...base.serviceSettings, chat_completion_source: 'openai' } },
        { serviceSettings: { ...base.serviceSettings, openrouter_model: 'model-b' } },
    ]) {
        assert.notEqual(createPromptManagerContextIdentity({ ...base, ...changed }), identity);
    }
    assert.equal(createPromptManagerContextIdentity({
        ...base,
        serviceSettings: { ...base.serviceSettings, temperature: 0.5 },
    }), identity);
});
