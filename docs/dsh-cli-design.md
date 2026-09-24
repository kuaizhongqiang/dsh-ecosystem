# dsh-cli 设计草案 v3（归属模型 + out 契约 + 工具清单）

> 状态：**设计定稿 v5**（2026-09-24）。依据：主人的口头需求 + D1–D10 / Q1–Q8 / Q1′–Q6′ / Q4″ / 最后 4 条答复 + 对 dsh 上游能力的实测取证。
> v5 变化：新增 §6.4「分段契约：一步一条」；§2 补 agent 面输出规则；§10 改为「已全部拍板」。
> 施工计划见 [dsh-cli-execution.md](dsh-cli-execution.md)。

---

## 1. 为什么要做

dsh 相比 openclaw 这类 agent **缺的不是「干活」，而是「被编排」**——典型例子就是**没有定时任务**。

方向不是「在 dsh 里补调度器」，而是：**dsh 当发动机，openclaw 当调度台**。

- **把 dsh 变成可被另一个 agent 调用的执行体**；
- **谁来定时、跑什么、跑完汇报给谁 —— 交给 openclaw 那一侧**；
- dsh 侧只需要：**能被调用**（重点）、**能被查询状态**、**人能直接在 cmd 里用**（要有，非重点）。

## 2. 目标、前提与硬约束

**两个方面**：① cmd 界面（要有，非重点）；② 对外可编程调用面（重点，GET / POST 之类的工具接口）。

**两个验收场景**

- **场景 A**：openclaw 每小时查看 dsh 的工作情况，汇报给主人。
- **场景 B**：openclaw 每 12 小时让 dsh 执行指定任务，能**指定 provider / model / workplace**、能**新增 session**。

**前提与硬约束（主人已明确）**

1. **CLI 与 dsh 只在同一台机器上** → 不考虑多机/远程，传输与发现由设计者定；
2. **命令冲突时 CLI 让路**：命令名、子命令、参数都不得与 dsh 本体冲突；dsh 一旦占用同名命令，**CLI 让位改名**。故 CLI **不抢 `dsh`**，用自己的命令名；
3. **定时/调度归 openclaw**，dsh 侧不提供 `schedule.*`；
4. **CLI 是依托 dsh「接出来」的一层**：不 fork、不改 dsh 本体，子模块只读；
5. 凭证红线不变：token 不进仓库、不进日志、不进清单。

**已定参数**

- 命令名 **`dshcli`**，别名 **`dshc`**；
- 传输：**本机回环 HTTP + JSON**（单机前提，不需要跨网络安全设计）；
- 鉴权：**要**本机 token（本机可读的文件 + ACL，不进日志/仓库）；
- 任务时限：默认 **30 分钟**上限；超时**标记但继续跑**，不硬杀；取消 = 终止运行时（上游无 mid-turn cancel，局限写进文档）；
- 交付与托管：**独立 exe**（自包含，目标机不需要装 Node），**由 launcher 启动/托管**；同时保留手跑路径；
- **agent 面输出颗粒度**：**一步（step）一条**（见 §6.4）；
- **二进制**（图 / 音 / 视 / 3D / 附件）：**不输出内容**，只给引用（路径 + 类型 + 大小 + 摘要）；
- **推理内容**：发，标 `kind: 'reasoning'`，由调用方自行取舍；
- **超大文本**：照发不裁，附 `oversize` 标记 + 可按 `seq` 取原件；
- **净化 / 截取**：CLI **不做**；只保证结构清楚、字段稳定，怎么消费是调用方的事。

## 3. 先摆事实：dsh 上游已经有什么、缺什么

| 已经有的 | 说明 |
|---|---|
| dsh 自带命令行（命令名就是 `dsh`） | profile 切形态：`web` / **`headless`** / `sdk` / `acp` / `base` |
| `headless` | **一次性非交互执行**：给指令跑完返回；支持 stdin、JSON 事件流、指定 session、退出码 |
| SDK（Node + Python） | 程序里直接 `run(task)` 拿结果（stdio 协议） |
| ACP | 跨厂商 agent-to-agent 标准协议 |

