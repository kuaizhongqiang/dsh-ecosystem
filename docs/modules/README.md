# 模块文档 — dsh 生态组件一览

> 伞仓形态(2026-09-04 改造,见 [RESTRUCTURE-UMBRELLA.md](../RESTRUCTURE-UMBRELLA.md)):
> **5 个自有组件为直接工程**(伞仓根目录下的独立 git 仓库,各自 .git/remote/历史),
> **deepseek-harness 为唯一官方 git 子模块**。
> 直接工程页中的 HEAD 是**说明性快照**,权威值以各仓 `git -C <dir> log -1` 为准;
> harness 指针以 `git submodule status` 为准。

## 索引

| 组件 | 形态 | 角色 | 当前 HEAD/指针(快照) | 页面 |
|---|---|---|---|---|
| [dsh-launcher](dsh-launcher.md) | 直接工程 | L0 载体(Windows 单文件安装 + 启动引导器,伞仓核心) | `979cec6`(v0.7.3) | [→](dsh-launcher.md) |
| [dsh-plugins](dsh-plugins.md) | 直接工程 | L3 插件合集(7 包 + install-* 技能) | `7a1b8a9` | [→](dsh-plugins.md) |
| [dsh-vscode](dsh-vscode.md) | 直接工程 | L4 周边(VSCode 扩展,Open VSX) | `1756889` | [→](dsh-vscode.md) |
| [dsh-desktop](dsh-desktop.md) | 直接工程 | L4 周边(Electron 桌面壳) | `250abfb` | [→](dsh-desktop.md) |
| [dsh-remote](dsh-remote.md) | 直接工程 | L6 广域网(Cloudflare Access 部署记录) | `4f755d2` | [→](dsh-remote.md) |
| [deepseek-harness](deepseek-harness.md) | **git 子模块** | L2 核心(dsh 本体,官方只读) | `47f94385` | [→](deepseek-harness.md) |

> 生态分层:见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) §1(L0–L6)与 §3(决策 D1–D8)。

## 相关文档

- 生态路线图 v3:[ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md)
- 伞仓形态改造:[RESTRUCTURE-UMBRELLA.md](../RESTRUCTURE-UMBRELLA.md)
- 发布流程:[RELEASING.md](../RELEASING.md)
- 工作日志:[WORKLOG.md](../WORKLOG.md)
- 代理手册:[.AGENT.md](../../.AGENT.md)
