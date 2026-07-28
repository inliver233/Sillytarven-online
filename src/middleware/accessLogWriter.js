import path from 'node:path';
import fs from 'node:fs';
import { getRealIpFromHeader } from '../express-common.js';
import { color, getConfigValue } from '../util.js';

const enableAccessLog = getConfigValue('logging.enableAccessLog', true, 'boolean');

const knownIPs = new Set();
const MAX_KNOWN_IPS = 50_000;

/**
 * Remembers a bounded number of recently seen addresses. A public server can
 * otherwise retain every scanner/bot IP until the process restarts.
 * @param {string} clientIp Normalized client IP
 * @returns {boolean} Whether this is a newly remembered address
 */
function rememberClientIp(clientIp) {
    if (knownIPs.has(clientIp)) {
        return false;
    }

    if (knownIPs.size >= MAX_KNOWN_IPS) {
        const oldestIp = knownIPs.values().next().value;
        if (oldestIp) {
            knownIPs.delete(oldestIp);
        }
    }

    knownIPs.add(clientIp);
    return true;
}

export const getAccessLogPath = () => path.join(globalThis.DATA_ROOT, 'access.log');

export function migrateAccessLog() {
    try {
        if (!fs.existsSync('access.log')) {
            return;
        }
        const logPath = getAccessLogPath();
        if (fs.existsSync(logPath)) {
            return;
        }
        fs.renameSync('access.log', logPath);
        console.log(color.yellow('Migrated access.log to new location:'), logPath);
    } catch (e) {
        console.error('Failed to migrate access log:', e);
        console.info('Please move access.log to the data directory manually.');
    }
}

/**
 * Creates middleware for logging access and new connections
 * @returns {import('express').RequestHandler}
 */
export default function accessLoggerMiddleware() {
    return function (req, res, next) {
        const clientIp = getRealIpFromHeader(req);
        const userAgent = String(req.headers['user-agent'] || 'unknown')
            .replace(/[\r\n\u0000-\u001F\u007F]+/g, ' ')
            .slice(0, 512);

        if (rememberClientIp(clientIp)) {
            // Log new connection
            // Write to access log if enabled
            if (enableAccessLog) {
                console.info(color.yellow(`New connection from ${clientIp}; User Agent: ${userAgent}\n`));
                const logPath = getAccessLogPath();
                const timestamp = new Date().toISOString();
                const log = `${timestamp} ${clientIp} ${userAgent}\n`;

                fs.appendFile(logPath, log, (err) => {
                    if (err) {
                        console.error('Failed to write access log:', err);
                    }
                });
            }
        }

        next();
    };
}
