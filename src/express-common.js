import ipaddr from 'ipaddr.js';

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
 * Gets the IP address of the client when behind reverse proxy using x-real-ip header, falls back to socket remote address.
 * This function should be used when the application is running behind a reverse proxy (e.g., Nginx, traefik, Caddy...).
 * @param {import('express').Request} req Request object
 * @returns {string} IP address of the client
 */
export function getRealIpFromHeader(req) {
    // Express only derives req.ip from forwarding headers when the immediate
    // peer matches app.set('trust proxy'). Never trust a raw client-supplied
    // X-Real-IP header here.
    return normalizeIpAddress(typeof req.ip === 'string' ? req.ip : req.socket.remoteAddress);
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
