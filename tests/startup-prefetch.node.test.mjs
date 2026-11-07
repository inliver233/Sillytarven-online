import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { STARTUP_REQUESTS, fillStartupPrefetchToken, getStartupPrefetchScript } from '../src/startup-prefetch.js';

/**
 * Runs the prefetch script with a stand-in fetch that records every network request.
 * @param {string} token CSRF token written into the page
 * @param {(url: string, init: object) => Promise<any>} [network] Answers a network request
 */
function runPrefetch(token, network = url => Promise.resolve({ from: 'network', url })) {
    const sent = [];
    const timers = [];
    const context = {
        Response: class {
            constructor(body, init) { this.body = body; this.headers = init?.headers; }
        },
        DOMException: class extends Error {
            constructor(message, name) { super(message); this.name = name; }
        },
        setTimeout: (callback, delay) => timers.push({ callback, delay }),
        Promise,
        String,
        JSON,
    };
    context.fetch = function (url, init) {
        sent.push({ url, init });
        return network(url, init);
    };
    context.window = context;
    const page = fillStartupPrefetchToken(`<head>${getStartupPrefetchScript()}</head>`, token);
    vm.runInNewContext(/<script>([\s\S]*?)<\/script>/.exec(page)[1], context);
    return { fetch: (...args) => context.window.fetch(...args), sent, timers, page };
}

test('the startup reads go out at once, and the app gets them when it asks for the same', async () => {
    const browser = runPrefetch('tok123');
    assert.equal(browser.sent.length, STARTUP_REQUESTS.length);
    const settings = browser.sent.find(request => request.url === '/api/settings/get' && request.init.body === '{}');
    assert.equal(settings.init.method, 'POST');
    assert.equal(settings.init.headers['X-CSRF-Token'], 'tok123');
    assert.equal(settings.init.headers['Content-Type'], 'application/json');
    const secrets = browser.sent.find(request => request.url === '/api/secrets/read');
    assert.equal(secrets.init.body, undefined);
    assert.equal(secrets.init.headers['Content-Type'], undefined, 'no body, no Content-Type, as the app sends it');

    // The same request from the app: answered by the prefetch, nothing more on the network.
    const answer = await browser.fetch('/api/settings/get', { method: 'POST', headers: { 'X-CSRF-Token': 'tok123' }, body: '{}' });
    assert.deepEqual({ ...answer }, { from: 'network', url: '/api/settings/get' });
    assert.equal(browser.sent.length, STARTUP_REQUESTS.length);
    // Used once: asking again is a new request.
    await browser.fetch('/api/settings/get', { method: 'POST', body: '{}' });
    assert.equal(browser.sent.length, STARTUP_REQUESTS.length + 1);

    // A different body, method or URL is not the prefetched request.
    await browser.fetch('/api/settings/get', { method: 'POST', body: '{"fields":["other"]}' });
    await browser.fetch('/api/extensions/discover', { method: 'POST' });
    await browser.fetch('/api/extensions/discover?x=1');
    assert.equal(browser.sent.length, STARTUP_REQUESTS.length + 4);
    await browser.fetch('/api/extensions/discover');
    await browser.fetch('/api/settings/get', { method: 'post', body: '{"fields":["quickReplyPresets"]}' });
    assert.equal(browser.sent.length, STARTUP_REQUESTS.length + 4, 'method case does not matter');

    // The CSRF token is in the page.
    const token = await browser.fetch('/csrf-token');
    assert.equal(JSON.parse(token.body).token, 'tok123');
    assert.equal(browser.sent.length, STARTUP_REQUESTS.length + 4);

    // Unused prefetches are dropped after a while.
    assert.equal(browser.timers.length, 1);
    browser.timers[0].callback();
    await browser.fetch('/version');
    assert.equal(browser.sent.length, STARTUP_REQUESTS.length + 5);
});

test('a prefetch that failed is sent again by the app, and an abort still works', async () => {
    let failing = true;
    const browser = runPrefetch('tok', url => failing ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve({ from: 'retry', url }));
    failing = false;
    const answer = await browser.fetch('/api/secrets/read', { method: 'POST' });
    assert.equal(answer.from, 'retry');

    const controller = new AbortController();
    const pending = browser.fetch('/version', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
});

test('the token is written into the page safely', () => {
    const page = fillStartupPrefetchToken(getStartupPrefetchScript(), 'a"b</script>$&');
    assert.doesNotMatch(page, /<\/script>\$&/);
    assert.match(page, /"token":"a\\"b\\u003c\/script>\$&"/);
    assert.doesNotMatch(page, /st-startup-csrf-token/);
});
