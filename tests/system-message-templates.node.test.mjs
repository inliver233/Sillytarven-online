import assert from 'node:assert/strict';
import test from 'node:test';

import { renderSystemMessageTemplates } from '../public/scripts/system-message-templates.js';

const expectedCalls = [
    ['help', undefined],
    ['hotkeys', undefined],
    ['formatting', undefined],
    ['welcome', { displayVersion: 'SillyTavern 1.15.0' }],
    ['welcomePrompt', undefined],
    ['assistantNote', undefined],
];

test('system message templates start together and preserve their named results', async () => {
    const calls = [];
    const pending = new Map();
    const renderTemplate = (templateId, templateData) => {
        calls.push([templateId, templateData]);
        return new Promise(resolve => pending.set(templateId, resolve));
    };

    const rendering = renderSystemMessageTemplates(renderTemplate, 'SillyTavern 1.15.0');
    assert.deepEqual(calls, expectedCalls);
    assert.equal(pending.size, expectedCalls.length);

    for (const [templateId] of [...expectedCalls].reverse()) {
        pending.get(templateId)(`rendered:${templateId}`);
    }

    assert.deepEqual(await rendering, {
        help: 'rendered:help',
        hotkeys: 'rendered:hotkeys',
        formatting: 'rendered:formatting',
        welcome: 'rendered:welcome',
        welcomePrompt: 'rendered:welcomePrompt',
        assistantNote: 'rendered:assistantNote',
    });
});

test('system message template failures reject only after all fixed requests start', async () => {
    const calls = [];
    const renderTemplate = async (templateId, templateData) => {
        calls.push([templateId, templateData]);
        if (templateId === 'formatting') {
            throw new Error('template unavailable');
        }
        return `rendered:${templateId}`;
    };

    await assert.rejects(
        renderSystemMessageTemplates(renderTemplate, 'SillyTavern 1.15.0'),
        /template unavailable/,
    );
    assert.deepEqual(calls, expectedCalls);
});
