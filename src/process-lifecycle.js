/**
 * Lifecycle of a server process run by the hot-reload keeper (keeper.js).
 *
 * A reload starts the new process while the old one keeps serving:
 * - standby: the new process starts up completely but does not serve yet, and
 *   must not write shared state, because the old process still owns it.
 * - active: serving. A standalone server (without the keeper) is always active.
 * - draining: the old process after handing over. It stops accepting requests,
 *   saves its in-memory state, and then may only finish what it was doing; it
 *   no longer writes shared state, which now belongs to the new process.
 *
 * Modules holding shared state in memory (statistics, controller state, usage
 * counters) check canPersistSharedState() before writing it, save it in an
 * onDrain hook, and reload it from disk in an onActivate hook.
 */

/** @typedef {'standby'|'active'|'draining'} ProcessPhase */

export const isKeeperWorker = process.env.ST_KEEPER_WORKER === '1' && typeof process.send === 'function';

/** @type {ProcessPhase} */
let phase = isKeeperWorker ? 'standby' : 'active';

/** @type {Array<() => unknown>} */
const activateHooks = [];
/** @type {Array<() => unknown>} */
const drainHooks = [];

/** @returns {ProcessPhase} */
export function getProcessPhase() {
    return phase;
}

/**
 * Whether this process may write state shared with other processes.
 * @returns {boolean}
 */
export function canPersistSharedState() {
    return phase === 'active';
}

/**
 * Runs when a standby process takes over: reload shared state from disk here.
 * @param {() => unknown} hook Hook
 */
export function onActivate(hook) {
    activateHooks.push(hook);
}

/**
 * Runs when an active process hands over, while it may still write: save
 * in-memory state and stop background work here.
 * @param {() => unknown} hook Hook
 */
export function onDrain(hook) {
    drainHooks.push(hook);
}

async function runHooks(hooks, label) {
    for (const hook of hooks) {
        try {
            await hook();
        } catch (error) {
            console.error(`[lifecycle] ${label} hook failed:`, error);
        }
    }
}

/** Standby → active: reload shared state, then allow writing it. */
export async function activateProcess() {
    if (phase !== 'standby') return;
    await runHooks(activateHooks, 'activate');
    phase = 'active';
}

/** Active → draining: save shared state, then stop writing it. */
export async function drainProcess() {
    if (phase !== 'active') return;
    await runHooks(drainHooks, 'drain');
    phase = 'draining';
}
