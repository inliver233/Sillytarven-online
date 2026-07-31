import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../config.yaml', import.meta.url)));
const testDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-performance-test-'));
globalThis.DATA_ROOT = testDataRoot;

const { router: performanceRouter } = await import('../src/endpoints/performance.js');
const { default: systemMonitor } = await import('../src/system-monitor.js');
const {
    PerformanceMonitor,
    beginEndpointPerformance,
    finalizeRequestPerformance,
    performanceMonitor,
    performanceRequestStartMiddleware,
} = await import('../src/performance-monitor.js');

after(() => {
    systemMonitor.destroy();
    systemMonitor.saveDataToDisk = () => {};
    fs.rmSync(testDataRoot, { recursive: true, force: true });
});

function createResponse() {
    const headers = new Map();
    return {
        statusCode: 200,
        headersSent: false,
        getHeader(name) {
            return headers.get(String(name).toLowerCase());
        },
        setHeader(name, value) {
            headers.set(String(name).toLowerCase(), value);
        },
    };
}

test('performance monitor retains a bounded aggregate without arbitrary content', () => {
    const monitor = new PerformanceMonitor({
        capacity: 10,
        serverOperations: ['safe-operation'],
        clientOperations: ['safe-client'],
    });

    for (let index = 0; index < 12; index++) {
        assert.equal(monitor.recordServerSample('safe-operation', {
            durationMs: index + 1,
            statusCode: index === 11 ? 500 : 200,
            requestBytes: 10,
            responseBytes: 20,
            phases: { read: index, '../secret': 999 },
            counters: { files: 1, message_text: Number.NaN },
            cacheState: index % 2 ? 'hit' : 'miss',
            secret: 'must not be retained',
        }), true);
    }
    assert.equal(monitor.recordServerSample('unknown-operation', { durationMs: 1 }), false);

    const summary = monitor.getSummary();
    assert.equal(summary.operations.length, 1);
    const operation = summary.operations[0];
    assert.equal(operation.count, 10);
    assert.equal(operation.errors, 1);
    assert.equal(operation.duration.p50, 7);
    assert.equal(operation.duration.p95, 12);
    assert.equal(operation.phases.read.count, 10);
    assert.equal(operation.phases['../secret'], undefined);
    assert.equal(operation.counters.files, 10);
    assert.doesNotMatch(JSON.stringify(summary), /must not be retained/);

    monitor.clear();
    assert.deepEqual(monitor.getSummary().operations, []);
});

test('client telemetry is whitelisted, sanitized, batched, and rate limited', () => {
    const monitor = new PerformanceMonitor({
        capacity: 20,
        clientSamplesPerMinute: 10,
        serverOperations: [],
        clientOperations: ['safe-client'],
        clientCounterNames: { 'safe-client': ['count'] },
    });
    const samples = Array.from({ length: 12 }, (_, index) => ({
        operation: index === 0 ? 'unknown-client' : 'safe-client',
        durationMs: index + 0.5,
        counters: { count: 1 },
        message: 'private content',
    }));

    const result = monitor.recordClientBatch('trusted-user-key', samples);
    assert.deepEqual(result, { accepted: 9, rejected: 3, rateLimited: true });
    const summary = monitor.getSummary();
    assert.equal(summary.operations[0].source, 'client');
    assert.equal(summary.operations[0].count, 9);
    assert.equal(summary.operations[0].counters.count, 9);
    assert.doesNotMatch(JSON.stringify(summary), /private content|trusted-user-key|\.\.\/path/);
});

test('client telemetry enforces operation counters and byte-bounded buckets', () => {
    const monitor = new PerformanceMonitor({
        capacity: 100,
        capacityBytes: 600,
        clientSamplesPerMinute: 100,
        serverOperations: [],
        clientOperations: ['safe-client'],
        clientCounterNames: { 'safe-client': ['count'] },
    });
    const result = monitor.recordClientBatch('user', [
        { operation: 'safe-client', durationMs: 1, counters: { count: 1 } },
        { operation: 'safe-client', durationMs: 2, counters: { unexpected: 1 } },
        { operation: 'safe-client', durationMs: 3, counters: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`key-${index}`, index])) },
        { operation: 'safe-client', durationMs: 4, counters: { count: 'x'.repeat(10_000) } },
    ]);
    assert.deepEqual(result, { accepted: 1, rejected: 3, rateLimited: false });

    for (let index = 0; index < 20; index++) {
        monitor.recordClientBatch('user', [{ operation: 'safe-client', durationMs: index, counters: { count: index } }]);
    }
    const summary = monitor.getSummary();
    assert.ok(summary.operations[0].count < 21);
    assert.ok(summary.operations[0].count > 0);
    assert.equal(summary.capacityBytes, 600);
});

