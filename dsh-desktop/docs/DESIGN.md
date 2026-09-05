# dsh-desktop 设计文档（Paper）

> 状态：v1.0（2026-09，架构重构：从"桌面端自管 server"改为"纯壳 + 三端同步"）
> 适用仓库：kuaizhongqiang/dsh-desktop（本仓库）
> 关联仓库：dsh-launcher（服务持有者）、dsh-vscode（VSCode 端）、dsh-plugins（插件合集）、
> deepseek-harness（上游，只读子模块）

---

## 1. 项目概述

### 1.1 背景与目标

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（**dsh**）自带 Web UI
（`dsh --profile web` 一条命令即可启动，默认监听 `http://127.0.0.1:3080`）。

v0.1.x 的 dsh-desktop 由桌面端**自己拉起并管理 dsh server 子进程**（双版本 Full/Slim、捆绑
Node/dsh、健康探测、端口回退）。v1.0 重构目标：

1. **桌面端变成纯壳**：不携带、不 spawn dsh server，只把 dsh Web UI 套进 Electron 窗口；
2. **三端同步**：desktop / vscode / web（浏览器）连接**同一份** dsh server 与数据
   （`DSH_HOME`），谁先启动谁持有 server 进程；
3. **服务生命周期交给 dsh-launcher**：安装 dsh、拉起 server、写共享 token 都由启动器负责，
   桌面端只负责"探测 → 连接 → 委托启动/停止"；
4. **插件随 server 走**：插件装进共享 `%DSH_HOME%\profiles\web\plugins`，三端共享；
   本仓库以子模块携带 dsh-plugins 合集并提供一键安装脚本。

### 1.2 术语

| 术语 | 说明 |
|---|---|
| **dsh server** | `dsh web` 启动的服务进程，承载 API 网关并托管 Web UI |
| **共享 server** | 本机唯一一份 dsh server，三端共用（默认端口 3080） |
| **launch-token** | dsh v0.1.2+ 每次启动生成的随机进程 token（只打印到日志） |
| **launch-token.json** | `$DSH_HOME/launch-token.json`，v1 共享文件：持有者写入 token，其他端读取 |
| **dsh-launcher** | 本机 dsh 安装 + 启动引导器；`start --no-browser` 常驻并持有 server |
| **桌面端** | 本仓库交付物：Electron 纯壳 |

### 1.3 非目标（v1）

- 不修改、不 fork dsh 上游；
- 桌面端不承担 dsh 安装/升级（交给 dsh-launcher）；
- 不做 macOS/Linux 支持（Windows 优先，架构上预留）；
- 不做远程/多设备访问（`--host` 固定回环；远程走 dsh-remote 部署，不属本仓库）。

---

## 2. 总体架构

### 2.1 三端同步模型

```
                ┌────────────────────────────────────┐
                │        共享 dsh server（一份）       │
                │  dsh web --port 3080               │
                │  DSH_HOME（settings/credentials/    │
                │           profiles/web/plugins/…）  │
                │  $DSH_HOME/launch-token.json        │
                └───────────────┬────────────────────┘
         谁先启动谁持有（探测端口）│
   ┌──────────────┬──────────────┼───────────────┐
   ▼              ▼              ▼               ▼
dsh-launcher   dsh web        dsh-vscode     dsh-desktop
（安装+拉起      （终端/浏览器） （扩展：连接/   （纯壳：
  并持有 server）                可拉起/复用）    只连接+委托）
```

**同步机制（三端共用两条约定）**：

1. **端口探测**：启动/连接前先探测 `127.0.0.1:3080`（可配置）。已运行 → 复用；空闲 →
   由"有能力的一端"拉起；被非 dsh 进程占用 → 明确报错，不盲目拉起。
2. **共享 launch token**：dsh v0.1.2+ 每次启动打印 `?token=…`；**持有者**（拉起 dsh 的一端）
   把 `{version:1, token, port?, url, pid?, writtenAt, source}` 写入
   `$DSH_HOME/launch-token.json`；**其他端**读取后用 `GET /?token=…`（303）换取 30 天会话
   cookie，认证所有 `/api` 与 `remote.mux` 请求。持有者退出时按 pid 匹配清理文件。

### 2.2 桌面端内部流程

```
启动（单实例）
  → 读设置（port / dataDir=DSH_HOME / launcherPath / autoLaunch / closeToTray）
  → preflight(port)：
      监听中 + GET / 返回 401/2xx/3xx（dsh）→ resolveTokenUrl（读 launch-token.json，
          校验 ?token= 有效）→ 窗口加载 {url} → 启动健康监控（10s 轮询，3 次失败回连接页）
      监听中但非 dsh → 连接页：明确报错（端口被占用）
      未监听 → 连接页：展示「启动服务（dsh-launcher）」/「重连」/「打开 dsh-launcher」
  → 用户点「启动服务」→ spawn dsh-launcher.exe start --no-browser（detached，常驻持有）
      → 轮询端口就绪（≤60s）→ 回到 preflight 成功分支
```

