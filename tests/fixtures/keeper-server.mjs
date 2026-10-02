// A minimal server run by keeper.js in tests, using the same protocol as server.js.
import fs from 'node:fs';
import http from 'node:http';

import { notifyServing, registerKeeperServer, requestListenHandle, setupKeeperWorker, trackPendingWrites, waitForActivation } from '../../src/keeper-worker.js';
import { onActivate, onDrain } from '../../src/process-lifecycle.js';

const port = Number(process.env.KEEPER_TEST_PORT);
const stateFile = process.env.KEEPER_TEST_STATE;

if (fs.existsSync(`${stateFile}.crash`)) {
    throw new Error('Simulated startup failure');
}

// Shared state in memory, saved on handover and reloaded on activation, like the real server.
let counter = 0;
const load = () => { counter = fs.existsSync(stateFile) ? Number(fs.readFileSync(stateFile, 'utf8')) : 0; };
load();
onActivate(load);
onDrain(() => fs.writeFileSync(stateFile, String(counter)));

const server = http.createServer((request, response) => {
    trackPendingWrites(request, response, () => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/slow') {
            // Streams for a while, like a model reply.
            response.write(`${process.pid}:`);
            let n = 0;
            const timer = setInterval(() => {
                response.write(`${n}.`);
                if (++n === 10) {
                    clearInterval(timer);
                    response.end('done');
                }
            }, 100);
            return;
        }
        if (request.method === 'POST') counter++;
        response.end(`${process.pid} ${counter}`);
    });
});

await waitForActivation();
const handle = await requestListenHandle('127.0.0.1', port, 4);
registerKeeperServer(server);
server.listen(handle, () => {
    setupKeeperWorker(async () => process.exit(0));
    notifyServing();
});
process.on('SIGTERM', () => process.exit(0));
