# dsh-vscode — L4 周边(VSCode 扩展)

| 项 | 值 |
|---|---|
| 来源仓 | [kuaizhongqiang/dsh-vscode](https://github.com/kuaizhongqiang/dsh-vscode)(**已归档只读**) |
| 形态 | **伞仓内目录 `dsh-vscode/`**(monorepo,随伞仓统一提交) |
| 生态位 | L4 周边(编辑器内使用 dsh 的入口) |
| 并入 HEAD | 随伞仓 monorepo;**当前发布 v0.8.5(Open VSX)**(权威版本见目录内 package.json) |
| 发布渠道 | Open VSX(伞仓 CI release 自动,需 OVSX_PAT);伞仓 Releases |

## 角色

VSCode 扩展:会话 / 聊天 / 工具卡片 / **优雅升级**(侧边栏首页「检查更新」一键检测 Open VSX 新版并自动升级);
与 dsh server 通过 `launch-token.json` 共享 token 自动登录,
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

## 内嵌 dsh web / 聊天中聊天 / 保活（milestone #2，#20–#23）

设计与决策记录见 [`dsh-vscode-embed-design.md`](dsh-vscode-embed-design.md)（含 seam 提案 §9、参考补丁 §10、真产品+真机验证 §10.5）。

- **承载/认证（#20/#21）**：侧栏新增 `dsh.web` 视图（`src/embed/`），薄壳 + iframe 复用 dsh web。
  认证优先走 dsh server 的 **embed seam**（`GET /api/embed/capability` → `{seam,version}`；`GET /api/embed/open?t=&path=` 一次性 token → 303 + embed cookie：`SameSite=None`，loopback/https 加 `Secure`，加 `Partitioned`）；**服务器没有 seam（例如官方发布版 dsh）时自动改用扩展侧本机反向代理**（`src/embed/embedProxy.ts`：把 launch-token 换成上游 cookie 后转发 HTTP/WebSocket，iframe 指向 `http://127.0.0.1:<port>/`），代理也失败才降级「在浏览器打开」（绝不空白页）。
  命令：`DSH：打开内嵌网页（侧栏）`（`ctrl+alt+e`）、`DSH: 在浏览器打开`。seam 本体实现位于 deepseek-harness `seam/embed-auth` 分支（capability/open/BrowserAuth）。
- **聊天中聊天（#22）**：会话内可插入**独立子会话卡片**（`src/chat/nestedSessions.ts` + `media/webview.html`），子会话=独立 dsh 会话（沿用父工作区、不共享执行上下文），支持流式文本、折叠、关闭、多开。
- **编辑器上下文注入（#23）**：`src/chat/editorContext.ts` + 右键命令 `DSH：附选中代码提问` / `DSH：附当前文件提问`（有界上下文块 + 问题一起发送）。
- **保活与兼容（#23）**：`src/client/liveness.ts` 断线计时/重连提示（状态栏 `连接断开，重连中 · Ns`，恢复提示），`src/client/versionCompat.ts` 基于 capability 的 seam 版本矩阵（ok/warn/unsupported）。
- **验证索引**：connection 包（harness）169/169 + 真产品 seam e2e；扩展 `vitest` 88 passed（含 webview 渲染/嵌套/上下文/保活/兼容）、typecheck、esbuild、`vsce package`；真 VS Code 侧栏内嵌截图 `docs/evidence/embed-sidebar-vscode-1/2.png`。
- **待真机**：真实桌面/远程桌面里的人工打字流式验收与双窗口并发一致性观察（纯 Xvfb 下 Electron 不接收合成键盘事件，已记录）。
