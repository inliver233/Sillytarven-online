import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

import express from 'express';
import sanitize from 'sanitize-filename';
import { CheckRepoActions, default as simpleGit } from 'simple-git';

import { PUBLIC_DIRECTORIES } from '../constants.js';
import { getExtensionModuleGraph } from '../extension-module-graph.js';
import { KeyedMutex } from '../keyed-mutex.js';

/**
 * @type {Partial<import('simple-git').SimpleGitOptions>}
 */
const OPTIONS = Object.freeze({ timeout: { block: 5 * 60 * 1000 } });
const INSTALL_GIT_OPTIONS = Object.freeze({ config: ['http.followRedirects=false'] });
const activeExtensionInstalls = new Set();
/** Serializes git work on one extension folder (checks, updates, branch changes, compaction, deletion). */
const extensionGitMutex = new KeyedMutex();
/** Runs one repository compaction at a time across the server. */
const compactionQueue = new KeyedMutex();
const scheduledCompactions = new Set();

/**
 * Extensions are cloned with --depth 1, but a plain fetch into a shallow clone downloads every
 * commit made since the clone. Busy repositories grew to hundreds of MB that way, all counted
 * against the user's storage quota. Only ever fetch the branch tips, and no tags (each tag
 * would keep its own history alive).
 * @param {import('simple-git').SimpleGit} git Repository
 */
async function fetchBranchTips(git) {
    await git.fetch('origin', ['--depth=1', '--no-tags']);
}

/**
 * Whether the clone holds more than the tips: history behind HEAD, or tags pinning old commits.
 * @param {import('simple-git').SimpleGit} git Repository
 * @returns {Promise<boolean>}
 */
async function hasOldHistory(git) {
    const historyLength = Number.parseInt(await git.raw(['rev-list', '--count', 'HEAD']), 10) || 0;
    return historyLength > 1 || (await git.raw(['tag', '--list'])).trim() !== '';
}

/**
 * Drop the objects a shallow fetch or an update left unreachable (old history and old tips).
 * Local tags go first: older full fetches brought them in, and they hold the old history.
 * Runs in the background, one repository at a time.
 * @param {string} extensionPath Extension folder
 */
function scheduleCompaction(extensionPath) {
    const key = path.resolve(extensionPath);
    if (scheduledCompactions.has(key)) return;
    scheduledCompactions.add(key);
    compactionQueue.runExclusive('compaction', () => extensionGitMutex.runExclusive(key, async () => {
        scheduledCompactions.delete(key);
        if (!fs.existsSync(path.join(key, '.git'))) return;
        const git = simpleGit({ baseDir: key, ...OPTIONS });
        const tags = (await git.raw(['tag', '--list'])).split('\n').filter(Boolean);
        for (let i = 0; i < tags.length; i += 100) {
            await git.raw(['tag', '--delete', ...tags.slice(i, i + 100)]);
        }
        await git.raw(['reflog', 'expire', '--expire=now', '--all']);
        await git.raw(['gc', '--prune=now', '--quiet']);
        console.info(`Extension repository has been compacted at ${key}`);
    })).catch(error => {
        scheduledCompactions.delete(key);
        console.warn(`Compacting the extension repository failed at ${key}`, error);
    });
}

/**
 * @template T
 * @param {string} extensionPath Extension folder
 * @param {() => Promise<T>} callback Git work on that folder
 * @returns {Promise<T>}
 */
function withExtensionGit(extensionPath, callback) {
    return extensionGitMutex.runExclusive(path.resolve(extensionPath), callback);
}

/**
 * GitLab redirects repository URLs without the canonical suffix. Resolve that
 * known redirect locally while keeping arbitrary Git redirects disabled.
 * @param {unknown} value Requested clone URL
 * @returns {unknown} Canonical clone URL when the input is a GitLab HTTPS repository
 */
export function normalizeExtensionCloneUrl(value) {
    if (typeof value !== 'string') return value;

    const trimmed = value.trim();
    try {
        const parsed = new URL(trimmed);
        const pathname = parsed.pathname.replace(/\/+$/u, '');
        const pathSegments = pathname.split('/').filter(Boolean);
        const isCanonicalizableGitLabUrl = parsed.protocol === 'https:'
            && parsed.hostname.toLowerCase() === 'gitlab.com'
            && !parsed.port
            && !parsed.username
            && !parsed.password
            && !parsed.search
            && !parsed.hash
            && !pathname.includes('/-/')
            && pathSegments.length >= 2;
        if (!isCanonicalizableGitLabUrl || pathname.toLowerCase().endsWith('.git')) {
            return trimmed;
        }

        parsed.pathname = `${pathname}.git`;
        return parsed.href;
    } catch {
        return trimmed;
    }
}