**桌面端永不 spawn dsh**。`dsh-launcher.exe start --no-browser` 进程常驻并把 dsh 作为其绑定
子进程（隐藏控制台，工具执行不弹窗）；关闭桌面端不影响该服务，三端继续可用。

### 2.3 认证时序（token 文件读写方）

| 场景 | 写入方 | 读取方 |
|---|---|---|
| dsh-launcher 拉起 dsh | dsh-launcher（source=dsh-launcher, pid=子进程） | dsh-vscode / dsh-desktop / 浏览器 |
| dsh-vscode 拉起 dsh | dsh-vscode（source=dsh-vscode, pid=子进程） | dsh-launcher / dsh-desktop |
| 终端 `dsh web` | 无人写入（浏览器手动带 token） | — |

桌面端是纯**读取方**：读 `launch-token.json` 构建 `/?token=…` URL，并校验其有效性
（303/200=有效，401=陈旧则回退普通 URL）。

---

## 3. 模块划分（desktop/）

```
src/main/
├── index.ts       入口：单实例 → 托盘/更新 → boot()（connect）
├── connect.ts     共享 server 探测（preflight）+ token URL 解析 + 健康监控（ServerMonitor）
├── launcher.ts    查找 dsh-launcher.exe（设置/PATH/常见位置）+ 委托 start/stop（detached）
├── controller.ts  ShellController：编排 connect+launcher+windows，维护 ConnectState
├── settings.ts    持久设置（port/dataDir/launcherPath/autoLaunch/closeToTray）
├── ipc.ts         最小 IPC 面（get-state / server:start|stop|connect / 设置 / 日志 / 更新）
├── tray.ts        托盘（状态 tooltip、启动/停止服务、日志/设置/更新/退出）
├── windows.ts     主窗口（连接页 ⇄ dsh URL）+ 日志/设置窗口（app:// 协议）
├── updater.ts     electron-updater（单版本 latest channel）
└── log-store.ts   环形缓冲日志
src/renderer/      ui.html + app.ts（connect / log / settings 三个视图）+ style.css
preload/           contextBridge（dshApi：最小调用面）
scripts/           build.mjs / smoke.mjs / install-plugins.mjs / publish-npm.mjs
dsh-plugins/       子模块（插件合集，安装源）
deepseek-harness/  子模块（上游参考，只读）
```

### 3.1 ConnectState

```ts
{ status: 'checking'|'connected'|'no-server'|'busy'|'starting',
  port, baseUrl, url: string|null, detail?, serverOwner? }
```
`serverOwner` 来自 launch-token.json 的 `source`（展示"谁持有服务"）。

### 3.2 设置项

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | 3080 | 共享 server 端口（须与持有端一致） |
| `dataDir` | '' | DSH_HOME 覆盖（'' = ~/.dsh；launch-token.json 所在处） |
| `launcherPath` | '' | dsh-launcher.exe 覆盖（'' = PATH / 常见位置自动查找） |
| `autoLaunch` | false | 开机自启 |
| `closeToTray` | true | 关闭窗口最小化到托盘 |

---

## 4. 关键决策（D）

| 决策 | 理由 |
|---|---|
| **D1 桌面端不携带 server** | 用户诉求"纯 web 套壳"；避免多份 server/数据分叉；EADDRINUSE 类问题归零 |
| **D2 谁先启动谁持有** | 端口探测 + 共享 token 文件即足够；不引入注册表/锁服务 |
| **D3 委托 dsh-launcher 启动** | 启动器已实现安装/隐藏控制台/绑定生命周期/token 写入；桌面端零重复 |
| **D4 共享 launch-token.json（v1）** | 与 dsh-launcher（tokenFile.ts）、dsh-vscode（launchToken.ts）同一规范，无需改上游 |
| **D5 删除双版本** | 不再捆绑 Node/dsh，Full/Slim 失去意义；单 NSIS 版本 + latest 更新通道 |
| **D6 插件进 DSH_HOME** | 插件是 server 侧资源，装进共享 `profiles/web/plugins` 三端即共享 |
| **D7 健康监控只"看"不"管"** | 探测失败只回连接页，不自动拉起（server 归属他端，避免抢生命周期） |

---

## 5. 依赖与约束

- Electron ≥ 39 / Node ≥ 22.19（构建环境）；运行时不捆绑 Node（桌面端只发 HTTP）。
- 需要本机存在 dsh（dsh-launcher 安装或全局安装）与一个共享 server。
- `launch-token.json` 规范：dsh v0.1.2+ 才有 launch token；更低版本回退普通 URL（无认证）。

## 6. 测试与 CI

- `npm run typecheck` / `npm run build`：静态门禁。
- `npm run smoke`（scripts/smoke.mjs，无 GUI）：自动安装 `@deepseek-ai/dsh@<config.dshVersion>`
  到临时前缀 → 启动 → 断言 `GET /`=401（token 认证开启）→ 日志抓到 `?token=` →
  `GET /?token=`=303 → 带 cookie 的 `POST /api/session/list` 非 401。
- CI（ci.yml）：typecheck → build → smoke；Release（release.yml）：单版本 NSIS → GitHub Release
  （latest.yml 更新源）。
