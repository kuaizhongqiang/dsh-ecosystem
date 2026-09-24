# dsh-cli 执行文档（施工计划）

> 设计定稿：[dsh-cli-design.md](dsh-cli-design.md) —— 本文只讲「怎么干」。
> 工作方式：**里程碑 + issue + PR + merge**；**提交推送按阶段做**（禁碎提交）。
> 发布：**沿用现有流水线**（[RELEASING.md](RELEASING.md)：一个 `vX.Y.Z` tag 全量发布）。

---

## 1. 交付物

新组件目录 **`dsh-cli/`**（生态位 **L1.5 入口层**，与 L0 的 launcher 并列），产出两样东西：

| 产物 | 说明 |
|---|---|
| `dshcli.exe` | **自包含单文件**（目标机不需要装 Node），随伞仓 Release 发布 |
| npm 包 `@kuaizhongqiang/dsh-cli` | `bin: dshcli`（别名 `dshc`） |

目录结构（规划）：

```
dsh-cli/
├── package.json / tsconfig.json / README.md
├── src/
│   ├── index.ts              # CLI 入口（commander）：dshcli <组> <名>
│   ├── commands/             # cmd 面子命令（run / status / doctor / serve / version ...）
│   ├── serve/                # 对外调用面：本机回环 HTTP + token
│   │   ├── server.ts
│   │   └── tools/            # 工具定义（与 dsh 工具同构：presentCall/presentResult）
│   ├── adapter/              # ★ 单点适配层（所有对 dsh 的引用都在这）
│   │   ├── dsh-adapter.ts    # 连接/拉起 dsh、读会话事件、调 SDK
│   │   ├── contract-map.ts   # 上游命令/字段/事件名 → 我方映射表
│   │   └── snapshot/         # 契约快照（golden）
│   ├── step/                 # 分段契约：轮/步/单元 → step record（design §6.4）
│   ├── ownership/            # 会话归属记录（design §5）
│   └── state/                # 本机状态：endpoints.json / sessions.json（不含明文 token）
├── scripts/                  # 质量门：verify-cli-*.mjs（桩 + 不触网）
└── tests/
```

## 2. 里程碑与 issue 拆分

**里程碑**：`dsh-cli`（一个）。

| issue | 阶段 | 标题（拟） | 验收（一句话） | 依赖 |
|---|---|---|---|---|
| **E** | — | [EPIC] dsh-cli：把 dsh 接成可被 openclaw 调度的执行体 | 场景 A / B 端到端跑通 | — |
| **T1** | P0+P1 | 骨架 · 连接 · 归属 · 会话与任务 | **场景 B** 跑通：新建 session（provider/model/workplace）→ 跑多步任务 → 拿 `out`；对外来运行中 session 写入被明确拒绝 | E |
| **T2** | P2 | 分段输出契约（一步一条 · 不裁 · 事件不丢） | 一个多步任务的输出可按步完整读出，且能从任意 `seq` 续取 | T1 |
| **T3** | P3 | 工作情况与汇报 | **场景 A** 跑通：一条命令拿到「这一小时」的结构化素材 + 人读汇报 | T2 |
| **T4** | P4 | 兼容检测与上游跟随 | 仿真「上游改字段」时，明确报出哪个工具不可用 + 原因 + 版本 | T1 |
| **T5** | P5 | 运维面 + launcher 托管（**含安装 / 更新入口**） | launcher 能安装 / 检查更新 / 升级 dsh-cli 并拉起注册；插件/凭证能查能改 | T1 |
| **T6** | P6 | 发布接入（沿用现有流水线） | CI 全绿 + Release 资产含 `dshcli-<ver>.exe` + npm 版本一致 | T5 |

## 3. 阶段明细

### P0 骨架与连接

- **范围**：包骨架（esbuild 构建链）、`adapter/` 骨架、**连接「已在跑的 dsh」**（读 launcher 注册文件 + 本机 `endpoints.json` + 本机 token）、`dshcli version` / `status` / `doctor`（最小兼容探测）、质量门脚本骨架、CI 构建 job 骨架。
- **验收**：有实例 / 无实例两种情况下 `doctor` 判断正确；`version` 能打 dsh / CLI / pin 三个版本。

### P1 会话与任务（场景 B）

- **范围**：`session.new|list|get|resume|history|adopt`、`task.run|run_async|get|out|wait|list|cancel`、**归属 registry**（`owner=cli|foreign`、运行中只读、硬失败 + 明确原因）、provider / model / workplace 透传、错误码与 §6.2 的 `out` 契约。
- **验收**：以 openclaw 视角写一个脚本 —— 新建 session（指定 provider / model / workplace）→ 下发多步任务 → 拿到 `out`；对**外来且运行中**的 session 写入 → 返回明确 `readonly`。

### P2 分段输出契约（design §6.4）

