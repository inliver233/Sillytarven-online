import fs from 'node:fs';
import path from 'node:path';

import { SETTINGS_FILE, USER_DIRECTORY_TEMPLATE } from './constants.js';
import { SECRETS_FILE } from './endpoints/secrets.js';
import { safeCopySync } from './util.js';

const DEFAULT_TEMPLATE_DIR_NAME = 'default-template';
const DEFAULT_TEMPLATE_ROOT = path.join(globalThis.DATA_ROOT, DEFAULT_TEMPLATE_DIR_NAME);
const DEFAULT_TEMPLATE_CONFIG = path.join(DEFAULT_TEMPLATE_ROOT, 'template.json');

const TEMPLATE_CATEGORIES = Object.freeze({
    settings: {
        label: 'Settings (settings.json)',
        type: 'file',
        fileName: SETTINGS_FILE,
    },
    secrets: {
        label: 'API Keys (secrets.json)',
        type: 'file',
        fileName: SECRETS_FILE,
        sensitive: true,
    },
    characters: {
        label: 'Characters',
        type: 'dir',
        dirKey: 'characters',
    },
    worlds: {
        label: 'World Info',
        type: 'dir',
        dirKey: 'worlds',
    },
    backgrounds: {
        label: 'Backgrounds',
        type: 'dir',
        dirKey: 'backgrounds',
    },
    themes: {
        label: 'Themes',
        type: 'dir',
        dirKey: 'themes',
    },
    avatars: {
        label: 'User Avatars',
        type: 'dir',
        dirKey: 'avatars',
    },
    assets: {
        label: 'Assets',
        type: 'dir',
        dirKey: 'assets',
    },
    instruct: {
        label: 'Instruct Presets',
        type: 'dir',
        dirKey: 'instruct',
    },
    context: {
        label: 'Context Presets',
        type: 'dir',
        dirKey: 'context',
    },
    sysprompt: {
        label: 'System Prompts',
        type: 'dir',
        dirKey: 'sysprompt',
    },
    reasoning: {
        label: 'Reasoning Templates',
        type: 'dir',
        dirKey: 'reasoning',
    },
    quickreplies: {
        label: 'Quick Replies',
        type: 'dir',
        dirKey: 'quickreplies',
    },
    openai_settings: {
        label: 'OpenAI Presets',
        type: 'dir',
        dirKey: 'openAI_Settings',
    },
    kobold_settings: {
        label: 'Kobold Presets',
        type: 'dir',
        dirKey: 'koboldAI_Settings',
    },
    novel_settings: {
        label: 'NovelAI Presets',
        type: 'dir',
        dirKey: 'novelAI_Settings',
    },
    textgen_settings: {
        label: 'TextGen Presets',
        type: 'dir',
        dirKey: 'textGen_Settings',
    },
    moving_ui: {
        label: 'Moving UI Layout',
        type: 'dir',
        dirKey: 'movingUI',
    },
});

const TEMPLATE_CATEGORY_IDS = Object.freeze(Object.keys(TEMPLATE_CATEGORIES));

function copyDirectoryContents(sourceDir, targetDir) {
    fs.mkdirSync(targetDir, { recursive: true });
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);
        // Hand-rolled copy: fs.cpSync({recursive:true}) crashes with non-ASCII paths on some Windows setups
        if (fs.existsSync(targetPath)) {
            fs.rmSync(targetPath, { recursive: true, force: true });
        }
        safeCopySync(sourcePath, targetPath);
    }
}

function resolveCategories(categories, fallbackAll = false) {
    const resolved = Array.isArray(categories)
        ? categories.filter((id) => TEMPLATE_CATEGORIES[id])
        : [];

    if (resolved.length === 0 && fallbackAll) {
        return [...TEMPLATE_CATEGORY_IDS];
    }

    return resolved;
}

function getTemplatePath(categoryId) {
    const category = TEMPLATE_CATEGORIES[categoryId];
    if (!category) {
        return null;
    }
    if (category.type === 'file') {
        return path.join(DEFAULT_TEMPLATE_ROOT, category.fileName);
    }
    const subdir = USER_DIRECTORY_TEMPLATE[category.dirKey];
    return path.join(DEFAULT_TEMPLATE_ROOT, subdir);
}

function getTargetPath(categoryId, directories) {
    const category = TEMPLATE_CATEGORIES[categoryId];
    if (!category) {
        return null;
    }
    if (category.type === 'file') {
        return path.join(directories.root, category.fileName);
    }
    return directories[category.dirKey];
}

