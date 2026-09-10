# dsh web × VS Code 承载与认证方案选型 —— issue #20 决策记录（草稿）

> **状态**：研究/决策草稿（未合入、不 commit）。目标是把 **dsh web 客户端**组装进 VS Code
> 侧栏（WebviewView）与聊天栏（主区/编辑器旁），并支持"聊天中聊天"（内嵌 dsh 会话）。
> 本文件只做**承载与认证的选型**，不做功能开发。
>
> **来源**：[kuaizhongqiang/dsh-ecosystem#20](https://github.com/kuaizhongqiang/dsh-ecosystem/issues/20)
> 配套实现 issue：#21（认证）、#22（侧栏承载）、#23（聊天内嵌）。
>
> **依据版本（重要）**：dsh-vscode `0.8.5`（伞仓目录内 package.json）；deepseek-harness
> **以本地工作副本 `/home/kuai/deepseek-harness` 为准**（`dsh-v0.1.5-alpha.1-2-g767b1e7673`）；
> 伞仓 `deepseek-harness` 子模块指针 `47f94385`（= `dsh-v0.1.0-rc.7~24`，**较旧**），两处不一致时
> 本文件以较新的本地工作副本为准并逐条标注。`dsh web` 行为经对本地 `http://127.0.0.1:3080`
> 的**只读探测**验证（见附录 A）。
>
> 证据格式：`仓:路径:行号`（`vscode/`=dsh-vscode 目录；`harness/`=deepseek-harness 工作副本）。

---

## 0. TL;DR（一句话结论 + 三个最关键技术事实）

**推荐一句话**：**放弃"浏览器 iframe 直接带 cookie 自动登录"的路径 A 原样实现；把『dsh server 提供
embed 认证 seam』定为前置依赖（#21），承载（#22）与聊天内嵌（#23）统一采用『薄壳 + iframe 全量复用
dsh web』为终态；在 seam 就绪前，#22/#23 先做壳与深链（现状自绘 UI 不变），避免再造一套渲染。**
（C 的"混合"是过渡形态而非并列第三选。）

**三个最关键的技术事实（带证据）**：

1. **dsh 的浏览器会话 cookie 是 `HttpOnly; SameSite=Strict`，且按 Host authority 做名**
   —— VS Code webview 顶级 origin（`vscode-webview://…`）与任何 dsh origin（本地
   `127.0.0.1:3080` 或远程 https）**跨站**，Strict cookie 在跨站 iframe 内既不发送也不可被
   JS 读取，故"iframe 直连 + token 换 cookie 自动登录"在**不改 dsh server** 的前提下不可行。
   证据：`harness/packages/client/connection/src/browser-auth.ts:106-123`（`cookieName = 'dsh-auth-' +
   sha256(authority)`；`sessionCookie(...) HttpOnly; SameSite=Strict`）、`:240-282`（仅 `GET /` 且
   恰好一个 `token` query 才 303+Set-Cookie，其余 401）。
2. **dsh web 客户端不是一份可独立 serve 的静态 dist**：`index.html` 由 server 在响应时注入
   `window.__DSH_BOOT__`（含 `rev/entries/batches` 的**运行时组合图**）+ 引导脚本 + 恢复配置，
   且 bundle 组合随已装插件（声明 `dsh.client` 的包）增量变化，bundle 由同源 `/plugins` 前缀路由
   提供。把 dist 打包进扩展本地 serve（方案 B）会得到一份**无法 boot 的空壳**。
   证据：`harness/packages/host/webserver/src/injections.ts:49-57,96-118`（global 注入
   `globalThis["__DSH_BOOT__"]=…` 与 `__DSH_BOOT_READY__`）；`harness/packages/client/modules/
   src/client/manifest.ts:80-92,167-256`（graph 解析，缺图即 throw）；`harness/packages/client/
   modules/src/index.ts:500-507,572`（boot 注入行 + `/plugins` 前缀 bundle 路由）；
   `harness/packages/bundle/web-app/src/index.ts:232`（`distIndex` 作为 frontend-static 挂载点，
   `web-app` 只是"胶水插件"，真正的 host 注入仍在 server 侧）。
3. **dsh 客户端"长连接"通道是 WebSocket mux（`/api/remote.mux`）+ server 每 2 s Ping 心跳 +
   客户端退避重连，不是浏览器 SSE**：SSE/`text/event-stream` 只出现在开发期 HMR
   （`packages/client/hmr`）与 server→模型厂商的上游流，生产 web 客户端不建 SSE。这直接覆盖 issue
   里"SSE 长连接 / QUIC 空闲断连"的顾虑——心跳+重连即对策，iframe 复用不会引入新的断连面。
   证据：`harness/packages/api/gateway/src/index.ts:116,171-174`（默认 2 000 ms）、
   `stream-server.ts:28-51,75-93`（Ping 帧 + missed 计数）；`packages/client/hmr/src/client/
   index.ts:166`（唯一浏览器 `EventSource` 使用点）；dsh-vscode 的 mux 客户端
   `vscode/src/client/mux.ts:160-164,224-229` 与 `connection.ts:366-380`。

---

## 1. 背景、范围与现状架构

### 1.1 issue #20 的决策空间（原文浓缩）

- A）Webview 内 **iframe 直连 dsh server**（本地或远程 URL）→ 带 token cookie 自动登录
  （launch-token / 30 天 cookie 机制；参考 dsh-launcher tokenFile / restart seam）。
- B）把 dsh web client 资源（dist assets / `@deepseek-ai/dsh-web-app`）**打包进扩展本地 serve**
  （同源、可离线、无额外服务依赖、与版本打包绑定）。
- C）混合：侧栏 iframe 直连、聊天内嵌用轻量会话组件。

范围与风险点名：SSE 长连接/心跳（QUIC 空闲断连）、工具图片卡与附件、Session v3、多窗口并发一致性、
local vs remote dsh、token 轮换、CSP、与桌面/浏览器端同账号并发。

### 1.2 现状：dsh-vscode 是"自绘 UI + 宿主直连协议"，与 dsh web 是两套 UI

- 扩展结构（`vscode/package.json`）：`main: dist/extension.js`（esbuild 单 CJS bundle、
  `--no-dependencies` 打包，运行时依赖仅 `ws`），`engines.vscode ^1.90.0`；
  `activationEvents: onStartupFinished / onView:dsh.sessions`；唯一视图
  `dsh.sessions`（`type: webview`）。
- 侧栏：`SidebarWebviewProvider`（`vscode/src/sidebarView.ts:440-487`）——自绘 HTML 字符串
  （`sidebarViewHtml.ts`），宿主 postMessage 快照、webview 动作走扩展命令白名单；
  CSP 为 `default-src 'none'; script-src 'unsafe-inline'; img-src data: https:`
  （`sidebarViewHtml.ts:16`）——**无 `connect-src`/`frame-src`**，目前页面既不能 fetch 也不能 iframe。
- 聊天栏：`ChatPanel`（`vscode/src/chat/chatPanel.ts`）= 每会话一个 WebviewPanel，
  读 `media/webview.html`（`:477-493`），同为纯 postMessage 桥（`media/webview.html:384,1201`），
  页面内无 fetch/WebSocket/EventSource/iframe（整文件 grep 无命中）；CSP 同上（`webview.html:6`）。
- 协议层（`vscode/src/client/`）：Node 侧直连 dsh——
  - unary：`POST /api/{ns}/{method}`（`rpc.ts:117`；cookie 与 extraHeaders 经 `requestHeaders()` 合并，
    `rpc.ts:86-89`）；
  - 事件/实时：`ws(s)://{base}/api/remote.mux` WebSocket + 逻辑流 `$events`、`session/control`、
    `workspace/follow`、`session/follow`（`mux.ts:160-164`、`connection.ts:366-407`）；断线按
    `dsh.reconnectIntervalMs`（默认 3 000 ms）退避重连（`mux.ts:73,224-229`）。
  - 会话 API 即当前 typert-remote 会话 wire（`session/create|list|page|prompt|cancel|rename|fork`、
    `session/modelCatalog`、`workspace/create`、事件瀑布 `approval/request` / `user-questions/request`），
    与 harness `api/session-controller` / `api/gateway` 的协议一致——即 issue 所称"Session v3"线。
- 认证/连接配置：`dsh.serverUrl`（默认 `http://127.0.0.1:3080`）、`dsh.remote`、
  `dsh.token`、`dsh.localServerPath`、`dsh.launchTokenFollow`、`dsh.extraHeaders`
  （`vscode/src/config.ts:84-105`）。

### 1.3 关键差异：dsh-desktop 的"顶栏直载"在 VS Code 里不可复制

伞仓 dsh-desktop（Electron）用 **BrowserWindow 把 dsh URL 作为顶级文档**直载
（`dsh-desktop/desktop/src/main/windows.ts:96-99` `loadDshUrl`），顶级 site 就是 dsh origin →
cookie/trust 全部按浏览器正常语义生效，token 从共享 `launch-token.json` 拼 `/?token=`
（`dsh-desktop/desktop/src/main/connect.ts:10-12,29-32`）。**VS Code webview 的主文档永远只能来自
扩展资源**（`vscode-webview://…` origin），不能把 webview.html 设为外部 http(s) URL；要嵌 dsh web
只能 iframe → 必然跨站。这是 A/B/C 所有路线共同的承载约束。

---

## 2. 事实基线（带证据）

### F1 dsh server 认证模型（launch-token / 30 天 cookie / 轮换 / 重启 seam）

- **进程 launch token**：每次 `dsh web` 进程启动随机生成 32 B（base64url），挂在进程 owner
  上（同一进程内 Connection 重载不换）；通过打印的带 token URL 暴露
  （`harness/packages/client/connection/src/browser-auth.ts:52-58`；
  `harness/packages/bundle/web-app/src/index.ts:252-272` 打印
  `dsh web: http://127.0.0.1:<port>/?token=… (LAN: …)`）。**token 只随进程重启轮换**。
- **token → 会话 cookie 交换**：仅 `GET {base}/?token=<launchToken>`（根路径 `/`、GET、恰好一个
  `token` 参数）→ `303 Location: /` + `Set-Cookie`；否则一律 401 文本
  （`browser-auth.ts:240-282,304-312`）。dsh-vscode 用 Node 原生 http(s) 完成该交换并持有 cookie
  （`vscode/src/client/auth.ts:47-135`：303/302 且含 `dsh-auth-` 才成功）。
- **cookie 形态**：名 = `dsh-auth-` + `sha256(authority)`（authority = 请求 `Host`，因此 cookie
  **按 host:port 隔离**：`127.0.0.1:3080` 与局域网/远程域名各自成对）；值 `v1.{body}.{hmac}`；
  属性 `Max-Age; Path=/; HttpOnly; SameSite=Strict`
  （`browser-auth.ts:69-78,106-123,129-132`）。**默认 30 天**（`cookieMaxAgeDays` 默认 30，
  `harness/packages/client/connection/src/index.ts:90-95,108,117`）。
- **cookie 签名密钥持久化**（credential record `client-connection/browser-session`）：dsh 重启后
  密钥仍在 → **已发放 cookie 跨重启继续有效 30 天**；只有"新登录"需要新 token
  （`browser-auth.ts:12,161-178`）。
- **重启 seam / token 轮换应对**（伞仓 M0/M6 协议）：谁拉起 dsh 谁把
  `{version,token,port,url,pid,writtenAt,source,managedBy?}` 写到 `$DSH_HOME/launch-token.json`
  （POSIX 0600），另一方读取跟随；清理按 source+pid 归属 + 复读确认（`vscode/src/launchToken.ts:
  26-53,59-61,80-108,121-152`；launcher 侧同协议见 WORKLOG M0）。扩展 401 时**重读共享文件并重试一次**
  （`vscode/src/extension.ts:186-220`），自己拉起的 dsh 退出时清文件
  （`vscode/src/localServer.ts:169-181,339-369`）。launcher 侧写 `managedBy: 'dsh-launcher'`
  （M6 重启 seam，`launchToken.ts:50-53`）。
- **/api 信任围栏（非认证层，但决定谁能调 /api）**：Host 必须 loopback 或 `trustedHosts`；
  `Sec-Fetch-Site: cross-site` 直接拒；带 `Origin` 时必须与 Host 同 authority；`Origin: null`
  （sandbox iframe / file:）拒（`harness/packages/client/connection/src/api-request-trust.ts:91-118`；
  WS 升级同样过 `requestRejection`，`api/gateway/src/index.ts:214-220`）。**iframe 内页面自身发起的
  /api 请求 Origin=Host= dsh origin，属于同源，围栏放行**——问题只在 cookie 是否随请求。

### F2 dsh web 客户端形态与 `__DSH_BOOT__`

- 构建：`apps/web`（`@deepseek-ai/dsh-web-frontend`）`vite build`，`base: './'`，产物
  `dist/index.html + dist/assets/*`（本地确有 `apps/web/dist/assets/index-*.js/css`、fonts、langs、
  vendor 等）；**故意不是独立应用**——`vite.config.ts` 直接拒绝裸 `vite dev/preview`（
  `STANDALONE_ERROR`：只有 `dsh web` 注入 `window.__DSH_BOOT__`）。
- 注入：server 读 `dist/index.html` → `webServer.renderIndex` 执行结构化注入行
  （`harness/packages/host/webserver/src/injections.ts:47-71,96-118`）：`<head>` 内联引导脚本（
  `window.__ModuleLoader__` 队列）、application preload、bootstrap combo `<script src>`、随后
  `globalThis["__DSH_BOOT__"] = <graph>`（`<` 被 `\u003c` 转义防逃逸）、末尾 `__DSH_BOOT_READY__`
  结算。另有 `__DSH_CONNECTION_RECOVERY__`（重连时序，`client/connection/src/index.ts:121-123`）。
- `__DSH_BOOT__` 结构：`{ rev, entries:[{id,url,rev,inject,external,immediately}],
  batches:[{phase:'bootstrap'|'application',url,rev,entries}] }`
  （`packages/client/modules/src/client/manifest.ts:80-92`）；浏览器侧解析失败即 loud throw
  （`:167-256`）。
- 组合来源：`ClientModuleRegistry` 增量扫描宿主 Loader 里**声明 `dsh.client` 的包**并重组 combo
  bundle（`packages/client/modules/src/index.ts:512-…`），bundle 路由为同源 **`/plugins`** 前缀
  （`index.ts:572`），combo 响应带 `cache-control: immutable`（`index.ts:1019`）。**装机不同
  （~/.dsh/profiles/web/plugins、cordis.patch.yml 白名单）→ graph 与 /plugins 内容不同**；
  这是"web 客户端 = server 进程的运行时产物"的根本证据。

### F3 live 通道与心跳（修正 issue 的"SSE"假设）

- 客户端实时通道 = **WebSocket `/api/remote.mux`**（`packages/api/gateway/src/stream-protocol.ts:6`；
  WS 升级前过 /api 信任围栏，`gateway/src/index.ts:214-220`）。
- 心跳 = gateway **每 2 000 ms（默认）发 WS Ping 帧**，跟踪 missed pong 清理死连接
  （`gateway/src/index.ts:116,171-174`；`gateway/src/stream-server.ts:28-51,75-93`）。浏览器端对
  Ping 协议层自动回 Pong → 空闲/代理（含 QUIC/HTTP3 空闲超时）断连由心跳覆盖；断连后客户端按
  recovery/退避重连（浏览器注入 recovery：base 500 ms→cap 10 s，`client/connection/src/
  recovery-config.ts:8-21`；扩展 3 000 ms，`vscode/src/client/mux.ts:73`）。
- 生产 web 客户端**没有浏览器 SSE**：全仓生产代码无 `new EventSource`，唯一命中在开发期 HMR
  `packages/client/hmr/src/client/index.ts:166`；`text/event-stream` 另用于 server→LLM 厂商上游
  （`packages/llm/llm-deepseek/src/adapter.ts:542` 与测试 fixtures）。SSE 相关风险项应改写为
  "WS mux 心跳 + 重连"。
- 图片/附件边界：附件进 RPC（图片 base64 + `imageLimits` 投影；`/api` 信封默认上限 300 MiB，
  `client/connection/src/index.ts:52,86-94`）；**媒体回读**为经认证的 `GET /api/file?path=…`，
  响应带 `CSP: sandbox; default-src 'none'` + `nosniff` + no-store（
  `packages/api/session-controller/src/media-references.ts:15-20,66-76`）。dsh web 内图片卡用
  `dsh-resource://file/session/…` 地址体系（`packages/util/workspace-path/src/file-address.ts:14`）。
  扩展聊天**不经 /api/file**：图片由宿主读文件 → base64 → `session/prompt` content
  （`vscode/src/chat/chatPanel.ts:286-320`；`client/connection.ts:249-269`；`chat/types.ts:73-81`）。

### F4 iframe 可嵌入性与本地/远程 URL/端口

- server 响应**无 `X-Frame-Options`、无 CSP `frame-ancestors`**（全仓生产代码仅 media-references
  有 CSP，且是针对文件响应的 sandbox）：从 server 侧看 dsh web 页面**可以被 iframe**；
  阻碍只在浏览器 cookie 语义（F1）。
- URL/端口：本地固定 loopback `http://127.0.0.1:3080`（`vscode/src/localServer.ts:71-72`；
  `vscode/src/config.ts:88`；`bundle/web-app/src/index.ts:80-82,149-153`）；`0.0.0.0` 部署时打印
  LAN URL 并把 LAN IPv4 自动纳入 `trustedHosts`（`web-app/src/index.ts:125-132`）；远程即配置的
  serverUrl（`dsh.serverUrl`）。**本地 dsh 也默认开启浏览器会话认证**（探测：`GET /` → 401）。
- **探测实录（本地 3080，见附录 A）**：`GET /` 与 `GET /index.html` → 401 明文；非 index 静态资产
  （`/favicon.svg`）→ 200 公开；**`GET /session/zzz` → 404**（当前 harness 静态 fallback 不提供
  SPA 深链回退，`frontend-static/src/index.ts:96-101`）——iframe 嵌入必须以 `/` 起步、在客户端内导航；
  dsh-vscode 现有的 `sessionWebUrl = {base}/session/{id}`（`vscode/src/config.ts:155-158`）直开语义
  是**较旧 dsh（伞仓指针 rc.7 时代）**的行为，与当前 harness 不一致（见 §7 依赖结论）。

### F5 版本兼容 / 升级通道（dsh-vscode ↔ dsh）

- 扩展自带"优雅升级"：Open VSX REST 查最新版（`https://open-vsx.org/api/kuaizhongqiang.dsh-vscode`）
  → 比较 → 下载 vsix → `workbench.extensions.installExtension` → 提示重载；失败兜底打开
  Open VSX 下载页（`vscode/src/updater.ts:12-46,69-80`；`extension.ts:817-893`）。
- 与 dsh server 的协议对齐**没有运行时协商**：靠"扩展发版跟 dsh wire"+
  `session/list` 探测 + 401 重读 token 重试（`localServer.ts:285-291` 注释"新版 DSH 移除了
  host.describe，用 session/list 探测"；`extension.ts:186-220`）。若引入 iframe 复用，**UI 语义
  与 wire 的绑定将从"扩展发版"移到"dsh server 发版"**（web 页面来自 server），反而消除双实现漂移。

---

## 3. 选型对比（A / B / C）

> 评分前提：**dsh server（上游官方）现状不改动**是 A/B/C 的公共分母；"需要上游改动"逐条标注，
> 因为它决定可行性而不是打分项。

| 维度 | A：iframe 直连 + cookie 自动登录 | B：打包 client 本地 serve | C：混合（侧栏 iframe + 聊天轻量组件） |
|---|---|---|---|
| 认证（现状 cookie 机制） | **不可行**：跨站 iframe 不发 `SameSite=Strict` cookie（F1）；放宽到 `None; Secure` 依赖 https（本地 loopback http 的 Secure 属性行为因浏览器而异，需上游特例），且仍受第三方 cookie 分区影响；`/` 的 token 交换是 303 重定向，登录态无法传给 iframe | 本地 serve 只是"看起来同源"；页面仍需 host 注入才能 boot（F2），与 cookie 无关 | 侧栏半边同 A（不可行）；聊天轻量组件若走浏览器 cookie 同样被 Strict 拦 |
| 功能完整性 | 若 seam 就绪则**100% 复用 dsh web**（会话列表/聊天/工具卡/设置/插件/工作区） | **0%**：静态 dist 无 `__DSH_BOOT__` 组合与 `/plugins`，`parseBootManifest` 直接 throw；要跑起来必须复刻整套 host（modules 组合、注入、WS、approval 瀑布、附件）——等于再造 dsh server 的 web 面 | 侧栏全功能（受 A 制约）；聊天=现状自绘组件（功能子集：文本/推理/工具卡/审批/提问/图片已有，无完整 dsh 工作台） |
| 资源/离线 | 依赖 dsh server 进程（本地模式扩展已能拉起，`localServer.ts`） | "离线"仅在自带快照意义成立；快照与装机（`dsh.client` 插件集合）和 server 版本必然漂移，离线=旧 UI 连新 server | 侧栏同 A；聊天不依赖 server UI |
| 版本耦合 | **与 server 自动同步**（UI 由 server 渲染；扩展只负责壳与认证引导） | 每次 server/client 或插件更新都要重打包 vsix；`@deepseek-ai/dsh-web-app` 只是胶水插件，不导出可独立运行的 client（`bundle/web-app/src/index.ts:1-12,232`） | 侧栏与 server 同步；聊天仍随扩展发版 |
| 多窗口/并发一致性 | 由 server 侧会话语义承担（extension 现状已支持同会话多 `session/follow` 客户端与事件瀑布应答，`connection.ts:383-407`） | 同现状扩展；无新增窗口面 | 同 A（侧栏）+ 现状（聊天） |
| token 轮换 / 重启 seam | 由扩展宿主持有凭据并在 seam 就绪后引导 iframe（重启后 cookie 30 天内仍有效，F1）；比"每次把 token 拼进 URL"稳 | 不涉及（页面无法运行） | 同 A |
| CSP / 边界 | 扩展壳 CSP 需加 `frame-src <dsh origin>`（当前两个 webview CSP 均无，`sidebarViewHtml.ts:16`、`webview.html:6`）；server 无需改 CSP（无 frame-ancestors） | 扩展需内置完整 CSP/connect-src 且自造注入 | 同 A + 现有聊天 CSP |
| 工程/维护成本 | 低（壳 + 认证引导）；**依赖上游 embed seam（见 §7）** | **极高**（复刻 host 组合与注入；双实现长期并存） | 中（两套 UI 并存期） |
| 结论 | **终态目标形态（前提：seam）**；seam 前不可直接落地 | **否决**（技术误判 + 成本不成比例；可作为"完全离线只读展示"的远期单独课题） | **过渡形态**：在 seam 前保留现状自绘聊天 + 侧栏深链；seam 后统一收敛到 A 形态 |

补充 B 的关键证据链：`dsh web` 的 dist 由 server 逐请求渲染注入
（`harness/packages/host/frontend-static/src/index.ts:120-141` 仅对 `distIndex` 路径做 auth+注入），
`__DSH_BOOT__` 的组合、`/plugins` bundle、recovery 注入都在 **server 进程内**完成
（`client/modules/src/index.ts:500-507,572`）；这些不是"构建时静态产物"。扩展侧即便带上
`@deepseek-ai/dsh-web-frontend/dist/*`，缺 host 就无法解析（`manifest.ts:167-169` "missing or not
an object" 直接 throw）。"client 复用"若要绕开注入（把 ui-* 当组件库编译进 webview），还需再实现
boot/HMR/SSE?/插件工具卡等边界——工作量等同再造半台 server，且每版 dsh 都要跟。

---

## 4. 推荐方案与理由

### 决策 D1（认证路线，供 #21）——"宿主持凭据 + 上游 embed seam"，不做浏览器 cookie 直连

1. **不采用**"iframe 自己拿 token/cookie 自动登录"：被 `SameSite=Strict` + webview 跨站 + 本地
   http 无 Secure 三重事实否决（F1/F4）。
2. **#21 的目标改为**：与上游（deepseek-harness 官方）提出/验证一个最小 **embed seam**，候选
   接口（按偏好排序）：
   - (a) **embed 会话 cookie 模式**：dsh 配置或专用入口（如 `/?embed=…`）按**受信 embed 源白名单**
     （如 `Origin: vscode-webview://<ext-id>`、`Referer`）颁发可用的会话（远程 https 部署
     `SameSite=None; Secure`；本地 loopback http 需要同源/无 SameSite 特例或 HTTPS），并在 index
     响应加 `frame-ancestors <白名单>`（现状无此头，加了更安全）；
   - (b) **一次性会话注入**：server 提供一个只对 embed 源开放的入口，把"会话身份"注入 iframe
     页面（如短时 `?sess=…` 由页面 JS 换 header 凭据）——改动面在
     `browser-auth.ts`（cookie 策略/`authorizeIndex`）与 `api-request-trust.ts`（Origin 白名单）附近；
   - (c) 若上游短期不做：伞仓**不强改官方包**（harness 只读子模块），在扩展内做"引导用户用系统
     浏览器/桌面完成登录"的降级（现状 `dsh.openInBrowser` 已带 token 自动登录，
     `extension.ts:624-640`）。
3. 扩展侧不变的能力基线继续沿用：Node 侧 token→cookie 交换、401 重读共享文件重试、
   launch-token 跟随（现状全部已有，`client/auth.ts`、`extension.ts:186-220`）。

### 决策 D2（侧栏承载，供 #22）——薄壳 WebviewView + iframe（seam 就绪后）；壳先行

- **壳**（不依赖 seam 即可开发）：`dsh.sessions` WebviewView 里渲染一个"容器页"：命令工具栏
  （新建/刷新/断开/设置/浏览器打开，复用现状命令）+ 主区 iframe/降级区。
- **主区**：
  - seam 就绪：iframe 指向 dsh web（本地 `resolveLaunchToken`/`localServer` 得 `base`；远程取
    `dsh.serverUrl`），容器页 CSP 加 `frame-src`；启动/重连引导用现有连接生命周期事件；
  - seam 未就绪：主区显示"在浏览器/桌面打开"引导（复用 `openInBrowser` token URL），**不降级到
    自绘复制**。
- 现状自绘侧栏（首页/会话/服务/设置/插件/模式卡片）在 iframe 形态上线后**退役**，避免双实现。

### 决策 D3（聊天内嵌"聊天中聊天"，供 #23）——与侧栏同一承载形态

- 聊天栏 WebviewPanel（Beside 列）同样采用"壳 + iframe 指向具体会话"（seam 后）；"聊天中聊天"
  由 **dsh web 页面内的多会话/子会话能力**承载（一个 iframe 即一个完整 dsh 会话上下文），扩展
  不再维护第二套渲染；多条聊天栏 = 多个 iframe 指向不同会话 URL。
- 会话间跳转：iframe 内由 dsh web 客户端自己路由（客户端内导航，不走
  `/session/{id}` 深链 404，F4）。
- seam 前聊天栏维持现状 ChatPanel（已覆盖文本/推理/工具卡/审批/提问/图片/费用），新"内嵌 dsh"
  能力置灰并提示升级路径。

**推荐理由（汇总）**：A 形态把"UI 与 server wire 的同步"从"扩展发版"转给"server 渲染"，终结两套
UI 漂移（这是 issue 的出发点）；B 在架构上不成立（F2 证据链）；C 是过渡不是终点。唯一"卡点"是
cookie 语义这一个上游事实（F1），其余（无 frame 头、/api 同源围栏、WS 心跳、附件通道）都支持
iframe 方案，故把"embed seam"作为 #21 依赖结论，是**一条上游改动换长期零维护的路径**；同时给出
seam 未就绪的明确降级，伞仓不空转。

---

## 5. 关键边界与风险

| # | 边界/风险 | 事实与对策 |
|---|---|---|
| R1 | iframe 跨站 + `SameSite=Strict`（**最大阻塞**） | 现状 cookie 不随跨站 iframe 请求（F1）；对策=D1 embed seam；本地 http 无法 `None;Secure`，远程 https 可；任何"URL 拼 token"方案都不解决 /api 的 cookie 携带 |
| R2 | 第三方 cookie 分区（3PCD）/ Storage Access | 即使 seam 发 None+Secure，用户浏览器 3PCD 下跨站 iframe 的 cookie 仍可能被分区/拦截；对策：embed 端把 `vscode-webview://` 源**白名单化**并配合 `frame-ancestors`，或走 D1(b) 一次性注入（不依赖 cookie 存储） |
| R3 | `/api` 信任围栏 Origin=null / cross-site | iframe 文档 origin=dsh origin 时 /api 同源放行（F1）；沙箱 iframe（`Origin: null`）会被拒——壳页 iframe **不要** `sandbox` 属性 |
| R4 | 客户端注入缺失（`__DSH_BOOT__`/`/plugins`/recovery） | 只对"直接 server 渲染的 index"成立 → iframe 必须指向 server origin，扩展本地 serve 无效（F2） |
| R5 | deep 会话 URL 语义漂移 | 当前 harness `/session/{id}` 直开 404（探测+F4）；iframe 一律从 `/` 起步客户端内导航；扩展 `openInBrowser`/`sessionWebUrl` 的直开假设需随 dsh 版本复核 |
| R6 | WS/心跳/断连（"QUIC 空闲断连"） | 生产无 SSE；WS mux + 2 s server Ping + 客户端退避重连已覆盖（F3）；iframe 不新增断连面；注意 VS Code webview 隐藏态 `retainContextWhenHidden` 已有（`extension.ts:120-122`），iframe 内 WS 在隐藏时由浏览器节流——验证断线重连表现 |
| R7 | 工具图片卡与附件 | dsh web 侧图片经 `GET /api/file`（`CSP: sandbox`）回读，iframe 同源即可；附件经 RPC base64 + 300 MiB 上限（F3）；扩展现状不经 /api/file——切换到 iframe 后**上传/粘贴图片走 dsh web 自身流程**，扩展的文件/音频粘贴特性（`chatPanel.ts:286-320`）需决定保留或弃用 |
| R8 | 多窗口并发一致性（侧栏+聊天+浏览器+桌面同账号） | server 会话模型已支持多客户端 follow 同一 session + 事件瀑布应答（`connection.ts:383-407`；gateway `$events`/waterfall）；风险在"同回合 steer 插话竞态"与审批瀑布重复应答——建议每会话单活跃窗口最佳实践；多窗口一致性**由 server 语义负责**，与承载方式正交 |
| R9 | token 轮换 / 重启 | 扩展宿主持有凭据；dsh 重启后 cookie 30 天内仍有效（密钥持久化），仅新登录需新 token（F1）；本地模式扩展已实现 401→重读→重试与进程退出清理（`localServer.ts`、`extension.ts:186-220`）；iframe 生命周期由扩展连接状态驱动，避免把 token 暴露进 URL/日志（现有 `redactTokenUrl`，`launchToken.ts:30-32`） |
| R10 | 本地 vs remote dsh | 本地 `127.0.0.1:3080`（扩展可拉起/复用）；remote 走 `dsh.serverUrl`+token/extraHeaders（CF Access 场景，`package.json` 配置描述）；embed seam 须同时覆盖 http loopback 与 https remote 两种 cookie 语义 |
| R11 | webview CSP | 壳页 CSP 需显式加 `frame-src <dsh origin(s)>` 与 `connect-src`（视壳是否需要宿主桥）；现状两个自绘页面 CSP 均不含（F 基线）；不要引入 `unsafe-eval` 之类放宽（页面本体在 server 侧，壳应最小化） |
| R12 | HMR/dev 语义差异 | dsh web 的插件 HMR 只在 `pnpm dev:web` 场景存在（F3）；产线 iframe 是 immutable combo + 整页刷新语义——扩展侧无 HMR 概念，无边界动作 |

---

## 6. 实现验收清单（seam 就绪后的目标验收；seam 前验收壳与降级）

- [ ] D1/seam 协议：在普通 Chrome 与 VS Code 两个 webview 里，iframe 加载 dsh 本地与远程 URL 均
      "一次认证、刷新不掉线、30 天内免登录"；401 时扩展宿主重引导（重读 launch-token/提示远程
      重新登录）。
- [ ] D2 壳：侧栏 WebviewView 工具栏命令与现状一致；连接状态（已连接/断开/本地服务运行）驱动
      iframe src 与占位；`retainContextWhenHidden` 下重连无白屏。
- [ ] iframe 会话流：流式文本/推理、工具调用与结果、审批瀑布、提问弹层、图片卡（/api/file）、
      附件上传在 iframe 内全部可用。
- [ ] "聊天中聊天"：Beside WebviewPanel 打开指定会话；同会话在侧栏/聊天栏/浏览器多开时消息与
      审批一致（server 语义验证）。
- [ ] 断连恢复：人为停本地 dsh → 扩展 401/WS 断 → 重启 dsh（token 轮换）→ 自动恢复（重读共享
      文件路径），iframe 无残留旧会话。
- [ ] CSP/安全回归：壳页 `frame-src` 白名单正确；iframe 无 `sandbox`；token 不出现在扩展日志/
      UI/iframe URL 持久字段；无 `X-Frame-Options` 冲突。
- [ ] 并发验证：VS Code 会话与浏览器/桌面同账号并发各 1 小时冒烟（多窗口一致性、心跳无断连）。
- [ ] 版本矩阵：dsh-vscode 0.8.x × dsh rc.7 快照（伞仓指针）与 dsh v0.1.5-alpha.1（工作副本）各
      验证连接与降级路径（协议层注释已知两版本有差异，见 §2 F5）。
- [ ] 退役自绘：iframe 形态稳定后移除侧栏自绘快照渲染与（若适用）聊天自绘，确认命令/上下文键
      （`setContext dsh.connected` 等）不回归。

---

## 7. 留给后续实现 issue（#21/#22/#23）的依赖结论

- **#21（认证）**：认证**不走"iframe 拿 token/cookie 自动登录"**（被 `SameSite=Strict` +
  webview 跨站否决，证据 F1）。落地 = 向深挖 harness 上游提最小 **embed seam** 需求
  （受信 embed 源白名单下的会话 cookie 策略 / 一次性会话注入，见 D1(a/b)），改动落点
  `harness/packages/client/connection/src/browser-auth.ts`（`sessionCookie`/`authorizeIndex`）与
  `api-request-trust.ts`（Origin 白名单）+ index `frame-ancestors`。扩展侧沿用现状 Node 认证与
  401 重读机制，不改。
- **#22（侧栏承载）**：**侧栏 = 薄壳 WebviewView + iframe 直连 dsh web**（seam 就绪后启用）；
  壳与降级（浏览器/桌面打开引导）可先行实现；不采用"打包 client 本地 serve"（B 否决，F2）。
- **#23（聊天内嵌）**：聊天栏与"聊天中聊天"与 #22 **同一承载形态**（WebviewPanel 壳 + 指向
  会话的 iframe / dsh web 客户端内多会话）；seam 前保持现状自绘 ChatPanel，不新造渲染。
- **跨 issue 横切**：`/session/{id}` 深链直开语义需按目标 dsh 版本复核（当前 harness 404，F4）；
  附件/图片通道、WS 心跳、多窗口一致性由 server 语义承担（F3、R8），扩展只做壳级引导。

---

## 8. 证据索引（文件:行/符号）

### dsh-vscode（`vscode/` = `/home/kuai/dsh-project/dsh-ecosystem/dsh-vscode`）
- package.json：`engines.vscode ^1.90.0`、`main dist/extension.js`、runtime dep 仅 `ws`、
  `views dsh.sessions type webview`、配置项 `serverUrl/remote/token/localServerPath/launchTokenFollow/
  extraHeaders`、`vsce package --no-dependencies`。
- `src/extension.ts:120-123`（WebviewView 注册 + retainContextWhenHidden）、`:186-220`（401 重读
  token 重试）、`:265-271`（resolveLaunchToken）、`:624-640`（openInBrowser 带 token）、
  `:817-893`（checkUpdate/upgradeTo/下载页兜底）。
- `src/launchToken.ts:26-53`（文件/记录 schema/managedBy）、`:59-61`（路径）、`:80-152`
  （读/写 0600/归属清理/复读确认）、`:30-32`（redactTokenUrl）。
- `src/localServer.ts:71-72`（3080）、`:156-158`（spawn dsh web）、`:285-291`（session/list 探测；
  401=DSH）、`:339-346,169-181,348-369`（写/清 launch-token、进程退出清理）。
- `src/client/auth.ts:47-135`（Node 侧 token→cookie 交换，303/302 且含 `dsh-auth-`）。
- `src/client/connection.ts:107-150,165-178,366-407`（认证+探测+mux 逻辑流/followSession）；
  `src/client/mux.ts:160-164`（`/api/remote.mux` + 握手头）、`:73,224-229`（重连）。
- `src/client/rpc.ts:86-89,117`（cookie+extraHeaders 合并到 /api）。
- `src/config.ts:84-105,155-158`（默认 serverUrl、sessionWebUrl=/session/{id}）。
- `src/sidebarView.ts:440-487`；`src/sidebarViewHtml.ts:16`（CSP 无 frame-src/connect-src）。
- `src/chat/chatPanel.ts:70-79,477-493`（WebviewPanel + media/webview.html）；
  `media/webview.html:6,384,1201`（CSP；纯 postMessage 桥，无 fetch/WS/iframe）。
- `src/chat/types.ts:73-81`（PromptImage base64；"DSH 提升为持久附件"）。
- `src/updater.ts:12-46,69-80`（Open VSX 元数据/直链/下载）。

### deepseek-harness（`harness/` = `/home/kuai/deepseek-harness`，dsh-v0.1.5-alpha.1-2-g767b1e7673）
- `packages/client/connection/src/browser-auth.ts:12-18,52-58`（密钥/launch token 生成）、
  `:69-78,106-123`（authority→cookie 名；`HttpOnly; SameSite=Strict`）、`:129-159`（签名/校验）、
  `:161-178`（secret 持久化）、`:185-216`（maxAgeDays）、`:223-230`（authenticatedUrl）、
  `:240-313`（authorizeIndex/isAuthenticated/401）。
- `packages/client/connection/src/index.ts:84-95`（cookieMaxAgeDays 默认 30）、`:104-139`
  （/api 前缀路由 + requestRejection + `__DSH_CONNECTION_RECOVERY__` 注入）。
- `packages/client/connection/src/api-request-trust.ts:91-118`（Host/`sec-fetch-site`/Origin 围栏）。
- `packages/api/gateway/src/index.ts:116,171-174`（WS 心跳默认 2 000 ms）、`:205-229`
  （`/api/remote.mux` 升级 + requestRejection）；`stream-protocol.ts:6,9,12`（mux/$events/
  $events/result）；`stream-server.ts:28-51,75-93`（Ping + missed 清理）。
- `packages/host/webserver/src/injections.ts:49-57,86-118`（global/script 注入渲染、转义、
  `__DSH_BOOT_READY__`）。
- `packages/host/frontend-static/src/index.ts:71-141`（dist serve：index 才 auth+注入，缺失文件
  404，非 index 资产公开，`<base href="/">`）。
- `packages/client/modules/src/client/manifest.ts:80-92,167-256`（__DSH_BOOT__ 结构/解析，缺图即
  throw）；`packages/client/modules/src/index.ts:500-507,572,1019`（注入行、`/plugins` 路由、
  immutable cache）。
- `packages/bundle/web-app/src/index.ts:232,252-272`（distIndex 挂载、打印 `dsh web: …/?token=`）；
  `apps/web/vite.config.ts`（STANDALONE_ERROR、base './'、preview 仅实验 worker 面）。
- `packages/api/session-controller/src/media-references.ts:15-20,66-76`（/api/file + sandbox CSP）；
  `packages/util/workspace-path/src/file-address.ts:14`（dsh-resource 文件地址）。
- `packages/client/hmr/src/client/index.ts:166`（唯一浏览器 EventSource：开发期 HMR）；
  `packages/client/connection/src/recovery-config.ts:8-21`（浏览器重连时序）。
- 旧子模块快照：伞仓 `git submodule status deepseek-harness` = `47f943859b`（dsh-v0.1.0-rc.7~24）——
  本文件事实以本地工作副本为准。

---

## 附录 A：本地 dsh web 只读探测记录（2026-09-10，127.0.0.1:3080）

```
GET /                → 401 text/plain; charset=utf-8   （本地也默认开浏览器会话认证）
GET /index.html      → 401 text/plain; charset=utf-8   （index 路径同样 gated）
GET /favicon.svg     → 200 image/svg+xml               （非 index 静态资产公开）
GET /session/zzz-nope→ 404                             （当前 harness 无 SPA 深链回退）
HEAD /              → 401，无 X-Frame-Options / CSP 头
```
对应实现：`frontend-static/src/index.ts`（index 才 auth、缺文件 404）、`browser-auth.ts`
（root + token 才放行）。

---

*本文件为决策草稿，未合入主线；事实部分基于指定版本源码与上述探测，若目标 dsh 版本变动请以
新版本源码复核 F1/F4/F5。*

---

## §9 前置依赖实现提案：dsh server「embed 认证 seam」（#21 先决）

> 结论先行：不新增 server seam 前，#21 只能给出「引导在浏览器打开」的降级形态，
> #22/#23 的会话内嵌无法成立。seam 属于 **dsh server（deepseek-harness）** 侧改动，
> 建议按最小面落地并做版本门控，避免影响现有浏览器/桌面/远程客户端。

### 9.1 目标形态

- VS Code WebviewView / 聊天内嵌 iframe 的顶层文档 = `vscode-webview://…`（跨站、无 3rd-party cookie 可用）。
- 因此 seam 的目标不是「复用浏览器 cookie」，而是给 **webview 携带的宿主身份**（launch-token /
  vscode 已持有的 session token）一次性的 **302 → Set-Cookie(同站可带) 或 URL 授权**：
  1. 扩展用既有的 launch-token（`launch-token.json`，扩展与 launcher 共享）请求 seam 端点；
  2. seam 校验后把请求 302 到 `/<session|ui>/…` 并种下 **受限 cookie（`SameSite=None; Secure?` 或 Path 限定 + HttpOnly）**，或直接下发一次性 embed URL（内嵌 token query，短 TTL、一次性）；
  3. iframe 内 dsh web 用该 cookie/URL 正常 boot（`__DSH_BOOT__` 与 `/plugins` 均为同源资源，不受影响）。

### 9.2 候选 seam 面（按改动最小排序）

| 方案 | 形态 | 优点 | 缺点 |
|---|---|---|---|
| S1 query-token 直开 | 扩展把 `?token=<one-time>` 拼到 `/{sessionId}` 深链，server 校验后 302 登录 | 改动集中在认证入口；深链天然可用 | 一次性 token 需 server 签发/回收；URL 可能落日志 |
| S2 同源代理 cookie 注入 | server 新增 `/api/embed/login`：POST launch-token → 302 + Set-Cookie(HttpOnly, SameSite=None, Secure=由部署决定) | 与浏览器登录一致、后续子资源自动带 cookie | 需处理 None+Secure 在 http(127.0.0.1) 下不可用 → 本地回退 SameSite=Lax + top-level 语义问题；严格讲仍需 iframe 内 first-party 导航才带 |
| **S3 推荐：内嵌页同源 gateway** | 扩展 WebviewView 首页由扩展本地 serve（`webview.asWebviewUri` 同源资源），页面内 `fetch`（非 iframe）直连 dsh REST（同现有 RPC），只在「需要完整 dsh web UI」时 iframe seam URL | 复用现有 RPC 通道实现 90% 侧栏功能；iframe 仅作「整页 UI」增强，可版本门控降级 | 不是「iframe 全量复用」字面形态，需在 #21/#22/#23 内定义「哪些能力走 RPC、哪些走 iframe」 |

### 9.3 建议排期（待用户/维护者拍板后执行）

1. 先在本地 harness（`/home/kuai/deepseek-harness`，v0.1.5-alpha.1 基线）实现 S1（one-time embed token + 深链 302），冒烟；
2. 同步伞仓 `deepseek-harness` 子模块指针（当前 rc.7，记忆待办）后随下一 dsh 版本发布；
3. 扩展侧实现 feature-detect：探测 seam 存在（`GET /api/embed/capability`）→ 有则 iframe 全量复用，无则 RPC 会话视图 + 浏览器打开降级；
4. #22「聊天中聊天」基于 seam 后同一套 iframe 宿主多实例（每条消息一张内嵌卡）。

> 注：本提案涉及 dsh server 版本发布与伞仓子模块指针（已列待办），超出 dsh-vscode 单仓闭环范围，
> 需先经团队确认（本地 dev 版本 vs 已发布版本线）。状态：**待评审**。