function getExtensionDirectoryName(url) {
    let repositoryPath = url;
    try {
        repositoryPath = decodeURIComponent(new URL(url).pathname);
    } catch {
        // SCP-style and local Git URLs are handled by path.basename below.
    }
    const name = sanitize(path.basename(String(repositoryPath).replace(/\/+$/u, ''), '.git'));
    if (!name || name === '.' || name === '..') {
        throw new TypeError('The repository URL does not contain a valid extension name.');
    }
    return name;
}

function isRedirectError(error) {
    const message = String(error?.message || error || '');
    return /redirect|\b30[12378]\b/iu.test(message);
}

/**
 * This function extracts the extension information from the manifest file.
 * @param {string} extensionPath - The path of the extension folder
 * @returns {Promise<Object>} - Returns the manifest data as an object
 */
async function getManifest(extensionPath) {
    const manifestPath = path.join(extensionPath, 'manifest.json');

    // Check if manifest.json exists
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`Manifest file not found at ${manifestPath}`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifest;
}

/**
 * This function checks if the local repository is up-to-date with the remote repository.
 * @param {string} extensionPath - The path of the extension folder
 * @returns {Promise<{isUpToDate: boolean, remoteUrl: string, hadOldHistory: boolean}>} - Returns the extension information as an object
 */
async function checkIfRepoIsUpToDate(extensionPath) {
    const git = simpleGit({ baseDir: extensionPath, ...OPTIONS });
    const hadOldHistory = await hasOldHistory(git);
    await fetchBranchTips(git);
    const currentBranch = await git.branch();
    const currentCommitHash = await git.revparse(['HEAD']);
    const log = await git.log({
        from: currentCommitHash,
        to: `origin/${currentBranch.current}`,
    });

    // Fetch remote repository information
    const remotes = await git.getRemotes(true);
    if (remotes.length === 0) {
        return {
            isUpToDate: true,
            remoteUrl: '',
            hadOldHistory,
        };
    }

    return {
        isUpToDate: log.total === 0,
        remoteUrl: remotes[0].refs.fetch, // URL of the remote repository
        hadOldHistory,
    };
}

export const router = express.Router();

/**
 * HTTP POST handler function to clone a git repository from a provided URL, read the extension manifest,
 * and return extension information and path.
 *
 * @param {Object} request - HTTP Request object, expects a JSON body with a 'url' property.
 * @param {Object} response - HTTP Response object used to respond to the HTTP request.
 *
 * @returns {void}
 */
