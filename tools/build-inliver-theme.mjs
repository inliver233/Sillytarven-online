/**
 * 从 tools/inliver-theme.source.css 生成 default/content/themes/inliver.json
 * 用法: node tools/build-inliver-theme.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cssPath = path.join(root, 'tools', 'inliver-theme.source.css');
const themePath = path.join(root, 'default', 'content', 'themes', 'inliver.json');

const css = fs.readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n').trim();
const theme = JSON.parse(fs.readFileSync(themePath, 'utf8'));

theme.custom_css = css;

// 与 CSS 变量保持同步的主题字段(柔和莫奈雾蓝)
Object.assign(theme, {
    main_text_color: 'rgba(233, 238, 244, 1)',
    italics_text_color: 'rgba(169, 194, 218, 1)',
    underline_text_color: 'rgba(163, 168, 201, 1)',
    quote_text_color: 'rgba(147, 179, 201, 1)',
    blur_tint_color: 'rgba(18, 24, 31, 0.78)',
    chat_tint_color: 'rgba(18, 24, 31, 0)',
    user_mes_blur_tint_color: 'rgba(29, 38, 50, 0.6)',
    bot_mes_blur_tint_color: 'rgba(23, 30, 39, 0.6)',
    shadow_color: 'rgba(169, 194, 218, 0.18)',
    shadow_width: 2,
    border_color: 'rgba(169, 194, 218, 0.14)',
    fast_ui_mode: false,
});

fs.writeFileSync(themePath, JSON.stringify(theme, null, 4) + '\n');
console.log(`主题已生成: ${themePath} (CSS ${css.length} 字符)`);
