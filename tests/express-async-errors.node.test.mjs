import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import express from 'express';

import { forwardAsyncRouteErrors, requestErrorHandler } from '../src/express-async-errors.js';

forwardAsyncRouteErrors();
forwardAsyncRouteErrors();

const unhandled = [];
const onUnhandled = error => unhandled.push(error);
process.on('unhandledRejection', onUnhandled);
after(() => process.off('unhandledRejection', onUnhandled));

const errorLog = [];
const originalError = console.error;
console.error = (...args) => errorLog.push(args.map(String).join(' '));
after(() => { console.error = originalError; });

// Without the fix the request never gets an answer: fail fast instead of hanging.
const fetch = (url, options = {}) => globalThis.fetch(url, { signal: AbortSignal.timeout(3000), ...options });

async function startApp(configure) {
    const app = express();
    app.use(express.json());
    configure(app);
    app.use((_request, response) => response.sendStatus(404));
    app.use(requestErrorHandler);
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const url = route => `http://127.0.0.1:${server.address().port}${route}`;
    return { url, close: () => new Promise(resolve => server.close(resolve)) };
}

test('an async route that throws fails the request, not the process', async t => {
    const router = express.Router();
    router.post('/generate', async (request, response) => {
        // What /api/backends/kobold/generate did with an empty body.
        if (request.body.api_server.indexOf('localhost') !== -1) {
            return response.send('unreachable');
        }
        return response.send('ok');
    });
    router.post('/later', async (_request, response) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        throw new Error('failed after an await');
    });
    const app = await startApp(application => application.use('/api', router));
    t.after(() => app.close());

    for (const route of ['/api/generate', '/api/later']) {
        const response = await fetch(app.url(route), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.equal(response.status, 500, route);
        const body = await response.text();
        assert.doesNotMatch(body, /at |TypeError|\.js:/, 'no stack trace for the client');
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.ok(errorLog.some(line => line.includes('POST /api/generate')), 'the failure is logged');
});

test('synchronous throws and client errors keep their status', async t => {
    const app = await startApp(application => {
        application.get('/sync', () => { throw new Error('sync failure'); });
        application.get('/teapot', () => { throw Object.assign(new Error('short and stout'), { status: 418 }); });
        application.post('/json', (request, response) => response.send(request.body));
    });
    t.after(() => app.close());

    assert.equal((await fetch(app.url('/sync'))).status, 500);
    assert.equal((await fetch(app.url('/teapot'))).status, 418);
    const invalidJson = await fetch(app.url('/json'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(invalidJson.status, 400);
    assert.equal((await fetch(app.url('/missing'))).status, 404);
});

test('a response already under way is closed, and later requests still work', async t => {
    const app = await startApp(application => {
        application.get('/stream', async (_request, response) => {
            response.write('data: partial\n\n');
            await new Promise(resolve => setTimeout(resolve, 5));
            throw new Error('stream broke');
        });
        application.get('/ok', async (_request, response) => response.send('ok'));
    });
    t.after(() => app.close());

    const stream = await fetch(app.url('/stream'));
    await assert.rejects(stream.text());
    assert.equal(await (await fetch(app.url('/ok'))).text(), 'ok');
    assert.deepEqual(unhandled, []);
});

test('async error handlers are covered too', async t => {
    const app = await startApp(application => {
        application.get('/boom', () => { throw new Error('first'); });
        // eslint-disable-next-line no-unused-vars
        application.use(async (error, _request, _response, _next) => { throw new Error('error handler failed'); });
    });
    t.after(() => app.close());

    assert.equal((await fetch(app.url('/boom'))).status, 500);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
});
