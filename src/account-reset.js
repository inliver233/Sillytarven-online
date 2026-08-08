/**
 * Checks the destructive account-reset confirmation against the signed-in handle.
 * Both values must already use the application's canonical handle format.
 * @param {unknown} username Normalized username supplied by the signed-in user
 * @param {unknown} expectedHandle Signed-in account handle
 * @returns {boolean} Whether the username identifies the signed-in account
 */
export function matchesAccountResetUsername(username, expectedHandle) {
    return typeof username === 'string'
        && typeof expectedHandle === 'string'
        && username.length > 0
        && username === expectedHandle;
}
