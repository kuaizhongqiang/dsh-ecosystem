# dsh-vscode — L4 周边(VSCode 扩展)

| 项 | 值 |
|---|---|
| 来源仓 | [kuaizhongqiang/dsh-vscode](https://github.com/kuaizhongqiang/dsh-vscode)(**已归档只读**) |
| 形态 | **伞仓内目录 `dsh-vscode/`**(monorepo,随伞仓统一提交) |
| 生态位 | L4 周边(编辑器内使用 dsh 的入口) |
| 并入 HEAD | `1756889`(并入快照);**当前发布 v0.8.0(Open VSX)**(权威版本见目录内 package.json) |
| 发布渠道 | Open VSX(手动,需 OVSX_PAT);伞仓 Releases |

## 角色

VSCode 扩展:会话 / 聊天 / 工具卡片;与 dsh server 通过 `launch-token.json` 共享 token 自动登录,
支持 `dsh.remote` / `dsh.serverUrl` / `dsh.token` / `dsh.extraHeaders`(对齐 Cloudflare Access 场景)。
M0 协议对齐(clearLaunchToken source+pid 双匹配等)已合入(0.3.0 线)。

## 自带文档 / 入口

- 目录内 README 与扩展配置说明;Open VSX 市场页使用说明。

## 与伞仓的关系 / 跟随语义(Phase 5 收窄表述)

- **开发在伞仓内进行**:修改 `dsh-vscode/` 后随伞仓 git 提交推送。
- **token 认证跟随**激活连接(`launch-token.json` 照写);`dsh.serverUrl` 为**静态配置,不自动切换**——
  切到 remote 连接组后需手动同步 serverUrl;远期直接读 `connections.json` 才实现全自动多组切换
  (见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) Phase 5)。

## 发布注意点

- **手动发布**:本地打包 vsix → `ovsx publish`(Open VSX,需 OVSX_PAT)/ 上传伞仓 Releases;
  原仓 ci/release workflow(含 Open VSX 自动发布)已随归档停摆(见 [RELEASING.md](../RELEASING.md))。
- M5/M6 若改动 token/连接语义,需回归验证扩展的 token 跟随路径。
