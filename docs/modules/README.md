# 模块文档 — dsh 生态组件一览

> 伞仓形态(2026-09-04 收敛):**monorepo 单仓**——自有组件为伞仓内普通目录(随伞仓统一版本控制,
> 原源仓已并入并归档只读;**dsh-remote 组件已移除**,内容见已归档的 kuaizhongqiang/dsh-remote);
> **deepseek-harness 为唯一官方 git 子模块**。
> 组件页中的 HEAD 为**并入快照**,权威版本以伞仓内组件目录为准(见各目录 package.json / README);
> harness 指针以 `git submodule status` 为准。
> 形态设计与发布:见 [MONOREPO-UMBRELLA.md](../MONOREPO-UMBRELLA.md) 与 [RELEASING.md](../RELEASING.md)(全量 tag)。

## 索引

| 组件 | 形态 | 角色 | 并入 HEAD / 指针(快照) | 当前版本 | 页面 |
|---|---|---|---|---|---|
| [dsh-launcher](dsh-launcher.md) | 伞仓内目录 | L0 载体(安装 + 启动引导器,伞仓核心) | `979cec6` | 0.8.0 | [→](dsh-launcher.md) |
| [dsh-plugins](dsh-plugins.md) | 伞仓内目录 | L3 插件合集(7 包 + install-* 技能) | `7a1b8a9` | 随伞仓 | [→](dsh-plugins.md) |
| [dsh-vscode](dsh-vscode.md) | 伞仓内目录 | L4 周边(VSCode 扩展,Open VSX) | `1756889` | 0.8.0 | [→](dsh-vscode.md) |
| [dsh-desktop](dsh-desktop.md) | 伞仓内目录 | L4 周边(Electron 桌面壳) | `250abfb` | 0.8.0 | [→](dsh-desktop.md) |
| [deepseek-harness](deepseek-harness.md) | **git 子模块** | L2 核心(dsh 本体,官方只读) | `47f94385` | — | [→](deepseek-harness.md) |

> 生态分层:见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) §1(L0–L6)与 §3(决策 D1–D8)。

## 相关文档

- 生态路线图 v3:[ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md)
- 伞仓 monorepo 化:[MONOREPO-UMBRELLA.md](../MONOREPO-UMBRELLA.md)
- 发布流程(手动 SOP):[RELEASING.md](../RELEASING.md)
- 工作日志:[WORKLOG.md](../WORKLOG.md)
- 代理手册:[.AGENT.md](../../.AGENT.md)
