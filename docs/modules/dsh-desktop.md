# desktop — L4 周边(上游桌面客户端 + 伞仓镜像)

> **2026-09-28 变更**:桌面版**归上游**。伞仓自建的 `dsh-desktop/` 目录已移除(其源码仓
> [kuaizhongqiang/dsh-desktop](https://github.com/kuaizhongqiang/dsh-desktop) 早已归档只读),
> 伞仓不再自建/签名/自发布桌面版,只在 Release 里**镜像**上游 win-x64 安装包。

| 项 | 值 |
|---|---|
| 归属 | **官方上游** `deepseek-harness/apps/desktop`(`@deepseek-ai/dsh-desktop`,跟随子模块指针) |
| 形态 | 上游 monorepo 内的 Electron 应用(伞仓只镜像产物,不放源码) |
| 生态位 | L4 周边(独立桌面客户端) |
| 版本 | 与 dsh 本体**严格同号**(当前子模块 `dsh-v0.1.7-rc.2` → 桌面版 `0.1.7-rc.2`) |
| 伞仓产物 | `deepseek-harness-<上游版>-win-x64.exe` + `.sha512`(镜像,见 [RELEASING.md](../RELEASING.md)) |

## 角色

Electron 外壳包住**完整的 dsh Web 应用**:Electron 以 `ELECTRON_RUN_AS_NODE=1` 起共享 profile runner,
再加载打包好的 Web 入口,默认端口 `19387`(与 Web 的 `3080` 错开)。自带托盘、原生 About 面板、
平台账号视图与 electron-updater;不依赖系统 Node/pnpm(自带打包运行时与 pnpm)。

## 上游事实(决定我们怎么跟随)

- **版本同一性**:上游的发布决策是「shell / Web client / 后端 / 插件图作为一个组合一起合格化」——
  **dsh 升级 = 一次 desktop 发布**,所以桌面版号永远等于 dsh 号;伞仓锁子模块即隐式锁了桌面版。
- **分发通道**:generic provider,生产 origin `https://download.deepseek.com`,
  清单 `dsh-desk/feeds/<target>/nightly.yml`,产物 `dsh-desk/bin/<target>/deepseek-harness-<ver>-<os>-<arch>.<ext>`;
  target 为 `mac-arm64` / `mac-x64` / `win-x64`。上游当前版本全是 prerelease,故只有 `nightly` 清单。
- **安装形态(Windows)**:NSIS,`oneClick:false` + `perMachine:false` + `allowElevation:false`
  → 按用户装到用户目录,并向 **HKCU** 的卸载注册项写 `DisplayName`(`DeepSeek Harness`)与
  `DisplayVersion`/`InstallLocation`。伞仓 launcher 就靠这个读「已装版本」(见下)。
- **数据边界**:shell 独占 `$DSH_HOME/profiles/desktop` 与其包管理状态;`$DSH_HOME` 下的会话/设置/凭证/插件
  与 CLI 共用,但可执行包、锁文件、`node_modules` 不共享。卸载**不碰** `~/.dsh` / `DSH_HOME`。
- 上游 CI(`deepseek-harness/.github/workflows/`)不构建桌面版,产物由其内部发布流程上传到 COS。

## 伞仓怎么跟随

- **镜像(可选项,不做也行)**:`scripts/desktop-mirror.json`(pin)+ `scripts/mirror-desktop.mjs`(取件/校验),
  CI `desktop-mirror` job 在每次全量 tag 时把**上游 win-x64** 安装包挂到本仓 Release。
  pin 必须与子模块 `apps/desktop/package.json` 同号(`verify-release.mjs` 交叉校验)。
- **本机识别**:launcher 概览卡的 desktop 版本 = `dsh-launcher/src/server.ts` 的
  `readUpstreamDesktopVersion()` —— 枚举 `HKCU`/`HKLM`(+`WOW6432Node`)的 `Uninstall` 键,
  按 `DisplayName == DeepSeek Harness` 匹配后读 `DisplayVersion`(注册项 GUID 不稳定,不能硬编码)。
- **launch-token 语义收窄**:launcher 解析激活连接后照写的 v1 `launch-token.json` 现在只有
  **dsh-vscode** 读(上游桌面版自带 Host 与鉴权,不读该文件);旧文档里「desktop 完全跟随」的说法已作废。
- **不再有伞仓版本号**:desktop 不参与伞仓三方版本一致性校验,也不进 npm。

## 迁移提示

- 已装伞仓自建 desktop(`@kuaizhongqiang/dsh-desktop` 0.8.x–0.11.x)的用户:手工卸载后装上游版;
  上游版与 dsh 同号并自带上游更新通道,npm 上的历史版本**不再更新、不删除**。
- mac 用户:直接走上游 `https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly.yml`
  对应的官方 dmg(伞仓不镜像 mac)。
