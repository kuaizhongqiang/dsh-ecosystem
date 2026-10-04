# dsh-continuity —— 任务连续性域（第 8 包）

> 不变量：**任务不因载体更替而中断**。载体 = 会话 / 上下文窗口 / 进程。
> v1 交付 `handoff` 一个服务；同域后续能力（restart 恢复、跨会话 resume 索引、
> brief 自动维护、历史任务召回）复用本包，不另开新包。

## 它解决什么

上下文快满时，沿用「让 agent 总结一段文字 → 手工复制到新会话」的做法，要额外一轮对话、
且完全靠人手。`handoff` 把它压缩成一次调用：

```
/handoff [--dry-run] [备注]
```

1. 从当前会话的**只读投影**收集状态：goal / 已批准的计划文本 / todo 快照 / 最近进展 / cwd；
2. 写一份确定性交接文档（**命令面零 token**，不调用模型）到
   `%DSH_HOME%\handoff\<workspace>\<YYYYMMDD-HHmmss>-<源会话前 8 位>.md`（同时刷新 `latest.md`）；
3. 在**同一个 workspace** 新建会话（走浏览器同一条 `sessionController.create` 链，
   preset / 持久化 / workspace 挂载都由它负责）；
4. **克隆 goal**：同一 objective、`maxGoalRounds` 继承，**轮次计数归零**（round 是 goal 自身的计数器，
   create 强制从 0 起）；
5. 播种首条消息（交接文档路径 + 目标 + 备注）→ `agent.followup()` **唤醒 driver**，
   新会话立刻自己开跑。

## 工具面

| 工具 | 说明 |
|---|---|
| `handoff_start` | 与 `/handoff` 同一实现。`brief` 参数允许**模型自己写**一份更好的交接文档（替换确定性生成的那份）；`dryRun=true` 只写文档、不建会话；`nextStep` / `note` 补充文档内容。 |

命令面是给人用的（不进模型历史，也不产生 token）；工具面是给模型用的——它可以在
自己判断上下文吃紧时主动交接，或把交接文档写成模型视角的高质量版本。

## 语义决定（2026-10-04 与用户确认）

| 决定 | 取值 | 理由 |
|---|---|---|
| 源会话在 plan mode（计划未批准） | **拒绝执行** | 否则新会话会去执行一份没人批准的计划；`--dry-run` 同样被拒 |
| goal 克隆的轮次计数 | **归零** | `goals.create` 语义如此；换来的是新会话有完整 round 预算，长任务不会一进去就撞 round-limit |
| 源 goal 为 `paused` | **不保持 paused**（以 active 启动） | 交接的目的是继续干，不是继续停 |
| 上下文与 KV 缓存 | **可丢** | 交接文档承担"记性"，不靠 prompt cache |
| todo | **不继承**（写进文档） | `todos` 投影遇 `turn/start` 重置，预置必被抹掉；由接手会话 `todo_write` 重建 |

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1                       # 安装（自动识别正在运行的 profile）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProfileName desktop  # 多 profile 机器显式指定
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Only handoff
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

无凭证。**profile 解析**：`-ProfileName` → `$env:DSH_PROFILE` / `$env:DSH_PROFILE_DIR`
（会话内由 dsh-shell-env 注入，最可靠）→ 进程祖先链 → 唯一候选 → 兜底 web。
**别再写死 `profiles\web`**：本机桌面宿主跑的是 `profiles\desktop`，写死会把插件装进没人加载的
profile（2026-10-04 实测踩到）。安装后**需要重启**：载荷 JS 换代不会自动换模块
（`dsh-plugin-manager`：「Package replacements require restarting the process to load a fresh
JavaScript module generation」），只有 config 改动可热应用。配套技能：`skills/install-continuity`。

## 验证

```bash
node scripts/verify-continuity.mjs     # 纯逻辑（桩 deps）+ 包结构 + 卸载节剥离，83 项
```

覆盖：plan 模式拒绝、dry-run 不建会话、goal 克隆参数（objective/maxGoalRounds/不 pause）、
首条消息内容、无 goal / goal complete 边界、建会话与 agent 解析失败路径、包结构与伞仓约定。

## 与 dsh 内置能力的分工（别重复造）

| 需求 | 现成能力 | 与 handoff 的关系 |
|---|---|---|
| 换个会话继续、且**保留全部历史** | `session.fork`（会话右键菜单 / `session.fork` 快捷键） | fork 复制整段事件前缀，**不释放 token**；上下文满了 fork 出来还是满的 |
| 会话内腾空间、降 token | 自动 compaction + `/compact` | 保留会话、有损；handoff 是另一条路：干净会话 + 蒸馏文档 |
| 跨会话引用一段内容 | `@[label](dsh-session:<id>)` mention（`dsh-session-reference`） | 快照式、有界；handoff 的文档是主动蒸馏的"任务状态" |
| 跨重启恢复工作 | `%DSH_HOME%\.dsh-restart-intent.json`（dsh-launcher 写入/读取） | 同域不同载体：restart-intent 管进程，handoff 管会话 |

## 已知限制

- **不能替 UI 切换活动会话**：新会话已建、已在跑，但要你在左侧列表点一下（客户端持有活动会话选择）。
- **不克隆 plan mode 状态**：计划文本进文档，模式不复制（`ctx.planMode.set` 存在，但刻意不用）。
- **`/export` 无模型工具**、`session.fork` 无 `-Only` 等价物：本包不去包装它们。
- 交接文档里「最近进展」是截断文本（默认最近 8 条、每条 1200 字符），不是完整对话回放；
  需要完整回放请用 `session.fork`。

## License

MIT © 2026 kuaizhongqiang
