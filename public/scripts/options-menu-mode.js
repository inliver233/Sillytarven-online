/**
 * ☰ 菜单最上面的「基础模式 / 完整模式」滑块。基础模式只留最基本的几项（开始新聊天、关闭聊天、管理聊天文件、
 * 删除消息、重新生成、继续），其余的（包括扩展加进来的）都收起来；点一下立刻切换，不用刷新。
 * 选择跟着账号走，默认完整模式。
 */
import { accountStorage } from './util/AccountStorage.js';
import { eventSource, event_types } from './events.js';

const STORAGE_KEY = 'optionsMenuMode';
/** 基础模式下留着的菜单项 */
const BASIC_ITEMS = ['option_start_new_chat', 'option_close_chat', 'option_select_chat', 'option_delete_mes', 'option_regenerate', 'option_continue'];

/**
 * @param {object} [options]
 * @param {() => void} [options.onChange] 菜单变高变矮以后（重新定位菜单）
 */
export function initOptionsMenuMode({ onChange = () => {} } = {}) {
    const menu = document.getElementById('options');
    if (!menu || menu.querySelector('.optionsModeSwitch')) {
        return;
    }
    // 同一个 id 菜单里可能有两处（关闭聊天就是），都要标上
    for (const id of BASIC_ITEMS) {
        menu.querySelectorAll(`[id="${id}"]`).forEach(item => item.classList.add('optionsBasicItem'));
    }

    // 放在菜单内容外面：扩展往菜单最前面插的项不会跑到它上面。
    // 不带 id：菜单里带 id 的元素点了会被当成菜单项执行并关掉菜单。
    const toggle = document.createElement('div');
    toggle.className = 'optionsModeSwitch';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', '基础模式');
    toggle.tabIndex = 0;
    toggle.title = '基础模式只显示最常用的几项，完整模式显示全部';
    toggle.innerHTML = '<span class="optionsModeThumb"></span>'
        + '<span class="optionsModeLabel" data-mode="basic">基础模式</span>'
        + '<span class="optionsModeLabel" data-mode="full">完整模式</span>';
    menu.prepend(toggle);

    const isBasic = () => menu.classList.contains('optionsMenuBasic');
    /** @param {boolean} basic */
    const apply = basic => {
        menu.classList.toggle('optionsMenuBasic', basic);
        toggle.classList.toggle('isBasic', basic);
        toggle.setAttribute('aria-checked', String(basic));
        onChange();
    };
    /** @param {boolean} basic */
    const choose = basic => {
        if (basic === isBasic()) {
            return;
        }
        accountStorage.setItem(STORAGE_KEY, basic ? 'basic' : 'full');
        apply(basic);
    };

    toggle.addEventListener('click', event => {
        const picked = /** @type {HTMLElement} */ (event.target).closest?.('.optionsModeLabel')?.getAttribute('data-mode');
        choose(picked ? picked === 'basic' : !isBasic());
    });
    toggle.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            choose(!isBasic());
        }
    });
    // 设置一般已经载入了；之后重新载入设置时再按存着的选一次
    const applySaved = () => apply(accountStorage.getItem(STORAGE_KEY) === 'basic');
    applySaved();
    eventSource.on(event_types.SETTINGS_LOADED, applySaved);
}
