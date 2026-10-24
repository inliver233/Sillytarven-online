import ignore from 'ignore';

/**
 * Which parts of a user's data directory a repository tracks, in tavern terms.
 *
 * Paths are repository paths (forward slashes, relative to the user's data directory).
 * Categories can be switched on and off by the user; the hard exclusions below cannot.
 */

/**
 * @typedef {object} Category
 * @property {string} id
 * @property {string} label
 * @property {string[]} prefixes Path prefixes ("dir/") or exact file names
 * @property {boolean} defaultEnabled
 * @property {string} [hint]
 */

/** @type {readonly Category[]} */
export const CATEGORIES = Object.freeze([
    { id: 'chats', label: '聊天', prefixes: ['chats/'], defaultEnabled: true },
    { id: 'groupChats', label: '群聊', prefixes: ['group chats/', 'groups/'], defaultEnabled: true },
    { id: 'characters', label: '角色卡', prefixes: ['characters/'], defaultEnabled: true },
    { id: 'worlds', label: '世界书', prefixes: ['worlds/'], defaultEnabled: true },
    {
        id: 'presets', label: '预设', defaultEnabled: true,
        prefixes: ['OpenAI Settings/', 'TextGen Settings/', 'KoboldAI Settings/', 'NovelAI Settings/', 'instruct/', 'context/', 'sysprompt/', 'reasoning/'],
    },
    { id: 'settings', label: '酒馆设置', prefixes: ['settings.json'], defaultEnabled: true },
    { id: 'personas', label: '用户人设', prefixes: ['User Avatars/'], defaultEnabled: true },
    { id: 'quickReplies', label: '快速回复', prefixes: ['QuickReplies/'], defaultEnabled: true },
    { id: 'themes', label: '主题与布局', prefixes: ['themes/', 'movingUI/'], defaultEnabled: true },
    { id: 'backgrounds', label: '背景图', prefixes: ['backgrounds/'], defaultEnabled: true },
    { id: 'userFiles', label: '用户文件', prefixes: ['user/', 'assets/'], defaultEnabled: true, hint: '聊天里的图片、附件、资源包' },
    { id: 'extensions', label: '第三方扩展', prefixes: ['extensions/'], defaultEnabled: false, hint: '体积大，且扩展本身可以重新安装' },
    { id: 'other', label: '其他文件', prefixes: [], defaultEnabled: true },
]);

/**
 * Never tracked, whatever the user picks: credentials, nested repositories,
 * and data the tavern regenerates or that only makes sense on this server.
 */
export const HARD_EXCLUDES = Object.freeze([
    'secrets.json',
    '.git/',
    '**/.git/',
    'backups/',
    'thumbnails/',
    'vectors/',
    'content.log',
    'stats.json',
    '**/*.tmp',
    '**/.DS_Store',
]);

const hardIgnore = ignore().add([...HARD_EXCLUDES]);

/**
 * @param {string} filepath
 * @returns {Category}
 */
export function categoryOf(filepath) {
    return CATEGORIES.find(category => category.prefixes.some(prefix => (prefix.endsWith('/') ? filepath.startsWith(prefix) : filepath === prefix)))
        ?? CATEGORIES[CATEGORIES.length - 1];
}

/**
 * Whether a path may ever be stored in a repository.
 * @param {string} filepath
 */
export function isHardExcluded(filepath) {
    return !filepath || hardIgnore.ignores(filepath) || filepath.split('/').includes('.git');
}

/**
 * @typedef {object} TrackingRules
 * @property {Record<string, boolean>} categories Enabled flag per category id
 * @property {string[]} ignore Extra gitignore-style patterns
 * @property {number} maxFileSizeMiB Larger files are skipped
 */

/** @returns {TrackingRules} */
export function defaultTrackingRules() {
    return {
        categories: Object.fromEntries(CATEGORIES.map(category => [category.id, category.defaultEnabled])),
        ignore: [],
        maxFileSizeMiB: 95,
    };
}

/**
 * Accepts rules from a client or a stored file and returns a complete, valid object.
 * @param {any} value
 * @returns {TrackingRules}
 */
export function sanitizeTrackingRules(value) {
    const rules = defaultTrackingRules();
    if (value && typeof value === 'object') {
        for (const category of CATEGORIES) {
            if (typeof value.categories?.[category.id] === 'boolean') {
                rules.categories[category.id] = value.categories[category.id];
            }
        }
        if (Array.isArray(value.ignore)) {
            rules.ignore = value.ignore.filter(line => typeof line === 'string').map(line => line.trim()).filter(Boolean).slice(0, 200).map(line => line.slice(0, 300));
        }
        const size = Number(value.maxFileSizeMiB);
        if (Number.isFinite(size) && size >= 1 && size <= 2000) {
            rules.maxFileSizeMiB = Math.round(size);
        }
    }
    return rules;
}

/**
 * Builds a predicate deciding whether a path is tracked under the given rules.
 * Directory prefixes ("dir/") are answered too, so walks can skip whole folders.
 * @param {TrackingRules} rules
 * @returns {(filepath: string) => boolean}
 */
export function createTrackFilter(rules) {
    const userIgnore = ignore().add(rules.ignore);
    return (filepath) => {
        // isomorphic-git asks about the root and about directories too; rejecting a directory
        // does not skip its contents, so only files really matter here.
        if (filepath === '.') return true;
        if (isHardExcluded(filepath)) return false;
        if (rules.ignore.length && userIgnore.ignores(filepath)) return false;
        const category = categoryOf(filepath);
        if (rules.categories[category.id]) return true;
        // A directory path may still contain tracked files of another category ("user/" vs "user/images/").
        return filepath.endsWith('/') && CATEGORIES.some(other => rules.categories[other.id] && other.prefixes.some(prefix => prefix.startsWith(filepath)));
    };
}

/**
 * A short, readable description of what a path is, for change lists and commit messages.
 * @param {string} filepath
 * @returns {{ category: string, categoryLabel: string, item: string }}
 */
export function describePath(filepath) {
    const category = categoryOf(filepath);
    const parts = filepath.split('/');
    const stripExt = name => name.replace(/\.(jsonl|json|png|webp|jpe?g|gif|txt|md|css)$/i, '');
    let item;
    switch (category.id) {
        case 'chats':
            // chats/<character>/<chat>.jsonl and its .chunks / .index / .metadata companions
            item = parts[1] ? `${parts[1]} · ${stripExt((parts[2] ?? '').replace(/\.jsonl(\.(chunks|index\.json|metadata\.json|revision\.json))?$/, '.jsonl'))}` : filepath;
            break;
        case 'groupChats':
            item = stripExt((parts[1] ?? filepath).replace(/\.jsonl(\.(chunks|index\.json|metadata\.json|revision\.json))?$/, '.jsonl'));
            break;
        case 'settings':
            item = '酒馆设置';
            break;
        default:
            item = stripExt(parts.length > 1 ? parts.slice(1).join('/') : filepath);
    }
    return { category: category.id, categoryLabel: category.label, item };
}