test('default browser operation contract includes every frontend producer', () => {
    const monitor = new PerformanceMonitor();
    const result = monitor.recordClientBatch('user', [
        { operation: 'regex-chat-refresh', durationMs: 1, counters: { requests: 1, merged: 0 } },
        { operation: 'prompt-token-dry-run', durationMs: 2, counters: { requests: 1, merged: 0 } },
        { operation: 'settings-save-serialize', durationMs: 3, counters: { characters: 100, noop: 0 } },
    ]);
    assert.deepEqual(result, { accepted: 3, rejected: 0, rateLimited: false });
});

test('endpoint timer measures phases and response callback emits bounded Server-Timing', async () => {
    performanceMonitor.clear();
    const request = {
        headers: { 'content-length': '123' },
        get(name) {
            return this.headers[String(name).toLowerCase()];
        },
    };
    let calledNext = false;
    performanceRequestStartMiddleware(request, {}, () => { calledNext = true; });
    assert.equal(calledNext, true);

    const timer = beginEndpointPerformance(request, 'version');
    timer.addDuration('git', 1);
    timer.measureSync('sync-work', () => 42);
    await timer.measureAsync('async-work', async () => Promise.resolve());
    const stop = timer.startPhase('serialize');
    stop();
    timer.setCounter('commands', 5);
    timer.increment('commands');
    timer.setCacheState('miss');

    const response = createResponse();
    response.setHeader('Content-Length', '456');
    finalizeRequestPerformance(request, response, 12.3456);
    finalizeRequestPerformance(request, response, 99);

    assert.equal(response.getHeader('X-Response-Time'), '12.346ms');
    assert.match(response.getHeader('Server-Timing'), /^app;dur=12\.3/);
    assert.match(response.getHeader('Server-Timing'), /git;dur=1\.0/);
    assert.match(response.getHeader('Server-Timing'), /cache;desc="miss"/);
    const operation = performanceMonitor.getSummary().operations.find(item => item.operation === 'version');
    assert.equal(operation.count, 1);
    assert.equal(operation.requestBytes.p50, 123);
    assert.equal(operation.responseBytes.p50, 456);
    assert.equal(operation.counters.commands, 6);
});

test('performance summary and clearing are administrator-only', async () => {
    performanceMonitor.clear();
    performanceMonitor.recordServerSample('version', { durationMs: 1, statusCode: 200 });
    const app = express();
    app.use((request, _response, next) => {
        request.user = { profile: { handle: 'test-user', admin: request.get('x-test-admin') === 'yes' } };
        next();
    });
    app.use('/api/performance', performanceRouter);

    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const baseUrl = `http://127.0.0.1:${address.port}/api/performance`;
        const oversizedClientBody = JSON.stringify({ samples: [{ operation: 'ui-long-task', durationMs: 1, padding: 'x'.repeat(70 * 1024) }] });
        const oversizedClientResponse = await fetch(`${baseUrl}/client`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: oversizedClientBody,
        });
        assert.equal(oversizedClientResponse.status, 413);
        assert.equal((await oversizedClientResponse.json()).error, 'telemetry_body_too_large');

        assert.equal((await fetch(`${baseUrl}/summary`)).status, 403);

        const summaryResponse = await fetch(`${baseUrl}/summary`, { headers: { 'x-test-admin': 'yes' } });
        assert.equal(summaryResponse.status, 200);
        assert.match(summaryResponse.headers.get('cache-control') || '', /private, no-store/);
        const summary = await summaryResponse.json();
        assert.equal(summary.operations.length, 1);
        assert.deepEqual(summary.caches.characterLists, { entries: 0, inflight: 0, totalBytes: 0, signatures: 0 });
        assert.deepEqual(summary.caches.settings, { entries: 0, inflight: 0, totalBytes: 0, signatures: 0 });
        assert.deepEqual(summary.caches.recentChats, { entries: 0, inflight: 0, totalBytes: 0, signatures: 0 });

        const cacheClearResponse = await fetch(`${baseUrl}/cache/characters/clear`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-test-admin': 'yes' },
            body: '{}',
        });
        assert.equal(cacheClearResponse.status, 200);
        const settingsCacheClearResponse = await fetch(`${baseUrl}/cache/settings/clear`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-test-admin': 'yes' },
            body: '{}',
        });
        assert.equal(settingsCacheClearResponse.status, 200);
        const recentChatsCacheClearResponse = await fetch(`${baseUrl}/cache/recent-chats/clear`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-test-admin': 'yes' },
            body: '{}',
        });
        assert.equal(recentChatsCacheClearResponse.status, 200);

        const clearResponse = await fetch(`${baseUrl}/clear`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-test-admin': 'yes' },
            body: '{}',
        });
        assert.equal(clearResponse.status, 200);
        assert.deepEqual(performanceMonitor.getSummary().operations, []);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
