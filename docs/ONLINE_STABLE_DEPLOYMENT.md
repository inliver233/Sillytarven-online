# Online 稳定分支部署指南

本文档面向运行多人云酒馆的服务器管理员。`online` 分支用于从不稳定的 dev 合并、启动优化或超大设置拆分版本，回退到经过线上验证的稳定代码，同时保留必要修复。

## 版本边界

当前稳定点：

- 分支：`online`
- 发布提交：`86fba2024e04d3dd1e8eb452b1112a5f274aacd9`
- 稳定基线：`97c5600`，包含完整 Free Gemini 提交链
- Node.js：最低 18，线上验证版本为 20

该分支额外包含：

- Discord OAuth 最小权限和隐私修复
- 插件安装默认分支、GitLab `.git` URL、禁止 Git 重定向、临时目录校验和原子落盘
- 关键 CSS 直接加载，避免载入动画和默认主题在串行 `@import` 期间失去样式
- 旧 `_storageReferences` 数据的校验、恢复和原子迁移工具
- 保存入口的旧标签页兼容保护，防止迁移前页面把引用重新写回
- 对应的 Node 回归测试

该分支有意不包含：

- dev 分支合并 `eca4a28`
- 启动 PR 合并 `5fa1728`
- 完整启动关键路径提交 `926ef5f`，仅独立保留静态 CSS 加载修复
- 超大设置拆分提交 `b037fad` 和 `a4fccdd`

可用以下命令核对边界。命令无输出且退出码为 1，表示对应提交不是当前分支祖先：

```bash
git merge-base --is-ancestor eca4a28 HEAD
git merge-base --is-ancestor 5fa1728 HEAD
git merge-base --is-ancestor b037fad HEAD
git merge-base --is-ancestor a4fccdd HEAD
git merge-base --is-ancestor 926ef5f HEAD
```

## 禁止提交的运行数据

仓库的 `.gitignore` 已排除以下内容：

- `data/` 和用户上传内容
- `config.yaml`
- `secrets.json`、`.env` 和证书
- `node_modules/`
- 日志、缓存、缩略图和备份目录
- 第三方用户插件目录

不要使用 `git add -f` 添加上述文件。生产密钥只能保留在服务器配置或密钥管理系统中。

## 新服务器部署

```bash
git clone --branch online --single-branch https://github.com/inliver233/Sillytarven-online.git
cd Sillytarven-online
npm ci
```

从 `default/config.yaml` 生成服务器自己的 `config.yaml`，再写入该服务器的监听地址、认证和密钥配置。不要把生产 `config.yaml` 提交回仓库。

首次启动前建议在 `config.yaml` 启用一次缓存清理：

```yaml
cacheBuster:
  enabled: true
  userAgentPattern: ''
```

这只清理浏览器 HTTP 缓存，不会删除 Cookie、Local Storage 或服务器用户数据。已经打开的旧标签页需要刷新一次。

启动示例：

```bash
node --max-old-space-size=4096 server.js
```

PM2 示例：

```bash
pm2 start server.js --name sillytarven --node-args="--max-old-space-size=4096"
pm2 save
```

## 现有服务器安全切换

目标是把依赖安装、代码检查和备份放在停机前完成，只在数据迁移和进程切换期间停止服务。

### 1. 准备独立发布目录

不要在正在运行且有本地改动的工作树中执行强制重置。

```bash
git clone --branch online --single-branch https://github.com/inliver233/Sillytarven-online.git /srv/sillytarven-online
cd /srv/sillytarven-online
npm ci
```

复制旧服务器的 `config.yaml` 到新发布目录，并根据 `default/config.yaml` 人工合并缺失配置。保持文件权限为仅管理员可读。

数据应保存在独立目录，例如 `/srv/sillytarven-data`，再由发布目录引用：

```bash
ln -s /srv/sillytarven-data /srv/sillytarven-online/data
```

如果原部署把 `data/` 放在代码目录中，应先确认真实路径，不要移动或删除运行中的数据。

### 2. 创建可验证备份

至少备份：

- 原仓库完整 Git bundle
- 原 `config.yaml`
- 完整用户数据目录
- 当前服务管理器配置

代码备份示例：

```bash
mkdir -p /srv/backups/sillytarven-before-online
git -C /srv/sillytarven-current bundle create /srv/backups/sillytarven-before-online/repository.bundle --all
git bundle verify /srv/backups/sillytarven-before-online/repository.bundle
```