function updateSettingsForNewUser(directories, userName) {
    if (!userName) {
        return false;
    }

    const trimmedName = String(userName).trim();
    if (!trimmedName) {
        return false;
    }

    const settingsPath = path.join(directories.root, SETTINGS_FILE);
    if (!fs.existsSync(settingsPath)) {
        return false;
    }

    try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const avatarId = settings?.user_avatar || 'user-default.png';

        let updated = false;
        if (settings.username !== trimmedName) {
            settings.username = trimmedName;
            updated = true;
        }

        if (!settings.power_user || typeof settings.power_user !== 'object') {
            settings.power_user = {};
            updated = true;
        }

        if (!settings.power_user.personas || typeof settings.power_user.personas !== 'object') {
            settings.power_user.personas = {};
            updated = true;
        }

        if (settings.power_user.personas[avatarId] !== trimmedName) {
            settings.power_user.personas[avatarId] = trimmedName;
            updated = true;
        }

        if (updated) {
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4), 'utf8');
        }

        return updated;
    } catch (error) {
        console.error('Failed to update settings for new user:', error);
        return false;
    }
}

export function listDefaultTemplateCategories() {
    return TEMPLATE_CATEGORY_IDS.map((id) => ({
        id,
        label: TEMPLATE_CATEGORIES[id].label,
        type: TEMPLATE_CATEGORIES[id].type,
        sensitive: Boolean(TEMPLATE_CATEGORIES[id].sensitive),
    }));
}

export function getDefaultTemplateInfo() {
    if (!fs.existsSync(DEFAULT_TEMPLATE_CONFIG)) {
        return {
            exists: false,
            categories: [],
        };
    }

    try {
        const rawConfig = JSON.parse(fs.readFileSync(DEFAULT_TEMPLATE_CONFIG, 'utf8'));
        const categories = resolveCategories(rawConfig.categories, false);
        return {
            exists: true,
            sourceHandle: rawConfig.sourceHandle || null,
            updatedAt: rawConfig.updatedAt || null,
            categories,
        };
    } catch (error) {
        console.error('Failed to read default template config:', error);
        return {
            exists: false,
            categories: [],
            error: 'Failed to read template config',
        };
    }
}

export function snapshotDefaultTemplateFromUser(directories, sourceHandle, categories) {
    const selectedCategories = resolveCategories(categories, true);
    const missing = [];

    fs.rmSync(DEFAULT_TEMPLATE_ROOT, { recursive: true, force: true });
    fs.mkdirSync(DEFAULT_TEMPLATE_ROOT, { recursive: true });

    for (const categoryId of selectedCategories) {
        const category = TEMPLATE_CATEGORIES[categoryId];
        if (!category) {
            continue;
        }
        const sourcePath = getTargetPath(categoryId, directories);
        const targetPath = getTemplatePath(categoryId);
        if (!sourcePath || !targetPath || !fs.existsSync(sourcePath)) {
            missing.push(categoryId);
            continue;
        }

        if (category.type === 'file') {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.copyFileSync(sourcePath, targetPath);
            continue;
        }

        copyDirectoryContents(sourcePath, targetPath);
    }

    const config = {
        sourceHandle,
        updatedAt: Date.now(),
        categories: selectedCategories,
    };
    fs.writeFileSync(DEFAULT_TEMPLATE_CONFIG, JSON.stringify(config, null, 2), 'utf8');

    return {
        ...config,
        missing,
    };
}

export function applyDefaultTemplateToUser(directories, options = {}) {
    const info = getDefaultTemplateInfo();
    if (!info.exists || !info.categories.length) {
        return { applied: false, appliedCategories: [], missing: [] };
    }

    const appliedCategories = [];
    const missing = [];

    for (const categoryId of info.categories) {
        const category = TEMPLATE_CATEGORIES[categoryId];
        if (!category) {
            continue;
        }
        const sourcePath = getTemplatePath(categoryId);
        const targetPath = getTargetPath(categoryId, directories);

        if (!sourcePath || !targetPath || !fs.existsSync(sourcePath)) {
            missing.push(categoryId);
            continue;
        }

        if (category.type === 'file') {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.copyFileSync(sourcePath, targetPath);
            appliedCategories.push(categoryId);
            continue;
        }

        copyDirectoryContents(sourcePath, targetPath);
        appliedCategories.push(categoryId);
    }

    if (appliedCategories.includes('settings')) {
        updateSettingsForNewUser(directories, options.userName);
    }

    return {
        applied: appliedCategories.length > 0,
        appliedCategories,
        missing,
    };
}

export function clearDefaultTemplate() {
    fs.rmSync(DEFAULT_TEMPLATE_ROOT, { recursive: true, force: true });
}
