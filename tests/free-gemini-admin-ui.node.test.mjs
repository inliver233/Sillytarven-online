import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relativePath => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const adminScript = read('public/scripts/admin-extensions.js');
const adminTemplate = read('public/scripts/templates/admin.html');
const adminStyles = read('public/css/admin-extensions.css');
const autoConnectScript = read('public/scripts/RossAscends-mods.js');
const indexTemplate = read('public/index.html');
const openaiScript = read('public/scripts/openai.js');
const userScript = read('public/scripts/user.js');

function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} must exist`);
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Could not extract ${name}`);
}

test('admin template uses a searchable per-model policy and request-format list', () => {
    const channelBlock = adminTemplate.match(/<!-- 全局免费 Gemini 渠道管理 -->([\s\S]*?)<!-- 旧管理员邀请码管理选项卡 -->/)?.[1] || '';

    assert.match(channelBlock, /id="freeGeminiModelSearch"[^>]+type="search"/);
    assert.match(channelBlock, /id="freeGeminiModelSelectionCount"/);
    assert.match(channelBlock, /<div id="freeGeminiUpstreamModels"[^>]+role="group"/);
    assert.doesNotMatch(channelBlock, /<select id="freeGeminiUpstreamModels"[^>]*multiple/);
    assert.match(channelBlock, /每个模型可独立选择“原生 Gemini”或“OpenAI 兼容”请求格式/);
    assert.match(channelBlock, /class="freeGeminiChannelActions[^>]*">\s*<button type="button"[^>]+id="saveFreeGeminiChannel"/);
    assert.match(adminScript, /\.addClass\('freeGeminiModelEnabled'\)[\s\S]*?\.data\('model', model\)/);
    assert.match(adminScript, /\$\('<span>'\)\.text\(model\)/);
    assert.doesNotMatch(adminScript, /data-model="\$\{escapeHtml\(model\)\}"/);
    assert.match(adminScript, /freeGeminiModelEnabledState\.set\(model, \$\(this\)\.prop\('checked'\)\)/);
    assert.match(adminScript, /\.addClass\('text_pole freeGeminiModelRequestFormat'\)/);
    assert.match(adminScript, /freeGeminiModelRequestFormats\.set\(model, format\)/);
    assert.match(adminScript, /modelRequestFormats: serializeFreeGeminiModelRequestFormats\(\)/);
    assert.match(adminStyles, /\.freeGeminiModelList\s*{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
    assert.match(adminStyles, /\.freeGeminiModelRow\s*{[\s\S]*?grid-template-columns:\s*auto minmax\(0, 1fr\) minmax\(130px, auto\)/);
    assert.match(adminStyles, /\.freeGeminiChannelActions\s*{[\s\S]*?position:\s*sticky/);
    assert.match(adminStyles, /@media \(max-width: 768px\)[\s\S]*?\.freeGeminiChannelActions \.menu_button/);
});

test('model policy serializer treats checked models as enabled for every policy', () => {
    const normalizeSource = extractFunction(adminScript, 'normalizeFreeGeminiModels');
    const serializerSource = extractFunction(adminScript, 'serializeFreeGeminiModelPolicy');
    const serialize = Function(`${normalizeSource}\n${serializerSource}\nreturn serializeFreeGeminiModelPolicy;`)();

    assert.deepEqual(serialize('allowlist', ['a', 'b', 'manual'], ['a', 'manual']), ['a', 'manual']);
    assert.deepEqual(serialize('denylist', ['a', 'b', 'manual'], ['a', 'manual']), ['b']);
    assert.deepEqual(serialize('all', ['a', 'b'], [], ['manual']), ['manual']);
    assert.match(serializerSource, /policy === 'allowlist' \? enabled\.has\(model\) : !enabled\.has\(model\)/);
});

test('admin save retention, mutation busy state, and request races are wired', () => {
    assert.match(adminScript, /const savedChannelId = String\(payload\.channel\?\.id \|\| id \|\| ''\)/);
    assert.match(adminScript, /await loadFreeGeminiChannelsAdmin\(savedChannelId\)/);
    assert.ok((adminScript.match(/setFreeGeminiChannelSaveBusy\(true\)/g) || []).length >= 4);
    assert.ok((adminScript.match(/setFreeGeminiChannelSaveBusy\(false\)/g) || []).length >= 4);
    assert.match(adminScript, /const requestId = \+\+freeGeminiChannelsLoadRequestId;[\s\S]*?requestId !== freeGeminiChannelsLoadRequestId/);
    assert.match(adminScript, /freeGeminiChannelMutationRequestId\+\+;[\s\S]*?function isCurrentFreeGeminiChannelMutation/);
    assert.ok((adminScript.match(/if \(!isCurrentFreeGeminiChannelMutation\(mutationRequestId\)\) return;/g) || []).length >= 8);
    assert.match(adminScript, /finally \{\s*if \(isCurrentFreeGeminiChannelMutation\(mutationRequestId\)\) setFreeGeminiChannelSaveBusy\(false\)/);
    assert.match(adminScript, /mergeFreeGeminiUpstreamModels\(models, refresh\)/);
    assert.match(adminScript, /replaceUpstream \? \[\] : currentFreeGeminiUpstreamModels/);
    assert.match(adminScript, /click\.freeGeminiNavigation[\s\S]*?freeGeminiChannelSaveInProgress[\s\S]*?stopImmediatePropagation/);
    assert.match(adminScript, /if \(root !== document\)\s*{[\s\S]*?click\.freeGeminiNavigation/);
    assert.match(adminScript, /confirmDiscardFreeGeminiChannelChanges\('切换选项卡会放弃当前未保存的渠道配置，确定继续吗？'\)/);
    assert.match(adminScript, /click\.freeGeminiChannels[\s\S]*?setTimeout\(loadFreeGeminiChannelsAdmin, 0\)/);
    assert.doesNotMatch(adminScript, /click\.freeGeminiChannels[\s\S]{0,200}?resetFreeGeminiChannelRuntimeState/);
    assert.match(adminScript, /function disposeAdminExtensions\(\)[\s\S]*?resetFreeGeminiChannelRuntimeState\(\)/);
    assert.match(adminScript, /function canCloseFreeGeminiChannelAdmin\(\)[\s\S]*?freeGeminiChannelSaveInProgress[\s\S]*?confirmDiscardFreeGeminiChannelChanges/);
    assert.match(adminScript, /freeGeminiDeleteChannel[\s\S]*?confirmDiscardFreeGeminiChannelChanges\('删除渠道会放弃当前未保存的渠道配置/);
    assert.match(userScript, /onClosing:[\s\S]*?window\.canCloseFreeGeminiChannelAdmin\(\)/);
});

test('channel tests use refreshed admin discovery and reject an empty model list', () => {
    const testChannelSource = extractFunction(adminScript, 'testFreeGeminiChannel');
    assert.match(testChannelSource, /\/api\/free-gemini-channels\/admin\/\$\{encodeURIComponent\(id\)\}\/models\?refresh=true/);
    assert.match(testChannelSource, /if \(models\.length === 0\) throw new Error/);
    assert.doesNotMatch(testChannelSource, /chat-completions\/status/);
});

test('automatic Free Gemini mode auto-connects and visible UI uses the branded asset', () => {
    assert.match(autoConnectScript, /\|\| \(oai_settings\.chat_completion_source == chat_completion_sources\.FREE_GEMINI\)/);
    assert.doesNotMatch(autoConnectScript, /free_gemini_channel_id\s*&&\s*oai_settings\.chat_completion_source\s*==\s*chat_completion_sources\.FREE_GEMINI/);
    assert.match(adminTemplate, /src="\/img\/free-gemini\.svg"/);
    assert.match(indexTemplate, /data-source="free-gemini"[\s\S]*?src="\/img\/free-gemini\.svg"/);
});

test('free Gemini exposes and forwards additional request body parameters', () => {
    assert.match(indexTemplate, /data-source="custom,free-gemini"[^>]+id="customize_additional_parameters"/);
    assert.match(openaiScript, /\[chat_completion_sources\.CUSTOM, chat_completion_sources\.FREE_GEMINI\]\.includes\(settings\.chat_completion_source\)[\s\S]*?custom_include_body[\s\S]*?custom_exclude_body/);
    assert.match(openaiScript, /chat_completion_source === chat_completion_sources\.FREE_GEMINI && Array\.isArray\(data\?\.choices\)[\s\S]*?data\.choices\?\.\[0\]\?\.delta\?\.content/);
});
