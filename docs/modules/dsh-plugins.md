# dsh-plugins — L3 插件(伞仓内目录)

| 项 | 值 |
|---|---|
| 来源仓 | [kuaizhongqiang/dsh-plugins](https://github.com/kuaizhongqiang/dsh-plugins)(**已归档只读**) |
| 形态 | **伞仓内目录 `dsh-plugins/`**(monorepo,随伞仓统一提交) |
| 生态位 | L3 插件(社区插件合集 + install-* 技能) |
| 并入 HEAD | `7a1b8a9`(权威:目录内 README 版本约定) |

## 角色

dsh 会话内「说一句安装」即可落地的插件包 + 配套 `install-*` 技能。路线图 §8 合并已落地(v0.7.0 起),
当前 **10 个插件包**(launcher 默认清单 9 包;ue-mcp 需本地 UE 工程,故不入默认清单)+ **10 个技能**:
dsh-media(感知四合一)/ dsh-image(图片生成)/ dsh-deepseek(账户二合一)/ dsh-credentials / dsh-github /
dsh-stock / unity-mcp / ue-mcp / dsh-launcher / agent-memory;每包自带 `install.ps1`
(支持 `-Only` / `-Uninstall`)与 `SKILL.md`,另有 `uninstall-old.ps1`(旧 11 包迁移清理:
载荷 + patch 节 + **旧技能** —— 技能清理默认执行,`-KeepSkills` 保留)。

## 自带文档 / 入口

- 目录内 README、`docs/PLUGIN-SPEC.md`(分层规范与模板)、各插件 `install.ps1` / `SKILL.md`
  (安装逻辑**唯一真源**,launcher 只做编排——决策 D1)。
- 合并计划与准入三问(独立凭证?独立外部系统?工具数 ≥8?):见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) §8。

## 与伞仓的关系

- **开发在伞仓内进行**:修改 `dsh-plugins/` 后随伞仓 git 提交推送;launcher 运行时插件源即伞仓内
  该目录的发布结果(launcher M1 按清单 sha 拉取)。
- 质量门:目录内 `scripts/verify-pm2..pm4.mjs`(安装/幂等/卸载/技能集合一致性)与
  `verify-image.mjs`(图片生成载荷:三模式请求体 + 桩 fetch 端到端)等 —— 真 PowerShell + 临时桩件,不触网。

## 发布注意点

- PM 里程碑工作项集中在伞仓 issues(PM1–PM4=#13–#16);实现提交在伞仓 `dsh-plugins/`。
- 合并/迁移类改动(旧包 deprecated + `uninstall-old.ps1`)规则不变;凭证与 settings 在 DSH_HOME 层不受影响。
