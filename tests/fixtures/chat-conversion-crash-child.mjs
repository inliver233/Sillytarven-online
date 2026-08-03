/* global globalThis */
import path from 'node:path';

import express from 'express';

const [userRoot, handle, groupChatId, configPath] = process.argv.slice(2);
const { setConfigFilePath } = await import('../../src/util.js');
setConfigFilePath(configPath);
globalThis.DATA_ROOT = path.dirname(userRoot);

const {
    router,
    setChatConversionFaultInjectorForTests,
} = await import('../../src/endpoints/chats.js');
const directories = {
    root: userRoot,
    groupChats: path.join(userRoot, 'group chats'),
    backups: path.join(userRoot, 'backups'),
    characters: path.join(userRoot, 'characters'),
    chats: path.join(userRoot, 'chats'),
    groups: path.join(userRoot, 'groups'),
};
setChatConversionFaultInjectorForTests((point) => {
    if (point === 'after-chat-conversion-chunk-reset') process.exit(0);
});

const app = express();
app.use(express.json());
app.use((request, _response, next) => {
    request.user = {
        profile: { handle, name: handle, admin: true },
        directories,
    };
    next();
});
app.use('/api/chats', router);
const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
});
const address = server.address();
await fetch(`http://127.0.0.1:${address.port}/api/chats/group/get`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: groupChatId }),
});
process.exit(2);
