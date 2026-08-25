# stcontrol 分方式注册策略适配器

本分支让 SillyTavern 成为本节点注册策略的唯一事实来源。签名的本机 stcontrol 适配器会报告 `password`、`github`、`discord`、`linuxdo` 四种新账号创建策略，Agent/Controller 不再把密码注册开关误当成整个节点的注册状态。

## 对外合同

`POST /api/stcontrol/internal/registration-policy` 返回：

```json
{
  "ok": true,
  "mode": "open",
  "version": 1,
  "methods": {
    "password": { "enabled": false, "invitation_required": false },
    "github": { "enabled": false, "invitation_required": false },
    "discord": {
      "enabled": true,
      "invitation_required": false,
      "guild_membership": {
        "enabled": true,
        "guild_id": "1134557553011998840",
        "guild_name": "类脑 ΟΔΥΣΣΕΙΑ",
        "minimum_days": 15
      }
    },
    "linuxdo": { "enabled": false, "invitation_required": false }
  }
}
```

策略版本保存在用户数据根目录的 `_stcontrol/adapter-state.json`，只有公开策略内容变化时才单调递增。OAuth 客户端 ID、客户端密钥、访问令牌、邮箱和用户身份 subject 都不进入响应或策略指纹。

## 注册执行

Controller 下发账号供应时，适配器会按 `oauth_provider` 重新读取对应方式：

- 密码供应只检查 `registration.password`；
- Discord 供应只检查 `registration.discord`；
- LinuxDo 供应只检查 `registration.linuxdo`；
- 策略版本变化、方式被关闭或缺少必需邀请码都会失败关闭。

`registration.*.enabled` 只控制创建新账号，不会关闭已有账号使用对应方式登录。Discord 公会成员和最低入群天数也只用于新账号注册。

## 升级检查

```bash
git fetch origin server && git switch server && git pull --ff-only origin server && npm ci --no-audit --no-fund && sudo systemctl restart sillytarven.service
```

更新后，Agent 健康探测必须看到 `registration_policy_methods` 能力。若 Agent 仍为旧版本，它会把新合同视为不兼容；请同时更新 stcontrol Agent 到 `0.3.0` 或更新版本。
