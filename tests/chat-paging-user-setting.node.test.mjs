import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    CHAT_PAGE_SIZE_DEFAULT,
    CHAT_PAGE_SIZE_MAX,
    resolveChatPagingPageSize,
} from '../public/scripts/chat-paging-settings.js';

test('chat paging derives its initial page size from the saved user setting', () => {
    assert.equal(resolveChatPagingPageSize(100), 100);
    assert.equal(resolveChatPagingPageSize('35'), 35);
    assert.equal(resolveChatPagingPageSize(1.9), 1);
    assert.equal(resolveChatPagingPageSize(5000), CHAT_PAGE_SIZE_MAX);
    assert.equal(resolveChatPagingPageSize('invalid'), CHAT_PAGE_SIZE_DEFAULT);
    assert.equal(resolveChatPagingPageSize(-1), CHAT_PAGE_SIZE_DEFAULT);
});

test('a zero chat history setting means load all messages without paging', () => {
    assert.equal(resolveChatPagingPageSize(0), null);

    const script = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
    assert.match(script, /chatPagingState\.enabled && resolveChatPagingPageSize\(power_user\.chat_truncation\) !== null/);
    assert.match(script, /if \(isChatPagingEnabled\(\)\)/);
});
