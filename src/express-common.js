import ipaddr from 'ipaddr.js';
import ipMatching from 'ip-matching';
import { RateLimiterRes } from 'rate-limiter-flexible';

const noopMiddleware = (_req, _res, next) => next();
/** @deprecated Do not use. A global middleware is provided at the application level. */
export const jsonParser = noopMiddleware;
/** @deprecated Do not use. A global middleware is provided at the application level. */
export const urlencodedParser = noopMiddleware;

/**
 * Gets the IP address of the client from the request object.
 * @param {import('express').Request} req Request object
 * @returns {string} IP address of the client
 */
export function getIpFromRequest(req) {
    return normalizeIpAddress(req.socket.remoteAddress);
}

/**
 * Normalizes IPv4-mapped IPv6 addresses without throwing on malformed input.
 * @param {string|undefined} input IP address
 * @returns {string} Normalized IP address
 */
function normalizeIpAddress(input) {
    let clientIp = input;
    if (!clientIp) {
        return 'unknown';
    }

    try {
        const ip = ipaddr.parse(clientIp);
        // Check if the IP address is IPv4-mapped IPv6 address
        if (ip.kind() === 'ipv6' && ip instanceof ipaddr.IPv6 && ip.isIPv4MappedAddress()) {
            return ip.toIPv4Address().toString();
        }

        return ip.toString();
    } catch {
        return 'unknown';
    }
}

/**
 * Get the client IP address from the request headers.
 * @param {import('express').Request} req Express request object
 * @returns {string|undefined} The client IP address
 */
export function getRealIpFromHeader(req) {
    // Express only derives req.ip from forwarding headers when the immediate
    // peer matches app.set('trust proxy'). Never trust a raw client-supplied
    // X-Real-IP header here.
    return normalizeIpAddress(typeof req.ip === 'string' ? req.ip : req.socket.remoteAddress);
}

/**
 * Gets the real client IP behind a trusted reverse proxy.
 * Only Express's `trust proxy` setting decides which forwarding headers count (see getRealIpFromHeader),
 * so a header sent by the client itself is never trusted.
 * @param {import('express').Request} req Express request object
 * @returns {string|undefined} The client IP address, or undefined if the request came directly
 */
export function getRealOrForwardedIp(req) {
    const realIp = getRealIpFromHeader(req);
    return realIp && realIp !== getIpFromRequest(req) ? realIp : undefined;
}

/**
 * Gets the IP address of the client, optionally including the real IP behind a trusted proxy.
 * Most common use cases: key for rate limiter, logging, etc.
 * Forwarding headers only count through Express's `trust proxy` setting (see getRealIpFromHeader):
 * a header sent by the client itself is never trusted.
 * @param {import('express').Request} request Request object
 * @param {boolean} [includeHeaderIp] Whether to include the real IP behind a trusted proxy
 * @returns {string} IP address of the client (with "forwarded" info if it differs from the socket)
 */
export function getIpAddress(request, includeHeaderIp = false) {
    const socketIp = getIpFromRequest(request);
    const realIp = includeHeaderIp ? getRealIpFromHeader(request) : null;
    return realIp && realIp !== socketIp ? `${socketIp} (forwarded: ${realIp})` : socketIp;
}

/**
 * Checks if the request is coming from a Firefox browser.
 * @param {import('express').Request} req Request object
 * @returns {boolean} True if the request is from Firefox, false otherwise.
 */
export function isFirefox(req) {
    const userAgent = req.headers['user-agent'] || '';
    return /firefox/i.test(userAgent);
}

/**
 * Filters and validates IP patterns.
 * @param {string[]} entries - The list of IP patterns to validate
 * @param {(entry: string, message: string) => string} formatLog - The function to format the warning message for invalid entries
 * @returns {string[]} The list of valid IP patterns
 */
export function filterValidIpPatterns(entries, formatLog) {
    const validEntries = [];

    if (!Array.isArray(entries)) {
        return validEntries;
    }

    for (const entry of entries) {
        try {
            // This will throw if the entry is not a valid IP or CIDR
            ipMatching.getMatch(entry);
            validEntries.push(entry);
        } catch (e) {
            if (typeof formatLog === 'function') {
                console.warn(formatLog(entry, e?.message || 'Unknown error'));
            }
        }
    }

    return validEntries;
}

/**
 * Sets the Retry-After header on the response based on the rate limit information.
 * @param {import('express').Response} response Express response object
 * @param {RateLimiterRes} rateLimit The rate limit information from rate-limiter-flexible
 * @returns {import('express').Response} The response object with the Retry-After header set if applicable
 */
export function retryAfter(response, rateLimit) {
    if (response.headersSent || !(rateLimit instanceof RateLimiterRes)) {
        return response;
    }
    const retryAfter = Math.ceil(rateLimit.msBeforeNext / 1000);
    response.set('Retry-After', retryAfter.toString());
    return response;
}
