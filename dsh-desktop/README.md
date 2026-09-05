# dsh-desktop

DeepSeek Harness（dsh）的 Windows 桌面**纯壳**客户端：用 Electron 壳内嵌 dsh Web UI，
**不携带、不拉起 dsh server**——它连接**共享的 dsh server**（由 dsh-launcher / dsh-vscode /
`dsh web` 三者中**先启动的一端**持有），与浏览器（web）、VSCode 扩展三端同步。

> 📄 完整方案见 [docs/DESIGN.md](docs/DESIGN.md)
> 📦 发布：[GitHub Releases](https://github.com/kuaizhongqiang/dsh-desktop/releases)（NSIS 安装包）
> 📦 npm：[`@kuaizhongqiang/dsh-desktop`](https://www.npmjs.com/package/@kuaizhongqiang/dsh-desktop)（`npx @kuaizhongqiang/dsh-desktop` 直接运行，Windows）

## 安装

```sh
# npm（Windows；安装时下载 electron 二进制，npm ≥ 11.16 需 allow-scripts electron）
npx @kuaizhongqiang/dsh-desktop
npm i -g @kuaizhongqiang/dsh-desktop && dsh-desktop
# 或下载 NSIS 安装包：GitHub Releases
```

## 三端同步模型

```
                ┌─────────────────────────────┐
                │  共享 dsh server（一份）      │
                │  dsh web --port 3080         │
                │  DSH_HOME（数据/插件/skills） │
                │  $DSH_HOME/launch-token.json │
                └──────────────┬──────────────┘
       谁先启动谁持有 ↑         │ 端口探测 + 共享 token
   ┌──────────────┬────────────┼──────────────┐
   ▼              ▼            ▼              ▼
dsh-launcher   dsh web      dsh-vscode    dsh-desktop
（安装+拉起）  （浏览器）    （扩展）      （纯壳，只连接）
```

- **谁持有 server**：dsh-launcher / VSCode 扩展 / 终端 `dsh web`——先启动的一端拉起并持有
  server 进程；其他端**探测端口**（`127.0.0.1:3080` 默认）发现已运行就直接连接，不重复拉起。
- **认证同步**：dsh v0.1.2+ 每次启动生成 launch token；持有者把 token 写入
  `$DSH_HOME/launch-token.json`（v1 规范，与 dsh-launcher / dsh-vscode 共用），
  各端读取后用 `/?token=…` 换取会话 cookie。
- **桌面端（本仓库）**：纯 Electron 壳，永不 spawn dsh。启动时探测共享 server：
  - 已运行 → 读取共享 token → 窗口加载 `http://127.0.0.1:<port>/?token=…`；
  - 端口空闲 → 显示连接页，一键「启动服务」**委托 dsh-launcher**（`start --no-browser`，
    启动器常驻并持有 server，关桌面端不影响服务）；
  - 端口被非 dsh 进程占用 → 明确报错提示。

## 功能特性

- **纯壳连接**：端口探测 + 共享 launch-token 认证 + 健康监控（server 停止自动回到连接页）
- **委托 dsh-launcher**：启动/停止服务均委托启动器（自动查找 PATH / 常见安装位置，可在设置指定）
- **桌面能力**：系统托盘（最小化到托盘、状态提示）、单实例锁、日志面板、设置页
  （端口 / DSH_HOME / launcher 路径 / 自启）、自动更新（electron-updater，单版本）
- **插件**：携带 [dsh-plugins](https://github.com/kuaizhongqiang/dsh-plugins) 子模块，
  `npm run plugins:install` 一键把插件安装技能装进 `%DSH_HOME%\skills`（插件装进共享
  DSH_HOME 的 `profiles/web/plugins`，三端共享）
- **dsh 版本锁定**：`config.json` 的 `dshVersion`（当前 `0.1.2-alpha.4`，与 npm alpha /
  GitHub main 一致）；`deepseek-harness/` 子模块仅作参考/审计，零修改

## 快速开始（开发）

要求：Node ≥ 22.19（本机建议 24.x）。

```sh
git submodule update --init --recursive   # deepseek-harness + dsh-plugins 子模块
cd desktop
npm install
npm run build                # tsc + 静态资源
npm run dev                  # 启动 Electron（连接本机共享 server，需先有 dsh 在跑）
npm run smoke                # 无 GUI 冒烟：验证 dsh 启动令牌协议 + Web UI
```

## 打包与发布

```sh
cd desktop
npm run pack                 # → release/（NSIS 单版本安装包）
```

CI 自动执行：typecheck → build → dsh 冒烟 → NSIS 打包 → 发布到 GitHub Release
（含 `latest.yml` 更新源）。配置仓库 Secrets `CSC_LINK` + `CSC_KEY_PASSWORD` 即启用签名。

```sh
git tag v0.2.0 && git push origin v0.2.0   # 触发发布
```

## 相关项目

- dsh 上游：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 服务持有者：[kuaizhongqiang/dsh-launcher](https://github.com/kuaizhongqiang/dsh-launcher)
- VSCode 端：[kuaizhongqiang/dsh-vscode](https://github.com/kuaizhongqiang/dsh-vscode)
- 插件合集：[kuaizhongqiang/dsh-plugins](https://github.com/kuaizhongqiang/dsh-plugins)
