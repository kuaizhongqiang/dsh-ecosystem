# dsh-desktop — L4 周边(Electron 桌面壳)

| 项 | 值 |
|---|---|
| 来源仓 | [kuaizhongqiang/dsh-desktop](https://github.com/kuaizhongqiang/dsh-desktop)(**已归档只读**) |
| 形态 | **伞仓内目录 `dsh-desktop/`**(monorepo,随伞仓统一提交;应用代码在 `desktop/` 子目录) |
| 生态位 | L4 周边(独立桌面客户端) |
| 并入 HEAD | `250abfb`(并入快照);**当前发布 v0.8.0**(权威版本见 `desktop/package.json`) |

## 角色

Electron 桌面壳客户端:连**共享的 dsh server**(本机或远端),提供独立于浏览器的 dsh 使用面。

## 自带文档 / 入口

- 目录内 README / `desktop/README.md`(连接方式、构建/打包说明)。

## 与伞仓的关系 / 跟随语义(Phase 5)

- **开发在伞仓内进行**:修改 `dsh-desktop/` 后随伞仓 git 提交推送。
- 按 `launch-token.json` 的 `url` 连接,**完全跟随**激活连接(launcher 解析激活连接后照写
  v1 `launch-token.json`,规范不变);见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) Phase 5。

## 发布注意点

- **手动发布**:本地 electron-builder 打包 → 上传伞仓 Releases;原仓 ci/release workflow 已随归档停摆
  (见 [RELEASING.md](../RELEASING.md))。
- 路线图 Phase 5「零改动跟随」对 desktop 是**完全跟随**(vscode 仅 token 跟随),相关改动时保持此语义。
- 原仓内层 submodule(deepseek-harness / dsh-plugins dev 引用)已随 monorepo 化清除。
