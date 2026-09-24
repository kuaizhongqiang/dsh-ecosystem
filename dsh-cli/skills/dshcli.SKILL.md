---
name: dshcli
description: 用 dshcli 命令行「让别的 agent 调 dsh 执行任务」或「人直接跑 dsh 任务 / 看工作情况」。dshcli 是 dsh-cli（L1.5 入口层）的自包含 exe：本机工具服务 + 两层命令（主命令 + 全工具面）。当你要用 dsh 跑任务、取任务终结产出 out、看会话分段记录、做工作汇报，或要在命令行里调 dsh 的任意工具时使用。
whenToUse: 用户说「用 dsh 跑一下…」「让 dsh 做…」「看看 dsh 现在在干什么」「汇报一下工作」「把任务派给 dsh」，或你要在脚本 / 自动化里调用 dsh、把 dsh 接进定时调度时使用。定时/调度本身不归 dsh（归调用方），dshcli 只负责执行与查询。
---

# dshcli —— 用 dsh 跑任务 / 让别的 agent 调 dsh

## 它是什么

`dshcli` 把 dsh 包成**可被编排的执行体**：dsh 只管**执行**与**查询**，定时、调度、汇报给谁归调用方（openclaw 等）。

- 数据源是 **dsh 的会话事件日志**（唯一真源），不是 `dsh --profile headless --json` 的投影
  —— 后者**会裁**（字符串 8KiB、事件行 32KiB、深度 64），而本工具**不裁**。
- 文件就在 `dshcli.exe` 旁边（本文件即技能说明）；`dshcli skill` 可随时重新打印。

## 先做三件事

```sh
dshcli doctor            # 环境 + 上游契约自检（缺什么会明说，别跳）
dshcli tools             # 78 个工具清单（● 已实现 / ○ 未实现）
dshcli tools task.run    # 看某个工具的参数、返回契约、实现状态
```

## 两层命令

### 层 1：主命令（短开关是别名，只能在第一位）

| 命令 | 短开关 | 干什么 |
|---|---|---|
| `dshcli run <任务…>` | | 跑任务，直接回 `out`（`--json` 给结构化） |
| `dshcli continue <任务…>` | `-c` | 续跑会话（默认最近一个；`-S <会话id>` 指定） |
| `dshcli list [tasks\|sessions\|all]` | `-l` | 列任务 / 会话 |
| `dshcli info [会话id]` | `-i` | 会话详情 + 最近几步分段 |
| `dshcli report [--since ISO]` | `-r` | 工作情况汇报（「这一小时」就这么取） |
| `dshcli tools [工具]` | `-t` | 工具清单 / 单工具参数 |
| `dshcli call <工具> --args '{"…":…}'` | | 直调任意工具（兜底） |
| `dshcli serve [--port N]` | `-s` | 起本机工具服务（给别的 agent 用） |
| `dshcli status` | | 运行时 / 任务 / 会话概览 |
| `dshcli doctor` | | 自检 |
| `dshcli version` | `-v` | 版本（dshcli / dsh / 契约表） |
| `dshcli skill [--install\|--where]` | | 本技能：打印 / 落盘 / 查状态 |

通用修饰符（**只在子命令之后**）：`-j/--json`、`-m/--model`、`-p/--provider`、`-w/--workplace|--cwd`、`-n/--limit`。

### 层 2：全工具面（78 个，参数由元数据生成）

```sh
dshcli task run "把 README 里过期的版本号改掉" -w F:\Project\x -p deepseek -m deepseek-chat
dshcli session list -n 5 --json
dshcli session history -S session-xxxx --json -n 20
dshcli stats tools --since 2026-09-24T00:00:00Z --json
```

- 每个工具的用法：`dshcli tools <工具名>`；未实现的工具（清单里 ○）调用会明确报 `not_implemented`。
- **`GET /tools`** 返回带参数声明的自描述清单 —— 起 `dshcli serve` 后，调用方不用读文档就能发现参数。

## 机器面契约（agent 主要看这段）

- **`--json` 一律无损 JSON**（不带 undefined、不带空壳）；解析失败就是真失败，不要靠字符串猜。
- **退出码**：`0` 成功；`1` 用法错误或任务失败（失败时 `out.status` 会是 `failed` / `timeout`，且带 `error.code`）。
- **任务有终结产出 `out`**：`{ status, text, artifacts[], usage, error, degraded[] }`；同步与异步**同形**，只认 `out` 即可。
- **第一接触命令（`-h` / `-i` / `-v` / `doctor`）会给 `hint.skill`**（本文件的绝对路径）—— 拿到路径就该读它。

## 三条硬规则（别越界）

1. **归属**：CLI 记录「哪些会话是 CLI 开的」。**外来会话永远可读；正在跑的一律不可写**，越界会**硬失败**并给 `readonly` 原因 —— 不要绕过、不要重试成攻击式写入。空闲的外来会话可写，也可 `session.adopt` 显式认领。
2. **`out` 是主、事件是辅**：要结果用 `out`；要看过程用 `session.history` / `event.poll`（按 `cursor` 增量，断了不怕）。
3. **输出不裁、不塞二进制**：9000 字长文本原样返回；二进制只给引用路径。

## 怎么装 / 怎么升级

- 有 launcher 时：`launcher_cli {action:'install'|'update'|'start'}`（安装/升级 dsh-cli 并拉起服务）。
- 手动：从 dsh-ecosystem 的 Release 下 `dshcli.exe` 放到 `%DSH_HOME%\bin\`；本技能紧随其旁。
- 升级后建议 `dshcli skill --where` 看技能是否与 exe 内嵌版本一致（不一致就跑 `dshcli skill --install` 刷新）。

## 排查

- `dshcli doctor` 输出里 **`degraded[]` 非空** = 上游事件字段/词表变了，看它点名的那一项 —— 不要自己去猜上游格式。
- `dshcli status` 的 `runtime.running=false` = dsh 本体没在跑（`run` 仍能工作，它直接起 headless 执行）。
- 写不进去/`readonly` = 目标会话是外来且运行中（见规则 1）。
