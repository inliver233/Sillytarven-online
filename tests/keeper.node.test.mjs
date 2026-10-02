import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Sharing a listening socket between processes works differently on Windows;
// the keeper is meant for the Linux servers.
const skip = process.platform === 'win32' ? 'the keeper runs on Linux servers' : false;

const keeperPath = fileURLToPath(new URL('../keeper.js', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/keeper-server.mjs', import.meta.url));

function freePort() {
    return new Promise(resolve => {
        const server = net.createServer().listen(0, '127.0.0.1', () => {
            const { port } = /** @type {net.AddressInfo} */ (server.address());
            server.close(() => resolve(port));
        });
    });
}

async function startKeeper(mode = 'parallel') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-keeper-'));
    const port = await freePort();
    const state = path.join(root, 'counter');
    const keeper = spawn(process.execPath, [keeperPath], {
        env: { ...process.env, ST_KEEPER_SERVER_SCRIPT: fixture, ST_KEEPER_RELOAD_MODE: mode, KEEPER_TEST_PORT: String(port), KEEPER_TEST_STATE: state },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    keeper.stdout.on('data', chunk => { log += chunk; });
    keeper.stderr.on('data', chunk => { log += chunk; });
    // A new connection per request, as nginx proxies to the server.
    const get = (route = '/', { method = 'GET' } = {}) => new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, path: route, method, agent: false, headers: { 'content-length': 0 } }, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve(body));
            response.on('error', reject);
        });
        request.on('error', error => reject(new Error(`${method} ${route}: ${error.code ?? error.message}`)));
        request.end();
    });
    const waitFor = async (check, what) => {
        for (let i = 0; i < 300; i++) {
            try {
                if (await check()) return;
            } catch {
                // Not up yet.
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.fail(`timed out waiting for ${what}\n${log}`);
    };
    await waitFor(async () => (await get()).length > 0, 'the first server');
    return {
        keeper, get, waitFor, state, log: () => log,
        stop: async () => {
            keeper.kill('SIGTERM');
            await new Promise(resolve => keeper.exitCode !== null ? resolve() : keeper.once('exit', resolve));
            fs.rmSync(root, { recursive: true, force: true });
        },
    };
}

test('a reload hands over without failing a request, and the old server finishes its stream', { skip, timeout: 60000 }, async () => {
    const run = await startKeeper('parallel');
    try {
        const firstPid = (await run.get()).split(' ')[0];
        await run.get('/', { method: 'POST' });
        await run.get('/', { method: 'POST' });

        let failures = 0;
        let requests = 0;
        let stop = false;
        const load = (async () => {
            while (!stop) {
                try {
                    await run.get('/', { method: requests % 2 ? 'POST' : 'GET' });
                } catch {
                    failures++;
                }
                requests++;
            }
        })();
        const stream = run.get('/slow');
        await new Promise(resolve => setTimeout(resolve, 150));
        run.keeper.kill('SIGHUP');
        await run.waitFor(async () => (await run.get()).split(' ')[0] !== firstPid, 'the new server');
        const streamed = await stream;
        stop = true;
        await load;

        assert.equal(failures, 0, `failed requests during the reload\n${run.log()}`);
        assert.ok(requests > 10, 'requests kept flowing');
        assert.match(streamed, new RegExp(`^${firstPid}:0\\.1\\.2\\.3\\.4\\.5\\.6\\.7\\.8\\.9\\.done$`), 'the old server finished its stream');
        // The new server continued from the counter the old one saved when handing over.
        const [, counter] = (await run.get()).split(' ');
        assert.ok(Number(counter) >= 2 + Math.floor(requests / 2), `counter ${counter} after ${requests} requests`);
        await run.waitFor(() => /Replaced server \d+ exited/.test(run.log()), 'the old server to exit');
    } finally {
        await run.stop();
    }
});

test('a new server that fails to start leaves the running one serving', { skip, timeout: 60000 }, async () => {
    const run = await startKeeper('parallel');
    try {
        const firstPid = (await run.get()).split(' ')[0];
        fs.writeFileSync(`${run.state}.crash`, '');
        run.keeper.kill('SIGHUP');
        await run.waitFor(() => /failed to start .*keeps serving/.test(run.log()), 'the failed start');
        assert.equal((await run.get()).split(' ')[0], firstPid);

        fs.rmSync(`${run.state}.crash`);
        run.keeper.kill('SIGHUP');
        await run.waitFor(async () => (await run.get()).split(' ')[0] !== firstPid, 'the retried reload');
    } finally {
        await run.stop();
    }
});

test('with little memory the reload runs one after the other, and requests wait instead of failing', { skip, timeout: 60000 }, async () => {
    const run = await startKeeper('sequential');
    try {
        const firstPid = (await run.get()).split(' ')[0];
        run.keeper.kill('SIGHUP');
        const results = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
            await new Promise(resolve => setTimeout(resolve, i * 20));
            return run.get().then(text => text.split(' ')[0], () => 'FAILED');
        }));
        assert.ok(!results.includes('FAILED'), results.join(','));
        await run.waitFor(async () => (await run.get()).split(' ')[0] !== firstPid, 'the new server');
    } finally {
        await run.stop();
    }
});

test('stopping the keeper stops its servers and frees the port', { skip, timeout: 30000 }, async () => {
    const run = await startKeeper('parallel');
    const serverPid = Number((await run.get()).split(' ')[0]);
    await run.stop();
    assert.throws(() => process.kill(serverPid, 0), { code: 'ESRCH' });
});
