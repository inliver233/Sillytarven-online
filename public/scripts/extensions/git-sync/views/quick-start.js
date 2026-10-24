import { esc, finishWorkTreeChange, flushPendingSaves, gitApi } from '../shared.js';
import { reloadSmartCommit } from '../smart-commit.js';

/**
 * 快速开始: the same two paths as the setup wizard (start here / restore from a remote), asked one
 * small question per screen, with links that open exactly the page to click on and the address
 * and token checked before anything happens.
 */

const REPO_NAME = 'tavern-backup';

/** Per-platform pages and what to click there. */
const PLATFORMS = {
    github: {
        label: 'GitHub',
        hint: '全球最大的代码网站，免费',
        host: 'github.com',
        home: 'https://github.com/signup',
        newRepo: `https://github.com/new?name=${REPO_NAME}&visibility=private`,
        newRepoSteps: ['仓库名已经帮你填好了', '确认选中了 <b>Private（私有）</b>', '其他什么都不用动', '点页面最下面绿色的 <b>Create repository</b>'],
        token: 'https://github.com/settings/tokens/new?scopes=repo&description=Tavern%20Git',
        tokenSteps: ['如果要求输入密码，输入你的 GitHub 密码', '<b>Expiration（有效期）</b>选 <b>No expiration</b>，以后就不用重新弄', '拉到页面最下面，点绿色的 <b>Generate token</b>', '复制出现的那一串字（<code>ghp_</code> 开头），回来粘贴'],
        tokenPattern: /^(ghp_|github_pat_|gho_)/,
    },
    gitee: {
        label: 'Gitee 码云',
        hint: '国内网站，打不开 GitHub 就选它',
        host: 'gitee.com',
        home: 'https://gitee.com/signup',
        newRepo: 'https://gitee.com/projects/new',
        newRepoSteps: [`<b>仓库名称</b>填 <code>${REPO_NAME}</code>`, '选 <b>私有</b>', '下面的“初始化仓库”之类的选项<b>都不要勾</b>', '点 <b>创建</b>'],
        token: 'https://gitee.com/profile/personal_access_tokens/new',
        tokenSteps: ['<b>私人令牌描述</b>随便写，比如“酒馆”', '下面的权限<b>保持默认</b>（确保 <b>projects</b> 是勾上的）', '点 <b>提交</b>，再输入一次 Gitee 密码', '复制出现的那一串字，回来粘贴（它只显示一次）'],
        tokenPattern: /^[0-9a-f]{32}$/i,
        needsUsername: true,
    },
    gitlab: {
        label: 'GitLab',
        hint: '和 GitHub 差不多的另一家',
        host: 'gitlab.com',
        home: 'https://gitlab.com/users/sign_up',
        newRepo: 'https://gitlab.com/projects/new#blank_project',
        newRepoSteps: [`<b>Project name</b> 填 <code>${REPO_NAME}</code>`, '<b>Visibility Level</b> 选 <b>Private</b>', '把 <b>Initialize repository with a README</b> 的勾<b>去掉</b>', '点 <b>Create project</b>'],
        token: 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Tavern%20Git&scopes=write_repository',
        tokenSteps: ['名字和权限已经帮你选好了（<b>write_repository</b>）', '<b>Expiration date</b> 可以选一个尽量远的日期', '点 <b>Create personal access token</b>', '复制出现的那一串字（<code>glpat-</code> 开头），回来粘贴'],
        tokenPattern: /^glpat-/,
    },
    custom: {
        label: '其他',
        hint: '我自己有 Gitea、Forgejo 等 Git 服务',
        host: '',
        needsUsername: true,
    },
};

/**
 * Tidies whatever the user pasted into a clone address: adds https://, drops the page part of a
 * browser address (…/tree/main) and adds .git on the big hosts.
 * @param {string} raw
 * @param {string} platformId
 * @returns {{ url?: string, owner?: string, platform?: string, error?: string }}
 */
