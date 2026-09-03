# 模块文档 — dsh 生态组件一览

> 伞仓以 6 个 git 子模块锁定生态版本。本目录为每个组件一页「生态位说明书」:
> 角色 / 仓 / 伞仓当前锁指针 / 自带文档入口 / bump 与发布注意点。
> 页面中的指针为快照值,权威值以 `git submodule status` 为准。

## 索引

| 组件 | 生态位 | 角色 | 当前锁指针(8 位) | 页面 |
|---|---|---|---|---|
| [dsh-launcher](dsh-launcher.md) | L0 载体 | Windows 单文件安装 + 启动引导器(伞仓核心) | `322acc59` | [→](dsh-launcher.md) |
| [dsh-plugins](dsh-plugins.md) | L3 插件 | 社区插件合集(11 包 + install-* 技能,计划 11→7) | `15ffcfd7` | [→](dsh-plugins.md) |
| [dsh-vscode](dsh-vscode.md) | L4 周边 | VSCode 扩展(会话/聊天/工具卡片,已发布 Open VSX) | `65c25bab` | [→](dsh-vscode.md) |
| [dsh-desktop](dsh-desktop.md) | L4 周边 | Electron 桌面壳(连共享 dsh server) | `250abfbd` | [→](dsh-desktop.md) |
| [dsh-remote](dsh-remote.md) | L6 广域网 | Cloudflare Access 远程部署记录 | `4f755d23` | [→](dsh-remote.md) |
| [deepseek-harness](deepseek-harness.md) | L2 核心 | dsh 本体(官方上游,只读消费) | `47f94385` | [→](deepseek-harness.md) |

> 生态分层:见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) §1(L0–L6)与 §3(决策 D1–D8)。

## 相关文档

- 生态路线图 v3:[ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md)
- 发布流程:[RELEASING.md](../RELEASING.md)
- 工作日志:[WORKLOG.md](../WORKLOG.md)
- 代理手册:[.AGENT.md](../../.AGENT.md)