| 确实缺的（= 我们要补的） | 影响 |
|---|---|
| **没有现成的「工具服务」形态** | 「另一个 agent 调 dsh」最通用的入口不存在 → **重点** |
| **没有跨进程的连接/凭证文件** | 「连到已经在跑的那个 dsh」做不到，只能每次另起 |
| **SDK 不能中途取消、结果与调用对不上号** | 长任务编排难受 → 我们用 §6 的 `out` 契约补 |
| **没有生态运维面** | 插件 / 凭证 / profile 日常操作都得手写命令 |

## 4. 已定决策（主人答复 → 设计结论）

| 编号 | 主人答复 | 设计结论 |
|---|---|---|
| D1 工具清单 | 先列一份，尽量多，后面商量怎么减 | §7 列 77 个候选，★ 为 P0 |
| D2 协议形态 | 单机，我来定 | 本机回环 HTTP + JSON + 本机 token |
| D3 provider/model/workplace | 能查能改 | E 组「查询 + 设置」成对出现 |
| D5 状态粒度 | 看工具设计 | C 组分三层：`status.*` → `report.*` → `artifact.*` |
| D6 event/hook/message | 我不熟，你来设计 | §8 |
| D7 兼容检测 | 按你的意思 | §9.1 |
| D8 上游跟随 | 关键是好改（不是自动化） | §9.2：单点适配层 + 契约快照 |
| D9 命令名 | `dshcli` | 采用 `dshcli`（+ 别名 `dshc`） |
| D10 先做什么 | 我来定 | 先做 §7 的 ★（跑通场景 A/B） |
| — 冲突让路 | CLI 给 dsh 让路 | §2 硬约束 2 |
| **Q1** | CLI 要记录「哪些 session 是 CLI 开的」；**不是 CLI 开的 session，在运行中 CLI 只能读不能写** | **§5 归属模型**（新） |
| **Q2** | CLI 可以给事件；有 run / run_async；但别的 agent 最终看 **out** | **§6 终结产出 out 契约**（新） |
| **Q3** | workplace = **session 所属的路径** | session 级属性；`session.new` 时指定 |
| **Q5** | 按我的来 | 本机 token 鉴权：要 |
| **Q6** | **单独 exe，launcher 可以启动** | 独立 exe + launcher 托管 |
| **Q7** | 按我的来 | 30 分钟上限 / 超时标记继续跑 / 取消=终止运行时 |
| **Q8** | 按我的来 | `dshcli` + 别名 `dshc` |
| **Q4** | 反问「report 是 bash 的 out 吗？」 | §6.3 已写清「汇报是什么」；只差选成文方式 |
| **Q1′** | 外来会话空闲时**允许**写；要认领动作 | §5.3/§5.5：空闲可写、运行中只读；保留 `session.adopt` |
| **Q2′** | 按我的来 | §6.2 的 `out` 形态定稿（同步 / 异步同形） |
| **Q3′** | 我对（单次任务不覆盖 workplace） | workplace 只在 `session.new` 时确定 |
| **Q5′** | 可以 | 归属记录丢失 → 回退「外来只读」；写保护**硬失败** + 明确原因 |
| **Q6′** | 是 | 自包含单文件 exe + launcher 拉起 `dshcli serve` + 支持手跑 |

## 5. 会话归属与写权限（Q1，新增）

**问题**：dsh 里同时存在「CLI 开的会话」和「别处开的会话」（web UI / VSCode / desktop / 人手动）。CLI 不能对后者乱写。

**设计**

1. **归属记录**：CLI 自己维护一份「CLI 开的会话」清单（本机文件，如 CLI 状态目录下的 `sessions.json`），每条记：`sessionId`、创建时间、创建者、用途备注、创建时的 dsh 版本。
2. **两种归属**：`owner=cli`（CLI 开的）/ `owner=foreign`（别处开的）。
3. **写权限规则**（核心）：
   - `owner=cli`：可读可写（下任务、续跑、插话、打断、删除）；
   - `owner=foreign`：**始终可读**（列表/详情/历史/产出/状态）；**运行中一律不可写**（你的原话：只能读不能写）；
   - 空闲的外来会话能否写 → 见 §10 Q1′。
4. **写类工具必须带归属与运行态判断**，判定失败返回**明确原因**（`readonly: session owned elsewhere` / `busy: session is running`），不静默降级。
5. **认领（adopt）**：提供一个显式动作，把外来会话**登记**给 CLI（登记后即 `owner=cli`）。否则「人在 web 里先建了会话、再想用 openclaw 驱动」这条路会被自己堵死 → 见 §10 Q1′。
6. **记录丢失的后果**：CLI 重装/换机后这份记录丢失 → 那些会话回退成 `owner=foreign`（只读）。这是**安全默认**，需在文档写明。

