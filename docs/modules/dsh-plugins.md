# dsh-plugins — L3 插件(开发集合视角)

| 项 | 值 |
|---|---|
| 上游仓 | [kuaizhongqiang/dsh-plugins](https://github.com/kuaizhongqiang/dsh-plugins) |
| 生态位 | L3 插件(社区插件合集 + install-* 技能) |
| 伞仓锁指针 | `15ffcfd7`(`15ffcfd77d391d6ba5fed8dc6285e6bb5ff0f72c`) |
| 本地开发 | 子仓克隆(本地开发根 `F:\Project\dsh-dev\*`,见 WORKLOG 2026-09-02) |

## 角色

dsh 会话内「说一句安装」即可落地的插件包 + 配套 `install-*` 技能。当前 **11 个插件包**
(audio-read / audio-speak / describe-image / video-read / document-read / deepseek-balance /
deepseek-recharge / credentials / github / stock / unity-mcp 桥),共享凭证/模式高度重叠
——路线图 §8 计划合并为 **7 个**(dsh-media、dsh-deepseek、dsh-credentials、dsh-github、
dsh-stock、dsh-unity、dsh-launcher 新增),里程碑 PM1–PM4。

## 自带文档 / 入口

- 仓内 README、各插件 `install.ps1` / `SKILL.md`(安装逻辑**唯一真源**,launcher 只做编排——决策 D1)。
- 合并计划与准入三问(独立凭证?独立外部系统?工具数 ≥8?):见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) §8。

## 与伞仓的关系

- 伞仓顶层 `dsh-plugins` = **开发集合视角**;bump 指针锁插件集版本。
- **双指针注意**:dsh-launcher 内部另有 dsh-plugins 子模块(运行时源),两处独立 bump,
  插件更新后**两处都要推进**(README 同述)。
- 插件版本化与 launcher 子模块联动落在 PM4(PLAN §8 里程碑表)。

## bump / 发布注意点

- PM 里程碑工作项集中在伞仓 issues(PM1–PM4=#13–#16);实现提交在 dsh-plugins 仓。
- 合并类改动(PM2)会触碰既有安装面:旧包 deprecated 一个版本周期 + 幂等迁移,凭证与
  settings 在 DSH_HOME 层不受影响(PLAN §8「迁移与兼容」)。
