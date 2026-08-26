import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsDirectory = fileURLToPath(new URL('.', import.meta.url));
const invitationTest = 'user-invitations.node.test.mjs';
const isolatedTests = readdirSync(testsDirectory)
    .filter(file => file.endsWith('.node.test.mjs') && file !== invitationTest)
    .sort()
    .map(file => fileURLToPath(new URL(file, import.meta.url)));

function runNode(arguments_) {
    const result = spawnSync(process.execPath, arguments_, { stdio: 'inherit' });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

runNode(['--test', ...isolatedTests]);

// This file starts the application in-process. Running it through Node 20's
// test isolation can fail in IPC deserialization before any assertion runs.
runNode([fileURLToPath(new URL(invitationTest, import.meta.url))]);