**写类工具一览**（清单中打 ⚠ 的都是受本规则约束的）：`task.run*`、`session.resume/interrupt/rename/delete/export`、`message.post`、`plugin.*`、`cred.*`、`runtime.*`、`config.set`、`model.set_default`、`workspace.set_default`。

## 6. 任务的终结产出 out（Q2，新增）

**你说的对**：事件是过程，**别的 agent 最终看的是 `out`**。所以契约要这么定：

### 6.1 out 是主，event 是辅

- **每个任务必须有终结性产出 `out`**：`task.run`（同步）直接返回它；`task.run_async` 拿 `taskId`，随后用 `task.get` / `task.out` / `event.poll` 最终拿到**同一个** `out`；
- **`out` 同形**：同步与异步的 `out` 结构完全一致，调用方写一套解析就够；
- 事件里**必有终态事件**（携带 `out` 的引用或内容），这样订阅方不会「等不到头」。

### 6.2 out 的形态（草案）

`out` = 结构化结果 + 可读文本 + 产出物引用 + 用量 + 错误：

| 字段 | 说明 |
|---|---|
| `status` | `ok` / `failed` / `timeout` / `cancelled` / `readonly` / `unavailable` |
| `text` | 任务最终答案（人/其他 agent 直接读这段） |
| `artifacts[]` | 产出物（路径、类型、摘要），便于「看图/看文件」 |
| `sessionId` / `taskId` | 溯源 |
| `usage` | token / 费用（有多少给多少） |
| `error` | 失败时的可读原因 + 机器可判的 code |
| `degraded[]` | 本次执行中 CLI 的降级/缺能力提示（见 §9.1） |

### 6.3 「汇报」到底是什么（Q4，主人要求说清）

**一句话**：汇报 = 一段**给主人看的、说「dsh 这段时间干了什么」的话**。

它由两段拼起来：

**① 素材（facts）** —— 客观事实，机器可读：

- **正在跑**什么（哪个会话 / 任务、跑了多久、卡在哪一步）
- **完成了**什么（任务、结果 `out`、改了什么）
- **失败了**什么（原因）
- **需要人处理**什么（缺凭证、要审批、要决策）
- **产出了**什么（文件 / diff / 链接）
- **花了多少**（token / 费用）

**② 成文（text）** —— 把素材写成人能读的一段话。

**素材从哪来**：dsh 的会话与任务事件（每一次工具调用及其输出、每一轮的结果）—— **不是**某条 bash 命令的 stdout，**也不是**某个任务的 `out`（`out` 是「一个任务的产出」，汇报是「一段时间里所有事的汇总」，两者是父子关系）。

**谁负责把它写成话 —— 三种，你挑一种或都要**：

| 方式 | 谁写 | 特点 | 工具 |
|---|---|---|---|
| (a) 只给素材 | 你 / openclaw 自己组织语言 | 最灵活、零模型成本；汇报口吻由 openclaw 决定 | `report.facts` |
| (b) 模板成文 | CLI 套固定格式 | 确定性强、稳定、零模型成本 | `report.digest` |
| (c) 模型成文 | dsh 跑一次「总结任务」 | 最像人写的、能讲清来龙去脉；花一次模型调用 | `report.narrate` |

**(b) 模板成文长这样**

```
【dsh 工作汇报 09-24 14:00→15:00】
在跑：1 个会话（session-8f3a「重构 auth 模块」，已 12 分钟）
完成：2 个任务
  - 14:12 修复 stock 时间判断 → ok（改 3 文件，+120/−18）
  - 14:41 给出图插件补测试 → ok（新增 1 个测试文件）
失败：0
要你处理：1 项 —— 14:41 的任务缺 ARK_API_KEY，需你确认走方舟还是复用中转 key
产出：plugins/stock/index.js、scripts/verify-image.mjs
用量：本小时 12.4 万 token，≈¥0.42
```

**(c) 模型成文长这样**

```
这一小时主要在收尾股票插件的时间判断：14:12 把定稿守卫的边界挪到 15:05，并修掉了时钟回拨导致的挂死，
三个文件共动了约 120 行；14:41 转去给出图插件补测试，但卡在缺火山方舟的 key，需要你确认走方舟还是
复用中转网关那把。另有一个「重构 auth 模块」的会话正在跑，已经 12 分钟。
```

