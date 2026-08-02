// native node modules
import path from 'node:path';
import util from 'node:util';
import net from 'node:net';
import dns from 'node:dns';
import process from 'node:process';

import cors from 'cors';
import { csrfSync } from 'csrf-sync';
import express from 'express';
import compression from 'compression';
import cookieSession from 'cookie-session';
import responseTime from 'response-time';
import helmet from 'helmet';
import bodyParser from 'body-parser';

// local library imports
import './fetch-patch.js';
import { serverDirectory } from './server-directory.js';

import { serverEvents, EVENT_NAMES } from './server-events.js';
import { loadPlugins } from './plugin-loader.js';
import {
    initUserStorage,
    getCookieSecret,
    getCookieSessionName,
    ensurePublicDirectoriesExist,
    getUserDirectoriesList,
    migrateSystemPrompts,
    migrateUserData,
    requireLoginMiddleware,
    setUserDataMiddleware,
    cleanUploads,
    getSessionCookieAge,
    verifySecuritySettings,
    loginPageMiddleware,
} from './users.js';

import getWebpackServeMiddleware from './middleware/webpack-serve.js';
import basicAuthMiddleware from './middleware/basicAuth.js';
import getWhitelistMiddleware from './middleware/whitelist.js';
import accessLoggerMiddleware, { getAccessLogPath, migrateAccessLog } from './middleware/accessLogWriter.js';
import multerMonkeyPatch from './middleware/multerMonkeyPatch.js';
import { createUploadMiddleware } from './upload-middleware.js';
import { isClientTelemetryJsonPath } from './body-parser-routing.js';
import initRequestProxy from './request-proxy.js';
import cacheBuster from './middleware/cacheBuster.js';
import corsProxyMiddleware from './middleware/corsProxy.js';
import hostWhitelistMiddleware from './middleware/hostWhitelist.js';
import {
    getVersion,
    color,
    removeColorFormatting,
    getSeparator,
    safeReadFileSync,
    setupLogLevel,
    setWindowTitle,
    getConfigValue,
    isPathUnderParent,
} from './util.js';
import { UPLOADS_DIRECTORY } from './constants.js';
import { isThirdPartyExtensionPath } from './endpoints/extensions.js';
import { ensureThumbnailCache } from './endpoints/thumbnails.js';

// Routers
import { router as usersPublicRouter } from './endpoints/users-public.js';
import { router as publicConfigRouter } from './endpoints/public-config.js';
import { router as oauthRouter, linuxdoCallbackHandler } from './endpoints/oauth.js';
import { init as statsInit, onExit as statsOnExit } from './endpoints/stats.js';
import { checkForNewContent } from './endpoints/content-manager.js';
import { init as settingsInit } from './endpoints/settings.js';
import { redirectDeprecatedEndpoints, ServerStartup, setupPrivateEndpoints } from './server-startup.js';
import { diskCache } from './endpoints/characters.js';
import { migrateFlatSecrets } from './endpoints/secrets.js';
import { migrateGroupChatsMetadataFormat } from './endpoints/groups.js';
import { initializeUserInvitationSystem } from './user-invitations.js';
import { getRegistrationMethodConfig } from './registration-policy.js';
import { beginEndpointPerformance, finalizeRequestPerformance, performanceRequestStartMiddleware } from './performance-monitor.js';

// Work around a node v20.0.0, v20.1.0, and v20.2.0 bug. The issue was fixed in v20.3.0.
// https://github.com/nodejs/node/issues/47822#issuecomment-1564708870
// Safe to remove once support for Node v20 is dropped.
if (process.versions && process.versions.node && process.versions.node.match(/20\.[0-2]\.0/)) {
    // @ts-ignore
    if (net.setDefaultAutoSelectFamily) net.setDefaultAutoSelectFamily(false);
}

// Keep accidental prompt/object logging bounded in production. Debug logging
// can still inspect useful context without retaining entire conversations.
util.inspect.defaultOptions.maxArrayLength = 100;
util.inspect.defaultOptions.maxStringLength = 2000;
util.inspect.defaultOptions.depth = 4;

/** @type {import('./command-line.js').CommandLineArguments} */
const cliArgs = globalThis.COMMAND_LINE_ARGS;

