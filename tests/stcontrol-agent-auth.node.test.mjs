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
