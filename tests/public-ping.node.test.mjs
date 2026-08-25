import assert from 'node:assert/strict';
import test from 'node:test';

import publicPingMiddleware from '../src/middleware/publicPing.js';

test('public ping permits credential-free cross-origin latency probes only through its empty response', () => {
    const headers = new Map();
    let status = 0;
    let ended = false;
    const response = {
        setHeader(name, value) { headers.set(name.toLowerCase(), value); },
        status(value) { status = value; return this; },
        end() { ended = true; return this; },
    };

    publicPingMiddleware({}, response);

    assert.equal(status, 204);
    assert.equal(ended, true);
    assert.equal(headers.get('access-control-allow-origin'), '*');
    assert.equal(headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(headers.get('cache-control'), 'no-store');
    assert.equal(headers.has('access-control-allow-credentials'), false);
});
