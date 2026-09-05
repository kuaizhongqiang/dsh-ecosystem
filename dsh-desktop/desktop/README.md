# dsh-desktop（desktop/）

DeepSeek Harness 桌面**纯壳**客户端（Electron + TypeScript）。完整设计见 [../docs/DESIGN.md](../docs/DESIGN.md)。

## 安装（npm / 安装包）

```sh
# npm 直接运行（Windows；安装时下载 electron 二进制 ~110MB）
npx @kuaizhongqiang/dsh-desktop
# 或全局安装后运行
npm i -g @kuaizhongqiang/dsh-desktop && dsh-desktop

# 正式安装包（NSIS，含自动更新）见 GitHub Releases：
#   https://github.com/kuaizhongqiang/dsh-desktop/releases
```

> npm ≥ 11.16 默认拦截安装脚本：若 electron 二进制未自动下载，先执行
> `npm config set allow-scripts electron` 再重装；国内网络可加
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 加速。

## 结构

```
src/main/      Electron 主进程（connect 探测/token 认证 / launcher 委托 / 托盘 / 设置 / 日志 / 更新）
src/renderer/  UI（连接页 / 日志 / 设置）
preload/       contextBridge（最小 IPC 面）
scripts/       build / smoke / install-plugins / publish-npm
build/         electron-builder 资源（icon，dsh 官方鲸鱼）
assets/        运行时图标（窗口/托盘，dsh 官方鲸鱼）
dsh-plugins/   插件合集子模块（../dsh-plugins）
```

## 开发

要求：Node ≥ 22.19；本机需有共享 dsh server 在跑（`dsh web`、dsh-launcher 或 VSCode 扩展任一）。

```sh
git submodule update --init --recursive
npm install              # 安装依赖（含 Electron）
npm run build            # tsc + 静态资源拷贝到 out/
npm run dev              # 启动 Electron（连接共享 server；无 server 时显示连接页）
npm run smoke            # 无 GUI 冒烟：验证 dsh 启动令牌协议（401→token→303→RPC 认证）
```

## 打包

```sh
npm run pack             # → release/（NSIS 单版本安装包）
```

产物：`dsh-desktop-{version}-setup.exe` + `latest.yml`（自动更新 feed）。

## 插件

```sh
npm run plugins:install  # 把 dsh-plugins 的安装技能装进 %DSH_HOME%\skills（幂等）
```

插件本体装进共享 `%DSH_HOME%\profiles\web\plugins`，三端（web / vscode / desktop 壳）共享。

## 发布（CI）

- **CI**（`.github/workflows/ci.yml`）：push/PR 时 typecheck + build + 共享协议冒烟。
- **Release**（`.github/workflows/release.yml`）：打 `v*` tag → 构建单版本 → 发布 GitHub Release（含更新源）。
- **签名**：Secrets 配置 `CSC_LINK` + `CSC_KEY_PASSWORD` 启用 Windows 代码签名。

```sh
git tag v0.2.0 && git push origin v0.2.0   # 触发发布
```

## dsh 版本锁定

- 期望版本见 `config.json`（`dshVersion`，当前 `0.1.2-alpha.4`；与 npm alpha / GitHub main 对齐）。
- 桌面端不捆绑 dsh：实际安装/升级由 dsh-launcher 负责（npm registry / GitHub tag 双源）。
- 子模块 `../deepseek-harness` 与 `../dsh-plugins` 仅作参考/审计/安装源，零修改。
