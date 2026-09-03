# dsh-vscode — L4 周边(VSCode 扩展)

| 项 | 值 |
|---|---|
| 上游仓 | [kuaizhongqiang/dsh-vscode](https://github.com/kuaizhongqiang/dsh-vscode) |
| 生态位 | L4 周边(编辑器内使用 dsh 的入口) |
| 伞仓锁指针 | `65c25bab`(`65c25bab26702ddcd233c1da1c559b15bde50868`) |
| 发布渠道 | Open VSX(已发布);GitHub Releases |
| 本地开发 | 子仓克隆(本地开发根 `F:\Project\dsh-dev\*`,见 WORKLOG 2026-09-02) |

## 角色

VSCode 扩展:会话 / 聊天 / 工具卡片;与 dsh server 通过 `launch-token.json` 共享 token 自动登录,
支持 `dsh.remote` / `dsh.serverUrl` / `dsh.token` / `dsh.extraHeaders`(对齐 Cloudflare Access 场景)。

## 自带文档 / 入口

- 仓内 README 与扩展配置说明;Open VSX 市场页使用说明。

## 与伞仓的关系 / 跟随语义(Phase 5 收窄表述)

- **token 认证跟随**激活连接(`launch-token.json` 照写);但 `dsh.serverUrl` 是**静态配置,不自动切换**——
  切到 remote 连接组后需手动同步 serverUrl;远期直接读 `connections.json` 才实现全自动多组切换
  (见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) Phase 5)。

## bump / 发布注意点

- 扩展发布走自身仓(Open VSX / Releases);伞仓 bump 指针锁版本。
- M5/M6 若改动 token/连接语义,需回归验证扩展的 token 跟随路径。
