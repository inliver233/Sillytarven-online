# `server` 分支安全更新与部署交接说明

## 1. 交付范围

- 仓库：`Sillytarven-online/online`
- 交付分支：`server`
- 基线分支：`online`
- 基线提交：`b4dd65b47c178ea87ea42f56ac1b7ef1a8a934cd`
- 目标：在不提交生产配置、密钥和用户数据的前提下，交付依赖安全更新、运行时兼容修复和针对性回归测试。

最终交付提交以远端 `origin/server` 为准。本文档与代码位于同一个提交中，接收者无需再手工复制补丁。

## 2. 已完成内容

### 2.1 依赖与运行时安全更新

| 项目 | 更新结果 |
| --- | --- |
| Transformers | 使用 `@xenova/transformers@2.17.2` 替代已弃用的 `sillytavern-transformers` |
| ONNX Runtime | 锁定 `onnxruntime-web@1.16.1`，并固定从本地同版本目录加载 WASM |
| Sharp | 锁定 `sharp@0.35.0` |
| Showdown | 固定到经校验的 `d1a8d16344b855ea2f37677ee8a9e0cc2c597ea4` 提交及 lockfile 完整性值 |
| Chevrotain | 锁定 `10.5.0` |
| Lodash | 锁定 `4.18.1` |
| Nodemailer | 锁定 `9.0.5` |
| Vectra | 锁定 `0.12.3` |
| ProtobufJS | 通过 overrides 锁定 `8.7.2` |
| Node.js | 最低版本从 18 提升为 `>=20.9` |
| Webpack | lockfile 实际安装 `5.109.2`，避免旧版 Webpack 的已知审计问题 |

更新后的 `npm audit --omit=dev` 结果为 **0 个漏洞**。作为对照，原始 `online` 基线在同一环境中的结果为 **56 个漏洞**（4 critical、16 high、35 moderate、1 low）。

### 2.2 应用代码修复

- SMTP STARTTLS 强制最低 TLS 1.2，并启用证书校验；移除 SSLv3 与 `rejectUnauthorized: false`。
- Transformers 的 JavaScript 运行时和 ONNX WASM 使用同一套锁定依赖；缺少本地 WASM 目录时直接失败，避免模型首次加载时才出现难以定位的版本错配。
- 保留并验证 OAuth 邀请码并发消费失败时的用户和头像回滚逻辑，同时修正相关 lint 问题。
- 修复 Showdown 3 浏览器 ESM 入口在 Webpack 5.109 下的解析和导出兼容问题；避免把仅供 Node.js 使用的延迟依赖打进浏览器包。
- 合并测试目录中重复的 ESLint 配置，并修正本次涉及测试文件的格式问题。

### 2.3 新增验证能力

- `npm run test:server-update`：集中执行本次安全更新、注册策略、stcontrol 适配器与打包验收测试。
- Showdown 安全回归：版本及完整性锁定、属性注入、CVE-2024-1899 复杂度载荷、现有扩展兼容。
- Transformers 安全回归：依赖去重与版本锁定、Sharp 图片转换、ONNX WASM 路径。
- Webpack 生产模式验收：真实生成浏览器 `lib.js`，检查构建错误、文件尺寸和 Showdown 内容。
- `SERVER_UPDATE_FILES.sha256`：本次交付文件的 SHA-256 清单，可在部署前后核对。

## 3. 验证结果

验证环境：Node.js `20.20.2`，npm `10.8.2`。

| 检查项 | 结果 |
| --- | --- |
| `npm ci --ignore-scripts` + `npm run postinstall` | 通过 |
| `npm audit --omit=dev` | 通过，0 vulnerabilities |
| 本次变更文件 ESLint | 通过，0 errors |
| `npm run test:server-update` | 47/47 通过，0 失败，0 跳过 |
| Webpack 生产打包验收 | 通过，Webpack 5.109.2 |
| 冷启动 | 通过，日志出现 `compiled successfully` 并监听本地端口 |
| 首页 `/` | HTTP 200 |
| 浏览器依赖包 `/lib.js` | HTTP 200，约 2.13 MB |

## 4. 接收、审查与合并

### 4.1 新检出 `server` 分支

```bash
git fetch origin
git switch --create server --track origin/server
```

如果本地已存在 `server` 分支：

```bash
git switch server
git pull --ff-only origin server
```

### 4.2 与 `online` 基线比较

```bash
git log --oneline origin/online..origin/server
git diff --stat origin/online...origin/server
git diff origin/online...origin/server
sha256sum -c SERVER_UPDATE_FILES.sha256
```

### 4.3 合并到其他发布分支

```bash
git fetch origin
git switch <目标发布分支>
git merge --no-ff origin/server
```

若目标分支已在基线提交后改动相同文件，重点检查 `package.json`、`package-lock.json`、`public/lib.js`、`webpack.config.js` 和 OAuth 端点。不要丢弃本次 lockfile，也不要用 `npm update` 重新解析依赖。

