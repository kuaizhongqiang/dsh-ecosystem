# dsh-launcher — L0 载体(伞仓核心)

| 项 | 值 |
|---|---|
| 上游仓 | [kuaizhongqiang/dsh-launcher](https://github.com/kuaizhongqiang/dsh-launcher) |
| 生态位 | L0 载体 / 生命周期(随身携带的「一个 exe 走天下」入口) |
| 伞仓锁指针 | `322acc59`(`322acc598144e9bb9f183b97bb3bddfe02ac1bdb`) |
| 现状基线 | launcher v0.6.4(PLAN §2「已具备」) |
| 本地开发 | 子仓克隆(本地开发根 `F:\Project\dsh-dev\*`,见 WORKLOG 2026-09-02) |

## 角色

Windows **单文件安装 + 启动引导器**:内置 Chromium + Node,零依赖;负责 dsh(core)的
安装/启动/停止、按需拉起整个生态(插件 → 技能 → 周边 → 个人层),并维护与 dsh 各端
共享的启动 seam(`launch-token.json`,远期 `connections.json`、`launcher-registration.json`)。

## 自带文档 / 入口

- 仓内 README 与代码注释;生态计划/审查/日志原在其 `docs/`,**已迁伞仓 docs/ 为单一事实源**(WORKLOG 2026-09-02)。
- 后续路线图实现在本仓落地:里程碑 M0–M8(见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) §6)。

## 与伞仓的关系

- 伞仓 bump 其指针即锁 launcher 版本;launcher 发布在**自身仓 Releases**。
- **双指针注意**:dsh-launcher 内部自带 `dsh-plugins` 子模块(安装/拉取时的**运行时源**),
  与伞仓顶层 `dsh-plugins`(开发集合视角)**指针独立**——更新插件时两处都要推进(README 同述)。

## bump / 发布注意点

- 逐仓验证后再 bump(伞仓指针 = 已验证版本);bump 提交 `chore: bump dsh-launcher → <sha-8>`。
- 涉及 M5/M6 的 seam 行为变化时,同步确认 dsh-vscode / dsh-desktop 的跟随语义(Phase 5 收窄表述)。
- 路线图 §8 的 **dsh-launcher 插件**(5 工具 + install-launcher 技能)依赖本仓 M5(connections.json)
  与 M6(restart API + 环境变量注入)完成后在 dsh-plugins 侧落地(PM3)。
