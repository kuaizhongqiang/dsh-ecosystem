# dsh-launcher — L0 载体(伞仓核心)

| 项 | 值 |
|---|---|
| 来源仓 | [kuaizhongqiang/dsh-launcher](https://github.com/kuaizhongqiang/dsh-launcher)(**已归档只读**) |
| 形态 | **伞仓内目录 `dsh-launcher/`**(monorepo,随伞仓统一提交) |
| 生态位 | L0 载体 / 生命周期(随身携带的「一个 exe 走天下」入口) |
| 并入 HEAD | `979cec6`(v0.7.3;权威版本见目录内 package.json) |

## 角色

Windows **单文件安装 + 启动引导器**:内置 Chromium + Node,零依赖;负责 dsh(core)的
安装/启动/停止、按需拉起整个生态(插件 → 技能 → 周边 → 个人层),并维护与 dsh 各端
共享的启动 seam(`launch-token.json`、`connections.json`、`launcher-registration.json`)。
M0–M8 里程碑已全部落地(v0.7.3 线)。

## 自带文档 / 入口

- 目录内 README 与代码注释;生态计划/审查/日志以伞仓 docs/ 为单一事实源。
- 里程碑实现历史:M0–M8(见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) §6)。

## 与伞仓的关系

- **开发在伞仓内进行**:修改 `dsh-launcher/` 后随伞仓 git 提交推送;无独立 remote。
- 原仓内层 `dsh-plugins` 子模块(dev 便利)已随 monorepo 化**清除**;运行时插件源逻辑
  (M1 `ensurePluginsSource` 锁 sha 从 GitHub 拉取)不受影响,插件目录统一为伞仓 `dsh-plugins/`。
- 质量门:目录内 `npm run build` / `verify:m0..m8`(`npm run verify:mX`,先 build;npm 勿用 pnpm)。

## 发布注意点

- 版本发布 = **手动 SOP**(本地 `dist:all` + 上传伞仓 Releases),见 [RELEASING.md](../RELEASING.md);
  原仓 release workflow 已随源仓归档停摆,伞仓重建 CI 为后续项。
- 涉及 M5/M6 seam 行为变化时,同步确认 dsh-vscode / dsh-desktop 的跟随语义(Phase 5 收窄表述)。