if (!cliArgs.enableIPv6 && !cliArgs.enableIPv4) {
    console.error('error: You can\'t disable all internet protocols: at least IPv6 or IPv4 must be enabled.');
    process.exit(1);
}

const app = express();
// Only trust forwarding headers from the local reverse proxy. This prevents a
// direct connection to the Node port from spoofing its client IP.
app.set('trust proxy', 'loopback');
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(compression());
app.use(responseTime(finalizeRequestPerformance));
app.use(performanceRequestStartMiddleware);

const globalJsonParser = bodyParser.json({ limit: '500mb' });
app.use((request, response, next) => {
    if (isClientTelemetryJsonPath(request.path)) {
        next();
        return;
    }
    globalJsonParser(request, response, next);
});
app.use(bodyParser.urlencoded({ extended: true, limit: '500mb' }));

// CORS Settings //
const CORS = cors({
    origin: 'null',
    methods: ['OPTIONS'],
});

app.use(CORS);

if (cliArgs.listen && cliArgs.basicAuthMode) {
    app.use(basicAuthMiddleware);
}

if (cliArgs.whitelistMode) {
    const whitelistMiddleware = await getWhitelistMiddleware();
    app.use(whitelistMiddleware);
}

app.use(hostWhitelistMiddleware);

if (cliArgs.listen) {
    app.use(accessLoggerMiddleware());
}

if (cliArgs.enableCorsProxy) {
    app.use('/proxy/:url(*)', corsProxyMiddleware);
} else {
    app.use('/proxy/:url(*)', async (_, res) => {
        const message = 'CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.';
        console.log(message);
        res.status(404).send(message);
    });
}

app.use(cookieSession({
    name: getCookieSessionName(),
    sameSite: 'lax',
    httpOnly: true,
    maxAge: getSessionCookieAge(),
    secret: getCookieSecret(globalThis.DATA_ROOT),
}));

app.use(setUserDataMiddleware);

/**
 * Pages whose contents or navigation depend on the current login cookie must
 * never be reused from a public/browser cache.
 * @param {import('express').Response} response Express response
 */
function setPrivateNoStoreHeaders(response) {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Expires', '0');
    response.vary('Cookie');
}

// CSRF Protection //
if (!cliArgs.disableCsrf) {
    const csrfSyncProtection = csrfSync({
        getTokenFromState: (req) => {
            if (!req.session) {
                console.error('(CSRF error) getTokenFromState: Session object not initialized');
                return;
            }
            return req.session.csrfToken;
        },
        getTokenFromRequest: (req) => {
            return req.headers['x-csrf-token']?.toString();
        },
        storeTokenInState: (req, token) => {
            if (!req.session) {
                console.error('(CSRF error) storeTokenInState: Session object not initialized');
                return;
            }
            req.session.csrfToken = token;
        },
        size: 32,
    });

    app.get('/csrf-token', (req, res) => {
        res.json({
            'token': csrfSyncProtection.generateToken(req),
        });
    });

    // Customize the error message
    csrfSyncProtection.invalidCsrfTokenError.message = color.red('Invalid CSRF token. Please refresh the page and try again.');
    csrfSyncProtection.invalidCsrfTokenError.stack = undefined;

    // 创建自定义的CSRF保护中间件，添加豁免逻辑
    const customCsrfProtection = (req, res, next) => {
        // 对安全方法直接放行
        if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
            return next();
        }
        // 豁免特定路径
        if (req.path.startsWith('/api/public-characters') ||
            req.path === '/api/users/me' ||
            req.path === '/api/users/heartbeat' ||
            req.path === '/api/invitation-codes/status' ||
            req.path === '/csrf-token' ||
            req.path === '/api/ping' ||
            req.path === '/api/forum/upload-image' ||
            req.path.startsWith('/api/forum/images/') ||
            req.path.startsWith('/api/settings/') ||
            (req.method === 'GET' && req.path.startsWith('/api/forum/'))) {
            return next();
        }

        // 对其他路径应用CSRF保护
        return csrfSyncProtection.csrfSynchronisedProtection(req, res, next);
    };

    app.use(customCsrfProtection);
} else {
    console.warn('\nCSRF protection is disabled. This will make your server vulnerable to CSRF attacks.\n');
    app.get('/csrf-token', (req, res) => {
        res.json({
            'token': 'disabled',
        });
    });
}