router.post('/install', async (request, response) => {
    if (typeof request.body.url !== 'string' || !request.body.url.trim()) {
        return response.status(400).send('Bad Request: URL is required in the request body.');
    }

    let stagingPath = null;
    let installKey = null;
    try {
        const git = simpleGit(INSTALL_GIT_OPTIONS);

        // make sure the third-party directory exists
        if (!fs.existsSync(path.join(request.user.directories.extensions))) {
            fs.mkdirSync(path.join(request.user.directories.extensions), { recursive: true });
        }

        if (!fs.existsSync(PUBLIC_DIRECTORIES.globalExtensions)) {
            fs.mkdirSync(PUBLIC_DIRECTORIES.globalExtensions, { recursive: true });
        }

        const { url, global, branch } = request.body;

        if (global && !request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to install global extensions.`);
            return response.status(403).send('Forbidden: No permission to install global extensions.');
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const cloneUrl = normalizeExtensionCloneUrl(url);
        const extensionName = getExtensionDirectoryName(cloneUrl);
        const extensionPath = path.join(basePath, extensionName);

        if (fs.existsSync(extensionPath)) {
            return response.status(409).send(`Directory already exists at ${extensionPath}`);
        }
        installKey = path.resolve(extensionPath);
        if (activeExtensionInstalls.has(installKey)) {
            return response.status(409).send(`An extension install is already in progress at ${extensionPath}`);
        }
        activeExtensionInstalls.add(installKey);

        stagingPath = path.join(
            path.dirname(basePath),
            `.${path.basename(basePath)}-${extensionName}.install-${crypto.randomUUID()}`,
        );
        const cloneOptions = { '--depth': 1 };
        if (branch) {
            cloneOptions['--branch'] = branch;
        }
        await git.clone(cloneUrl, stagingPath, cloneOptions);
        const { version, author, display_name } = await getManifest(stagingPath);

        if (fs.existsSync(extensionPath)) {
            await fs.promises.rm(stagingPath, { recursive: true, force: true });
            stagingPath = null;
            return response.status(409).send(`Directory already exists at ${extensionPath}`);
        }
        await fs.promises.rename(stagingPath, extensionPath);
        stagingPath = null;
        console.info(`Extension has been installed at ${extensionPath} from the ${branch || '(default)'} branch`);

        return response.send({ version, author, display_name, extensionPath });
    } catch (error) {
        if (stagingPath) {
            try {
                await fs.promises.rm(stagingPath, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error('Failed to clean extension install staging directory', cleanupError);
            }
        }
        console.error('Importing custom content failed', error);
        if (isRedirectError(error)) {
            return response.status(400).send('Bad Request: Repository redirects are disabled. Use the canonical clone URL (for GitLab, append .git).');
        }
        return response.status(500).send(`Server Error: ${error.message}`);
    } finally {
        if (installKey) activeExtensionInstalls.delete(installKey);
    }
});

/**
 * HTTP POST handler function to pull the latest updates from a git repository
 * based on the extension name provided in the request body. It returns the latest commit hash,
 * the path of the extension, the status of the repository (whether it's up-to-date or not),
 * and the remote URL of the repository.
 *
 * @param {Object} request - HTTP Request object, expects a JSON body with an 'extensionName' property.
 * @param {Object} response - HTTP Response object used to respond to the HTTP request.
 *
 * @returns {void}
 */
router.post('/update', async (request, response) => {
    if (!request.body.extensionName) {
        return response.status(400).send('Bad Request: extensionName is required in the request body.');
    }

    try {
        const { extensionName, global } = request.body;

        if (global && !request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to update global extensions.`);
            return response.status(403).send('Forbidden: No permission to update global extensions.');
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, sanitize(extensionName));

        if (!fs.existsSync(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        const result = await withExtensionGit(extensionPath, async () => {
            const git = simpleGit({ baseDir: extensionPath, ...OPTIONS });
            const isRepo = await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
            if (!isRepo) {
                throw new Error(`Directory is not a Git repository at ${extensionPath}`);
            }
            const { isUpToDate, remoteUrl, hadOldHistory } = await checkIfRepoIsUpToDate(extensionPath);
            const currentBranch = await git.branch();
            if (!isUpToDate) {
                // The fetched tip has no history to merge with; move to it. Untracked files stay.
                await git.reset(['--hard', `origin/${currentBranch.current}`]);
                console.info(`Extension has been updated at ${extensionPath}`);
            } else {
                console.info(`Extension is up to date at ${extensionPath}`);
            }
            if (!isUpToDate || hadOldHistory) {
                scheduleCompaction(extensionPath);
            }
            const fullCommitHash = await git.revparse(['HEAD']);
            const shortCommitHash = fullCommitHash.slice(0, 7);
            return { shortCommitHash, extensionPath, isUpToDate, remoteUrl };
        });

        return response.send(result);
    } catch (error) {
        console.error('Updating extension failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

router.post('/branches', async (request, response) => {
    try {
        const { extensionName, global } = request.body;

        if (!extensionName) {
            return response.status(400).send('Bad Request: extensionName is required in the request body.');
        }

        if (global && !request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to list branches of global extensions.`);
            return response.status(403).send('Forbidden: No permission to list branches of global extensions.');
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, sanitize(extensionName));

        if (!fs.existsSync(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        const result = await withExtensionGit(extensionPath, async () => {
            const git = simpleGit({ baseDir: extensionPath, ...OPTIONS });
            // Fetch the tip of every branch (switching only needs the tips, not the full history)
            await git.remote(['set-branches', 'origin', '*']);
            await fetchBranchTips(git);
            const localBranches = await git.branchLocal();
            const remoteBranches = await git.branch(['-r', '--list', 'origin/*']);
            return [
                ...Object.values(localBranches.branches),
                ...Object.values(remoteBranches.branches),
            ].map(b => ({ current: b.current, commit: b.commit, name: b.name, label: b.label }));
        });

        return response.send(result);
    } catch (error) {
        console.error('Getting branches failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

router.post('/switch', async (request, response) => {
    try {
        const { extensionName, branch, global } = request.body;

        if (!extensionName || !branch) {
            return response.status(400).send('Bad Request: extensionName and branch are required in the request body.');
        }

        if (global && !request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to switch branches of global extensions.`);
            return response.status(403).send('Forbidden: No permission to switch branches of global extensions.');
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, sanitize(extensionName));

        if (!fs.existsSync(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        const missingBranch = await withExtensionGit(extensionPath, async () => {
            const git = simpleGit({ baseDir: extensionPath, ...OPTIONS });
            const branches = await git.branchLocal();

            if (String(branch).startsWith('origin/')) {
                const localBranch = branch.replace('origin/', '');
                if (branches.all.includes(localBranch)) {
                    console.info(`Branch ${localBranch} already exists locally, checking it out`);
                    await git.checkout(localBranch);
                    return false;
                }

                console.info(`Branch ${localBranch} does not exist locally, creating it from ${branch}`);
                await git.checkoutBranch(localBranch, branch);
                return false;
            }

            if (!branches.all.includes(branch)) {
                return true;
            }

            // Check if the branch is already checked out
            const currentBranch = await git.branch();
            if (currentBranch.current === branch) {
                console.info(`Branch ${branch} is already checked out`);
                return false;
            }

            // Checkout the branch
            await git.checkout(branch);
            console.info(`Checked out branch ${branch} at ${extensionPath}`);
            return false;
        });

        if (missingBranch) {
            console.error(`Branch ${branch} does not exist locally`);
            return response.status(404).send(`Branch ${branch} does not exist locally`);
        }

        return response.sendStatus(204);
    } catch (error) {
        console.error('Switching branches failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

router.post('/move', async (request, response) => {
    try {
        const { extensionName, source, destination } = request.body;

        if (!extensionName || !source || !destination) {
            return response.status(400).send('Bad Request. Not all required parameters are provided.');
        }

        if (!request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to move extensions.`);
            return response.status(403).send('Forbidden: No permission to move extensions.');
        }

        const sourceDirectory = source === 'global' ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const destinationDirectory = destination === 'global' ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const sourcePath = path.join(sourceDirectory, sanitize(extensionName));
        const destinationPath = path.join(destinationDirectory, sanitize(extensionName));

        if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
            console.error(`Source directory does not exist at ${sourcePath}`);
            return response.status(404).send('Source directory does not exist.');
        }

        if (fs.existsSync(destinationPath)) {
            console.error(`Destination directory already exists at ${destinationPath}`);
            return response.status(409).send('Destination directory already exists.');
        }

        if (source === destination) {
            console.error('Source and destination directories are the same');
            return response.status(409).send('Source and destination directories are the same.');
        }

        fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true });
        fs.rmSync(sourcePath, { recursive: true, force: true });
        console.info(`Extension has been moved from ${sourcePath} to ${destinationPath}`);

        return response.sendStatus(204);
    } catch (error) {
        console.error('Moving extension failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

/**
 * HTTP POST handler function to get the current git commit hash and branch name for a given extension.
 * It checks whether the repository is up-to-date with the remote, and returns the status along with
 * the remote URL of the repository.
 *
 * @param {Object} request - HTTP Request object, expects a JSON body with an 'extensionName' property.
 * @param {Object} response - HTTP Response object used to respond to the HTTP request.
 *
 * @returns {void}
 */
router.post('/version', async (request, response) => {
    if (!request.body.extensionName) {
        return response.status(400).send('Bad Request: extensionName is required in the request body.');
    }

    try {
        const { extensionName, global } = request.body;
        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, sanitize(extensionName));

        if (!fs.existsSync(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        const result = await withExtensionGit(extensionPath, async () => {
            const git = simpleGit({ baseDir: extensionPath, ...OPTIONS });
            let currentCommitHash;
            try {
                const isRepo = await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
                if (!isRepo) {
                    throw new Error(`Directory is not a Git repository at ${extensionPath}`);
                }
                currentCommitHash = await git.revparse(['HEAD']);
            } catch (error) {
                // it is not a git repo, or has no commits yet, or is a bare repo
                // not possible to update it, most likely can't get the branch name either
                return { currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '' };
            }

            const currentBranch = await git.branch();
            // get only the working branch
            const currentBranchName = currentBranch.current;
            console.debug(extensionName, currentBranchName, currentCommitHash);
            const { isUpToDate, remoteUrl, hadOldHistory } = await checkIfRepoIsUpToDate(extensionPath);
            // Up to date means the shallow fetch just cut HEAD's history, so the old history can go
            if (isUpToDate && hadOldHistory) {
                scheduleCompaction(extensionPath);
            }

            return { currentBranchName, currentCommitHash, isUpToDate, remoteUrl };
        });

        return response.send(result);

    } catch (error) {
        console.error('Getting extension version failed', error);
        return response.status(500).send(`Server Error: ${error.message}`);
    }
});

/**
 * HTTP POST handler function to delete a git repository based on the extension name provided in the request body.
 *
 * @param {Object} request - HTTP Request object, expects a JSON body with a 'url' property.
 * @param {Object} response - HTTP Response object used to respond to the HTTP request.
 *
 * @returns {void}
 */
router.post('/delete', async (request, response) => {
    if (!request.body.extensionName) {
        return response.status(400).send('Bad Request: extensionName is required in the request body.');
    }

    try {
        const { extensionName, global } = request.body;

        if (global && !request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to delete global extensions.`);
            return response.status(403).send('Forbidden: No permission to delete global extensions.');
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, sanitize(extensionName));

        if (!fs.existsSync(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        await withExtensionGit(extensionPath, () => fs.promises.rm(extensionPath, { recursive: true }));
        console.info(`Extension has been deleted at ${extensionPath}`);

        return response.send(`Extension has been deleted at ${extensionPath}`);

    } catch (error) {
        console.error('Deleting custom content failed', error);
        return response.status(500).send(`Server Error: ${error.message}`);
    }
});

/**
 * Discover the extension folders
 * If the folder is called third-party, search for subfolders instead
 */
router.get('/discover', function (request, response) {
    if (!fs.existsSync(path.join(request.user.directories.extensions))) {
        fs.mkdirSync(path.join(request.user.directories.extensions));
    }

    if (!fs.existsSync(PUBLIC_DIRECTORIES.globalExtensions)) {
        fs.mkdirSync(PUBLIC_DIRECTORIES.globalExtensions);
    }

    // Get all folders in system extensions folder, excluding third-party
    const builtInExtensions = fs
        .readdirSync(PUBLIC_DIRECTORIES.extensions)
        .filter(f => fs.statSync(path.join(PUBLIC_DIRECTORIES.extensions, f)).isDirectory())
        .filter(f => f !== 'third-party')
        .map(f => ({ type: 'system', name: f }));

    // Get all folders in local extensions folder
    const userExtensions = fs
        .readdirSync(path.join(request.user.directories.extensions))
        .filter(f => fs.statSync(path.join(request.user.directories.extensions, f)).isDirectory())
        .map(f => ({ type: 'local', name: `third-party/${f}` }));

    // Get all folders in global extensions folder
    // In case of a conflict, the extension will be loaded from the user folder
    const globalExtensions = fs
        .readdirSync(PUBLIC_DIRECTORIES.globalExtensions)
        .filter(f => fs.statSync(path.join(PUBLIC_DIRECTORIES.globalExtensions, f)).isDirectory())
        .map(f => ({ type: 'global', name: `third-party/${f}` }))
        .filter(f => !userExtensions.some(e => e.name === f.name));

    // Combine all extensions
    const allExtensions = [...builtInExtensions, ...userExtensions, ...globalExtensions];
    console.debug('Extensions available for', request.user.profile.handle, allExtensions);

    return response.send(allExtensions);
});

/**
 * The modules each extension imports from its own folder, so the client can
 * preload them all at once instead of one import level at a time.
 */
router.post('/module-graph', async function (request, response) {
    try {
        const names = Array.isArray(request.body?.names) ? request.body.names : [];
        const modules = await getExtensionModuleGraph(names, request.user.directories.extensions);
        return response.send({ modules });
    } catch (error) {
        console.warn('Could not map extension modules:', error);
        return response.send({ modules: {} });
    }
});
