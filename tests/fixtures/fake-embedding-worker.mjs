// Stands in for src/vectors/embedding-worker.js: answers with [text length, thread id, model name length].
import { parentPort, threadId, workerData } from 'node:worker_threads';

parentPort.on('message', ({ id, text }) => {
    if (text === 'crash') process.exit(3);
    if (text === 'hang') return;
    if (text === 'fail') {
        parentPort.postMessage({ id, error: 'model failed' });
        return;
    }
    parentPort.postMessage({ id, vector: [text.length, threadId, String(workerData.model).length] });
});
