import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { matchesAccountResetUsername } from '../src/account-reset.js';

test('account reset confirmation accepts only the signed-in username', () => {
    assert.equal(matchesAccountResetUsername('alice', 'alice'), true);
    assert.equal(matchesAccountResetUsername('Alice', 'alice'), false);
    assert.equal(matchesAccountResetUsername('not-alice', 'alice'), false);
    assert.equal(matchesAccountResetUsername('', 'alice'), false);
    assert.equal(matchesAccountResetUsername(null, 'alice'), false);
});

test('reset everything submits a username and no longer requests a console code', () => {
    const client = fs.readFileSync(new URL('../public/scripts/user.js', import.meta.url), 'utf8');
    const template = fs.readFileSync(new URL('../public/scripts/templates/userReset.html', import.meta.url), 'utf8');
    const endpoint = fs.readFileSync(new URL('../src/endpoints/users-private.js', import.meta.url), 'utf8');

    assert.match(client, /JSON\.stringify\(\{ username \}\)/);
    assert.doesNotMatch(client, /reset-step1/);
    assert.match(template, /name="username"/);
    assert.doesNotMatch(template, /name="code"|name="password"/);
    assert.match(endpoint, /normalizeHandle\(request\.body\.username\)/);
    assert.match(endpoint, /matchesAccountResetUsername\(normalizedUsername, request\.user\.profile\.handle\)/);
    assert.doesNotMatch(endpoint, /RESET_CACHE|resetCode|request\.body\.code/);
});
