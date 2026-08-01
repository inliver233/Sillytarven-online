import fs from 'node:fs';

import { createDurableChatTransaction } from '../../src/chat-journal.js';

const [mode, userRoot, handle, filePath, artifactPathsJson, replacement] = process.argv.slice(2);
const transaction = createDurableChatTransaction({
    filePath,
    artifactPaths: JSON.parse(artifactPathsJson),
    userRoot,
    handle,
    hooks: mode === 'committed'
        ? { afterCommitMarker: () => process.exit(0) }
        : {},
});
if (mode === 'prepared') {
    process.exit(0);
}
transaction.markMutating();
fs.writeFileSync(filePath, replacement);
if (mode === 'committed') {
    transaction.commit();
}
process.exit(0);
