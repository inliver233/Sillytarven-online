/**
 * The app asks the server for its startup data one request after another (CSRF
 * token, version, secrets, settings, extensions, ...), each waiting for the one
 * before. Far from the server every request costs a round trip, so the page
 * sends these requests itself as soon as it starts to load, all at once and
 * while the modules are still downloading, and hands each response to the app
 * when the app asks for exactly the same thing.
 *
 * Only reads that every start makes, always the same, are on the list (not the
 * passkey list, asked for only until the user was offered a passkey): a response is
 * used once, for the same method, URL and body; anything else, or a prefetch
 * that failed, goes to the network as before. The CSRF token is written into
 * the page, so asking for it costs nothing.
 */

/**
 * [method, URL, body] of the startup reads, as the app sends them. A POST
 * without a body is sent with no Content-Type, as the app does.
 * @type {ReadonlyArray<[string, string, string|null]>}
 */
export const STARTUP_REQUESTS = Object.freeze([
    ['GET', '/version', null],
    ['GET', '/api/passkeys/config', null],
    ['POST', '/api/secrets/read', null],
    ['GET', '/api/free-gemini-channels', null],
    ['POST', '/api/settings/get', '{}'],
    ['POST', '/api/settings/get', '{"fields":["quickReplyPresets"]}'],
    ['GET', '/api/users/me', null],
    ['GET', '/api/users/feedback-link', null],
    ['GET', '/api/extensions/discover', null],
    ['POST', '/api/git-sync/state', '{}'],
    ['POST', '/api/avatars/get', null],
    ['POST', '/api/groups/all', null],
    ['POST', '/api/backgrounds/all', '{}'],
    ['POST', '/api/backgrounds/folders', '{}'],
    ['POST', '/api/image-metadata/all', '{"prefix":"backgrounds/"}'],
    ['GET', '/api/input-drafts?key=none', null],
    ['GET', '/api/announcements/current', null],
]);

/** Stands in for the user's CSRF token in the cached page; replaced per request. */
const TOKEN_PLACEHOLDER = 'st-startup-csrf-token';

/** How long an unused prefetched response is kept for the app. */
const PREFETCH_TTL_MS = 120_000;

/**
 * @returns {string} Inline script that starts the startup requests and serves them to the app
 */
export function getStartupPrefetchScript() {
    const options = JSON.stringify({ token: TOKEN_PLACEHOLDER, requests: STARTUP_REQUESTS, ttl: PREFETCH_TTL_MS });
    return `<script>(function (o) {
        var nativeFetch = window.fetch;
        if (typeof nativeFetch !== 'function' || typeof Response !== 'function') return;
        var pending = {};
        var keyOf = function (method, url, body) { return method + ' ' + url + ' ' + (body == null ? '' : body); };
        o.requests.forEach(function (request) {
            var headers = { 'X-CSRF-Token': o.token };
            if (request[2] !== null) headers['Content-Type'] = 'application/json';
            var response = nativeFetch(request[1], { method: request[0], headers: headers, body: request[2] === null ? undefined : request[2], cache: 'no-cache', credentials: 'same-origin' });
            // A failed prefetch is never reported: the app's own request goes out instead.
            response.catch(function () {});
            pending[keyOf(request[0], request[1], request[2])] = response;
        });
        pending[keyOf('GET', '/csrf-token', null)] = Promise.resolve(new Response(JSON.stringify({ token: o.token }), { headers: { 'Content-Type': 'application/json' } }));
        setTimeout(function () { pending = {}; }, o.ttl);
        window.fetch = function (input, init) {
            var body = init && init.body;
            if (typeof input === 'string' && (body == null || typeof body === 'string')) {
                var key = keyOf(String(init && init.method || 'GET').toUpperCase(), input, body);
                var prefetched = pending[key];
                if (prefetched) {
                    delete pending[key];
                    var self = this, args = arguments, signal = init && init.signal;
                    var answer = prefetched.then(null, function () { return nativeFetch.apply(self, args); });
                    if (!signal) return answer;
                    return new Promise(function (resolve, reject) {
                        var abort = function () { reject(signal.reason || new DOMException('The operation was aborted.', 'AbortError')); };
                        if (signal.aborted) return abort();
                        signal.addEventListener('abort', abort);
                        answer.then(resolve, reject);
                    });
                }
            }
            return nativeFetch.apply(this, arguments);
        };
    })(${options});</script>`;
}

/**
 * @param {string} page Page with the prefetch script
 * @param {string} token The user's CSRF token
 * @returns {string} Page for this user
 */
export function fillStartupPrefetchToken(page, token) {
    // JSON-escaped, and a function, so "$&" in it is not read as a replacement pattern.
    const value = JSON.stringify(String(token)).slice(1, -1).replace(/</g, '\\u003c');
    return page.replace(`"token":"${TOKEN_PLACEHOLDER}"`, () => `"token":"${value}"`);
}
