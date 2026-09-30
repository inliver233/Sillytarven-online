import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('./fixtures/stcontrol-config.yaml', import.meta.url)));
const {
    requireStcontrolAgent,
    resetStcontrolStateForTests,
    signStcontrolRequest,
} = await import('../src/stcontrol.js');

test('stcontrol agent authentication rejects a replayed nonce', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-stcontrol-auth-'));
    globalThis.DATA_ROOT = root;
    resetStcontrolStateForTests();
    try {
        const body = { handle: 'alice' };
        const timestamp = String(Math.floor(Date.now() / 1000));
        const nonce = '0123456789abcdef0123456789abcdef';
        const signature = signStcontrolRequest('test-agent-psk', 'POST', '/api/stcontrol/internal/test', timestamp, nonce, body);
        const headers = {
            'x-agent-id': '7',
            'x-timestamp': timestamp,
            'x-nonce': nonce,
            'x-signature': signature,
        };
        const request = {
            body,
            method: 'POST',
            path: '/api/stcontrol/internal/test',
            socket: { remoteAddress: '127.0.0.1' },
            get(name) { return headers[name.toLowerCase()]; },
        };
        const statuses = [];
        const response = { sendStatus(status) { statuses.push(status); return this; } };
        let accepted = 0;
        await requireStcontrolAgent(request, response, () => accepted++);
        await requireStcontrolAgent(request, response, () => accepted++);
        assert.equal(accepted, 1);
        assert.deepEqual(statuses, [401]);
    } finally {
        resetStcontrolStateForTests();
        globalThis.DATA_ROOT = previousDataRoot;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('stcontrol agent authentication fails closed when the nonce window is full', async () => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-stcontrol-auth-capacity-'));
    globalThis.DATA_ROOT = root;
    resetStcontrolStateForTests();
    try {
        const now = Math.floor(Date.now() / 1000);
        fs.mkdirSync(path.join(root, '_stcontrol'), { recursive: true });
        fs.writeFileSync(path.join(root, '_stcontrol', 'adapter-state.json'), JSON.stringify({
            version: 6,
            mode: 'managed',
            modeGeneration: 1,
            controllerGeneration: 1,
            reasonCode: 'initial',
            changedAt: new Date().toISOString(),
            nonces: Array.from({ length: 2000 }, (_, index) => ({
                digest: String(index).padStart(64, '0'),
                timestamp: now,
            })),
            operations: {},
            gates: {},
            sessions: {},
            lastActiveOwners: {},
            takeoverChallenges: {},
            pendingSyncUsers: {},
            leases: {},
            leaseConfirmationAt: 0,
        }));
        resetStcontrolStateForTests();

        const body = { handle: 'alice' };
        const timestamp = String(now);
        const nonce = 'fedcba9876543210fedcba9876543210';
        const signature = signStcontrolRequest('test-agent-psk', 'POST', '/api/stcontrol/internal/test', timestamp, nonce, body);
        const headers = {
            'x-agent-id': '7',
            'x-timestamp': timestamp,
            'x-nonce': nonce,
            'x-signature': signature,
        };
        const request = {
            body,
            method: 'POST',
            path: '/api/stcontrol/internal/test',
            socket: { remoteAddress: '127.0.0.1' },
            get(name) { return headers[name.toLowerCase()]; },
        };
        const statuses = [];
        const response = { sendStatus(status) { statuses.push(status); return this; } };
        let accepted = 0;
        await requireStcontrolAgent(request, response, () => accepted++);
        assert.equal(accepted, 0);
        assert.deepEqual(statuses, [401]);
    } finally {
        resetStcontrolStateForTests();
        globalThis.DATA_ROOT = previousDataRoot;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
