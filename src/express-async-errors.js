import Layer from 'express/lib/router/layer.js';

/**
 * Express 4 only catches errors that a route handler throws synchronously. An async handler that
 * rejects leaves an unhandled rejection, and the server exits on it (the uncaughtException handler
 * in server-main.js): one malformed request from any signed-in user restarted the server.
 * This hands those errors to Express like a synchronous throw, so only that request fails.
 */
const PATCHED = Symbol.for('sillytavern.forwardAsyncRouteErrors');

/**
 * Calls a route handler and forwards a rejected promise to `next`.
 * @param {Function} handler Express handler
 * @param {any[]} args Handler arguments, `next` last
 */
function callHandler(handler, args) {
    const next = args[args.length - 1];
    try {
        const result = handler(...args);
        if (result && typeof result.then === 'function') {
            result.then(undefined, error => next(error ?? new Error('Route handler rejected without an error')));
        }
    } catch (error) {
        next(error);
    }
}

/** Makes every Express router forward errors of async handlers. Safe to call more than once. */
export function forwardAsyncRouteErrors() {
    if (Layer.prototype[PATCHED]) {
        return;
    }
    // Same as Express's own handle_request / handle_error, plus the promise.
    Layer.prototype.handle_request = function handleRequest(req, res, next) {
        if (this.handle.length > 3) {
            return next();
        }
        callHandler(this.handle, [req, res, next]);
    };
    Layer.prototype.handle_error = function handleError(error, req, res, next) {
        if (this.handle.length !== 4) {
            return next(error);
        }
        callHandler(this.handle, [error, req, res, next]);
    };
    Layer.prototype[PATCHED] = true;
}

/**
 * Last error handler: the request fails, the server keeps running, and the client gets the status
 * without the stack trace (Express's default handler sends it outside production).
 * @type {import('express').ErrorRequestHandler}
 */
export function requestErrorHandler(error, request, response, next) {
    if (response.headersSent) {
        // Express closes the connection of a response that is already under way.
        return next(error);
    }
    const status = Number(error?.status ?? error?.statusCode);
    const code = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
    if (code >= 500) {
        console.error(`Request failed: ${request.method} ${request.originalUrl}`, error);
    }
    return response.sendStatus(code);
}