app.get('/', cacheBuster.middleware, (request, response) => {
    setPrivateNoStoreHeaders(response);
    if (request.session && (request.session.userId || request.session.handle)) {
        return response.sendFile('index.html', { root: path.join(serverDirectory, 'public') });
    }
    return response.sendFile('welcome.html', { root: path.join(serverDirectory, 'public') });
});

// Explicit welcome route
app.get('/welcome', (request, response) => {
    setPrivateNoStoreHeaders(response);
    return response.sendFile('welcome.html', { root: path.join(serverDirectory, 'public') });
});

// Keep original app at /app
app.get('/app', cacheBuster.middleware, (request, response) => {
    setPrivateNoStoreHeaders(response);
    return response.sendFile('index.html', { root: path.join(serverDirectory, 'public') });
});

// Callback endpoint for OAuth PKCE flows (e.g. OpenRouter)
app.get('/callback/:source?', (request, response) => {
    const source = request.params.source;
    const query = request.url.split('?')[1];
    const searchParams = new URLSearchParams();
    source && searchParams.set('source', source);
    query && searchParams.set('query', query);
    const path = `/?${searchParams.toString()}`;
    return response.redirect(307, path);
});

// Linux.do 应用平台注册的兼容回调地址。
// 标准内部路由仍保留为 /api/oauth/linuxdo/callback。
app.get('/oauth', (request, response, next) => {
    setPrivateNoStoreHeaders(response);
    return linuxdoCallbackHandler(request, response, next);
});

// Host login page
app.get('/login', (request, response, next) => {
    setPrivateNoStoreHeaders(response);
    return loginPageMiddleware(request, response, next);
});

// Host additional pages
app.get('/register', (request, response) => {
    setPrivateNoStoreHeaders(response);
    return response.sendFile('register.html', { root: path.join(serverDirectory, 'public') });
});

app.get('/forum', (request, response) => {
    setPrivateNoStoreHeaders(response);
    const enableForum = getConfigValue('enableForum', true, 'boolean');
    if (!enableForum) {
        return response.status(404).send('页面未启用');
    }
    return response.sendFile('forum.html', { root: path.join(serverDirectory, 'public') });
});

app.get('/public-characters', (request, response) => {
    setPrivateNoStoreHeaders(response);
    const enablePublicCharacters = getConfigValue('enablePublicCharacters', true, 'boolean');
    if (!enablePublicCharacters) {
        return response.status(404).send('页面未启用');
    }
    return response.sendFile('public-characters.html', { root: path.join(serverDirectory, 'public') });
});

// Host frontend assets
const webpackMiddleware = getWebpackServeMiddleware();
app.use(webpackMiddleware);
const publicDirectory = path.join(serverDirectory, 'public');
const templatesDirectory = path.join(publicDirectory, 'scripts', 'templates');
const publicStaticMiddleware = express.static(publicDirectory, {
    maxAge: 0,
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        const extension = path.extname(filePath).toLowerCase();
        const isTemplate = extension === '.html' && isPathUnderParent(templatesDirectory, filePath);

        if (extension === '.html' && !isTemplate) {
            setPrivateNoStoreHeaders(res);
        } else if (['.woff', '.woff2', '.ttf', '.otf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'].includes(extension)) {
            // Binary assets are expensive and do not influence login routing.
            res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
        } else if (isTemplate || ['.js', '.mjs', '.css'].includes(extension)) {
            // Source filenames are not content-hashed, so keep the freshness
            // window short enough for smooth production deployments.
            res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        }
    },
});
app.use((request, response, next) => {
    if (isThirdPartyExtensionPath(request.path)) {
        return next();
    }
    return publicStaticMiddleware(request, response, next);
});

// Public API
app.use('/api/users', usersPublicRouter);
app.use('/api/public-config', publicConfigRouter);

// OAuth routes (no auth required for initial flow)
app.use('/api/oauth', oauthRouter);

