# 🐋 dsh-launcher

[![Release](https://img.shields.io/github/v/release/kuaizhongqiang/dsh-launcher?style=flat-square)](https://github.com/kuaizhongqiang/dsh-launcher/releases)
[![License](https://img.shields.io/github/license/kuaizhongqiang/dsh-launcher?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0a7dff?style=flat-square)]()

dsh 的 **Windows 单文件安装 + 启动引导器**。双击 `dsh-launcher.exe` 即弹出桌面窗口：查看环境状态、选择安装目录与版本、安装、一键启动。

> **安装源（v0.5.0 起默认 GitHub）**：默认从 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 克隆源码并本地构建（锁定最新 `dsh-v*` tag，可指定版本、可走代理），与官方发布/服务器完全同步；`--source npm` 保留原 registry 安装方式作后备。
>
> **TS/JS 技术栈，与 dsh web 同源**：界面直接消费 dsh 的 dsw 设计系统（同一套 `--dsw-*` 令牌），Electron 打包为单文件 exe，启动零依赖（内置 Chromium + Node）。

## 截图

![dsh-launcher GUI](assets/screenshot.png)

> 截图来自早期 Go 版；TS/JS 版界面视觉沿用 dsh web 主题（极光背景 / 毛玻璃卡片 / 脉冲状态点 / 按钮辉光）。

## 特性

- 🪟 **桌面窗口** — 双击 exe 弹出 frameless 窗口（自绘标题栏），**不依赖浏览器**
- 📦 **单文件零依赖** — Electron portable 单 exe（约 65MB），内置 Chromium + Node，启动无需任何外部运行时
- 📥 **两种构建** — 便携单文件（随处拷走）**与** NSIS 安装版（可固定到任务栏、带开始菜单快捷方式）
- 🎨 **dsh web 同款视觉** — dsw 设计系统：背景极光、毛玻璃卡片、脉冲状态点、按钮辉光、不定进度条
- ⚡ **一键启动** — 未安装 dsh 时自动引导（目录选择 → 版本选择 → 安装 → 启动），已安装则直接拉起服务并打开浏览器
- 🔑 **token 自动登录** — dsh v0.1.2+ 采用启动令牌认证：`start` 自动抓取 dsh 打印的带 token URL 并打开，浏览器自动换 cookie（30 天有效），无需手动复制 token；token 同时写入**共享文件** `$DSH_HOME/launch-token.json`（默认 `~/.dsh/`），dsh-vscode 插件直接读取，从哪边启动 dsh 另一边都能自动认证
- 🔗 **绑定运行** — dsh 作为启动器子进程运行（继承启动器的隐藏控制台）：执行工具不再弹 PowerShell/cmd 窗口；关闭启动器即停止 dsh
- 🛑 **停止 dsh** — 直接结束绑定的子进程（窗口「停止」按钮 / `stop` 命令；旧版遗留的独立进程按端口回退结束）
- 🔀 **挪动 dsh** — 把已安装的 dsh 包挪到任意路径（跨盘自动复制+删除）；dsh 运行中时拒绝移动
- 🔍 **环境状态** — Node.js / npm / dsh 版本、安装状态、端口健康度
- 🔔 **升级检测** — 启动时与点「检查更新」都会比对 dsh（GitHub 最新 tag，默认；npm 源查 registry）与启动器自身（GitHub Release 最新版）
- 📜 **实时日志** — 安装与启动输出实时显示在窗口内（SSE 推送）
- ⌨️ **命令行备用** — `install` / `move` / `start` / `stop` / `status` / `check-update` / `--version` / `--help` 照常可用
- 🧩 **插件生态** — 以 git 子模块携带 [dsh-plugins](dsh-plugins/) 插件合集（当前 v0.5.0）

## 环境要求

- **Windows 10 / 11**（x64）
- 目标机器需安装 **Node.js**：`^22.19 || >=24`（仅在运行 dsh 时需要；启动器本身自包含）
- GitHub 源码源需要 **git** 与 **pnpm**（缺 pnpm 时启动器自动 `npm i -g pnpm`；npm 源不需要）
- GitHub 网络受限时用 `--proxy`（git 走 socks5/http 代理）或环境变量 `DSH_LAUNCHER_PROXY` / `HTTPS_PROXY`
- 目标机器无需 Go、无需 npm 全局配置、无需环境变量

## 下载

从 [Releases 页面](https://github.com/kuaizhongqiang/dsh-launcher/releases) 获取最新构建。每次发布由 GitHub Actions 在 `windows-latest` 上自动构建并附带**两个**产物：

| 产物 | 适用场景 |
|---|---|
| `dsh-launcher.exe`（便携版） | 随处拷走即用，不写系统——**无法固定到任务栏**（Windows 限制：便携版把程序解压到临时目录、退出即删，固定出的快捷方式会失效） |
| `dsh-launcher-setup-<版本>.exe`（NSIS 安装版） | 安装到固定路径，带开始菜单快捷方式，**可固定到任务栏**——需要固定时用这个 |

## 使用

### 桌面窗口（双击，推荐）

1. 双击 `dsh-launcher.exe`（或命令行无参运行）→ 弹出桌面窗口。
2. 查看"环境状态"卡片（Node / npm / dsh / 端口）。
3. 点击**启动**：
   - 已安装 dsh → 启动服务（已在运行则直接打开浏览器），按钮变为"已运行"
   - 未安装 → 先点**浏览…**选择安装目录（或直接输入），再点**启动**即可自动安装并启动
4. 需要挪动 dsh 时，点**移动**并选择目标目录（dsh 运行中会拒绝）。
5. 点**停止**结束 dsh；点 **×** 关闭窗口时**会同时停止 dsh**（dsh 绑定启动器运行）。
6. 点**检查更新**可立即比对 dsh 与启动器的最新版本。

> 设 `DSH_LAUNCHER_NO_BROWSER=1` 可跳过自动打开浏览器。
>
> **固定到任务栏**：便携版在临时目录中运行、退出即删，固定出的任务栏图标会丢失目标（"快捷方式丢失"）。要固定请安装 NSIS 版（`dsh-launcher-setup-<版本>.exe`）后固定安装好的启动器。

### 命令行

```powershell
dsh-launcher.exe install [--dir <目录>] [--source github|npm] [--version <tag>] [--proxy <url>]
                            # 安装 dsh（默认 GitHub 源码构建 + 最新 tag；--version 指定 tag；
                            # --source npm 走 registry；--proxy 给 git 走代理）
                            # 默认安装目录 %LOCALAPPDATA%\dsh
dsh-launcher.exe move --dir <目录>        # 把已安装的 dsh 挪到新路径（运行中拒绝）
dsh-launcher.exe start [--no-browser]     # 启动 dsh 并保持本进程常驻（自动抓取 token URL 打开）
dsh-launcher.exe stop                     # 停止 dsh（结束绑定子进程，或按端口回退）
dsh-launcher.exe status                   # 显示安装目录 / 版本 / 运行状态
dsh-launcher.exe check-update             # 检查升级：dsh（GitHub tag / npm）与启动器（GitHub Release）
dsh-launcher.exe --version                # 显示版本
dsh-launcher.exe --help
```

> dsh **绑定启动器**（v0.4.0 起）：`start` 启动 dsh 后保持前台运行，启动器持有隐藏控制台，
> dsh 及其 pwsh 子进程继承它——执行工具不再弹 PowerShell/cmd 窗口；关闭启动器即停止 dsh。
>
> **token 自动登录**（v0.5.0 起）：dsh v0.1.2+ 的浏览器令牌认证要求通过带 `?token=` 的
> URL 访问。`start` 会从 dsh 输出中自动抓取该 URL 并打开，浏览器自动换 cookie（30 天）。
> 若 dsh 已由其它进程启动（`start` 检测到端口占用），仍会尝试从日志抓取当前 token URL。
> dsh 每次重启 token 都会变化，重新 `start` 即可。日志见 `%TEMP%\dsh-launcher-child.log`。
>
> **共享 token 文件**：本启动器拉起 dsh 时，会把 token 写入 `$DSH_HOME/launch-token.json`
> （默认 `~/.dsh/launch-token.json`），dsh-vscode 插件直接读取即可认证，无需手动抄 token；
> 反过来，dsh 已由 vscode 插件拉起时，`start` 会**优先读共享文件**打开带 token 的 URL。
> 启动器停止自己的 dsh 子进程时按 pid 匹配清理该文件，不会误删另一应用维护的记录。
> 规范见 `DSH-LAUNCH-TOKEN-FILE.md`。

日志写入 `%TEMP%\dsh-launcher.log`（窗口版无控制台，以此为准）。

## 配置（launcher.json）

首次 `install` 时生成在 **exe 同目录**（便携：exe 与配置一起拷走）：

```json
{
  "dshInstallDir": "C:\\Users\\<user>\\AppData\\Local\\dsh",
  "dshVersion": "dsh-v0.1.2-alpha.1",
  "port": 3080,
  "installedAt": "2026-08-30T08:00:00+08:00",
  "source": "github",
  "proxy": "socks5h://127.0.0.1:10808"
}
```

- `source`：`github`（源码构建，默认）/ `npm`（registry 安装）；`proxy`：GitHub 访问代理（可选）。
- 目录结构（github 源）：`<安装目录>/deepseek-harness/`（克隆的仓库，构建产物在
  `apps/cli/lib/bin.js`）。
- **绝不触碰** `~/.dsh`（`DSH_HOME`）— 现有 profile / 插件 / 会话保持原样。
- 新机器上运行 `install` 会覆盖配置中的安装路径。

## 插件生态（dsh-plugins）

dsh 本身支持插件：插件放在 `%DSH_HOME%\profiles\web\plugins\`，通过 profile 的
`cordis.patch.yml` 挂载。本仓库以 **git 子模块**方式携带社区插件合集（当前 **v0.5.0**）：

- 本地检出：[`dsh-plugins/`](dsh-plugins/)
- GitHub：[kuaizhongqiang/dsh-plugins](https://github.com/kuaizhongqiang/dsh-plugins)

合集里每个插件包都自包含（`install.ps1` + `plugins/`），并配套一个**安装技能**
（`skills/install-<name>/SKILL.md`），告诉 dsh 的 Agent 如何一步步安装。

更新子模块：

```powershell
git submodule update --remote dsh-plugins
git add dsh-plugins && git commit -m "chore: bump dsh-plugins submodule"
```

> dsh-launcher **绝不触碰** `~/.dsh`（`DSH_HOME`）：插件的安装与使用与启动器完全独立。

## 从源码构建

需要 Node.js 22+（开发机）。无 Go 依赖。

```powershell
npm ci                      # 安装开发依赖（esbuild / electron / electron-builder）
npm run check               # TypeScript 类型检查
npm run build               # esbuild 打包（dist/launcher.cjs + electron-main + preload）
npm run dist                # electron-builder 打包单文件：release\dsh-launcher.exe
npm run dist:installer      # electron-builder NSIS 安装版：release\dsh-launcher-setup-<版本>.exe（可固定任务栏）
npm run dist:all            # 同时产出上面两个
```

开发模式直接跑桌面窗口：

```powershell
npm run start:desktop       # npx electron .（本地窗口，走 dev 逻辑）
npm run start               # 纯 Node CLI（node dist/launcher.cjs）
```

> **体积敏感备选（Node SEA）**：`npm run dist:sea` 用 Node 单文件可执行（约 87MB，内嵌 Node 运行时，但界面需浏览器打开）——保留为备选路线，默认交付为 Electron portable。

## 技术架构

```
src/                          TS 逻辑（与语言无关，Node/Electron 通用）
├── config.ts                 launcher.json 读写（便携：跟随 exe）
├── node.ts                   node/npm/pnpm/git 探测、GitHub 源（tag 列表/浅克隆/代理）、registry 镜像策略
├── semver.ts                 语义化版本比较（GitHub tag 排序 / 升级检测共用）
├── install.ts                install / move 流程（github 源码构建 / npm 双源）
├── console.ts                隐藏控制台（koffi AllocConsole + SW_HIDE，供 dsh 子进程继承）
├── launch.ts                 start/stop（dsh 作为子进程绑定启动器、抓取 token URL）
├── tokenFile.ts              共享启动 token 文件（`$DSH_HOME/launch-token.json` 读写清理，与 dsh-vscode 同一规范）
├── update.ts                 升级检测（GitHub tag + npm registry + GitHub Release）
├── server.ts                 node:http 本地服务（UI 静态资源 + REST bridge + SSE 日志）
├── cli.ts                    命令行入口
├── electron-main.ts          Electron 主进程（窗口 + CLI 双模式）
└── electron-preload.ts       窗口控制桥（最小化）
ui/                           Web 界面（dsh web 同款 dsw 设计系统）
├── tokens.css                从 @deepseek-ai/dsh-client-ui-theme 提取的设计令牌（脚本可再生成）
├── launcher.css              界面样式（只消费令牌）
├── index.html / app.js       页面 + 逻辑（bridge 注入，模拟/真实自动切换）
scripts/
├── build.mjs                 esbuild 打包
├── build-sea.mjs             Node SEA 备选构建
└── extract-dsw-tokens.mjs    重新提取 dsw 设计令牌
```

## 设计要点

| 决策 | 理由 |
|---|---|
| TS/JS 与 dsh 同栈 | 界面直接消费 dsw 设计系统；逻辑可复用/可插件化；单一语言维护 |
| Electron portable 单文件 | 满足"单一文件 + 启动零依赖 + 桌面窗口"；内置 Chromium + Node |
| NSIS 安装版互补 | 便携版无法固定任务栏（临时解压目录退出即删），安装版用于固定与开始菜单 |
| UI 走本地 http 服务 | 主进程 `node:http` 服务 + BrowserWindow 加载；浏览器/桌面窗口形态共用一套前端 |
| frameless 自绘标题栏 | 与 dsh 风格统一，自绘拖动区/关闭/最小化 |
| `PORTABLE_EXECUTABLE_DIR` | electron-builder portable 提供 exe 所在目录，配置跟随 exe（便携） |
| dsh 绑定启动器 | 启动器持有隐藏控制台，dsh 及其 pwsh 子进程继承——执行工具不弹窗；关闭启动器即停 dsh，生命周期清晰 |
| npm 安装流式输出 | 每行经日志订阅推送到窗口（SSE），实时可见 |
| SEA 备选保留 | 体积敏感场景可退化为内嵌 Node 的单文件（界面走浏览器） |

## License

[MIT](LICENSE)
