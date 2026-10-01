/* global globalThis */
// Chat routes in their own process for chat-hydration.node.test.mjs: the test
// loads omitted fields with blocking requests, which would stall an in-process server.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const [repoRoot, testRoot] = process.argv.slice(2);
const load = (file) => import(pathToFileURL(path.join(repoRoot, file)).href);

(await load('src/util.js')).setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));
globalThis.DATA_ROOT = path.join(testRoot, 'data');
fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });

const { default: express } = await import('express');
const { router } = await load('src/endpoints/chats.js');
const directories = Object.fromEntries(['root', 'groupChats', 'backups', 'characters', 'chats', 'groups']
    .map(name => [name, path.join(testRoot, name)]));
for (const directory of Object.values(directories)) {
    fs.mkdirSync(directory, { recursive: true });
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((request, _response, next) => {
    request.user = { profile: { handle: 'hydration-test', name: 'Hydration Test', admin: true }, directories };
    next();
});
app.use('/api/chats', router);
const listener = app.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${listener.address().port}\n`));
