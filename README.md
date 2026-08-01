# SillyTavern MOD (STC-MOD) - 酒馆社区专属版

> ⚠️ **重要公告：旧版仓库迁移说明**
> 
> 原仓库 [`zhaiiker/SillyTavernchat`](https://github.com/zhaiiker/SillyTavernchat)（基于 1.15.0）现已**正式停止维护**。
> 
> **为什么废弃旧版？** > 旧版项目中，我们采用了“侵入式开发”的模式直接修改了大量官方底层代码。这导致每次跟进 SillyTavern 官方的版本升级时，代码移植的工作量极其巨大，不仅耗时耗力，而且极易引发各种未知的 Bug 和冲突。
> 
> **新版全面进化：**
> 为了社区的长远发展，我们痛定思痛进行了底层重构。本项目是全新的接替者，基于 **SillyTavern 1.16.0 官方版本** 构建，采用了更加现代和优雅的架构设计。

---
## 新仓库地址：[`zhaiiker/SillyTavernMOD`](https://github.com/zhaiiker/SillyTavernMOD/)（基于 1.16.0）。

## 💡 架构亮点：低侵入，易升级

本项目最大的革新在于采用了 **「外挂模块 / Sidecar Module」** 的开发思路。

我们将“酒馆社区 (STC-MOD)”的一系列管理与运营功能作为独立模块外挂于官方核心之上，最大限度地减少了对官方原生代码的直接修改（低侵入）。
这种解耦设计意味着：
* **丝滑跟进官方更新**：未来 SillyTavern 官方发布新版本时，合并代码的冲突将大幅减少，升级过程更加平滑。
* **原汁原味的体验**：核心对话引擎与官方保持 100% 一致，享受最原生的性能与新特性。
* **更稳定的系统**：自定义模块的错误不会轻易波及核心服务。

## ✨ 核心功能特性

本仓库完美继承并重构了旧版深受大家喜爱的社区功能，为您提供一套完整的运营级解决方案：

* 👤 **独立的用户系统**：内置游客自主注册、登录页面，方便社区化运营与多用户管理。
* ☁️ **云端角色卡集散地**：专属的云角色卡分享中心，支持在网页端浏览并**一键导入**到本地，打破角色卡分享壁垒。
* 💬 **社区交流广场**：内置社区交流分享页面，方便玩家互动、分享提示词（Prompts）、世界书（World Info）和调教心得。
* 🛡️ **精细化运营管理**：支持分段聊天存储、用户空间限制等后台管理功能，保障服务器资源的合理分配。

## 🚀 快速开始

请确保您当前拉取的是 `stc-mod` 分支，这是我们主要维护的二开分支。

```bash
# 1. 克隆本项目并直接切换到 stc-mod 分支
git clone -b stc-mod https://github.com/zhaiiker/SillyTavernMOD.git

# 2. 进入项目目录
cd SillyTavernMOD

# 3. 安装依赖（与官方流程一致）
npm install

# 4. 启动服务
node server.js

```

# SillyTavernchat v1.15.0

基于官方 SillyTavern **1.15.0** 的增强版本，继续保持用户管理、系统监控、论坛社区、公告管理等企业级功能。

## 🆕 最新更新（V1.15.0）

### 官方 1.15.0 更新要点

#### 亮点
- 首次预览 Macros 2.0，对宏系统进行全面重构，支持宏嵌套、稳定求值顺序等。
- 建议在 用户设置 -> 聊天/消息处理 中启用“Experimental Macro Engine（实验性宏引擎）”体验新版宏引擎。
- 旧版宏替换将不再更新，并将在未来移除。

#### 破坏性变更
- {{pick}} 宏在旧版与新版宏引擎之间不兼容，切换引擎会改变现有 pick 结果。
- 由于群聊元数据文件处理方式变更，现有群聊文件会自动迁移，升级后的群聊与旧版本不兼容。

#### 后端
- Chutes：新增为 Chat Completion 源。
- NanoGPT：在 UI 中开放更多采样器。
- llama.cpp：支持模型选择与多滑动生成。
- OpenAI、Google、Claude、Z.AI 模型列表已同步。
- Electron Hub：支持 Claude 模型缓存。
- OpenRouter：支持 Gemini 与 Claude 的系统提示缓存。
- Gemini：支持适用模型的思维签名（thought signatures）。
- Ollama：支持从回复中提取推理内容。

#### 改进
- 实验性宏引擎：支持嵌套宏、稳定求值顺序，并改进自动补全。
- 群聊元数据格式与普通聊天统一。
- “管理聊天文件”对话框新增备份浏览器。
- Prompt Manager：主提示词可设置为绝对位置。
- 三项媒体内联开关合并为一个设置项。
- 支持的 Chat Completion 源新增“冗长度/verbosity”控制。
- Gemini 源新增图像分辨率与宽高比设置。
- 改进角色导入时 CharX 资源提取逻辑。
- 背景功能：新增 UI 标签页并支持上传聊天背景。
- 可通过开关将推理块排除在平滑流式输出之外。
- Linux/MacOS 的 start.sh 不再使用 nvm 管理 Node.js 版本。

#### STscript
- 新增 /and 指令。
- 新增 /message-role 与 /message-name 指令。
- /api-url 指令支持 VertexAI 区域设置。

#### 扩展
- 语音识别：新增 Chutes、MistralAI、Z.AI、ElevenLabs、Groq 作为 STT 来源。
- 图像生成：新增 Chutes、Z.AI、OpenRouter、RunPod Comfy 作为推理源。
- TTS：统一 ElevenLabs 与其他来源的 API Key 处理方式。
- 图像字幕：支持 Z.AI（通用/代码）为视频文件生成字幕。
- 网页搜索：支持 Z.AI 作为搜索来源。
- 图库：支持视频上传与播放。

## 演示地址


**https://ai.cao.baby**

## 🌟 核心特性

### 📊 基于SillyTavern 1.15.0
- ✅ 支持所有原版SillyTavern功能
- ✅ 集成最新的AI模型和API支持
- ✅ MiniMax TTS语音合成
- ✅ Moonshot、Fireworks、CometAPI等新API源
- ✅ 增强的Story String包装序列
- ✅ 改进的扩展系统和UI/UX
- ? 管理员可配置新用户默认模板（设置、预设、角色卡等）

## 🚀 二次开发功能

### 👥 用户管理系统
- **用户注册与登录**：完整的用户认证系统
- **邮箱注册验证**：支持邮箱验证码注册（V1.13.12 新增）
  - 注册时发送邮箱验证码
  - 验证码5分钟内有效
  - 自动绑定邮箱到用户账户
  - 如果邮件服务未启用，则无需邮箱验证即可注册
- **邮箱密码找回**：通过邮箱找回密码（V1.13.12 新增）
  - 如果用户绑定了邮箱且邮件服务已启用，恢复码将发送到用户邮箱
  - 如果未绑定邮箱或邮件服务未启用，恢复码将输出到服务器控制台
  - 恢复码5分钟内有效
- **密码恢复**：密码重置功能
- **会话管理**：安全的用户会话控制
- **用户数据隔离**：每个用户独立的数据存储
- **存储空间监控**：实时显示每个用户的存储占用情况
- **用户存储空间限制**（V1.15.0 新增）
  - 管理员可在后台启用限制并设置默认空间上限（MiB）
  - 用户面板显示“已用/总可用”和剩余空间
  - 激活码扩容：管理员可批量生成扩容码，用户输入激活码扩容
  - 签到奖励扩容：可设置每日签到增加空间（MiB），为 0 则关闭按钮
  - 空间不足时禁止新增聊天记录/角色卡，用户可删除内容或扩容后继续使用
- **用户邮箱信息**：用户面板显示绑定的邮箱地址（V1.13.12 新增）
- **OAuth第三方注册登录**：支持第三方账号快速注册和登录（V1.13.12 新增）
  - **支持的 OAuth 提供商**：GitHub、Discord、Linux.do
  - **一键登录**：无需记住密码，快速登录
  - **自动同步信息**：自动同步第三方账号的真实用户名、头像和邮箱
  - **智能头像管理**：首次登录自动下载并设置第三方账号头像，每次登录自动更新
  - **灵活的登录方式**（V1.13.12 优化）：
    - 纯 OAuth 用户（未设置密码）：只能通过第三方 OAuth 登录
    - OAuth 用户（已设置密码）：可以使用 OAuth 登录或用户名密码登录
  - **密码设置功能**：OAuth 用户可在个人设置中设置密码，设置后即可使用两种登录方式
  - **独立注册策略**：密码、GitHub、Discord、Linux.do 可分别控制新用户注册和邀请码要求
  - **登录不受注册开关影响**：关闭某个 OAuth 的新用户注册后，已绑定用户仍可继续登录
  - **动态回调 URL**：自动适配反向代理和 SSL 配置
  - **安全验证**：使用 state 参数防止 CSRF 攻击
- **备份文件清理**：管理员可清理用户备份文件释放空间
  - 单个用户备份清理：针对特定用户清理备份文件
  - 批量备份清理：一键清理所有用户的备份文件
  - 智能空间分析：显示各类型文件的占用比例
  - 安全清理：只清理备份文件，保留聊天记录和重要数据
- **一键删除长期未登录用户数据**：管理员可按未登录时长筛选（1周/半个月/1个月/2个月），并可设置最大存储占用阈值（MiB），预览确认后删除用户数据、备份文件、聊天记录等。（V1.13.11 新增）2025/11/07 新增，已扩展筛选条件

### 🎫 邀请码系统
- **邀请码生成**：管理员可生成邀请码
- **注册限制**：通过邀请码控制用户注册
- **有效期管理**：支持邀请码过期时间设置
- **使用统计**：邀请码使用情况跟踪
- **打开关闭方式**：`enableInvitationCodes` 提供全局默认值，也可通过 `registration.*.requireInvitationCode` 按注册方式覆盖

### 🎫 邀请码系统新增功能 （V1.13.10 新增功能）
- **按时间邀请码生成**：当用户使用一天有效期的邀请码注册，用户从注册开始计算一天后到期，以此类推。
- **过期续费**：当用户账户过期后，系统自动踢出过期用户，使用户重新登录，登录可使用新的邀请码进行续费账户，续费后账户到期时间延长。
- **后台配置续费链接**：管理员可在后台配置续费链接，用户在登录页面点击续费git 链接，跳转到续费页面，获取新的邀请码进行续费。
- **续费功能**：用户可使用邀请码续费账户
- **续费码管理**：管理员可生成续费码
- **续费码使用**：用户可使用续费码续费账户
- **续费码使用统计**：续费码使用情况跟踪
- **当邀请码关闭时**：当邀请码关闭，所有注册用户默认为永久用户。当邀请码开启时，所有注册用户默认为邀请码有效期用户。
- **邀请码订阅时长**：支持 7 种时长类型的邀请码（1天/1周/1月/1季度/半年/1年/永久）

### 📢 公告管理系统
- **主站公告**：系统内置公告发布功能（是登陆后弹窗公告）
  - 支持创建、编辑、删除公告
  - 公告启用/禁用状态控制
  - 公告分类管理（教程、讨论、官方公告等）
- **登录页面公告**：独立的登录页面公告系统 (V1.13.12 新增)（是登陆页面顶部显示公告信息）
  - 在登录页面顶部显示公告信息
  - 支持多条公告同时显示
  - 公告类型标识（信息/警告/成功/错误）
  - 与登录主题完美融合的美观设计
  - 管理员后台独立管理
  - 无需登录即可查看，适合发布维护通知、使用说明等
- **管理功能**：
  - 管理员后台统一管理主站和登录页面公告
  - 支持切换不同公告类型进行管理
  - 实时启用/禁用控制
  - 公告创建时间和更新时间记录

### 📈 系统监控
- **实时系统负载监控**：CPU、内存、磁盘使用率
- **用户活动统计**：消息数量、活跃用户统计
- **历史数据记录**：系统性能历史趋势
- **可视化图表**：直观的数据展示界面
- **性能告警**：系统资源使用异常提醒

### 💬 论坛社区
- **文章发布系统**：支持富文本编辑
- **分类管理**：文章分类和标签系统
- **评论互动**：文章评论和回复功能
- **用户互动**：点赞、收藏、分享功能
- **内容管理**：管理员内容审核功能（可以删除和关闭论坛文章）
- **打开关闭方式**：更改根目录./config.yaml  搜索：enableForum: true/false 开/关


### 🎭 公共角色卡库
- **角色卡分享**：用户可分享自己的角色卡
- **角色卡浏览**：公共角色卡库浏览
- **搜索和筛选**：按分类、标签搜索角色卡
- **下载和导入**：一键下载和导入角色卡
- **评分系统**：角色卡评分和评论.
- **打开关闭方式**：更改根目录./config.yaml  搜索：enablePublicCharacters: true/false  开/关

### 📧 邮件服务系统（V1.13.12 新增）
- **SMTP邮件发送**：基于 nodemailer 的邮件服务
- **后台邮件配置**：管理员可在后台配置SMTP服务器
  - SMTP服务器地址和端口配置
  - SSL/TLS加密支持
  - 发件人邮箱和名称设置
  - 测试邮件发送功能
- **支持的邮箱服务商**：
  - Gmail（需要应用专用密码）
  - QQ邮箱（需要授权码）
  - 腾讯企业邮箱（支持SSL）
  - 163邮箱（需要授权码）
  - Outlook
  - 其他标准SMTP服务
- **智能降级**：如果邮件服务未启用，系统自动降级为控制台输出模式
- **配置管理**：配置保存在 `config.yaml` 文件中，修改后需重启服务生效

### 用户空间限制
- **后台配置**：管理员可启用限制并设置默认空间上限（MiB）
- **用户面板**：显示已用/总可用与剩余空间
- **扩容方式**：激活码扩容与每日签到奖励（MiB）
- **使用限制**：空间不足时禁止新增聊天记录/角色卡，删除内容或扩容后可继续使用
- **打开关闭方式**：更改根目录./config.yaml  搜索：userStorage enabled: true/false  开/关
- **注意需要打开定时清理备份文件**：必须要设置定时清理备份文件，清理所有用户备份文件，清理周期为1小时一次，否则用户备份文件会占用空间越来越大。

### 🎨 界面增强
- **导航链接**：角色卡页面新增快捷导航
  - 欢迎首页链接
  - 共享角色卡库链接  
  - 论坛链接
- **响应式设计**：适配各种屏幕尺寸
- **主题兼容**：与SillyTavern主题系统完美集成
- **现代化注册页面**：全新的注册页面设计（V1.13.12 新增）
  - 分区式表单布局
  - 图标化字段标识
  - 渐变主题和动画效果
  - 响应式设计，适配PC和移动端


### 管理员默认配置模板
- ? **默认配置模板**：管理员可在后台将任意用户的配置快照为新用户默认模板。
- ? **覆盖范围可选**：支持设置 settings.json、API 密钥（secrets.json）、预设、正则、角色卡、世界书、主题等。
- ? **新用户自动继承**：注册/管理员创建/OAuth 注册时自动应用模板。
- ? **安全提示**：若包含 API 密钥，会在保存时提醒管理员确认。

### 聊天文件分段存储优化
- ✅ **聊天文件分段存储**：每 200~500 条切一个 .jsonl 分片，读写更轻，备份/迁移更快。
- ✅ **轻量元数据索引（chat index）**：保存每个 chat 的条数、最后一条、时间戳、分片列表，列表/预览无需扫描全文件。
- ✅ **增量写入**：保存时只追加最后 N 条的差异，不再整体重写，确保所有聊天记录可以保存，不允许丢失聊天记录，进一步减少磁盘写压力。
- ✅ **客户端缓存最近消息**：二次打开聊天秒开，减少重复读取。
- ✅ **新增接口**：按"从末尾向前"拉取 N 条聊天（支持继续向前加载），不再返回整份 JSONL。
- ✅ **优化加载策略**：打开聊天时仅拉取最近 20 条；点击"继续加载"再拉上一段。
- ✅ **移动端性能优化**：移动端默认限制 DOM 历史数量（比如只保留最近 200 条消息节点），避免滚动卡顿。


## 🔧 技术架构

### 后端技术栈
- **Node.js + Express**：服务器框架
- **node-persist**：数据持久化存储
- **cookie-session**：会话管理
- **rate-limiter-flexible**：API限流保护
- **multer**：文件上传处理
- **helmet**：安全头设置
- **nodemailer**：邮件发送服务（V1.13.12 新增）

### 前端技术栈
- **原生JavaScript**：无额外框架依赖
- **jQuery**：DOM操作和AJAX
- **FontAwesome**：图标系统
- **CSS3**：现代样式和动画
- **响应式布局**：移动端适配

### 安全特性
- **CSRF保护**：跨站请求伪造防护
- **输入验证**：服务器端数据验证
- **SQL注入防护**：参数化查询
- **XSS防护**：内容过滤和转义
- **会话安全**：安全的会话管理

## 📦 安装部署

### 环境要求
- Node.js >= 18.0.0
- npm >= 8.0.0
- 2GB+ RAM
- 10GB+ 磁盘空间

### 快速开始
```bash
# 克隆项目
git clone https://github.com/zhaiiker/SillyTavernchat.git
cd SillyTavernchat

# 安装依赖
npm install

# 启动服务
npm start

# 或使用批处理文件（Windows）
Start.bat

# 或在根目录使用批处理文件（Linux）
sudo sh start.sh

```

### Docker 部署

- Docker Hub 镜像名：`sillytavernchat-zk`（https://hub.docker.com/r/zhaiker/sillytavernchat-zk）

#### Docker Compose（推荐）
```bash
# 在项目根目录执行
docker compose -f docker/docker-compose.yml up -d --build
```

如果使用官方镜像（不需要本地构建），可在 `docker/docker-compose.yml` 中将 `image` 改为：
```
zhaiker/sillytavernchat-zk:latest
```

目录说明（相对 `docker/docker-compose.yml` 所在目录）：
- `docker/config`：配置文件目录（首次启动会自动生成 `config.yaml`）
- `docker/data`：数据持久化目录（用户数据、论坛、公共角色卡等）
- `docker/plugins`：插件目录
- `docker/extensions`：第三方扩展目录

常用命令：
```bash
# 查看日志
docker compose -f docker/docker-compose.yml logs -f

# 停止并删除容器
docker compose -f docker/docker-compose.yml down
```

#### Docker run（可选）
```bash
docker pull zhaiker/sillytavernchat-zk:latest
docker build -t sillytavernchat:latest .
docker run -d --name sillytavernchat \
  -p 8000:8000 \
  -e NODE_ENV=production \
  -e FORCE_COLOR=1 \
  -v "$(pwd)/docker/config:/home/node/app/config" \
  -v "$(pwd)/docker/data:/home/node/app/data" \
  -v "$(pwd)/docker/plugins:/home/node/app/plugins" \
  -v "$(pwd)/docker/extensions:/home/node/app/public/scripts/extensions/third-party" \
  sillytavernchat:latest
```

如果直接使用官方镜像，替换最后一行镜像名即可：
```
zhaiker/sillytavernchat-zk:latest
```

> 提示：Windows PowerShell 可将 `$(pwd)` 替换为 `$PWD`，并使用反引号换行；如需外网访问，请确保 `config.yaml` 中 `listen: true`，并放行端口 `8000`。

### 配置说明
```yaml
# config.yaml 主要配置项
listen: true                    # 监听外部连接
port: 8000                     # 服务端口()
whitelist: []                  # IP白名单
basicAuthMode: false           # 基础认证模式
enableExtensions: true        # 启用扩展系统
enableInvitationCodes: true   # 启用邀请码系统
enableForum: true             # 启用论坛系统
enablePublicCharacters: true  # 启用公共角色卡库系统
enableSystemLoadMonitoring: true  # 启用系统负载监控系统
enableUserActivityStatistics: true  # 启用用户活动统计系统
enableHistoryDataRecord: true  # 启用历史数据记录系统
enableVisualizationChart: true  # 启用可视化图表系统
enablePerformanceAlarm: true  # 启用性能告警系统
enableUserManagement: true  # 启用用户管理系统
enableUserRegistration: true  # 启用用户注册系统
enableUserLogin: true  # 启用用户登录系统
enableUserLogout: true  # 启用用户注销系统
enableUserProfile: true  # 启用用户个人资料系统
enableUserSettings: true  # 启用用户设置系统
enableUserTheme: true  # 启用用户主题系统

# 新用户注册策略
# requireInvitationCode 为 null 时继承 enableInvitationCodes
registration:
  password:
    enabled: true
    requireInvitationCode: null
  github:
    enabled: true
    requireInvitationCode: null
  discord:
    enabled: true
    requireInvitationCode: null
  linuxdo:
    enabled: true
    requireInvitationCode: null

# OAuth第三方登录配置（V1.13.12 新增）
oauth:
  github:
    enabled: false            # 是否启用GitHub OAuth
    clientId: ''              # GitHub OAuth App Client ID
    clientSecret: ''          # GitHub OAuth App Client Secret
    callbackUrl: ''           # 回调URL（留空则自动生成，支持反向代理）
  discord:
    enabled: false            # 是否启用Discord OAuth
    clientId: ''              # Discord OAuth App Client ID
    clientSecret: ''          # Discord OAuth App Client Secret
    callbackUrl: ''           # 回调URL（留空则自动生成，支持反向代理）
  linuxdo:
    enabled: false            # 是否启用Linux.do OAuth
    clientId: ''              # Linux.do OAuth App Client ID
    clientSecret: ''          # Linux.do OAuth App Client Secret
    callbackUrl: ''           # 回调URL（留空则自动生成，支持反向代理）
    authUrl: ''               # 授权URL（默认：https://connect.linux.do/oauth2/authorize）
    tokenUrl: ''              # Token URL（默认：https://connect.linux.do/oauth2/token）
    userInfoUrl: ''           # 用户信息URL（默认：https://connect.linux.do/api/user）

# 邮件服务配置（V1.13.12 新增）
email:
  enabled: false              # 是否启用邮件服务
  smtp:
    host: ''                  # SMTP服务器地址（如：smtp.qq.com）
    port: 587                 # SMTP端口（465需要启用SSL，587使用STARTTLS）
    secure: false              # 是否使用SSL/TLS（端口465必须为true）
    user: ''                   # SMTP用户名（通常是邮箱地址）
    password: ''               # SMTP密码或授权码
  from: ''                     # 发件人邮箱地址
  fromName: 'SillyTavern'     # 发件人名称
```

**OAuth配置说明**：
- 支持 GitHub、Discord、Linux.do 三种 OAuth 提供商
- `oauth.<provider>.enabled` 控制该 OAuth 登录服务是否可用；`registration.<provider>.enabled` 只控制是否允许该方式创建新账号
- 如需停止某个 OAuth 的新用户注册但保留老用户登录，请保持 `oauth.<provider>.enabled: true`，并设置 `registration.<provider>.enabled: false`
- `registration.<method>.requireInvitationCode` 可设为 `true`、`false` 或 `null`；`null` 继承全局 `enableInvitationCodes`
- 旧配置不包含 `registration` 时，四种注册方式默认开放且邀请码要求继续继承 `enableInvitationCodes`，升级行为不变
- 只要全局开关或任一注册方式要求邀请码，邀请码管理功能就会保持可用
- 回调 URL 可留空，系统会根据当前访问地址自动生成（支持反向代理和 SSL）
- 配置修改后需要重启服务才能生效
- 获取 OAuth 凭证：
  - **GitHub**：访问 https://github.com/settings/developers 创建 OAuth App
  - **Discord**：访问 https://discord.com/developers/applications 创建 OAuth2 应用
  - **Linux.do**：联系 Linux.do 管理员获取 OAuth 凭证

**邮件服务配置说明**：
- 启用邮件服务后，用户注册需要邮箱验证码
- 用户密码找回会发送恢复码到绑定的邮箱
- 如果邮件服务未启用，系统自动降级为控制台输出模式
- 配置修改后需要重启服务才能生效
- 建议在后台"邮件配置"页面进行配置，支持测试邮件发送

## 🎯 使用指南

### 管理员首次设置
1. 启动系统后访问 `http://localhost:8000`
2. 请直接点击立即登录，不要注册！不要注册。系统会自动注册一个默认管理员账户，是没有密码的。默认管理员用户名为：default-user  密码为空，直接点击进入后台添加新的管理员账户！
3. 后台添加注册第一个用户（然后将新注册的用户进行提权为管理员权限）
4. 退出默认帐户，登录新添加的管理员帐户，并禁用默认用户
5. 在邀请码管理中生成邀请码
6. 配置论坛分类和权限设置
7. （可选）在公告管理中发布登录页面公告，向用户展示重要信息
8. （可选）配置OAuth第三方登录（V1.13.12 新增）
   - 在第三方平台创建 OAuth 应用并获取 Client ID 和 Client Secret
   - 编辑 `config.yaml` 文件，配置对应 OAuth 提供商的凭证
   - 回调 URL 可留空，系统会自动生成（格式：`http(s)://域名:端口/api/oauth/提供商/callback`）
   - 重启服务后，登录页面将显示对应的 OAuth 登录按钮
9. （可选）配置邮件服务（V1.13.12 新增）
   - 进入后台"邮件配置"页面
   - 填写SMTP服务器信息
   - 点击"发送测试邮件"验证配置
   - 保存配置后重启服务生效
   - 启用后，用户注册将需要邮箱验证码
10. （可选）启用用户空间限制（V1.15.0 新增）
   - 进入后台“用户空间”页面
   - 勾选“启用用户存储空间限制”
   - 设置默认空间上限与每日签到奖励（MiB）
   - 如需扩容，生成激活码并分发给用户

### 普通用户使用
1. 注册账户
   - **方式一：传统注册**：使用邀请码注册账户
     - 如果系统启用了邮件服务，需要填写邮箱并输入验证码
     - 验证码会发送到您填写的邮箱，5分钟内有效
     - 注册成功后，邮箱会自动绑定到您的账户
   - **方式二：OAuth第三方登录**（V1.13.12 新增/优化）
     - 点击登录页面的 GitHub、Discord 或 Linux.do 登录按钮
     - 授权后自动跳转回系统
     - 如果启用了邀请码系统，首次登录需要输入邀请码完成注册
     - 系统会自动同步第三方账号的真实用户名、头像和邮箱信息
     - OAuth 用户默认无密码，可直接通过第三方账号登录

2. OAuth用户设置密码（V1.13.12 新增）
   - OAuth用户可在**个人设置 → 修改密码**中设置密码
   - **首次设置密码无需输入旧密码**，系统会显示友好提示
   - 设置密码后，您可以使用以下**两种方式**登录：
     - 继续使用第三方 OAuth 登录（推荐）
     - 使用用户名 + 密码登录
   - 个人资料页面会显示您的 OAuth 提供商信息

3. 登录方式说明
   - **OAuth用户（未设置密码）**：只能通过第三方 OAuth 登录
   - **OAuth用户（已设置密码）**：可使用 OAuth 或密码两种方式登录
   - **传统注册用户**：使用用户名 + 密码登录

4. 使用系统功能
   - 登录系统开始使用AI对话功能
   - 在论坛中参与社区讨论
   - 分享和下载公共角色卡
   - 个性化设置和主题配置
   - 在个人资料中查看“已用/总可用”和剩余空间

5. 密码找回（V1.13.12 新增）
   - 如果已绑定邮箱，恢复码会发送到您的邮箱
   - 如果未绑定邮箱，恢复码会显示在服务器控制台（需联系管理员）
   - 恢复码5分钟内有效
   - **注意**：未设置密码的 OAuth 用户无法使用密码找回功能，请使用第三方账号登录

6. 用户空间限制（V1.15.0 新增）
   - 个人资料中可使用“激活码扩容”和“签到奖励”按钮
   - 每日签到增加可用空间（管理员设置为 0 则关闭）
   - 当空间不足时无法新增聊天记录或角色卡，可删除内容或扩容后继续使用



## 🔐 OAuth 第三方登录技术细节（V1.13.12）

### 实现原理

#### 1. **用户名获取优化**
- **问题**：Linux.do 返回的 JWT token 只包含认证信息（sub, iss, aud），不包含用户详细信息
- **解决方案**：
  1. 解码 access_token JWT，检查是否包含 username 等用户信息
  2. 如果只有认证信息，自动调用 `/api/user` 端点获取完整用户数据
  3. 支持多种用户信息字段：`username`, `login`, `preferred_username`, `name`
  4. 自动处理嵌套数据结构（`user.username` 或 `username`）

#### 2. **头像自动同步**
- **首次注册**：下载第三方账号头像并转换为 base64 data URL 存储
- **每次登录**：自动更新头像，确保显示最新头像
- **支持格式**：JPEG、PNG、GIF、WebP 等常见图片格式
- **错误处理**：头像下载失败不影响登录流程

#### 3. **灵活的登录方式**
- **判断逻辑**：
  ```javascript
  if (user.oauthProvider && !user.password && !user.salt) {
    // 纯 OAuth 用户，只能通过第三方登录
  } else if (user.oauthProvider && user.password && user.salt) {
    // OAuth 用户已设置密码，可使用两种方式登录
  }
  ```
- **密码设置**：
  - OAuth 用户首次设置密码时无需验证旧密码
  - 前端自动隐藏"当前密码"输入框
  - 显示友好的引导提示信息

#### 4. **安全特性**
- **State 参数**：防止 CSRF 攻击，每次授权使用随机生成的 state
- **JWT 验证**：解码并验证 JWT token 的有效性
- **会话管理**：OAuth 登录后创建安全的用户会话
- **权限隔离**：OAuth 用户和传统用户使用相同的权限系统

### 支持的 OAuth 提供商

| 提供商 | 用户名字段 | 头像字段 | 邮箱字段 | 特殊说明 |
|--------|-----------|---------|---------|---------|
| **GitHub** | `login` | `avatar_url` | `email` | 标准 OAuth2 |
| **Discord** | `username` | `avatar` | `email` | 需要构建头像URL |
| **Linux.do** | `username` | `avatar_url` | `email` | 使用 Discourse API |

### 配置示例

```yaml
oauth:
  linuxdo:
    enabled: true
    clientId: 'your_client_id_here'
    clientSecret: 'your_client_secret_here'
    callbackUrl: ''  # 留空自动生成
    # 以下三个URL可留空使用默认值
    authUrl: 'https://connect.linux.do/oauth2/authorize'
    tokenUrl: 'https://connect.linux.do/oauth2/token'
    userInfoUrl: 'https://connect.linux.do/api/user'  # 使用 Discourse API 端点
```

### API 端点说明

#### OAuth 认证流程
1. **GET** `/api/oauth/:provider` - 发起 OAuth 登录授权
2. **GET** `/api/oauth/:provider?intent=register` - 发起明确的新用户注册授权
3. **GET** `/api/oauth/:provider/callback` - OAuth 回调处理
4. **POST** `/api/oauth/verify-invitation` - 完成邀请码验证（如果需要）

#### 第三方平台端点（Linux.do）
- **授权端点**：`https://connect.linux.do/oauth2/authorize`
- **Token端点**：`https://connect.linux.do/oauth2/token`
- **用户信息端点**：`https://connect.linux.do/api/user`（返回完整用户数据）

#### 返回数据格式（Linux.do）
```json
{
  "id": 107981,
  "username": "ZhaiKer",
  "name": "Ker Zhai",
  "email": "user@example.com",
  "avatar_url": "https://linux.do/user_avatar/linux.do/zhaiker/288/493521_2.png",
  "active": true,
  "trust_level": 3,
  "silenced": false
}
```

## 🛠️ 开发指南

### 目录结构
```
SillyTavernchat/
├── src/                    # 后端源码
│   ├── endpoints/         # API端点
│   │   ├── users-public.js  # 用户公开API（登录、注册、密码找回）
│   │   ├── users-private.js # 用户私有API（修改密码、头像、个人信息）
│   │   ├── users-admin.js   # 用户管理API（管理员功能）
│   │   ├── forum.js      # 论坛API
│   │   ├── system-load.js # 系统监控API
│   │   ├── invitation-codes.js # 邀请码API
│   │   ├── user-storage.js # 用户存储空间限制API
│   │   ├── announcements.js # 公告管理API
│   │   ├── oauth.js         # OAuth第三方登录API（V1.13.12 新增/优化）
│   │   │                    # - 支持 GitHub、Discord、Linux.do
│   │   │                    # - 自动头像下载和同步
│   │   │                    # - JWT token 解析和用户信息获取
│   │   │                    # - 灵活的密码设置和登录方式
│   │   ├── oauth-config.js  # OAuth配置管理API（V1.13.12 新增）
│   │   ├── email-config.js  # 邮件配置API（V1.13.12 新增）
│   │   └── email-status.js  # 邮件服务状态API（V1.13.12 新增）
│   ├── middleware/        # 中间件
│   ├── system-monitor.js  # 系统监控核心
│   ├── storage-codes.js   # 存储空间激活码逻辑
│   ├── storage-quota.js   # 用户存储空间配额计算
│   ├── users.js          # 用户管理核心（优化了OAuth用户认证逻辑）
│   └── email-service.js   # 邮件服务核心（V1.13.12 新增）
├── public/                # 前端资源
│   ├── login.html        # 登录页面（支持OAuth第三方登录按钮）
│   ├── register.html     # 注册页面
│   ├── forum.html        # 论坛页面
│   ├── public-characters.html # 角色卡库
│   └── scripts/          # JavaScript文件
│       ├── user.js       # 用户管理前端（优化了密码设置逻辑）
│       └── templates/    # HTML模板
│           ├── userProfile.html  # 个人资料（显示OAuth提供商）
│           └── changePassword.html # 修改密码表单
└── data/                 # 数据存储
    ├── default-user/     # 默认用户数据
    ├── system-monitor/   # 监控数据
    ├── forum_data/       # 论坛数据
    └── announcements/    # 公告数据
        ├── announcements.json       # 主站公告
        └── login_announcements.json # 登录页面公告
```



## 🤝 贡献指南

### 提交代码
1. Fork 项目到您的GitHub账户
2. 创建功能分支：`git checkout -b feature/新功能名称`
3. 提交更改：`git commit -m '添加新功能'`
4. 推送分支：`git push origin feature/新功能名称`
5. 创建Pull Request

### 报告问题
- 使用GitHub Issues报告bug
- 提供详细的错误信息和复现步骤
- 包含系统环境信息

## 📄 许可证
本项目基于 AGPL-3.0 许可证开源，详见 [LICENSE](LICENSE) 文件。

## 🙏 致谢
- [SillyTavern](https://github.com/SillyTavern/SillyTavern) - 提供优秀的基础框架
- 所有贡献者和社区成员的支持

## 📞 联系方式
- 项目主页：https://github.com/zhaiiker/SillyTavernchat
- 问题反馈：https://github.com/zhaiiker/SillyTavernchat/issues
- 讨论社区：https://github.com/zhaiiker/SillyTavernchat/discussions

---

**SillyTavernchat** - 让AI对话更智能，让社区更活跃！ 🎉

