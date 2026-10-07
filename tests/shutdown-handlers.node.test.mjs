import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const signalListeners = () => ({ SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') });

test('importing server modules installs no signal handlers', async () => {
    // Only server-main.js may end the process on a signal: a module that exits on its
    // own cuts short the server's saving of in-memory state, and keeps scripts that
    // import it from stopping the normal way.
    const before = signalListeners();
    const { default: scheduledTasks } = await import('../src/scheduled-tasks.js');
    // With a config.yaml in the working directory its tasks start on import; stop them so the test can end.
    scheduledTasks.stopAllTasks();
    await import('../src/system-monitor.js');
    assert.deepEqual(signalListeners(), before);
});