- **范围**：step record 投影（`step` / `between` / `reasoning` + `seqRange` + `cells[]` + `usage`）、二进制只给引用、超大文本照发 + `oversize` + 按 `seq` 取原件、`event.poll` 游标续取。
- **验收**：多步任务按步可读、**不裁**、**事件不丢**（含压缩 / hook / inbox 这类轮次间事件）；从中途 `seq` 能续取。

### P3 工作情况与汇报（场景 A）

- **范围**：`status.overview|health|compat`、`report.facts(since)` / `report.digest` / `report.narrate`（可选）、`artifact.list|diff`、`stats.*`。
- **验收**：一条命令产出「这一小时」的结构化素材 + 人读汇报文本（样例见 design §6.3）。
- **状态（2026-09-24 / v0.11.0）**：**已落地** —— `dshcli report [--since]` = `report.facts` + `report.digest`（模板成文，零模型成本）；
  `report.narrate`（模型成文）已实现但默认不启用；`stats.usage|tools|activity` 跨会话聚合（带 `since` 窗口与 `limit`）；
  `artifact.diff` 给真实 `git diff`；`report.facts` 带 `sessionsActive`（含 web/vscode 里跑的会话）。

### P4 兼容检测与上游跟随

- **范围**：断言表（依赖 dsh 的哪些命令 / 字段 / 事件）、`compat.check`、`degraded[]` 贯穿 `out`、**契约快照**（golden）、适配层收敛验证（上游 bump 后只改一处）、可选的 CI 上游探测（拉最新 tag 跑快照 → 红即告警）。
- **验收**：仿真「上游字段改名 / 命令变更」→ `doctor` / `compat.check` 明确报出「哪个工具不可用 + 缺什么 + 当前 dsh 版本」。
- **状态（2026-09-24 / v0.11.0）**：**已落地** —— 断言表 `CONTRACT` + `compat.check` / `dshcli doctor`；
  契约快照 `dsh-cli/tests/fixtures/session-sample.jsonl`（真实形状）；质量门里注入「事件缺 `seq`」与「词表缺
  tool/call|tool/result」两种仿真变更，断言自检明确报 `event-shape` / `event-vocabulary` 降级（§9 用例）；
  `status.compat` 同时报已实现 / 待实现（28/78）。**未做**：CI 侧定时拉上游最新 tag 跑快照告警（可选，见"范围"末项）。

### P5 运维面 + launcher 托管（含**安装 / 更新入口**）

- **范围**：`plugin.*` / `skill.*` / `cred.*` / `ecosystem.*` / `runtime.*`；
  **加上 E 组「配置 / 元信息」**（`provider.*` / `model.*` / `workspace.*` / `preset.*` / `config.*`）——
  其中 `provider.list` / `model.list` / `workspace.list` / `config.get` 是 design §7 的 ★P0，
  之前没被排进任何阶段（**计划缺口，2026-09-24 补**）；launcher 拉起 `dshcli serve`（复用注册与重启 seam）。
- **launcher 侧入口（主人 2026-09-24 追加要求）**：launcher 必须同时具备 dsh-cli 的
  1. **安装入口** —— 检测是否已安装 / 当前版本；从**同一 tag 的 Release 资产**下载 `dshcli-<ver>.exe` 落到本机；安装后能启动并注册；
  2. **更新入口** —— 检查更新（对比 Release 最新版 / `latest` 语义）；一键升级（替换 exe、必要时重启 `dshcli serve`）；升级失败可回退到旧 exe。
  实现落点：复用 launcher 现有的「dsh 本体安装 / 升级 / check_update」链路与注册 seam，插件面（`dsh-launcher-dsh-plugin`）新增对应工具，生态页（M2）加入口。
- **验收**：launcher 能**安装**、**检查更新**、**升级** dsh-cli 并按需拉起；launcher 启动后 CLI 服务在跑且已注册；插件 / 凭证 / 配置（provider / model / workplace / preset）可查可改。
- **状态（2026-09-24 / v0.11.0）**：launcher 侧安装 + 更新入口**已落地** —— launcher 插件第 6 个工具
  `launcher_cli`（`status` / `install` / `update` / `start`，默认取 `releases/latest/download/dshcli.exe`，
  旧 exe 自动备份，离线/内网可用 `from`），门见 `verify-pm3` §6。**运维面工具本身仍未实现**（见下表）。

#### 剩余待实现工具（50 个，按组；实时以 `dshcli tools` 为准）

| 组 | 待实现 | 具体 |
|---|---|---|
| B 会话（5） | ⚠ 写类为主 | `session.rename` / `session.interrupt` / `session.fork` / `session.export` / `session.delete` |
| A 任务（4） | | `task.log` / `task.retry` / `task.follow` / `task.plan` |
| D 产出物（3） | | `artifact.get` / `artifact.open` / `artifact.publish` |
| E 配置/元信息（12） | 查 + 改成对 | `provider.list|get` · `model.list|get|set_default` · `workspace.list|get|set_default` · `preset.list|get` · `config.get|set` |
| F 插件/技能/生态（9） | ⚠ 全写类 | `plugin.list|install|remove|reload` · `skill.list|install|remove` · `ecosystem.pull|status` |
| G 凭证（5） | ⚠ 只回名字与状态 | `cred.list|set|verify|unset|where` |
| H 运行时/运维（5） | ⚠ | `runtime.start|stop|restart|logs|upgrade` |
| I 事件/回调/消息（5） | ⚠ | `event.subscribe` · `hook.set|list|delete` · `message.post|outbox` |
| C 汇报（1） | | `report.daily`（`report.facts/digest` 带 `since` 已能顶） |

