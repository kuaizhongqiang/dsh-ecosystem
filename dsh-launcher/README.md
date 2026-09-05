# 🐋 dsh-launcher

[![Release](https://img.shields.io/github/v/release/kuaizhongqiang/dsh-launcher?style=flat-square)](https://github.com/kuaizhongqiang/dsh-launcher/releases)
[![License](https://img.shields.io/github/license/kuaizhongqiang/dsh-launcher?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/kuaizhongqiang/dsh-launcher/release.yml?style=flat-square)](https://github.com/kuaizhongqiang/dsh-launcher/actions)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0a7dff?style=flat-square)]()

A single-file Windows launcher for **dsh**. Double-click `dsh-launcher.exe` to open a **desktop window**: check your environment, pick an install directory and version, install, and start dsh with one click.

> **Install source (default GitHub since v0.5.0)**: by default the launcher clones [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) and builds dsh locally (pinned to the latest `dsh-v*` tag, version-selectable, proxy-aware) — fully in sync with official releases and your server. `--source npm` keeps the registry install as a fallback.
>
> **Same TS/JS stack as dsh web**: the UI consumes dsh's dsw design system (the same `--dsw-*` tokens). Packaged with Electron as a single-file exe — zero startup dependencies (Chromium + Node built in).

[中文说明](README.zh-CN.md)

## Screenshot

![dsh-launcher GUI](assets/screenshot.png)

> Screenshot from the early Go version; the TS/JS UI keeps the dsh web theme (aurora background / frosted card / pulsing status dots / button glow).

## Features

- 🪟 **Desktop window** — double-click opens a frameless window (custom title bar), **no browser required**
- 📦 **Single file, zero dependencies** — Electron portable exe (~65 MB), Chromium + Node built in
- 📥 **Two build flavors** — portable exe (copy anywhere) **and** NSIS installer (taskbar-pinnable, Start Menu shortcut)
- 🎨 **dsh web visuals** — dsw design system: aurora background, frosted-glass card, pulsing status dots, button glow, indeterminate progress bar
- ⚡ **One-click start** — installs dsh if missing (directory + version picker), then starts the server and opens your browser
- 🔑 **Token auto-login** — dsh v0.1.2+ uses launch-token auth: `start` grabs the token URL dsh prints and opens it, so the browser exchanges a 30-day cookie automatically. The token is also written to the **shared token file** `$DSH_HOME/launch-token.json` (`~/.dsh`), readable by the [dsh-vscode](https://github.com/kuaizhongqiang/dsh-vscode) extension — whoever starts dsh (launcher or the extension), the other side reads the token from the same file, no manual copy on every restart
- 🔗 **Bound server** — dsh runs as a child of the launcher, inheriting its hidden console: executing tools no longer pops up PowerShell/cmd windows; closing the launcher stops dsh
- 🛑 **Stop** — ends the bound child process directly (GUI **停止** button / `stop` command; legacy detached processes are still resolved by port as a fallback)
- 🔀 **Relocate dsh** — move the installed dsh package to any path (cross-drive copy+delete); refused while dsh is running
- 🔍 **Environment status** — Node.js / npm / dsh versions, install state, port health
- 🔔 **Upgrade check** — compares dsh (latest GitHub tag by default; npm registry for the npm source) and the launcher itself (GitHub Release) against what's installed
- 📜 **Live log** — install & startup output streamed into the window (SSE)
- ⌨️ **CLI fallback** — `install` / `move` / `start` / `stop` / `status` / `check-update` / `--version` / `--help`
- 🧩 **Plugin ecosystem** — carries the [dsh-plugins](dsh-plugins/) collection as a git submodule (v0.5.0)

## Requirements

- **Windows 10 / 11** (x64)
- **Node.js** on the target machine: `^22.19 || >=24` — needed only to *run* dsh; the launcher itself is self-contained
- The GitHub source requires **git** and **pnpm** (pnpm is auto-installed via `npm i -g pnpm` when missing; the npm source needs neither)
- If GitHub is unreachable, pass `--proxy` (git socks5/http proxy) or set `DSH_LAUNCHER_PROXY` / `HTTPS_PROXY`
- No Go toolchain, no npm global config, no environment variables on the target machine

## Download

Grab the latest build from the [Releases page](https://github.com/kuaizhongqiang/dsh-launcher/releases). Each release is built by GitHub Actions on `windows-latest` and attaches **two** artifacts:

| Artifact | When to use |
|---|---|
| `dsh-launcher.exe` (portable) | Copy anywhere, run without installing — **cannot be pinned to the taskbar** (Windows limitation: the portable app unpacks to a temp dir that is deleted on exit, so a pinned shortcut breaks) |
| `dsh-launcher-setup-<ver>.exe` (NSIS installer) | Install to a stable path, get a Start Menu shortcut, **taskbar pinning works** — use this if you want to pin the launcher |

## Usage

### Desktop window (double-click, recommended)

1. Double-click `dsh-launcher.exe` (or run with no args) → a desktop window opens.
2. Check the "环境状态" card (Node / npm / dsh / port).
3. Click **启动**:
   - dsh installed → starts the service (or re-opens the browser if already running); the button turns into "已运行"
   - Not installed → pick a directory with **浏览…** (or type one), then **启动** installs and starts automatically
4. **移动** relocates the installed dsh package (refused while running).
5. **停止** stops dsh; **×** closes the window and **stops dsh with it** (dsh is bound to the launcher).
6. **检查更新** compares dsh and the launcher against the latest versions.

> Set `DSH_LAUNCHER_NO_BROWSER=1` to skip auto-opening the browser.
>
> **Taskbar pinning**: the portable exe runs from a temp directory that is removed on exit, so a pinned taskbar icon loses its target ("shortcut missing"). To pin, install the NSIS build (`dsh-launcher-setup-<ver>.exe`) and pin the installed launcher instead.

### CLI

```powershell
dsh-launcher.exe install [--dir <dir>] [--source github|npm] [--version <tag>] [--proxy <url>]
                            # install dsh (default: GitHub source build, latest tag;
                            # --version pins a tag; --source npm uses the registry;
                            # --proxy routes git through a proxy)
                            # default install dir %LOCALAPPDATA%\dsh
dsh-launcher.exe move --dir <dir>        # relocate dsh (refused while running)
dsh-launcher.exe start [--no-browser]    # start dsh and stay resident (auto-grabs the token URL)
dsh-launcher.exe stop                    # stop dsh (end the bound child, or fall back to the port)
dsh-launcher.exe status                  # install dir / version / running state
dsh-launcher.exe check-update            # check dsh (GitHub tag / npm) and launcher (GitHub Release)
dsh-launcher.exe --version
dsh-launcher.exe --help
```

> **Bound server (since v0.4.0)**: `start` launches dsh and stays in the foreground. The launcher owns a hidden
> console that dsh and its pwsh children inherit — tool execution no longer pops up PowerShell/cmd windows,
> and closing the launcher stops dsh.
>
> **Token auto-login (since v0.5.0)**: dsh v0.1.2+ requires opening the web UI via a `?token=` URL.
> `start` extracts that URL from dsh's output and opens it, so the browser gets its 30-day cookie
> automatically. The token rotates on every dsh restart — just run `start` again. See
> `%TEMP%\dsh-launcher-child.log` for dsh's raw output.
>
> **Shared token file**: when dsh is started by this launcher, the token is persisted to
> `$DSH_HOME/launch-token.json` (`~/.dsh`) so the [dsh-vscode](https://github.com/kuaizhongqiang/dsh-vscode)
> extension can authenticate without a manually copied token; when dsh is *already running* (started by the
> extension or elsewhere), `start` falls back to reading that file to open the token URL. The file is removed
> when the launcher stops its own bound child (pid-matched), never clobbering another app's record.
> Spec: `DSH-LAUNCH-TOKEN-FILE.md`.

Logs go to `%TEMP%\dsh-launcher.log` (the windowed build has no console).

## Config (launcher.json)

Created next to the exe on first `install` (portable — copy the exe and the config together):

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

- `source`: `github` (source build, default) / `npm` (registry); `proxy`: optional GitHub proxy.
- Directory layout (github source): `<install dir>/deepseek-harness/` (cloned repo; built bin at `apps/cli/lib/bin.js`).
- **Never touches** `~/.dsh` (`DSH_HOME`) — your existing profiles / plugins / sessions stay as-is.
- Running `install` on a new machine overwrites the install path in the config.

## Build from source

Requires Node.js 22+ (dev machine). No Go needed.

```powershell
npm ci                      # dev deps (esbuild / electron / electron-builder)
npm run check               # tsc --noEmit
npm run build               # esbuild bundles → dist/
npm run dist                # electron-builder portable → release\dsh-launcher.exe
npm run dist:installer      # electron-builder NSIS → release\dsh-launcher-setup-<ver>.exe (pinnable)
npm run dist:all            # both of the above
```

Dev modes:

```powershell
npm run start:desktop       # npx electron . (local window)
npm run start               # plain Node CLI (node dist/launcher.cjs)
```

> **Size-sensitive alternative (Node SEA)**: `npm run dist:sea` builds a Node single-executable (~87 MB, embedded Node runtime, UI opens in the browser) — kept as a fallback; the default deliverable is the Electron portable.

## Architecture

```
src/                          TS logic (shared by CLI and Electron)
├── config.ts                 launcher.json read/write (portable: follows the exe)
├── node.ts                   node/npm/pnpm/git detection, GitHub source (tag listing / shallow clone / proxy), registry mirror strategy
├── semver.ts                 semantic version compare (GitHub tag sort / upgrade checks)
├── install.ts                install / move flows (github source build / npm)
├── console.ts                hidden console (koffi AllocConsole + SW_HIDE, inherited by the dsh child)
├── launch.ts                 start/stop (dsh as a bound child process, token-URL grab)
├── tokenFile.ts              shared launch-token file (`$DSH_HOME/launch-token.json`, read/write/clear — same spec as dsh-vscode)
├── update.ts                 upgrade checks (GitHub tag + npm registry + GitHub Release)
├── server.ts                 local node:http service (UI assets + REST bridge + SSE logs)
├── cli.ts                    CLI entry
├── electron-main.ts          Electron main (window + CLI dual mode)
└── electron-preload.ts       window controls bridge (minimize)
ui/                           Web UI (dsh web dsw design system)
├── tokens.css                design tokens extracted from @deepseek-ai/dsh-client-ui-theme
├── launcher.css              UI styles (tokens only)
└── index.html / app.js       page + logic (bridge-injected; mock/real auto-switch)
scripts/
├── build.mjs                 esbuild bundling
├── build-sea.mjs             Node SEA fallback build
└── extract-dsw-tokens.mjs    re-extract dsw design tokens
```

## Design notes

| Decision | Why |
|---|---|
| TS/JS, same stack as dsh | UI consumes the dsw design system directly; logic reusable/pluggable; one language to maintain |
| Electron portable single file | Meets "single file + zero-dependency startup + desktop window"; Chromium + Node built in |
| NSIS installer companion | Portable exe can't be taskbar-pinned (temp unpack dir is deleted on exit), so an installer build ships for pinning/Start Menu |
| UI served via local http | Main process runs `node:http`; BrowserWindow loads it — browser and desktop forms share one frontend |
| Frameless custom title bar | Matches dsh style; custom drag/close/minimize |
| `PORTABLE_EXECUTABLE_DIR` | electron-builder portable exposes the exe dir → config follows the exe (portable) |
| dsh bound to the launcher | Launcher owns a hidden console; dsh and its pwsh children inherit it — no more popup windows when executing tools; closing the launcher stops dsh (clear lifecycle) |
| Streamed npm output | Every line pushed to the window via log subscription (SSE) |
| SEA fallback kept | Size-sensitive deployments can degrade to an embedded-Node single file (browser UI) |

## License

[MIT](LICENSE)
