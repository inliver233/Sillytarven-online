import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import storage from 'node-persist';

const dataRoot = path.resolve(process.env.STCONTROL_E2E_DATA_ROOT || 'data-e2e');
const portFile = process.env.STCONTROL_E2E_PORT_FILE;
if (!portFile) throw new Error('STCONTROL_E2E_PORT_FILE is required');
globalThis.DATA_ROOT = dataRoot;

const { setConfigFilePath } = await import('../../src/util.js');
setConfigFilePath(fileURLToPath(new URL('./stcontrol-config.yaml', import.meta.url)));
await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0 });
const { router } = await import('../../src/endpoints/stcontrol.js');
const systemMonitor = (await import('../../src/system-monitor.js')).default;

const app = express();
app.use(express.json());
app.use(router);
const server = app.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('adapter address unavailable');
    fs.writeFileSync(portFile, String(address.port), { encoding: 'utf8', mode: 0o600 });
});

async function shutdown() {
    await new Promise(resolve => server.close(resolve));
    systemMonitor.destroy();
    if (typeof storage.stop === 'function') storage.stop();
    process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
