# dsh-plugins — L3 插件(伞仓根直接工程)

| 项 | 值 |
|---|---|
| 上游仓 | [kuaizhongqiang/dsh-plugins](https://github.com/kuaizhongqiang/dsh-plugins) |
| 形态 | **直接工程**(伞仓根 `dsh-plugins/`,独立 git,改动在仓内提交推送) |
| 生态位 | L3 插件(社区插件合集 + install-* 技能) |
| HEAD 快照 | `7a1b8a9`(权威值 `git -C dsh-plugins log -1`) |

## 角色

dsh 会话内「说一句安装」即可落地的插件包 + 配套 `install-*` 技能。路线图 §8 合并已落地(v0.7.0 起),
当前 **7 个插件包 + 技能**:dsh-media(感知五合一)/ dsh-deepseek(账户二合一)/ dsh-credentials /
dsh-github / dsh-stock / dsh-unity / dsh-launcher;每包自带 `install.ps1`(支持 `-Only` / `-Uninstall`)与
`SKILL.md`,仓库根另有 `uninstall-old.ps1`(旧 11 包迁移清理)。

## 自带文档 / 入口

- 仓内 README、`docs/PLUGIN-SPEC.md`(分层规范与模板)、各插件 `install.ps1` / `SKILL.md`
  (安装逻辑**唯一真源**,launcher 只做编排——决策 D1)。
- 合并计划与准入三问(独立凭证?独立外部系统?工具数 ≥8?):见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) §8。

## 与伞仓的关系

- 伞仓根的 `dsh-plugins/` 就是本仓检出(开发集合视角):更新 = 目录内 `git pull` / 提交推送,**无伞仓 bump 仪式**。
- **双 dsh-plugins 注意**:dsh-launcher 仓内部另有自己的 dsh-plugins 子模块(安装/拉取时的运行时源),
  两处检出相互独立——插件更新后:伞仓根目录推进 + launcher 内层按其仓纪律 bump(README 同述)。

## 发布注意点

- PM 里程碑工作项集中在伞仓 issues(PM1–PM4=#13–#16);实现提交在 dsh-plugins 仓。
- 合并类改动(PM2 已完成)触碰既有安装面:旧包 deprecated 一个版本周期 + 幂等迁移(`uninstall-old.ps1`),
  凭证与 settings 在 DSH_HOME 层不受影响(PLAN §8「迁移与兼容」)。