## 5. 部署与验收步骤

### 5.1 部署前

1. 记录当前线上提交：`git rev-parse HEAD`。
2. 备份生产 `config.yaml`、密钥注入方式、反向代理配置和数据目录。
3. 确认生产 Node.js 版本满足 `>=20.9`，推荐沿用已验证的 Node.js 20 LTS 环境。
4. 确认服务器能访问 npm registry 和本次锁定的 Showdown GitHub tarball；依赖安装完成后再切换流量。

本分支**不包含**生产密钥、OAuth 凭据、SMTP 密码、用户数据或生产 `config.yaml`。

### 5.2 安装和验证

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run postinstall
npm audit --omit=dev
npm run test:server-update
```

如需重复执行本次文件 lint：

```bash
npx eslint src/email-service.js src/endpoints/oauth.js src/transformers.js src/users.js public/lib.js webpack.config.js tests/showdown-security.node.test.mjs tests/stcontrol-adapter.node.test.mjs tests/stcontrol-disaster-login.node.test.mjs tests/transformers-security.node.test.mjs tests/server-branch-webpack.node.test.mjs
```

随后按现有进程管理方式启动服务，并检查：

1. 启动日志包含 Webpack `compiled successfully`，且没有 Showdown、ONNX 或 Sharp 加载错误。
2. 首页 `/` 与 `/lib.js` 返回 HTTP 200。
3. 使用测试账号完成密码登录、注册策略、邀请注册和已配置的 OAuth 提供商登录。
4. 如生产启用了 stcontrol，对内部 health、会话同步、用户 provision/restore/password 和灾难登录做一次真实联调。
5. 验证 SMTP 时必须使用证书链有效、支持 TLS 1.2 或更高版本的邮件服务器。

## 6. 仍需在生产环境完成的事项

- 真实 OAuth 客户端、回调 URL、邀请策略和会话 Cookie 只能在生产域名下完成端到端验收。
- stcontrol 的内部密钥、网络连通性和控制面联调不在仓库中，部署后仍需用生产配置验证。
- SMTP 严格证书校验可能暴露原先被忽略的自签名证书或不完整证书链；应修复邮件服务器证书，不应恢复不安全的跳过校验配置。
- 首次真实模型推理仍应做一次冒烟测试，以覆盖模型下载、缓存目录权限、内存和 CPU 架构差异。
- 生产应接入现有监控、日志和回滚告警，并在灰度观察后再扩大流量。

## 7. 已知但不阻断本次交付的问题

- 仓库全量 `npm run lint` 仍有 **262 个历史错误**；原始 `online` 基线为 **335 个**。本次所有变更文件为 0 个 lint 错误，没有扩展修复无关历史代码。
- `npm run test:user-invitations` 在默认 Node.js 测试隔离模式下会触发现有的 runner IPC `Unable to deserialize cloned data`。使用支持的非隔离模式检查时，11 个用例中 4 个通过、7 个因默认关闭邀请功能而跳过；本次主门禁中的注册策略测试 15/15 通过。生产邀请流程仍按第 5 节做真实验收。
- Showdown 使用固定 GitHub tarball，而不是 npm registry 版本；这保证提交级可复现性，但全新安装环境需要能访问 GitHub。生产制品仓库可镜像该 tarball，同时保留相同完整性校验。

## 8. 回滚

如果部署后出现不可接受的问题：

1. 停止新版本进程并摘除流量。
2. 切回部署前记录的提交或原发布分支。
3. 在旧提交下重新执行 `npm ci --ignore-scripts --no-audit --no-fund` 和 `npm run postinstall`，避免继续使用新版本 `node_modules`。
4. 恢复配置或数据时只使用部署前备份；不要删除生产数据目录。
5. 启动旧版本并复核首页、登录、OAuth、stcontrol 和 SMTP。

本次变更没有数据库迁移，也不应覆盖生产数据；正常代码回滚不需要修改用户数据。

## 9. 交付文件索引

- 依赖与脚本：`package.json`、`package-lock.json`
- 浏览器打包：`public/lib.js`、`webpack.config.js`
- 服务端修复：`src/email-service.js`、`src/endpoints/oauth.js`、`src/transformers.js`、`src/users.js`
- 测试配置：`tests/.eslintrc.cjs`，并删除重复的 `tests/.eslintrc.js`
- 安全与验收测试：`tests/showdown-security.node.test.mjs`、`tests/transformers-security.node.test.mjs`、`tests/server-branch-webpack.node.test.mjs`
- 既有集成测试整理：`tests/stcontrol-adapter.node.test.mjs`、`tests/stcontrol-disaster-login.node.test.mjs`
- 交接材料：`SERVER_BRANCH_UPDATE_CN.md`、`SERVER_UPDATE_FILES.sha256`
