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

## 用法（cmd 面）：两层

**层 1 主命令**（短开关是别名，**只能在第一位**）：

| 命令 | 短开关 | 干什么 |
|---|---|---|
| `dshcli run <任务…>` | | 跑任务，直接回 `out` |
| `dshcli continue <任务…>` | `-c` | 续跑会话（默认最近一个，`-S <会话id>` 指定） |
| `dshcli list [tasks\|sessions\|all]` | `-l` | 列任务 / 会话 |
| `dshcli info [会话id]` | `-i` | 会话详情 + 最近几步 |
| `dshcli report [--since ISO]` | `-r` | 工作情况汇报 |
| `dshcli tools [工具]` | `-t` | 工具清单 / 单工具参数 |
| `dshcli call <工具> --args '{"…":…}'` | | 直调任意工具（兜底） |
| `dshcli serve [--port N]` | `-s` | 起本机工具服务 |
| `dshcli status` / `doctor` / `version` | `-v` | 概览 / 自检 / 版本 |
| `dshcli skill [--install\|--where]` | | 技能说明：打印 / 落盘 / 查状态 |
| `dshcli help` | `-h` | 分组帮助 |

通用修饰符（**只在子命令之后**）：`-j/--json`、`-m/--model`、`-p/--provider`、`-w/--workplace|--cwd`、`-n/--limit`。

**层 2 全工具面**（78 个，由 `src/tools.js` 的参数元数据自动生成）：

```sh
dshcli session list -n 5 --json
dshcli session history -S session-xxxx -n 20
dshcli task run "把 README 里过期的版本号改掉" -w F:\Project\x -p deepseek -m deepseek-chat
dshcli tools cred.set            # 看参数/契约/实现状态
dshcli call session.list --args '{"limit":5}'   # JSON 兜底
```

撞名规则（`report` / `status` / `skill` 既是主命令又是工具组）：第二个词能匹配到该组工具就走层 2
（`dshcli report facts`），否则走主命令（`dshcli report --since …`）。

## 技能说明（跟着 exe 走）

技能正文在 `skills/dshcli.SKILL.md`，**构建时内嵌进 exe**，运行时与 `dshcli.exe` **同级**
（`dshcli.SKILL.md`）；首次运行自动落一份。第一接触命令会提示先读它：

```sh
dshcli -h            # 末尾：提示 + 技能绝对路径
dshcli -h --json     # hint.skill = <绝对路径>
dshcli skill         # 直接打印
dshcli skill --where # 路径 / 是否落盘 / 与内嵌是否一致（不一致会提醒刷新）
```

launcher 装 / 升级 dsh-cli 时会顺带调 `dshcli.exe skill --install`（`skill:false` 可关）。

### 层 2 示例（等价写法）

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
node scripts/verify-cli.mjs      # 66 项：多帧 zstd / 会话读取 / 分段契约 / 归属 / out / 桩 dsh 端到端 / HTTP / CLI / 契约快照
```

不触网、不需要装 dsh —— 执行链用一个「自己写会话日志的桩 dsh」跑通。

## 装与升级

**人用**（launcher 侧有入口，推荐）：

| 动作 | 怎么调 |
|---|---|
| 看是否已装 / 版本 | `launcher_cli {action:'status'}`（launcher 插件工具） |
| 安装 | `launcher_cli {action:'install'}` —— 从伞仓 Release 取 `dshcli.exe` 落到 `%DSH_HOME%\bin\`；可给 `version` 或本地 `from` |
| 升级 | `launcher_cli {action:'update'}` —— 版本不同才替换，旧 exe 自动备份 |
| 起服务 | `launcher_cli {action:'start'}` 或直接 `dshcli serve` |

**npm**：`npx @kuaizhongqiang/dsh-cli version`（需要 Node ≥ 22.19 / 24）。

**自己构建**（要出 exe 时）：

```sh
npm install            # devDeps: esbuild + postject
npm run build:exe      # → dist/dshcli.exe（自包含，90MB 级）+ dist/dshcli-<ver>.exe
```

发布跟随伞仓全量 tag：`vX.Y.Z` 时 CI 的 `build-dsh-cli` job 会跑质量门 → 构建 exe → 上传
`dshcli.exe` 与 `dshcli-<ver>.exe` → 发 npm（`NPM_TOKEN` 存在时）。

## 已知限制（本阶段）

- `report.narrate` / `artifact.diff` 等仍为 `not_implemented`（工具清单里打 `○`）；
- 取消 = 终止本次运行（上游没有 mid-turn cancel）；
- 失败判定目前只看 `error`/`isError`/`ok`/`status` 字段，上游把结果放在 `data.message` 里，失败语义待校准。
