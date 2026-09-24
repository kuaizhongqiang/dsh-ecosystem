# dsh-cli —— 用 dsh 跑任务 / 让别的 agent 调 dsh

> 生态位 **L1.5 入口层**（与 L0 的 launcher 并列）。设计定稿见 [docs/dsh-cli-design.md](../docs/dsh-cli-design.md)，
> 施工计划见 [docs/dsh-cli-execution.md](../docs/dsh-cli-execution.md)。

## 它解决什么

dsh 相比 openclaw 这类 agent **缺的不是「干活」，而是「被编排」**（典型：没有定时任务）。
dsh-cli 的定位是**接出来的一层**：

- **dsh 当发动机，openclaw 当调度台** —— 定时、跑什么、汇报给谁归调用方；
- dsh 侧只做三件事：**能被调用**（工具面）、**能被查询状态**（工作情况/分段记录）、**人能直接在 cmd 里用**。

## 命令名

`dshcli`（别名 `dshc`）。**不叫 `dsh`** —— 上游已占用该命令，按设计约定「命令冲突时 CLI 让路，一切以 dsh 本体优先」。

## 用法（cmd 面）

```sh
dshcli run "把 README 里的过期版本号改掉" --cwd F:\Project\xxx   # 跑一个任务，直接给 out
dshcli report --since 2026-09-24T00:00:00Z                       # 工作情况汇报（默认给人读）
dshcli status                                                    # 运行时 / 任务 / 会话概览
dshcli doctor                                                    # 环境与上游契约自检
dshcli tools                                                     # 工具清单（含未实现的）
dshcli sessions | dshcli tasks                                   # 列会话 / 列任务
dshcli call session.history --args "{\"sessionId\":\"session-xxx\"}"
dshcli serve                                                     # 起本机工具服务（给别的 agent 用）
```

`--json` 一律给机器可读的无损 JSON；不加则给人读。

## 对外调用面（重点）

本机回环 HTTP（`127.0.0.1`）+ 本机 token（`%DSH_HOME%/dsh-cli/endpoint.json`，不进仓库/日志）：

```sh
dshcli serve
# → http://127.0.0.1:<port>
curl -H "authorization: Bearer <token>" http://127.0.0.1:<port>/tools
curl -H "authorization: Bearer <token>" -H "content-type: application/json" \
     -d '{"prompt":"总结今天的改动","cwd":"F:\\Project\\x","provider":"deepseek","model":"deepseek-chat"}' \
     http://127.0.0.1:<port>/call/task.run
```

也可直接在 Node 里 `import { callTool } from '@kuaizhongqiang/dsh-cli'` 用同一套工具，不必起服务。

## 三条硬规则（设计 §5 / §6）

1. **归属**：CLI 记录「哪些 session 是 CLI 开的」。**外来会话始终可读；运行中一律不可写**，越界**硬失败**并说清原因（`readonly`）。空闲的外来会话可写，也可用 `session.adopt` 显式认领。
2. **`out` 是主、event 是辅**：每个任务都有终结产出 `out`（`status` / `text` / `artifacts` / `usage` / `error` / `degraded`），同步与异步**同形**。
3. **分段契约（一步一条）**：按 dsh 轨迹视图的「第 X 轮 · 第 N 步」发记录（`kind: step|between|reasoning` + `seqRange` + `cells` + `usage`），**不裁**（9000 字长文本原样保留）、**不塞二进制**（只给引用）、**不丢事件**（轮次之间的事件走 `between`）。

> 为什么不用 `dsh --profile headless --json` 当数据源？它**是裁的**：每个字符串/键 8KiB、每条事件行 32KiB、深度 64，极端情况只剩 `{type, truncated:true}`（只有最终答案不裁）。所以 dsh-cli **直接读会话事件日志**（`%DSH_HOME%/sessions/**/session.jsonl.zstd`，多帧 zstd —— Node 原生只解第一帧，我们逐帧解）。

## 上游跟随（设计 §9）

- **单点适配层**：所有对 dsh 的引用集中在 `src/dsh.js`（含依赖断言表 `CONTRACT`）；
- **契约自检**：`dshcli doctor` / 工具 `compat.check`，失败时给出「哪个能力不可用 + 缺什么」并进 `out.degraded`；
- **不猜**：缺什么报什么，不做猜测式兼容。

## 质量门

```sh
node scripts/verify-cli.mjs      # 51 项：多帧 zstd / 会话读取 / 分段契约 / 归属 / out / 桩 dsh 端到端 / HTTP / CLI
```

不触网、不需要装 dsh —— 执行链用一个「自己写会话日志的桩 dsh」跑通。

## 已知限制（本阶段）

- `report.narrate` / `artifact.diff` 等仍为 `not_implemented`（工具清单里打 `○`）；
- 取消 = 终止本次运行（上游没有 mid-turn cancel）；
- 失败判定目前只看 `error`/`isError`/`ok`/`status` 字段，上游把结果放在 `data.message` 里，失败语义待校准。