**投递不归 dsh 管**：dsh 只负责产出素材 / 成文；「什么时候发、发给谁、用什么口吻」由 openclaw 决定（它才是跟主人说话的那个）。

**与场景 A 的关系**：openclaw 每小时醒来 → 调 `report.facts`（可带 `since=` 取增量）→ 自己组织语言或直接用 `report.digest` / `report.narrate` 的成稿 → 汇报给主人。

### 6.4 分段契约：agent 面「一步一条」（主人拍板）

**颗粒度 = 一步（step）**，与 dsh 轨迹视图的「第 X 轮 · 第 N 步」同源（`packages/client/ui-trajectory`；`session.md:44` 定义 step = **一次模型调用，加上它请求执行的那些工具**）。

**一条记录的内容**

| 字段 | 说明 |
|---|---|
| `turn` / `step` | 轮号 / 步号（与 webui 同一套编号） |
| `seqRange` | 本条覆盖的事件序号区间 `[start, end]` —— 断点续取的锚点 |
| `kind` | `step`（正常一步）/ `between`（轮次之间的非步事件）/ `reasoning`（推理内容） |
| `cells[]` | 该步的单元：assistant 内容块、`tool/call` + `tool/result`（成对） |
| `usage` | 该步的 token 计量（有就给） |
| `refs[]` | 二进制 / 超大内容的**引用**（见下），不塞内容 |

**三条硬规则**

1. **不裁**：一步内的文本原样给，不做截断、不做摘要、不做"友好化"；
2. **不塞二进制**：图 / 音 / 视 / 3D / 附件只给引用 `{ path, mime, bytes }`，要内容自己取（`artifact.get`）；
3. **不丢事件**：不属于任何步的事件（压缩 `compaction/*`、`hook/invoked`、`agent/inbox/spliced`、轮级事件）以 `kind: 'between'` 发出，别静默吞掉。

**超大文本**：照发（守规则 1），同时给 `oversize: true` + `seq`，调用方想省流量可按 seq 自取原件。

**为什么不能偷懒用上游 `headless --json`**：它的投影**是裁的** —— 每个字符串/键上限 8KiB、每条事件行 32KiB、深度上限 64，极端情况下只剩 `{ type, truncated: true }`；**只有最终答案 `final` 不裁**（`packages/bundle/headless/src/json-stream.ts:16,19,66,323`）。所以本契约**直接吃会话事件日志**（唯一真源），不经过 headless 投影。

**与 `out` 的关系**：CLI 的一次调用 ≈ 一轮（`turn`）；`out` = 那一轮的终结产出；分段记录是过程中的逐步输出。两者都以 §6.2 的 `out` 形态收口。

## 7. 工具清单（**78 个候选**，★ = P0 先做，⚠ = 受 §5 写权限约束）

> 这 78 个 = 下表 A–I 各组之和。**实现状态以代码为准**：`dshcli tools`（或 `toolCatalog()`）实时列，
> ● 已实现 / ○ 未实现；2026-09-24 首次发布（v0.11.0）时点 = **已实现 28 / 待实现 50**。

> 命令名 `dshcli`；同名工具同时给 cmd 用（`dshcli 组 名`）。

### A. 任务（11）

| 工具 | 一句话 |
|---|---|
| ★ `task.run` | 下达任务并等它跑完，直接回 `out` |
| ★ `task.run_async` | 下达任务立即返回 `taskId`（长任务用） |
| ★ `task.get` | 查任务状态 / 进度 / 结果 |
| ★ `task.out` | **只取任务的终结产出 `out`**（其他 agent 常用这个） |
| ★ `task.wait` | 阻塞等任务完成（可设超时） |
| ★ `task.list` | 列任务（按状态 / 时间过滤） |
| ⚠ `task.cancel` | 取消任务（= 终止运行时） |
| `task.log` | 取任务原始事件记录 |
| `task.retry` | 同参数重跑一次 |
| `task.follow` | 持续跟随任务事件（流式） |
| `task.plan` | 只让 dsh 出计划不执行（可选，评审用） |

### B. 会话（11）