// Public invitation codes status (no auth)
app.get('/api/invitation-codes/status', (req, res) => {
    const enabled = getRegistrationMethodConfig('password').requireInvitationCode;
    res.json({ enabled });
});

// Public email service status (no auth)
const emailStatusModule = await import('./endpoints/email-status.js');
app.use('/api/email', emailStatusModule.router);

// Public login page announcements (no auth)
app.get('/api/announcements/login/current', async (req, res) => {
    try {
        const fs = await import('node:fs');
        const announcementsFilePath = path.join(process.cwd(), 'data', 'announcements', 'login_announcements.json');

        if (!fs.default.existsSync(announcementsFilePath)) {
            return res.json([]);
        }

        const data = fs.default.readFileSync(announcementsFilePath, 'utf8');
        const announcements = JSON.parse(data);

        // 筛选有效的公告
        const validAnnouncements = announcements.filter(announcement => {
            return announcement.enabled;
        });

        res.json(validAnnouncements);
    } catch (error) {
        console.error('Error getting current login announcements:', error);
        res.status(500).json({ error: 'Failed to get current login announcements' });
    }
});

// Everything below this line requires authentication
app.use(requireLoginMiddleware);
app.post('/api/ping', (request, response) => {
    if (request.query.extend && request.session) {
        request.session.touch = Date.now();
    }

    response.sendStatus(204);
});

// File uploads
const uploadsPath = path.join(cliArgs.dataRoot, UPLOADS_DIRECTORY);
app.use(createUploadMiddleware(uploadsPath));
app.use(multerMonkeyPatch);

app.get('/version', async function (request, response) {
    const performanceTimer = beginEndpointPerformance(request, 'version');
    const data = await getVersion({
        onCacheState: state => performanceTimer.setCacheState(state),
        onGitDuration: durationMs => performanceTimer.addDuration('git', durationMs),
    });
    performanceTimer.startPhase('serialize');
    response.send(data);
});

redirectDeprecatedEndpoints(app);
setupPrivateEndpoints(app);

/**
 * Tasks that need to be run before the server starts listening.
 * @returns {Promise<void>}
 */
async function preSetupTasks() {
    const version = await getVersion();

    // Print formatted header
    console.log();
    console.log(`SillyTavern ${version.pkgVersion}`);
    if (version.gitBranch && version.commitDate) {
        const date = new Date(version.commitDate);
        const localDate = date.toLocaleString('en-US', { timeZoneName: 'short' });
        console.log(`Running '${version.gitBranch}' (${version.gitRevision}) - ${localDate}`);
        if (!version.isLatest && ['staging', 'release'].includes(version.gitBranch)) {
            console.log('INFO: Currently not on the latest commit.');
            console.log('      Run \'git pull\' to update. If you have any merge conflicts, run \'git reset --hard\' and \'git pull\' to reset your branch.');
        }
    }
    console.log();

    const directories = await getUserDirectoriesList();
    await migrateGroupChatsMetadataFormat(directories);
    await checkForNewContent(directories);
    await ensureThumbnailCache(directories);
    await diskCache.verify(directories);
    migrateFlatSecrets(directories);
    cleanUploads();
    migrateAccessLog();

    await settingsInit();
    await statsInit();

    const pluginsDirectory = path.join(serverDirectory, 'plugins');
    const cleanupPlugins = await loadPlugins(app, pluginsDirectory);
    const consoleTitle = process.title;

    let isExiting = false;
    const exitProcess = async () => {
        if (isExiting) return;
        isExiting = true;
        await statsOnExit();
        if (typeof cleanupPlugins === 'function') {
            await cleanupPlugins();
        }
        diskCache.dispose();
        setWindowTitle(consoleTitle);
        process.exit();
    };

    // Set up event listeners for a graceful shutdown
    process.on('SIGINT', exitProcess);
    process.on('SIGTERM', exitProcess);
    process.on('uncaughtException', (err) => {
        console.error('Uncaught exception:', err);
        exitProcess();
    });

    // Add request proxy.
    initRequestProxy({ enabled: cliArgs.requestProxyEnabled, url: cliArgs.requestProxyUrl, bypass: cliArgs.requestProxyBypass });

    // Wait for frontend libs to compile
    await webpackMiddleware.runWebpackCompiler();
}