> 已实现 28 个：A 7 · B 6 · C 9（status 3 + report 3 + stats 3）· D 2 · H 3（runtime.status/version + compat.check）· I 1（event.poll）。
> 口径与候选全表见 design §7；清单里未实现的条目**调用时会明确报 `not_implemented`**，不静默、不假装成功。

### P6 发布（沿用现有流水线）

- **范围**：版本 bump **四处一致**（`dsh-launcher` / `dsh-vscode` / `dsh-desktop/desktop` / **`dsh-cli`**）→ `verify-release.mjs` 扩展（四处版本一致 + CLI 可构建）→ `.github/workflows/release.yml` 新增 job `build-dsh-cli`（esbuild → Node SEA 单文件 exe → 上传 Release 资产）→ npm 发布 `@kuaizhongqiang/dsh-cli`（沿用 desktop 的 npm 步骤与 `NPM_TOKEN` 约定）→ 打 tag `vX.Y.Z` → CI 全绿 → 按 RELEASING.md「发布后」逐项核验 → 记 WORKLOG。
- **验收**：Release 资产含 `dshcli-<ver>.exe`；npm `latest` = 该版本；四处版本与 tag 一致。
- **状态（2026-09-24 / v0.11.0）**：**已落地并首发成功** —— tag `v0.11.0` 的 CI 中新 job `build-dsh-cli`
  54s 通过（质量门 → esbuild → Node SEA → postject → exe 冒烟 → 上传资产）；Release 资产 `dshcli.exe` +
  `dshcli-0.11.0.exe`；npm `@kuaizhongqiang/dsh-cli@0.11.0`（`latest`）。`verify-release.mjs` 已加四处版本一致校验。
  **注意**：同一 tag 的 desktop job 因环境原因失败（npm 未跑 dsh 依赖的 install scripts），见 issue #47。

## 4. 分支 / PR / 提交规则

1. **一阶段一分支**：`feat/<issue#>-<slug>`（例：`feat/37-cli-skeleton`）；
2. **PR** 标题带 issue 号，正文写 `Closes #<issue#>`；**合并用 rebase**（与上一轮 v0.10.0 一致，保持线性历史）；
3. **只在阶段边界提交推送** —— 不碎提交、不「随手 commit」；
4. 文档改动随该阶段 PR 一起走（改代码必须同批改文档）。

## 5. 质量门（每阶段必跑）

| 门 | 内容 |
|---|---|
| `dsh-cli/scripts/verify-cli-*.mjs` | **桩 + 不触网**：假 dsh 实例 + 假会话事件日志；覆盖 · 上游投影被裁的场景（证明我们**没走** headless 投影）· 归属写保护 · step 分段完整性 · `out` 形态 |
| 组件内 lint / build | `dsh-cli` 自身类型检查与构建 |
| 伞仓 `node scripts/verify-release.mjs` | 发布前置：清单与**四处版本**一致 |

## 6. 风险与对策

| 风险 | 事实 | 对策 |
|---|---|---|
| 取消做不到中途停 | 上游 SDK 无 mid-turn cancel | 取消 = 终止运行时；文档写明，`out.status = cancelled` |
| 连不上「已在跑的实例」 | 上游 token 只在进程内，跨进程无凭证文件 | 我们落本机 `endpoints.json`（端口 / pid，**不含明文 token**）+ 复用 launcher 注册文件 |
| 上游输出会裁 | headless `--json` 每串 8KiB / 每行 32KiB / 深度 64 | **不走 headless 投影**，直读会话事件日志 |
| 会话日志体积大 | 长会话事件多 | 按 step 分段 + `seq` 游标 + 超大内容给引用 |
| 上游高速迭代 | dsh 本体周更 | 单点适配层 + 契约快照 + `degraded` 告警（design §9） |
| 写坏别人的会话 | 会话可能来自 web / VSCode | 归属 registry + 运行中只读 + **硬失败**（design §5） |

## 7. 不做清单

- 不做调度器（`schedule.*` 不提供，定时归 openclaw）；
- 不做净化 / 截取（结构清楚即交付）；
- 不抢 dsh 命令名（**冲突时 CLI 让路**）；
- 不改 / 不 fork dsh 本体（子模块只读）；
- 不支持多机 / 远程（单机前提）；
- 不输出二进制内容（只给引用）；
- 不做 SSE（上游走 WS，本机也不需要）。
