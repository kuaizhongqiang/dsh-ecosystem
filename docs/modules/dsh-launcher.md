# dsh-launcher — L0 载体(伞仓核心)

| 项 | 值 |
|---|---|
| 上游仓 | [kuaizhongqiang/dsh-launcher](https://github.com/kuaizhongqiang/dsh-launcher) |
| 形态 | **直接工程**(伞仓根 `dsh-launcher/`,独立 git,改动在仓内提交推送) |
| 生态位 | L0 载体 / 生命周期(随身携带的「一个 exe 走天下」入口) |
| HEAD 快照 | `979cec6`(v0.7.3;权威值 `git -C dsh-launcher log -1`) |

## 角色

Windows **单文件安装 + 启动引导器**:内置 Chromium + Node,零依赖;负责 dsh(core)的
安装/启动/停止、按需拉起整个生态(插件 → 技能 → 周边 → 个人层),并维护与 dsh 各端
共享的启动 seam(`launch-token.json`、`connections.json`、`launcher-registration.json`)。
M0–M8 里程碑已全部落地(v0.7.3 线)。

## 自带文档 / 入口

- 仓内 README 与代码注释;生态计划/审查/日志原在其 `docs/`,已迁伞仓 docs/ 为单一事实源(WORKLOG 2026-09-02)。
- 路线图实现落点:里程碑 M0–M8(见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) §6)。

## 与伞仓的关系

- 伞仓根的 `dsh-launcher/` 就是本仓检出:代码更新 = 目录内 `git pull` / 提交推送,**无伞仓 bump 仪式**。
- **双 dsh-plugins 注意**:本仓**内部**自带 `dsh-plugins` 子模块(安装/拉取时的**运行时源**,
  见 launcher 仓自己的 .gitmodules),与伞仓根的 `dsh-plugins` 直接工程目录**相互独立**——
  更新插件时两处分别推进(伞仓根目录 `git pull`;launcher 内层按 launcher 仓纪律 bump)。

## 发布注意点

- 版本发布在**自身仓 Releases**(v0.7.x 线);launcher 内层 dsh-plugins 子模块的 bump 同步在 launcher 仓内完成。
- 涉及 M5/M6 的 seam 行为变化时,同步确认 dsh-vscode / dsh-desktop 的跟随语义(Phase 5 收窄表述)。
- PM3 的 **dsh-launcher 插件**(5 工具 + install-launcher 技能)已在 dsh-plugins 侧落地,依赖本仓
  M5(connections.json)与 M6(restart API + 环境变量注入)。
