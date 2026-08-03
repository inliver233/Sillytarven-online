/* global globalThis */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { setConfigFilePath } from '../../src/util.js';

const [configPath, dataRoot, userJson, bodyJson, faultPoint] = process.argv.slice(2);
setConfigFilePath(configPath);
globalThis.DATA_ROOT = dataRoot;

const user = JSON.parse(userJson);
const body = JSON.parse(bodyJson);
const {
    createDurableChatFamilyTransaction,
    executeChatBranch,
    recoverChatBranchTransactions,
    renameChatBranchFamily,
    runChatBranchFaultPoint,
    setChatBranchFaultInjectorForTests,
    updateChatBranchGroupMetadata,
} = await import('../../src/chat-branch.js');

if (body.action === 'recover') {
    const result = recoverChatBranchTransactions(
        user.directories.root,
        user.profile.handle,
        user.directories,
    );
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
}

setChatBranchFaultInjectorForTests(point => {
    if (point === faultPoint) process.exit(86);
});

if (body.action === 'group-rename') {
    const sourcePath = path.join(user.directories.groupChats, `${body.oldChatId}.jsonl`);
    const destinationPath = path.join(user.directories.groupChats, `${body.newChatId}.jsonl`);
    const groupPath = path.join(user.directories.groups, `${body.groupId}.json`);
    const groupData = JSON.parse(fs.readFileSync(groupPath, 'utf8'));
    const transaction = createDurableChatFamilyTransaction({
        root: user.directories.root,
        handle: user.profile.handle,
        directories: user.directories,
        operation: 'rename',
        sourcePath,
        destinationPath,
        groupPath,
    });
    transaction.markMutating();
    await runChatBranchFaultPoint('after-chat-family-rename-journal-mutating');
    await renameChatBranchFamily(user.directories.root, sourcePath, destinationPath);
    await updateChatBranchGroupMetadata(groupPath, groupData, body.oldChatId, body.newChatId);
    await runChatBranchFaultPoint('before-chat-family-rename-commit');
    transaction.markCommitted();
    await runChatBranchFaultPoint('after-chat-family-rename-commit-marker');
    transaction.cleanup();
    process.stderr.write(`Fault point was not reached: ${faultPoint}\n`);
    process.exit(2);
}

const { runWithChatStorageLocks } = await import('../../src/endpoints/chats.js');
const request = { user, body };
const result = await executeChatBranch(request, {
    runWithStorageLocks: (filePaths, callback) => runWithChatStorageLocks(request, filePaths, callback),
});
process.stderr.write(`Fault point was not reached: ${faultPoint}; result=${JSON.stringify(result)}\n`);
process.exit(2);