export function cleanRepoAddress(raw, platformId) {
    let text = String(raw ?? '').trim().replace(/^[“"'「]+|[”"'」]+$/g, '').trim();
    if (!text) return { error: '还没有粘贴地址' };
    if (/^(ghp_|github_pat_|glpat-)/.test(text) || (/^[0-9a-f]{32}$/i.test(text))) return { error: '这是“钥匙”，不是地址。钥匙下一步再贴，这里要的是仓库网址' };
    if (text.startsWith('git@')) text = text.replace(/^git@([^:]+):/, 'https://$1/');
    if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
    let url;
    try {
        url = new URL(text);
    } catch {
        return { error: '这看起来不是一个网址' };
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const platform = Object.entries(PLATFORMS).find(([, entry]) => entry.host && host === entry.host)?.[0] ?? (platformId === 'custom' ? 'custom' : null);
    if (!platform) return { error: `这不是 ${PLATFORMS[platformId].label} 的网址，请复制你刚建好的仓库页面的网址` };
    let segments = url.pathname.split('/').filter(Boolean);
    if (platform !== 'custom') {
        const pagePart = segments.findIndex((segment, index) => segment === '-' || (index >= 2 && ['tree', 'blob', 'commits', 'issues', 'pulls', 'settings', 'wikis'].includes(segment)));
        if (pagePart >= 0) segments = segments.slice(0, pagePart);
        if (platform !== 'gitlab') segments = segments.slice(0, 2);
        if (['new', 'settings', 'projects', 'profile', 'dashboard'].includes(segments[0])) return { error: '这是创建页面的网址。请先点“创建”，再复制建好之后那个页面的网址' };
        if (segments.length < 2) return { error: '地址不完整，应该像这样：https://' + PLATFORMS[platform].host + '/你的用户名/' + REPO_NAME };
        segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/, '') + '.git';
    }
    url.pathname = '/' + segments.join('/');
    url.search = '';
    url.hash = '';
    return { url: url.toString(), owner: segments[0] ?? '', platform };
}

/** @param {HTMLElement} input */
async function pasteInto(input) {
    try {
        input.value = (await navigator.clipboard.readText()).trim();
        input.dispatchEvent(new Event('input'));
    } catch {
        input.focus();
        toastr.info('请长按输入框，选“粘贴”');
    }
}

/**
 * @param {HTMLElement} container
 * @param {import('../index.js').PanelApp} app
 * @param {{ onlineOnly?: boolean, onExit?: () => void }} [options] onlineOnly: the repository exists, only connect it to the internet
 */
export function renderQuickStart(container, app, { onlineOnly = false, onExit } = {}) {
    /** Answers so far. */
    const answers = {
        mode: onlineOnly ? 'new' : '',
        online: onlineOnly,
        platform: '',
        url: '',
        owner: '',
        username: '',
        token: '',
        auto: true,
        branch: '',
        branches: [],
    };
    const trail = [];

    const show = (screen, remember = true) => {
        if (remember && current) trail.push(current);
        current = screen;
        draw();
    };
    const back = () => {
        const previous = trail.pop();
        if (!previous) {
            onExit?.();
            return;
        }
        current = previous;
        draw();
    };
    let current = null;

    /** Screen order for the progress dots. */
    const route = () => {
        if (answers.mode === 'restore') return ['start', 'platform', 'url', 'token', 'auto', 'confirm'];
        if (!answers.online) return ['start', 'where', 'auto', 'run'];
        return [...(onlineOnly ? [] : ['start', 'where']), 'platform', 'account', 'repo', 'url', 'token', 'auto', 'run'];
    };

    const frame = (inner) => {
        const steps = route();
        const index = Math.max(steps.indexOf(current), 0);
        container.innerHTML = `
            <div class="git-sync-qs">
                <div class="git-sync-qs-top">
                    <button type="button" class="git-sync-qs-back" data-qs="back"><i class="fa-solid fa-arrow-left"></i> 上一步</button>
                    <div class="git-sync-qs-dots">${steps.map((_, i) => `<span class="${i < index ? 'done' : i === index ? 'now' : ''}"></span>`).join('')}</div>
                </div>
                ${inner}
                <div class="git-sync-qs-error" hidden></div>
            </div>`;
        container.querySelector('[data-qs="back"]').addEventListener('click', back);
        container.querySelector('.git-sync-qs').scrollIntoView?.({ block: 'start' });
    };
    const fail = (text) => {
        const box = container.querySelector('.git-sync-qs-error');
        box.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> ${text}`;
        box.hidden = false;
        box.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    };
    const choices = (items) => `<div class="git-sync-qs-choices">${items.map(item => `
        <button type="button" class="git-sync-qs-choice${item.primary ? ' primary' : ''}" data-choice="${esc(item.id)}">
            <i class="fa-solid ${item.icon}"></i>
            <span><b>${item.title}</b>${item.text ? `<small>${item.text}</small>` : ''}</span>
            <i class="fa-solid fa-chevron-right git-sync-qs-arrow"></i>
        </button>`).join('')}</div>`;
    const onChoice = (handler) => container.querySelectorAll('[data-choice]').forEach(button => button.addEventListener('click', () => handler(button.dataset.choice)));
    const head = (icon, title, text = '') => `
        <div class="git-sync-qs-head">
            <i class="fa-solid ${icon}"></i>
            <h2>${title}</h2>
            ${text ? `<p>${text}</p>` : ''}
        </div>`;
    const next = (label = '下一步', icon = 'fa-arrow-right') => `<button type="button" class="menu_button git-sync-qs-next" data-qs="next">${label} <i class="fa-solid ${icon}"></i></button>`;
    const platform = () => PLATFORMS[answers.platform];
    const openLink = (href, label) => `<a class="menu_button git-sync-qs-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square"></i> ${label}</a>`;
    const stepList = (items) => `<ol class="git-sync-qs-steps">${items.map(item => `<li>${item}</li>`).join('')}</ol>`;

    const screens = {
        start() {
            frame(head('fa-hand-sparkles', '你以前用酒馆 Git 存过备份吗？', '不知道的话，选“没有”就对了。') + choices([
                { id: 'new', icon: 'fa-seedling', title: '没有，我第一次用', text: '帮我把现在的聊天、角色卡存起来', primary: true },
                { id: 'restore', icon: 'fa-cloud-arrow-down', title: '有，我要把以前的备份拿回来', text: '比如换了账号、换了酒馆' },
            ]));
            onChoice((id) => {
                answers.mode = id;
                answers.online = id === 'restore';
                show(id === 'restore' ? 'platform' : 'where');
            });
        },
        where() {
            frame(head('fa-box-archive', '备份放在哪里？') + choices([
                { id: 'local', icon: 'fa-house', title: '只放在这个酒馆里', text: '最简单，点一下就好。但如果这个账号没了，备份也会一起没' },
                { id: 'online', icon: 'fa-cloud', title: '再往网上放一份（更安全）', text: '账号出问题也能找回来。要先注册一个网站，大概 5 分钟', primary: true },
            ]));
            onChoice((id) => {
                answers.online = id === 'online';
                show(answers.online ? 'platform' : 'auto');
            });
        },
        platform() {
            const restoring = answers.mode === 'restore';
            frame(head('fa-globe', restoring ? '你的备份放在哪个网站？' : '选一个网站放备份', restoring ? '' : '都免费。选一个你能打开的就行。') + choices(Object.entries(PLATFORMS).map(([id, entry]) => ({
                id, icon: id === 'custom' ? 'fa-server' : id === 'gitee' ? 'fa-g' : id === 'gitlab' ? 'fa-gitlab' : 'fa-github', title: entry.label, text: entry.hint, primary: id === 'github',
            }))));
            container.querySelectorAll('.git-sync-qs-choice i.fa-github, .git-sync-qs-choice i.fa-gitlab').forEach(icon => icon.classList.replace('fa-solid', 'fa-brands'));
            onChoice((id) => {
                answers.platform = id;
                show(restoring || id === 'custom' ? 'url' : 'account');
            });
        },
        account() {
            frame(head('fa-user-plus', `第 1 步：登录 ${esc(platform().label)}`, '没有账号的话，先点下面的按钮注册一个。已经有账号就直接登录。')
                + `<div class="git-sync-qs-actions">${openLink(platform().home, `打开 ${esc(platform().label)}`)}</div>`
                + `<div class="git-sync-qs-foot">${next('我已经登录好了')}</div>`);
            container.querySelector('[data-qs="next"]').addEventListener('click', () => show('repo'));
        },
        repo() {
            frame(head('fa-folder-plus', '第 2 步：建一个空仓库', '仓库就是放备份的“文件夹”。点下面的按钮，然后照着做：')
                + stepList(platform().newRepoSteps)
                + `<div class="git-sync-qs-actions">
                    ${openLink(platform().newRepo, '打开创建页面')}
                    <button type="button" class="menu_button git-sync-qs-link" data-qs="copy-name"><i class="fa-solid fa-copy"></i> 复制名字 ${REPO_NAME}</button>
                </div>`
                + `<div class="git-sync-qs-foot">${next('建好了')}</div>`);
            container.querySelector('[data-qs="copy-name"]').addEventListener('click', () => navigator.clipboard?.writeText(REPO_NAME).then(() => toastr.success('已复制')).catch(() => toastr.info(`名字是 ${REPO_NAME}`)));
            container.querySelector('[data-qs="next"]').addEventListener('click', () => show('url'));
        },
        url() {
            const restoring = answers.mode === 'restore';
            const example = platform().host ? `https://${platform().host}/你的用户名/${REPO_NAME}` : 'https://git.example.com/你的用户名/仓库名';
            frame(head('fa-link', `${restoring || !platform().newRepo ? '' : '第 3 步：'}把仓库的网址贴过来`, restoring
                ? '打开你放备份的那个仓库，复制浏览器最上面地址栏里的网址。'
                : '刚才建好仓库后，浏览器会跳到仓库页面。复制<b>浏览器最上面地址栏</b>里的网址。')
                + `<div class="git-sync-qs-field">
                    <input class="text_pole" data-field="url" value="${esc(answers.url)}" placeholder="${esc(example)}" spellcheck="false" autocomplete="off" inputmode="url">
                    <button type="button" class="menu_button" data-qs="paste"><i class="fa-solid fa-paste"></i> 粘贴</button>
                </div>
                <div class="git-sync-qs-check" data-check></div>
                <div class="git-sync-qs-example">长得像这样：<code>${esc(example)}</code></div>`
                + `<div class="git-sync-qs-foot">${next()}</div>`);
            const input = /** @type {HTMLInputElement} */ (container.querySelector('[data-field="url"]'));
            const check = container.querySelector('[data-check]');
            const validate = () => {
                if (!input.value.trim()) {
                    check.innerHTML = '';
                    return null;
                }
                const result = cleanRepoAddress(input.value, answers.platform);
                check.className = `git-sync-qs-check ${result.error ? 'bad' : 'good'}`;
                check.innerHTML = result.error ? `<i class="fa-solid fa-circle-exclamation"></i> ${esc(result.error)}` : '<i class="fa-solid fa-circle-check"></i> 看起来对了';
                return result;
            };
            input.addEventListener('input', validate);
            validate();
            container.querySelector('[data-qs="paste"]').addEventListener('click', () => pasteInto(input));
            container.querySelector('[data-qs="next"]').addEventListener('click', () => {
                const result = validate();
                if (!result) return fail('请先把网址粘贴到上面的框里');
                if (result.error) return fail(esc(result.error));
                answers.url = result.url;
                answers.owner = result.owner;
                answers.platform = result.platform;
                if (!answers.username) answers.username = result.owner;
                show('token');
            });
        },
        token() {
            const restoring = answers.mode === 'restore';
            const entry = platform();
            frame(head('fa-key', `${restoring || !entry.newRepo ? '' : '第 4 步：'}拿一把“钥匙”`, '钥匙（令牌）让酒馆可以把备份放进你的仓库。它只保存在你的酒馆账号里，别发给别人。')
                + (entry.token ? stepList([`点下面的按钮，打开 ${esc(entry.label)} 的钥匙页面`, ...entry.tokenSteps]) + `<div class="git-sync-qs-actions">${openLink(entry.token, '打开钥匙页面')}</div>` : '<p class="git-sync-qs-text">在你的 Git 服务的设置里创建一个有<b>仓库读写权限</b>的访问令牌。</p>')
                + (entry.needsUsername ? `<label class="git-sync-qs-label">你在${answers.platform === 'custom' ? '这个 Git 服务上' : ` ${esc(entry.label)} `}的用户名<small>（一般就是网址里的这一段，已经帮你填好了）</small>
                    <input class="text_pole" data-field="username" value="${esc(answers.username)}" spellcheck="false" autocomplete="off"></label>` : '')
                + `<label class="git-sync-qs-label">把钥匙粘贴到这里</label>
                <div class="git-sync-qs-field">
                    <input class="text_pole" data-field="token" type="password" value="${esc(answers.token)}" placeholder="粘贴那一串字" spellcheck="false" autocomplete="new-password">
                    <button type="button" class="menu_button" data-qs="paste"><i class="fa-solid fa-paste"></i> 粘贴</button>
                </div>
                <div class="git-sync-qs-check" data-check></div>`
                + `<div class="git-sync-qs-foot">
                    ${restoring ? '<button type="button" class="git-sync-qs-skip" data-qs="skip">我的仓库是公开的，不需要钥匙</button>' : ''}
                    ${next('连接试试', 'fa-plug')}
                </div>`);
            const input = /** @type {HTMLInputElement} */ (container.querySelector('[data-field="token"]'));
            const check = container.querySelector('[data-check]');
            const validate = () => {
                const value = input.value.trim();
                if (!value) {
                    check.innerHTML = '';
                    return;
                }
                const problem = /^https?:\/\//.test(value) ? '这是网址，不是钥匙。钥匙是一长串字母和数字'
                    : /\s/.test(value) ? '钥匙中间不应该有空格，可能复制多了'
                        : entry.tokenPattern && !entry.tokenPattern.test(value) ? `${entry.label} 的钥匙一般不长这样，确认一下复制的对不对（不对的话下一步会告诉你）` : '';
                check.className = `git-sync-qs-check ${problem ? 'bad' : 'good'}`;
                check.innerHTML = problem ? `<i class="fa-solid fa-circle-exclamation"></i> ${esc(problem)}` : '<i class="fa-solid fa-circle-check"></i> 收到';
            };
            input.addEventListener('input', validate);
            validate();
            container.querySelector('[data-qs="paste"]').addEventListener('click', () => pasteInto(input));
            const connect = async (useToken) => {
                answers.token = useToken ? input.value.trim() : '';
                answers.username = container.querySelector('[data-field="username"]')?.value.trim() || answers.owner;
                if (useToken && !answers.token) return fail('请先把钥匙粘贴到上面的框里');
                if (/^https?:\/\//.test(answers.token)) return fail('这是网址，不是钥匙');
                try {
                    const info = await app.busy('正在连接，请稍等…', async () => {
                        await gitApi('/remote/save', { name: 'origin', url: answers.url, provider: answers.platform === 'custom' ? '' : answers.platform, username: answers.username, token: answers.token, clearToken: !answers.token });
                        return gitApi('/remote/test', { name: 'origin' });
                    });
                    if (restoring) {
                        if (!info.branches.length) return fail('连上了，但这个仓库是<b>空的</b>，里面没有备份。确认一下网址是不是你放备份的那个仓库。');
                        answers.branches = info.branches.map(branch => branch.name);
                        answers.branch = info.defaultBranch || answers.branches[0];
                        show('auto');
                        return;
                    }
                    if (!info.canPush) return fail('连上了，但这把钥匙<b>没有写入权限</b>。请回到钥匙页面重新建一把，按上面的步骤勾好权限。');
                    if (info.branches.length) return fail('这个仓库里<b>已经有东西了</b>。如果这是你以前的备份，请回到最开始选“有，我要把以前的备份拿回来”；不然请换一个新建的空仓库。');
                    show('auto');
                } catch (error) {
                    fail(friendlyError(error));
                }
            };
            container.querySelector('[data-qs="next"]').addEventListener('click', () => connect(true));
            container.querySelector('[data-qs="skip"]')?.addEventListener('click', () => connect(false));
        },
        auto() {
            const online = answers.online;
            frame(head('fa-wand-magic-sparkles', '以后要我自动帮你存吗？', '自动存的时候不会打扰你，AI 正在回复时也会等它说完。') + choices([
                { id: 'yes', icon: 'fa-check', title: '要，自动存（推荐）', text: `每次离开一个聊天、每聊 20 条消息，自动存一次${online ? '，并放到网上' : ''}`, primary: true },
                { id: 'no', icon: 'fa-hand-pointer', title: '不用，我自己点保存', text: '想存的时候打开酒馆 Git，点“全部提交”' },
            ]));
            onChoice((id) => {
                answers.auto = id === 'yes';
                show(answers.mode === 'restore' ? 'confirm' : 'run');
            });
        },
        confirm() {
            frame(head('fa-triangle-exclamation', '最后确认一下', '')
                + `<div class="git-sync-qs-warn">
                    <p>恢复会用<b>网上的备份</b>，<b>替换掉</b>这个酒馆里现在的聊天、角色卡、世界书等。</p>
                    <p><i class="fa-solid fa-shield-heart"></i> 别怕：替换之前，现在的数据会<b>自动先存一份</b>。后悔的话，在酒馆 Git 的“安全存档”里能找回来。</p>
                </div>`
                + (answers.branches.length > 1 ? `<label class="git-sync-qs-label">要恢复哪一份？<small>（不知道就不用改）</small>
                    <select class="text_pole" data-field="branch">${answers.branches.map(name => `<option${name === answers.branch ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select></label>` : '')
                + '<div class="git-sync-qs-foot"><button type="button" class="menu_button git-sync-qs-next danger" data-qs="next"><i class="fa-solid fa-cloud-arrow-down"></i> 确定，开始恢复</button></div>');
            container.querySelector('[data-qs="next"]').addEventListener('click', async () => {
                answers.branch = container.querySelector('[data-field="branch"]')?.value || answers.branch;
                try {
                    await flushPendingSaves();
                    await saveAutoSave();
                    const result = await app.busy('正在下载并恢复，东西多的话要等一会儿，别关页面…', () => gitApi('/import', { remote: 'origin', branch: answers.branch }));
                    container.innerHTML = doneHtml('恢复好了！', '酒馆马上会自动刷新，刷新后就能看到你的备份内容。');
                    finishWorkTreeChange(result, '恢复完成');
                } catch (error) {
                    fail(friendlyError(error));
                }
            });
        },
        async run() {
            const tasks = [
                ...(onlineOnly ? [] : [{ label: '准备好存放备份的地方', work: () => gitApi('/init', { branch: 'main' }) }]),
                ...(onlineOnly ? [] : [{
                    label: '存下第一份备份', work: async () => {
                        await flushPendingSaves();
                        await gitApi('/commit', { message: '第一份存档' }).catch(error => {
                            if (error.status !== 409) throw error;
                        });
                    },
                }]),
                ...(answers.online ? [{ label: '放一份到网上', work: () => gitApi('/push', { remote: 'origin' }) }] : []),
                { label: answers.auto ? '打开自动存档' : '记下你的选择', work: saveAutoSave },
            ];
            frame(head('fa-gears', '正在帮你弄好…', '一般几秒钟，东西多的话要久一点。别关页面。')
                + `<ul class="git-sync-qs-progress">${tasks.map(task => `<li><i class="fa-regular fa-circle"></i> ${task.label}</li>`).join('')}</ul>`);
            container.querySelector('[data-qs="back"]').hidden = true;
            const rows = container.querySelectorAll('.git-sync-qs-progress li');
            for (const [index, task] of tasks.entries()) {
                const icon = rows[index].querySelector('i');
                icon.className = 'fa-solid fa-spinner fa-spin';
                try {
                    await task.work();
                    icon.className = 'fa-solid fa-circle-check';
                    rows[index].classList.add('done');
                } catch (error) {
                    icon.className = 'fa-solid fa-circle-xmark';
                    rows[index].classList.add('failed');
                    container.querySelector('[data-qs="back"]').hidden = false;
                    fail(`${friendlyError(error)}<br>可以点“上一步”检查一下再试。`);
                    return;
                }
            }
            container.innerHTML = doneHtml('搞定了！', answers.online
                ? `你的聊天、角色卡、世界书都已经存好，网上也有一份了。${answers.auto ? '以后会自动帮你存。' : ''}`
                : `你的聊天、角色卡、世界书都已经存好了。${answers.auto ? '以后会自动帮你存。' : ''}`,
            '<div class="git-sync-qs-foot"><button type="button" class="menu_button git-sync-qs-next" data-qs="finish">好的 <i class="fa-solid fa-check"></i></button></div>');
            container.querySelector('[data-qs="finish"]').addEventListener('click', () => app.refresh('overview'));
        },
    };

    const doneHtml = (title, text, foot = '') => `
        <div class="git-sync-qs">
            <div class="git-sync-qs-head done">
                <i class="fa-solid fa-circle-check"></i>
                <h2>${title}</h2>
                <p>${text}</p>
                <p class="git-sync-qs-tip"><i class="fa-solid fa-lightbulb"></i> 想回到以前的某个时候：打开酒馆 Git → <b>历史</b>，找到那一次，点“回到这个版本”。</p>
            </div>
            ${foot}
        </div>`;

    const saveAutoSave = async () => {
        await gitApi('/settings', {
            smartCommit: {
                ...(app.state.settings.smartCommit ?? {}),
                onChatSwitch: answers.auto,
                everyMessages: answers.auto ? 20 : 0,
                push: answers.auto && answers.online,
                remote: 'origin',
            },
        });
        await reloadSmartCommit();
    };

    const draw = () => {
        void screens[current]();
    };
    show(onlineOnly ? 'platform' : 'start', false);
}

/** Server errors, said simply (the server's own message stays in small print). */
function friendlyError(error) {
    const message = String(error?.message || error || '');
    const detail = `<small>（${esc(message)}）</small>`;
    if (/^认证失败/.test(message)) return `钥匙不对。请回到钥匙页面重新建一把，完整复制后再粘贴。${detail}`;
    if (/^没有权限/.test(message)) return `这把钥匙没有写入权限，或者这个仓库不是你的。请按步骤重新建一把钥匙。${detail}`;
    if (/^找不到仓库/.test(message)) return `找不到这个仓库。检查一下网址对不对、仓库是不是已经建好了。私有仓库一定要钥匙。${detail}`;
    if (/^无法解析/.test(message)) return `网址里的网站名不对，请重新复制网址。${detail}`;
    if (/^连接仓库失败/.test(message)) return `暂时连不上那个网站，过一会儿再试。${detail}`;
    if (/^远程仓库有你本地没有/.test(message)) return `网上的仓库里已经有别的东西了。请换一个新建的空仓库。${detail}`;
    return `出了点问题：${esc(message)}`;
}