| 工具 | 一句话 |
|---|---|
| ★ `session.new` | 新建会话（指定 provider / model / workplace / preset）→ `owner=cli` |
| ★ `session.list` | 列会话（含归属、是否在跑） |
| ★ `session.get` | 会话详情（配置 / 统计 / 状态 / 归属） |
| ★ `session.resume` | 往指定会话继续下任务 ⚠ |
| ★ `session.history` | 回合 / 消息 / 工具调用历史 |
| ⚠ `session.adopt` | **认领**外来会话，登记为 CLI 所有（§5.5） |
| ⚠ `session.rename` | 重命名会话 |
| ⚠ `session.interrupt` | 打断当前回合 |
| ⚠ `session.fork` | 从某会话分叉出新会话 |
| ⚠ `session.export` | 导出会话归档 |
| ⚠ `session.delete` | 删除会话 |

### C. 工作情况 / 汇报（10）

| 工具 | 一句话 |
|---|---|
| ★ `status.overview` | 整体状态：在跑吗 / 几个会话 / 最近干了什么 |
| ★ `status.health` | 健康检查（进程 / 端口 / 插件 / 凭证） |
| ★ `status.compat` | 兼容状态：哪些工具可用 / 降级 / 不可用 |
| ★ `report.facts` | **汇报素材（机器可读）**：在跑 / 完成 / 失败 / 待人处理 / 产出 / 用量；可带 `since=` 取增量（每小时汇报就用它） |
| ★ `report.digest` | **汇报成文（模板）**：把素材套成人能读的一段话（零模型成本，§6.3 方式 b） |
| `report.narrate` | **汇报成文（模型）**：让 dsh 跑一次总结任务写成叙述式（花一次模型调用，§6.3 方式 c） |
| `stats.usage` | token / 费用统计 |
| `stats.activity` | 活跃度：谁跑了多久、卡在哪 |
| `stats.tools` | 工具调用统计（用得最多 / 失败最多） |
| `report.daily` | 日报（按天汇总的固定形态；`report.facts/digest` 带 `since` 已能顶，故排后） |

### D. 产出物（5）

| 工具 | 一句话 |
|---|---|
| ★ `artifact.list` | 某会话 / 任务的产出文件清单 |
| ★ `artifact.diff` | 代码改动 diff（dsh 改了什么） |
| `artifact.get` | 取产出物内容 / 路径 |
| `artifact.open` | 在本机打开产出物 |
| `artifact.publish` | 把产出物导出到指定目录 |

### E. 配置 / 元信息（12，查 + 改成对）⚠ 设置类受写权限约束

| 工具 | 一句话 |
|---|---|
| ★ `provider.list` | 有哪些 provider 可用 |
| ★ `model.list` | 有哪些 model 可用（可按 provider 过滤） |
| ★ `workspace.list` | 有哪些 workplace 可用 |
| ★ `config.get` | 读当前默认配置 |
| ⚠ `config.set` | 改默认配置 |
| `provider.get` | provider 详情（能力 / 默认 model） |
| `model.get` | model 详情（上下文长度 / 价格） |
| ⚠ `model.set_default` | 设默认 model |
| `workspace.get` | workplace 详情（存在性 / 是否 git / 大小） |
| ⚠ `workspace.set_default` | 设默认 workplace |
| `preset.list` | 有哪些 agent preset |
| `preset.get` | preset 详情 |

### F. 插件 / 技能 / 生态（9）⚠

| 工具 | 一句话 |
|---|---|
| `plugin.list` | 已装插件 + 状态 |
| ⚠ `plugin.install` | 装插件（走生态清单） |
| ⚠ `plugin.remove` | 卸载插件 |
| ⚠ `plugin.reload` | 重载插件（上游结论：改动后建议重启） |
| `skill.list` | 已装技能 |
| ⚠ `skill.install` | 装技能 |
| ⚠ `skill.remove` | 删技能 |
| ⚠ `ecosystem.pull` | 按清单拉齐（生态全家桶） |
| `ecosystem.status` | 清单与版本漂移检查 |

### G. 凭证（5，只回名字与状态，永不回值）⚠

| 工具 | 一句话 |
|---|---|
| `cred.list` | 有哪些凭证（只有名字） |
| ⚠ `cred.set` | 写入凭证 |
| `cred.verify` | 验证凭证可用 |
| ⚠ `cred.unset` | 删除凭证 |
| `cred.where` | 这个凭证被哪些插件在用 |