用户数据优先使用云盘快照、LVM/ZFS/Btrfs 快照或经过校验的完整副本。不要把硬链接副本作为唯一备份，因为原程序若原地修改文件，硬链接内容也会变化。备份后记录 SHA-256 或使用快照平台的完整性校验。

### 3. 停止旧服务并迁移

先停止旧服务，确保没有并发设置保存，再进行迁移。以下命令默认只读取数据：

```bash
cd /srv/sillytarven-online
node tools/rehydrate-extension-settings.mjs --data-root /srv/sillytarven-data --dry-run
```

输出中的 `users` 和 `references` 表示待恢复数量。确认外置数据和磁盘空间正常后执行：

```bash
node tools/rehydrate-extension-settings.mjs \
  --data-root /srv/sillytarven-data \
  --apply \
  --backup-root /srv/backups/sillytarven-before-online/rehydration
```

迁移器会：

- 在任何写入前验证全部引用、元数据、gzip、SHA-256、解压大小和 JSON
- 为每个将修改的 `settings.json` 保存精确原件
- 使用原子替换写入
- 在写入失败时回滚已修改文件
- 生成 `rehydration-manifest.json`

迁移完成后再次运行 `--dry-run`，预期结果是：

```json
{
  "users": 0,
  "references": 0
}
```

旧页面仍可能在服务恢复后提交迁移前引用。`online` 分支会在每用户原子保存锁内恢复这些值，并继续返回原有的精确成功响应 `{"result":"ok"}`，因此不会再次产生“settings could not be saved”提示，也不会让引用重新落盘。

### 4. 启动新版本

确认新进程的工作目录指向新发布目录，数据路径指向原数据目录，然后启动服务。PM2 示例：

```bash
pm2 start /srv/sillytarven-online/server.js \
  --name sillytarven \
  --cwd /srv/sillytarven-online \
  --node-args="--max-old-space-size=4096"
pm2 save
```

如果 PM2 中已经存在同名进程，应使用现有运维流程更新定义，避免同时启动两个进程占用同一端口。

## 部署后验证

```bash
pm2 describe sillytarven
curl --fail --show-error --head http://127.0.0.1:12379/app
node tools/rehydrate-extension-settings.mjs --data-root /srv/sillytarven-data --dry-run
```

应确认：

- PM2 状态为 `online`，`unstable restarts` 为 0
- `/app` 返回 200
- `public/css/loader.css` 和页面全部样式返回 200
- 默认主题文件 `default/content/themes/inliver.json` 存在
- 所有用户 `settings.json` 都能解析
- 迁移 dry-run 的 `users` 和 `references` 均为 0
- 日志没有 `Settings write failed`、未捕获异常、内存溢出或端口占用

Free Gemini 的 429、503、超时和客户端中断属于上游或请求级错误；角色卡格式错误、缺失世界书和无效插件 manifest 也不代表服务进程异常，但应按用户和上游情况分别处理。

完整代码回归：

```bash
node --test tests/*.node.test.mjs
```

## 回退

1. 停止 `online` 进程，避免回退期间继续写入。
2. 保留故障现场副本和日志。
3. 恢复切换前的代码目录或 Git bundle。
4. 如果数据验证失败，恢复切换前的完整数据快照。
5. 用原工作目录、配置和数据路径启动旧版本。

迁移目录中的逐用户 `settings.json` 是迁移前原件，可能仍包含 `_storageReferences`。不要把这些文件直接恢复到不支持引用的版本。完整回退优先使用切换前数据快照；只有回退到支持旧外置引用的代码，并且对应 `user/extension-data/*/legacy` 数据仍完整时，才可使用逐用户迁移备份。

## 相关实现

- `tools/rehydrate-extension-settings.mjs`：离线扫描、备份和迁移入口
- `src/legacy-extension-settings.js`：共享引用验证和恢复逻辑
- `src/settings-save.js`：旧标签页回写兼容保护
- `tests/rehydrate-extension-settings.node.test.mjs`：迁移完整性和损坏数据测试
- `tests/settings-save-route.node.test.mjs`：在线保存兼容和失败关闭测试
- `tests/extension-install-stable.node.test.mjs`：插件安装事务和 GitLab URL 测试
- `tests/frontend-css-critical-path.node.test.mjs`：关键样式加载顺序测试
