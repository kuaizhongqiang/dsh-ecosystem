# dsh-vscode — L4 周边(VSCode 扩展)

| 项 | 值 |
|---|---|
| 上游仓 | [kuaizhongqiang/dsh-vscode](https://github.com/kuaizhongqiang/dsh-vscode) |
| 形态 | **直接工程**(伞仓根 `dsh-vscode/`,独立 git,改动在仓内提交推送) |
| 生态位 | L4 周边(编辑器内使用 dsh 的入口) |
| HEAD 快照 | `1756889`(launch-token 增量整合;权威值 `git -C dsh-vscode log -1`) |
| 发布渠道 | Open VSX(已发布);GitHub Releases |

## 角色

VSCode 扩展:会话 / 聊天 / 工具卡片;与 dsh server 通过 `launch-token.json` 共享 token 自动登录,
支持 `dsh.remote` / `dsh.serverUrl` / `dsh.token` / `dsh.extraHeaders`(对齐 Cloudflare Access 场景)。
M0 协议对齐(clearLaunchToken source+pid 双匹配等)已合入(0.3.0 线)。

## 自带文档 / 入口

- 仓内 README 与扩展配置说明;Open VSX 市场页使用说明。

## 与伞仓的关系 / 跟随语义(Phase 5 收窄表述)

- 伞仓根的 `dsh-vscode/` 就是本仓检出,更新 = 目录内 `git pull` / 提交推送,**无伞仓 bump 仪式**。
- **token 认证跟随**激活连接(`launch-token.json` 照写);但 `dsh.serverUrl` 是**静态配置,不自动切换**——
  切到 remote 连接组后需手动同步 serverUrl;远期直接读 `connections.json` 才实现全自动多组切换
  (见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) Phase 5)。

## 发布注意点

- 扩展发布走自身仓(Open VSX / Releases);Open VSX 发布需 OVSX_PAT(待用户提供)。
- M5/M6 若改动 token/连接语义,需回归验证扩展的 token 跟随路径。