### H. 运行时 / 运维（8）

| 工具 | 一句话 |
|---|---|
| ★ `runtime.status` | 运行时在不在跑（进程 / 端口 / 版本） |
| ★ `runtime.version` | 版本信息（dsh / CLI / 插件 / pin） |
| ⚠ `runtime.start` | 启动运行时 |
| ⚠ `runtime.stop` | 停止运行时 |
| ⚠ `runtime.restart` | 重启（复用 launcher 的重启 seam） |
| `runtime.logs` | 运行时日志 |
| ⚠ `runtime.upgrade` | 升级 dsh 本体 / CLI |
| `compat.check` | 手动跑一次兼容检测（doctor 的机器版） |

### I. 事件 / 回调 / 消息（7）

| 工具 | 一句话 |
|---|---|
| ★ `event.poll` | 拉增量事件（简单可靠，先做这个） |
| `event.subscribe` | 订阅事件（流式，第二步） |
| ⚠ `hook.set` | 注册回调地址（HTTP 回调） |
| `hook.list` | 列回调 |
| ⚠ `hook.delete` | 删回调 |
| ⚠ `message.post` | 往会话里投一条消息（插入指令） |
| `message.outbox` | 取「待汇报给人的消息」 |

### J. 明确不做（1，**不计入上面 78 个候选**）

| 工具 | 说明 |
|---|---|
| `schedule.*` | **不提供**。定时归 openclaw，dsh 侧只执行 —— 写进文档，避免以后误以为漏了 |

**统计**：候选 **78 个**（A 11 + B 11 + C 10 + D 5 + E 12 + F 9 + G 5 + H 8 + I 7），★ P0 = 25 个；
其中 v0.11.0 时点已实现 **28**、待实现 **50**（分组缺口见 `docs/dsh-cli-execution.md` P5）。

## 8. event / hook / message（由我设计）

| 概念 | 是什么 | 谁消费 | 草案形态 |
|---|---|---|---|
| **event** | 任务进行中的状态变化（开始 / 工具调用 / 产出 / 结束 / 失败） | 调用方主动取 | 先 `event.poll`（带游标拉增量，不怕断线），再 `event.subscribe`（长连接） |
| **hook** | 关键节点主动通知你，不用轮询 | 调用方注册的地址 | `hook.set` 注册 HTTP 回调：完成 / 失败 / 需审批 / 长时间无进展 |
| **message** | 真正要给人看的文本 | 主人（经 openclaw 转） | 结构化文本 + 来源标注；`report.*` 生成、`message.outbox` 取 |

**取向**：先把「可拉取」做扎实（`event.poll` + `report.*` + `task.out`），再上「主动推」（hook / subscribe）。理由：拉取不怕断线、好排障，且 openclaw 本来就是定时醒来的调度模型。

## 9. 兼容检测（D7）与「好改」（D8）

### 9.1 兼容检测与告警

- 把「CLI 依赖 dsh 的哪些命令 / 接口 / 字段」做成一张**断言表**；
- **启动时自检** + **每次调用前轻量探测**；
- 某工具因上游变化不可用 → **明确输出**：哪个工具不可用、缺什么、当前 dsh 版本；
- 两种读法：人看 `dshcli doctor`；机器看返回里的 `degraded[]`（也随 `out` 返回，见 §6.2）；
- 处置：**默认降级执行 + 告警**；只有关键工具（`task.run`、`session.new`）不可用才拒绝执行。

### 9.2 「跟随上游的关键是好改」

1. **单点适配层**：所有对 dsh 的引用（命令 / 参数 / 字段 / 事件名）集中在一个 adapter + 一张映射表，上游变了只改这里；
2. **契约快照**：把依赖的上游行为固化成可自动跑的样例（golden），更新后一条命令看红绿；
3. **降级优先于崩溃**；
4. **不猜**：缺什么报什么，不做猜测式兼容。

## 10. 已全部拍板

D1–D10、Q1–Q8、Q1′–Q6′、Q4″，以及最后 4 条（分段颗粒度 / 二进制不输出 / 推理内容要发 / 超大文本照发）**均已确定**，无需再答。

## 11. 下一步（施工）

见 [dsh-cli-execution.md](dsh-cli-execution.md)：里程碑 + issue 拆分、阶段验收、分支 / PR 规则、发布接入（沿用现有流水线）。
