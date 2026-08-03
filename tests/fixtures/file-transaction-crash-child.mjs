import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { FileTransaction, getFileTransactionNamespace } from '../../src/file-transaction.js';

const [root, handle, crashPoint] = process.argv.slice(2);
const first = path.join(root, 'characters', 'First.png');
const second = path.join(root, 'backgrounds', 'Second.png');
const created = path.join(root, 'chats', 'Created.jsonl');

const crash = point => {
    if (point === crashPoint) process.exit(86);
};
const transaction = new FileTransaction(root, {
    handle,
    afterBackup: ({ index }) => {
        if (index === 0) crash('after-first-backup');
    },
    afterApply: ({ index }) => {
        if (index === 0) crash('after-first-apply');
    },
    afterCommit: async () => {
        if (['after-commit-missing-backup', 'after-commit-missing-new'].includes(crashPoint)) {
            const namespace = getFileTransactionNamespace(root, handle);
            const [transactionName] = await fs.promises.readdir(namespace);
            const artifactDirectory = crashPoint.endsWith('backup') ? 'backup' : 'new';
            await fs.promises.rm(path.join(namespace, transactionName, artifactDirectory), { recursive: true });
            crash(crashPoint);
        }
        crash('after-commit');
    },
});

await transaction.stageFile(first, 'new-first');
await transaction.stageFile(second, 'new-second');
await transaction.stageFile(created, 'new-created');
await transaction.commit();
process.stderr.write(`Crash point was not reached: ${crashPoint}\n`);
process.exit(2);
