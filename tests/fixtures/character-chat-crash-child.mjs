import fs from 'node:fs';
import process from 'node:process';

import { createCharacterChatTransaction } from '../../src/character-chat-transaction.js';

const [optionsJson, crashState] = process.argv.slice(2);
const options = JSON.parse(optionsJson);
const transaction = createCharacterChatTransaction(options);

function mutatePartially() {
    if (options.operation === 'rename') {
        fs.writeFileSync(options.newCardPath, 'partial-new-card');
        if (options.oldChatsPath && options.newChatsPath) {
            fs.cpSync(options.oldChatsPath, options.newChatsPath, { recursive: true, force: true });
            fs.writeFileSync(`${options.newChatsPath}/partial.txt`, 'partial-new-chat');
        }
        fs.rmSync(options.oldCardPath, { force: true });
    } else {
        fs.rmSync(options.oldCardPath, { force: true });
        if (options.oldChatsPath) fs.rmSync(options.oldChatsPath, { recursive: true, force: true });
    }
}

function mutateCompletely() {
    if (options.operation === 'rename') {
        fs.writeFileSync(options.newCardPath, 'committed-new-card');
        fs.rmSync(options.oldCardPath, { force: true });
        if (options.oldChatsPath && options.newChatsPath) {
            fs.cpSync(options.oldChatsPath, options.newChatsPath, { recursive: true, force: true });
            fs.rmSync(options.oldChatsPath, { recursive: true, force: true });
        }
    } else {
        fs.rmSync(options.oldCardPath, { force: true });
        if (options.oldChatsPath) fs.rmSync(options.oldChatsPath, { recursive: true, force: true });
    }
}

if (crashState === 'prepared') {
    mutatePartially();
    process.exit(86);
}

transaction.markMutating();
if (crashState === 'mutating') {
    mutatePartially();
    process.exit(86);
}

if (crashState === 'committed') {
    mutateCompletely();
    transaction.markCommitted();
    process.exit(86);
}

process.stderr.write(`Unknown crash state: ${crashState}\n`);
process.exit(2);
