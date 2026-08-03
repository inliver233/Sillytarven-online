/**
 * Starts independent startup tasks together and rejects if any task fails.
 * @param {Array<() => any|Promise<any>>} tasks Startup task factories
 * @returns {Promise<any[]>} Task results in input order
 */
export function runStrictStartupTasks(tasks) {
    if (!Array.isArray(tasks) || tasks.some(task => typeof task !== 'function')) {
        throw new TypeError('startup tasks must be an array of functions');
    }

    return Promise.all(tasks.map(task => Promise.resolve().then(task)));
}

/**
 * Starts a background startup task without making it part of the critical path.
 * @param {() => any|Promise<any>} task Background task factory
 * @param {(error: unknown) => void|Promise<void>} [onError] Rejection handler
 */
export function startBackgroundStartupTask(task, onError = error => console.error('Background startup task failed:', error)) {
    if (typeof task !== 'function' || typeof onError !== 'function') {
        throw new TypeError('background startup task and error handler must be functions');
    }

    void Promise.resolve()
        .then(task)
        .catch(async error => {
            try {
                await onError(error);
            } catch (handlerError) {
                console.error('Background startup error handler failed:', handlerError);
            }
        });
}
