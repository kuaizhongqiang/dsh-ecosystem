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
| [dsh-plugins](dsh-plugins.md) | 伞仓内目录 | L3 插件合集(8 包 + install-* 技能) | `7a1b8a9` | 随伞仓 | [→](dsh-plugins.md) |
| [dsh-vscode](dsh-vscode.md) | 伞仓内目录 | L4 周边(VSCode 扩展,Open VSX) | `1756889` | 0.8.0 | [→](dsh-vscode.md) |
| [desktop](dsh-desktop.md) | **上游**(`deepseek-harness/apps/desktop`)+ 伞仓镜像产物 | L4 周边(Electron 桌面客户端,**已归上游**) | `—` | 随上游(与 dsh 同号) | [→](dsh-desktop.md) |
| [agent-memory](agent-memory.md) | 伞仓内目录 + L3 插件包 | L5 记忆层(桥 + 接入器;引擎为第三方上游) | `4080826` | 0.3.0 | [→](agent-memory.md) |
| [dsh-cli](dsh-cli.md) | 伞仓内目录 | L1.5 入口层(终端 CLI + 本机工具服务:给别的 agent 调 dsh) | `0.11.0` | v0.11.0 首发 | [→](dsh-cli.md) |
| [deepseek-harness](deepseek-harness.md) | **git 子模块** | L2 核心(dsh 本体,官方只读;含上游桌面版 `apps/desktop`) | `477b4f42`(dsh-v0.1.7-rc.2) | — | [→](deepseek-harness.md) |

> 生态分层:见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) §1(L0–L6)与 §3(决策 D1–D8)。

## 速查:层级 / 决策 / 代号

> 权威出处是 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) §1(分层)与 §3(决策),这里只做速查。

- **层**:L0 载体(launcher)/ **L1.5 入口层(`dsh-cli`)** / L1 运行时(Node `^22.19 ‖ >=24`)/ L2 核心(dsh)/
  L3 插件 / L4 周边(dsh-vscode;**desktop 归上游**) / L5 个人层(`%DSH_HOME%`)/ L6 广域网连接
  (连接概念保留,部署记录组件已移除)。
- **决策 D1–D8**:D1 launcher 不手写 DSH_HOME · D2 凭证红线 · D3 清单即生态 · D4 目录边界不变 ·
  D5 连接即启动项 · D6 重启委托管理者 · D7 插件按凭证/模式聚合 · D8 监督者协调协议。
- **形态/发布决策**:D-M1–M6([MONOREPO-UMBRELLA.md](../MONOREPO-UMBRELLA.md) §3);
  **全量发布** = 一个 `vX.Y.Z` tag 发所有包([RELEASING.md](../RELEASING.md))。
- **审查优先级代号**:P0 必修 / P1 必补 / P2 采纳 / P3 酌情。

## 相关文档

- 生态路线图 v3:[ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md)
- 伞仓 monorepo 化:[MONOREPO-UMBRELLA.md](../MONOREPO-UMBRELLA.md)
- 发布流程(手动 SOP):[RELEASING.md](../RELEASING.md)
- 工作日志:[WORKLOG.md](../WORKLOG.md)
- 代理手册:[.AGENT.md](../../.AGENT.md)
