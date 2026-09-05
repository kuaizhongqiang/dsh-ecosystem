# dsh-vscode

[![Open VSX 版本](https://img.shields.io/open-vsx/v/kuaizhongqiang/dsh-vscode?label=Open%20VSX)](https://open-vsx.org/extension/kuaizhongqiang/dsh-vscode)
[![Open VSX 下载](https://img.shields.io/open-vsx/dt/kuaizhongqiang/dsh-vscode)](https://open-vsx.org/extension/kuaizhongqiang/dsh-vscode)
[![GitHub Release](https://img.shields.io/github/v/release/kuaizhongqiang/dsh-vscode)](https://github.com/kuaizhongqiang/dsh-vscode/releases)

在 VSCode 中连接 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 实例的扩展：
会话列表、流式聊天、工具调用卡片、审批与提问处理，无需打开浏览器。

**安装**：[Open VSX 扩展页](https://open-vsx.org/extension/kuaizhongqiang/dsh-vscode) 或 [GitHub Releases](https://github.com/kuaizhongqiang/dsh-vscode/releases) 下载 VSIX。

## 功能

- **连接管理**：本地 / 远程双模式，状态栏实时显示连接状态；事件流断线自动重连。
  - **本地模式**（默认）：配置 `dsh.localServerPath` 后自动拉起 `dsh web` 并连接（若 3080 端口已有 DSH 实例在运行则直接复用，不重复拉起）；也可直接连默认 `http://127.0.0.1:3080`。
  - **远程模式**：开启 `dsh.remote` 并填入 DSH 启动 token（`dsh.token`），扩展自动换取会话 cookie 认证，改配置自动重连。
- **侧边栏入口式首页**（会话 / 拉起服务 / 进入配置 / 插件库 / 模式列表）：
  - 首页高亮当前工作区路径，显示连接状态与各入口概览，可进入子视图并返回；
  - **会话列表**：默认只显示当前工作区的会话（可切换查看全部），运行中 / 轮次 / 更新时间一目了然；**单击会话条目直接打开聊天面板**，支持新建、重命名、停止、在浏览器打开；
  - **拉起服务**：本地服务一键启动 / 停止，显示状态、端口、日志摘要与失败原因；
  - **进入配置**：设置页（连接模式开关、Cloudflare cookie、本地服务路径、服务地址、行为与数值项），改动即保存生效，断开连接时也可访问；
  - **插件库**：浏览已安装（`DSH_HOME` 下的 skills / tools / presets）与可用（dsh-plugins 合集仓库）插件，点击打开目录；
  - **模式列表**：浏览 agent preset，单击设为新建会话默认。
- **聊天面板**（Webview）：
  - 历史消息加载 + 实时流式输出（文本 / 思考过程分开展示，带打字光标）；用户 / 助手消息左右分栏带头像；**消息气泡之间无任何分隔线**（纯背景与间距区分）
  - **模型选择器**：面板头部直接切换会话使用的模型（provider/model）
  - **工具调用卡片**：参数、执行状态（等待 / 执行中 / 完成 / 出错）、耗时、结果分区展示；**默认折叠**，点击头部展开/收起；**工具类型用内联 SVG 矢量图标**（read=文档、edit=铅笔、grep/web_search=放大镜、bash/pwsh=终端、web=地球…），状态用彩色圆点表达（完成绿 / 出错红 / 运行黄）；纯工具回合不渲染空的助手气泡
  - **审批卡片**：工具请求执行时直接在面板「允许一次 / 拒绝」
  - **提问表单**：Agent 提问时以选项 / 多选 / 自由文本作答，提交应答校验服务端回执，失败时明确提示（不再静默卡住）
  - **会话概览**：消息区上方实时展示 📋 任务清单（todo/write）与 🎯 目标面板（goal/change：目标文案 / 阶段 / 轮次进度 / 受阻原因），可折叠
  - **斜杠命令**：输入 `/` 弹出命令候选（停止当前回合 / 清空显示 / 浏览器打开 / 帮助）
  - **`@` 文件提及**：输入 `@` 列出会话目录下的文件 / 文件夹，选中后以 `@路径` 引用
  - **文件拖入 / 粘贴**：把文件拖进输入区生成附件 chip，发送时以 `@文件名` 引用；**粘贴 / 拖入图片**（png/jpeg/webp/gif）直接作为附件发送（模型需支持图片输入）；**粘贴音频**保存到会话目录 `.dsh-paste/` 并以 `@路径` 引用
  - 停止当前回合（输入区与发送并排）、一键在浏览器打开同一会话、底部用量统计条（轮次 / 步数 / tokens / 上下文占用 / **累计费用 ¥**，价格按 DeepSeek 官方峰谷价与小米 MiMo 官方价内置，可在 `dsh.pricing` 设置覆盖）
- **新建会话引导**：有多个 agent preset / 工作区时弹出选择，新会话可用不同 preset 与目录
- **工作区自动关联**：打开文件夹时自动在 DSH 创建 / 关联同名工作区（路径规范化比较，Windows 大小写 / junction 不重复创建，多根工作区全部关联），新会话默认在该目录工作。
- 会话标题 / 运行状态通过 mux 投影实时同步；官方 DSH 鲸鱼 logo 用于活动栏与市场图标。

## 要求

- VSCode ≥ 1.90（Node ≥ 20）
- 一个可访问的 DSH 实例（`dsh web` 已启动）。默认连接 `http://127.0.0.1:3080`。
- 远程访问时，DSH 需用 `--trusted-host <你的域名>` 启动（`/api` 信任围栏），否则 /api 会返回 403。
- **新版 DSH 无论本地还是远程都默认开启浏览器会话认证**：`/api` 不带会话 cookie 一律返回 401。
  扩展需要 launch token 换取会话 cookie（见下文「认证」）。

### 认证（DSH token，本地与远程通用）

新版 DSH 每次启动 `dsh web` 都会打印一个进程启动 token（`?token=…`）。浏览器用它换取浏览器的会话 cookie；
扩展作为机器客户端，用**同一个 token** 换取可复用的会话 cookie，认证所有 `/api` 请求与 `remote.mux` 事件流。

- **本地模式（推荐）：无需手动填 token。** 扩展拉起 `dsh web` 后会自动把 token 写入共享文件
  `$DSH_HOME/launch-token.json`（默认 `~/.dsh/launch-token.json`）；连接时自动读该文件换取会话 cookie。
  该文件与 **dsh-launcher** 共用：launcher 拉起 dsh 时也会写入，扩展直接读取；
  反过来扩展拉起的实例 launcher 也能读到（见 `DSH-LAUNCH-TOKEN-FILE.md` 规范）。服务重启后 token 自动轮换、自动更新，无需人工干预。
- **远程模式：需手动填 `dsh.token`**（远程服务器的 token 无法自动落到本机共享文件）。
- 显式配置的 `dsh.token` 优先级高于共享文件（远程 / 手动场景覆盖）。

**手动配置方式（远程，或共享文件不可用时的兜底）**
1. 启动 DSH，记下打印的 token（形如 `dsh web → http://127.0.0.1:3080/?token=<TOKEN>`）。
2. 设置页（侧边栏「进入配置」）或设置 JSON：
   - 远程模式：开启 `dsh.remote`、填入 `dsh.serverUrl` 为远程地址；
   - 本地模式：`dsh.serverUrl` 保持 `http://127.0.0.1:3080`（或由 `dsh.localServerPath` 自动拉起）；
   - 两种模式都填入 `dsh.token` 为上面记下的 token。
3. 扩展连接时自动 `GET {base}/?token=…` 换取 `dsh-auth-*` 会话 cookie，并携带到所有 `/api` 与事件流请求；改配置后自动重连。

> 注意：**DSH 服务重启后会生成新的 token**，旧 token 立即失效（401）。本地模式由共享
> token 文件自动处理；手动填写的 `dsh.token` 需要在服务重启后更新。

### 本地服务路径（dsh.localServerPath）

`dsh.localServerPath` 是**本地模式下 dsh 的安装 / 启动目录**，即运行 `dsh web` 时所在的目录，
**应包含 dsh 启动器**（`dsh.cmd` / `dsh` / `dsh.exe` / `dsh-launcher.exe` / `launcher.json`）。

- 样例：
  - Windows：`D:\dsh`（`dsh.cmd` / `dsh.exe` / `dsh-launcher.exe` 所在目录，即 dsh 安装根目录）
  - macOS / Linux：`~/dsh`（`dsh` 可执行文件所在目录）
- 配置时会校验：路径存在、是目录、含 dsh 启动器；不满足时给出明确错误提示，不会写入。
- 配置后 VSCode 启动（或点击连接 / 侧边栏「拉起服务 → 启动服务」）会自动 `spawn dsh web`（cwd=该目录）、
  轮询就绪后连接；扩展退出时自动终止服务进程（Windows 下杀进程树），不残留孤儿进程。
- 端口占用处理：`dsh web` 固定监听 3080。若 3080 上**已有 DSH 实例**在运行（例如已有一个 `dsh web`），
  「拉起服务」会**直接复用**该实例（幂等，不重复拉起、不报端口冲突）；若 3080 被**非 DSH 进程**占用，
  会明确报错提示先释放端口，不会盲目拉起导致 EADDRINUSE 崩溃。

## 安装

### 从源码构建（开发）

```bash
git clone https://github.com/kuaizhongqiang/dsh-vscode.git
cd dsh-vscode
pnpm install        # 或 npm install
pnpm build          # 产出 dist/extension.js
```

按 `F5` 打开扩展开发宿主（需要 `.vscode/launch.json`，已随仓库提供）。

### 打包 .vsix

```bash
pnpm exec vsce package --no-dependencies
code --install-extension dsh-vscode-0.2.0.vsix
```

## 配置

| 设置 | 默认 | 说明 |
|---|---|---|
| `dsh.serverUrl` | `http://127.0.0.1:3080` | DSH 服务地址（本地模式可留空用默认，远程模式必填远程地址） |
| `dsh.remote` | `false` | 连接模式开关：`true` = 远程模式（配 token 认证），`false` = 本地模式（可拉起本地 `dsh web`） |
| `dsh.token` | `""` | DSH 进程启动 token（`dsh web` 打印的 `?token=…` 值）。**本地模式可留空**：扩展自动读共享文件 `$DSH_HOME/launch-token.json`（与 dsh-launcher 共用）；远程模式必填。显式配置优先于共享文件 |
| `dsh.localServerPath` | `""` | 本地模式下 dsh 安装 / 启动目录（应包含 `dsh.cmd` / `dsh` 启动器）。样例：Windows `D:\dsh`，macOS/Linux `~/dsh` |
| `dsh.autoConnect` | `true` | 启动后自动连接（本地模式下若已配置 `localServerPath` 会自动拉起服务） |
| `dsh.autoAttachWorkspace` | `true` | 自动创建 / 关联当前文件夹为 DSH 工作区 |
| `dsh.defaultAgentPreset` | `standard` | 新建会话的 agent preset（不存在时回退到服务端默认） |
| `dsh.historyPageSize` | `40` | 打开会话时加载的 message 数量 |
| `dsh.reconnectIntervalMs` | `3000` | 事件流重连间隔 |
| `dsh.autoOpenChat` | `true` | 新建会话后自动打开聊天面板 |
| `dsh.showReasoning` | `true` | 是否显示模型的思考过程（reasoning）折叠块 |
| `dsh.maxToolResultChars` | `4000` | 工具调用结果在面板中的最大展示字符数 |
| `dsh.promptMode` | `steer` | 发送消息模式：`steer` = 插话（立即处理，与 DSH Web 一致），`queue` = 排队（等当前回合结束） |
| `dsh.pricing` | 内置官方价 | 用量栏费用估算的价格表：按模型 id 的每百万 tokens 单价（¥），默认内置 DeepSeek 官方峰谷价与小米 MiMo 价，官方调价后可覆盖 |
| `dsh.extraHeaders` | `{}` | 附加到每个 `/api` 请求与 `remote.mux` 事件流 WebSocket 握手头的自定义请求头 |

## 命令

| 命令 | 说明 | 快捷键 |
|---|---|---|
| `DSH: 连接` / `DSH: 断开连接` | 连接 / 断开 DSH 实例 | |
| `DSH: 打开聊天` | 打开选中会话的聊天面板（未选中则快速选择） | `Ctrl+Alt+D` |
| `DSH: 新建会话` | 在当前工作区新建会话并打开聊天 | |
| `DSH: 刷新会话列表` | 重新拉取 session.list + workspace.list | |
| `DSH: 在浏览器打开` | 在浏览器打开选中会话（DSH Web GUI） | |
| `DSH: 停止当前回合` | 取消选中会话正在进行的回合 | |
| `DSH: 重命名会话` | 重命名选中会话 | |
| `DSH: 打开设置` | 侧边栏切换到设置页（标题栏第 4 个按钮） | |
| `DSH: 返回首页` | 侧边栏返回入口式首页 | |
| `DSH: 切换侧边栏视图` | 内部导航命令（会话 / 服务 / 设置 / 插件 / 模式） | |
| `DSH: 打开设置页` | 「拉起服务」页内跳转到设置页 | |
| `DSH: 切换会话范围` | 会话列表「只看当前工作区 ⇄ 查看全部」 | |
| `DSH: 编辑设置项` | 设置页点击某项后编辑（开关翻转 / 输入框 / 目录选择） | |
| `DSH: 设为默认 preset` | 模式列表中单击 preset 设为新建会话默认 | |
| `DSH: 打开设置 JSON` | 打开 VSCode 设置 UI 并定位到 dsh 项 | |
| `DSH: 打开 DSH_HOME 目录` | 在资源管理器中显示 DSH 数据目录 | |
| `DSH: 打开插件路径` | 插件库中点击插件打开其目录 / 文件 | |
| `DSH: 启动本地服务` | 拉起本地 `dsh web`（需已配置 `dsh.localServerPath`） | |
| `DSH: 停止本地服务` | 停止本地 `dsh web` 服务进程 | |

## 架构

```
src/
├── extension.ts         激活入口：连接生命周期、命令、工作区自动关联、设置与本地服务编排
├── config.ts            设置读写（含 remote / token / localServerPath 与自定义请求头）
├── statusBar.ts         状态栏
├── sidebar.ts           侧边栏入口式首页 + 会话 / 服务 / 设置 / 插件 / 模式多视图导航
├── sessionStore.ts      会话/工作区缓存（session.list + host 帧增量）
├── localServer.ts       本地 dsh web 服务生命周期（spawn / 就绪轮询 / 终止，路径校验；拉起后写共享 token 文件）
├── launchToken.ts       `$DSH_HOME/launch-token.json` 共享启动 token 读写（与 dsh-launcher 共用规范）
├── dshHome.ts           DSH_HOME 解析（插件目录与共享 token 文件的统一来源）
├── plugins.ts           插件库数据源（DSH_HOME 已安装 + dsh-plugins 合集仓库可用）
├── client/
│   ├── types.ts         DSH 线上协议类型（对齐 Typert Remote / API Gateway）
│   ├── auth.ts          token → 会话 cookie 换取（dsh-auth-*）
│   ├── rpc.ts           /api/{ns}/{method} 单发 RPC 客户端（client-request / server-response 信封）
│   ├── mux.ts           /api/remote.mux 逻辑流 WebSocket 客户端（open/item/end/error，自动重连）
│   └── connection.ts    高层封装：session/workspace 操作、$events 审批/提问应答、事件分发
└── chat/
    ├── types.ts         渲染模型 + webview 双向消息协议（含 @ 文件候选）
    ├── chatModel.ts     会话消息模型（历史 + 流式，seq 去重）
    └── chatPanel.ts     Webview 面板控制器（含 @ 提及目录扫描）
media/webview.html       聊天 UI（零依赖，内联 CSS/JS：斜杠命令 / @ 提及 / 拖入 / 视觉主题）
```

### 协议要点（无需安装任何 DSH npm 包）

- 单发 RPC：`POST {base}/api/{namespace}/{method}`，body 为
  `{"type":"client-request","rpcId":"<uuid>","method":"session/list","payload":{"args":{…}}}`，
  响应 `{"type":"server-response","rpcId":"…","result":{"ok":true,"value":…}|{"ok":false,"error":…}}`。
  所有 Remote 载荷统一包在 `{ args }` 中。方法如 `session/list`、`session/create`、`session/prompt`
  （`requestId` 必填）、`session/page`、`session/follow`（流）、`session/control`（流）、
  `workspace/create`、`workspace/follow`（流）、`$events/result`。
- 逻辑流：WebSocket `{base}/api/remote.mux`，客户端发 `{type:'open', streamId, endpoint, payload:{args}}`
  / `{type:'cancel', streamId}`，服务端回 `{type:'item'|'end'|'error', streamId, …}`。
  `$events` 流投递转发的应用事件（`ready` / `emit` / `waterfall` / `cancel`）；
  `session/follow` / `session/control` / `workspace/follow` 分别投递会话日志 / 队列·任务·投影 / 工作区。
- 审批 / 提问：经 `$events` 流的 `waterfall` 帧到达（`approval/request`、`user-questions/request`），
  通过 `POST {base}/api/$events/result`（`{ clientId, eventId, outcome }`）应答。
- 认证：`GET {base}/?token=<launchToken>` → 303 `Set-Cookie: dsh-auth-<hash>=v1…`，
  扩展把该 cookie 作为 `Cookie` 头发送到所有 `/api` 请求与 `remote.mux` 握手。
- 会话事件（follow 流内）：`user/message`、`assistant/chunk`（text-delta / reasoning-delta /
  tool-call-delta…）、`assistant/message`、`tool/call`、`tool/result`、`turn/end` 等。

## 测试

```bash
# 协议冒烟测试（只读：list/page/modelCatalog + remote.mux 逻辑流）
node --experimental-strip-types scripts/smoke.mts http://127.0.0.1:3080 [token]

# 端到端（会新建会话并发一条极小 prompt，验证 创建→prompt→follow 流→history）
node --experimental-strip-types scripts/e2e.mts http://127.0.0.1:3080 [token]

# 综合联调（token 认证 + workspace + createSession + prompt + follow + 审批探测）
node --experimental-strip-types scripts/verify-live.mts http://127.0.0.1:3080 [token]

pnpm typecheck   # tsc --noEmit
pnpm build       # esbuild
pnpm test        # vitest 单元测试
node scripts/check-webview-js.mjs   # webview 内联 JS 语法校验
```

## 已知限制（v0.2.3）

- 历史分页「加载更多」尚未实现（仅加载最近一页；`session.history` 的 `maxMessages` 语义是「最近 N 条消息的全部事件」，事件极密的会话一次可能拉取数万条）。
- 费用按**当前会话模型**的官方价估算累计值（会话内混用多模型时不能精确分摊到各模型，可在 `dsh.pricing` 覆盖价格）。
- 图片消息暂不展示字节（文本 / 推理 / 工具已支持；粘贴 / 拖入图片会作为附件以 `image` block 发送给模型，历史回显仅显示 `[图片]` 占位）。
- 事件流为单向推送；无断点续传，重连后靠 seq 去重收敛。
- `@` 文件提及扫描的是会话 cwd 的一级目录（不递归）；拖入普通文件以 `@文件名` 文本引用（webview 拿不到完整路径）。
- 概览区的 `🛠 工具调用:X · 卡片:Y · 渲染错误:Z` 是排查用的诊断条（后续版本可隐藏）。

## CI 与发布

- `.github/workflows/ci.yml`：push/PR 时执行 typecheck、单元测试（vitest）、构建、webview JS 校验并打包 VSIX 产物。
- `.github/workflows/release.yml`：推送 `v*` tag 时自动构建并发布 GitHub Release（附 VSIX）。可选往
  [Open VSX](https://open-vsx.org) 发布：在仓库 Secrets 中配置 `OPEN_VSX_TOKEN` 后自动生效。

```bash
git tag v0.2.1 && git push origin v0.2.1   # 触发发布流水线
```

## License

MIT