/**
 * Tasks that need to be run after the server starts listening.
 * @param {import('./server-startup.js').ServerStartupResult} result The result of the server startup
 * @returns {Promise<void>}
 */
async function postSetupTasks(result) {
    const browserLaunchHostname = await cliArgs.getBrowserLaunchHostname(result);
    const browserLaunchUrl = cliArgs.getBrowserLaunchUrl(browserLaunchHostname);
    const browserLaunchApp = String(getConfigValue('browserLaunch.browser', 'default') ?? '');

    if (cliArgs.browserLaunchEnabled) {
        try {
            // TODO: This should be converted to a regular import when support for Node 18 is dropped
            const openModule = await import('open');
            const { default: open, apps } = openModule;

            function getBrowsers() {
                const isAndroid = process.platform === 'android';
                if (isAndroid) {
                    return {};
                }
                return {
                    'firefox': apps.firefox,
                    'chrome': apps.chrome,
                    'edge': apps.edge,
                    'brave': apps.brave,
                };
            }

            const validBrowsers = getBrowsers();
            const appName = validBrowsers[browserLaunchApp.trim().toLowerCase()];
            const openOptions = appName ? { app: { name: appName } } : {};

            console.log(`Launching in a browser: ${browserLaunchApp}...`);
            await open(browserLaunchUrl.toString(), openOptions);
        } catch (error) {
            console.error('Failed to launch the browser. Open the URL manually.', error);
        }
    }

    setWindowTitle('SillyTavern WebServer');

    let logListen = 'SillyTavern is listening on';

    if (result.useIPv6 && !result.v6Failed) {
        logListen += color.green(
            ' IPv6: ' + cliArgs.getIPv6ListenUrl().host,
        );
    }

    if (result.useIPv4 && !result.v4Failed) {
        logListen += color.green(
            ' IPv4: ' + cliArgs.getIPv4ListenUrl().host,
        );
    }

    const goToLog = `Go to: ${color.blue(browserLaunchUrl)} to open SillyTavern`;
    const plainGoToLog = removeColorFormatting(goToLog);

    console.log(logListen);
    if (cliArgs.listen) {
        console.log();
        console.log('To limit connections to internal localhost only ([::1] or 127.0.0.1), change the setting in config.yaml to "listen: false".');
        console.log('Check the "access.log" file in the data directory to inspect incoming connections:', color.green(getAccessLogPath()));
    }
    console.log('\n' + getSeparator(plainGoToLog.length) + '\n');
    console.log(goToLog);
    console.log('\n' + getSeparator(plainGoToLog.length) + '\n');

    setupLogLevel();
    serverEvents.emit(EVENT_NAMES.SERVER_STARTED, { url: browserLaunchUrl });
}

/**
 * Registers a not-found error response if a not-found error page exists. Should only be called after all other middlewares have been registered.
 */
function apply404Middleware() {
    const notFoundWebpage = safeReadFileSync(path.join(serverDirectory, 'public/error/url-not-found.html')) ?? '';
    app.use((req, res) => {
        res.status(404).send(notFoundWebpage);
    });
}

/**
 * Sets the DNS resolution order based on the command line arguments.
 */
function setDnsResolutionOrder() {
    try {
        if (cliArgs.dnsPreferIPv6) {
            dns.setDefaultResultOrder('ipv6first');
            console.log('Preferring IPv6 for DNS resolution');
        } else {
            dns.setDefaultResultOrder('ipv4first');
            console.log('Preferring IPv4 for DNS resolution');
        }
    } catch (error) {
        console.warn('Failed to set DNS resolution order. Possibly unsupported in this Node version.');
    }
}

// User storage module needs to be initialized before starting the server
initUserStorage(globalThis.DATA_ROOT)
    .then(initializeUserInvitationSystem)
    .then(setDnsResolutionOrder)
    .then(ensurePublicDirectoriesExist)
    .then(migrateUserData)
    .then(migrateSystemPrompts)
    .then(verifySecuritySettings)
    .then(preSetupTasks)
    .then(apply404Middleware)
    .then(() => new ServerStartup(app, cliArgs).start())
    .then(postSetupTasks);
