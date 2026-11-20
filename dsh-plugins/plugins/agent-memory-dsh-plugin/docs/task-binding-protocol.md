# 任务绑定协议（Task Binding Protocol，TBP v1）

> 适用：`plugins/agent-memory-native`（native 模式）v0.1.2+，引擎 TencentDB Agent Memory v2.0.4+。
> 目标：让 `task_id` 从「随手拼的字符串」升级为**服务端发号、会话级绑定、可校验、可关闭**的记忆分区键。

## 1. 要解决的问题

改造前的事实（2026-11-20 实测）：

| 问题 | 证据 |
|---|---|
| `task_id` 不是实体 | `meta_tasks` = 0 条；31 个 task_id 只是 L0/L1 里的字符串 |
| 没有接收通道 | 插件只能从 `config.taskId` 或 cwd 目录名取 task_id，无会话级绑定 |
| 不能建任务 | 插件只带 `Authorization: Bearer`，`/v3/meta/*` 一律 401 `missing_user_key` |
| L2/L3 不认 task | 画像作用域是 `team:<T>\|agent:<A>`（`MemoryCore/src/core/profile/profile-scope.ts`），task 与 user 都被故意忽略 |

因此**「让 worker 只在这个 task_id 里干活」单靠口头约定必然分叉**：一个拼写差异就是一个新桶，而且不会报错。

## 2. 数据模型

```
meta_tasks（metadata.db）                  ← 任务实体：task_id / team_id / creator_user_id / title / status / linked_agents
  └─ task_agents（关联 agent）
会话绑定文件 %DSH_HOME%/.dsh-memory-task-bindings.json
  └─ { sessions: { "<session_id>": { task_id, title, bound_at } } }
L0/L1（vectors.db）                        ← 读写时 task_id = 绑定值（无绑定则回退 config/cwd）
L2/L3（profiles/）                         ← 仍按 (team, agent)，**不参与**任务隔离
```

**边界必须说清**：本协议只隔离「事实层」（L0/L1）。L2 场景与 L3 画像是 agent 级资产，跨任务共享——这是设计选择，不是缺陷（任务结束，方法论留下）。

## 3. 协议（P1–P7）

**P1｜服务端发号，worker 不许自己拼**
`task_create` 调 `/v3/meta/task/create`，服务端生成不可变 `task_id`（`task-xxxx`），创建者固定为配置里的 `userId`（引擎要求 `creator_user_id == caller`）。
worker 只接受 `task_create` 返回值或 `task_list` 里的 id，**任何自由字符串都视为非法**。

**P2｜绑定是会话级的，且持久化**
`task_bind(task_id)`：
1. `task_get` 校验：存在、`team_id` 一致、`status === 'running'`；
2. 写入绑定文件（原子写 tmp+rename），key 是 `session_id`；
3. 幂等：重复 bind 同一 id 无副作用；bind 到 `completed` 任务直接拒绝。

绑定只在**当前会话**生效；其它会话（含子代理）不继承。重启后从文件恢复。

**P3｜绑定后，读写都带它**
`resolveTaskId` 优先级：**绑定 > `config.taskId` > cwd 目录名**。
所有数据面调用（`conversation/add`、`atomic/search`、`atomic/query`、`core/read`、`scenario/ls`）**以及进程内自动入库**都走同一解析函数，因此绑定后不会出现「工具写绑定桶、capture 写旧桶」的分裂。

**P4｜权限分层**

| 角色 | 配置 | 能做什么 | 不能做什么 |
|---|---|---|---|
| serve agent | `taskAdmin: true` | `task_create` / `task_close` / `task_bind` / `task_get` / `task_list` | 改他人任务、团队管理 |
| worker | `taskAdmin: false`（默认） | `task_bind` / `task_get` / `task_list` | 建任务、关任务 |
| 人（Panel） | user key | 全部（含成员/资产/块管理） | — |

引擎侧权限（`MemoryCore/src/metadata/service/metadata-service.ts`）：
- `createTaskForCaller`：team 存在 + active member + `creator_user_id == caller`；
- `update/delete/archiveTaskForCaller`：仅 task creator；
- `getTaskForCaller`：team 资源可读（v2.0.4 起按 caller/成员过滤）。

**注意**：`taskAdmin` 是 profile 级配置，DSH 子代理与本会话**共享同一插件实例**，因此也会继承该权限。worker 约束靠预设提示词 + 工具描述（`task_create` 会二次校验 `taskAdmin`）。若要硬隔离，给 worker 用独立 profile。

**P5｜生命周期闭环**
`task_close` 把 `status` 置 `completed`（仅 creator）；若当前会话绑定的是它，同时解绑。
关闭**不删除**记忆：该桶按约定转只读；可复用的方法/判例应在关闭前提炼到 agent 级 L2。

**P6｜冷启动继承**
新桶天然为空。`memory_brief` 的顺序是：
1. 绑定任务信息 + 未结 `work_task`（`metadata_json.status != done`，按 deadline 升序、priority 降序）；
2. L3 画像**摘要**（~1.4KB，不是 36KB 全文）；
3. L2 场景**索引**（path + updated_at，丢 summary）；
4. 最近 `work_fact`；
5. 全部压进字符预算（默认 8000 ≈ 2.7K token），超预算按「场景 → 事实 → 任务 → 画像」顺序裁剪。

因此新任务不会「瞎」，但旧任务的事实也不会串进来。

**P7｜历史兼容**
历史 31 个 task_id 的桶**只读保留**，不迁移；新任务全部走 P1–P6。
未绑定的会话行为与改造前完全一致（`config.taskId` / cwd），所以旧桶的读写不受影响。

## 4. 工具

| 工具 | 权限 | 说明 |
|---|---|---|
| `memory_brief` | 所有 | 预算化简报（绑定任务 + 未结任务 + 画像摘要 + 场景索引 + 最近事实） |
| `recall_memory` | 所有 | L1 检索；`include_persona` 默认 **false**；`include_scenes` 只返索引；支持 `type` / `time_start` / `time_end` |
| `search_memories` | 所有 | 同检索，支持 `type` 与时间窗 |
| `task_create` | serve | 发号并自动绑定当前会话 |
| `task_bind` | 所有 | 校验后绑定当前会话 |
| `task_get` / `task_list` | 所有 | 读任务与关联 agent |
| `task_close` | serve | 置 completed + 解绑当前会话 |
| `store_memory` / `code_*` ×8 | 所有 | 原有能力不变 |

## 5. 失败模式与处置

| 症状 | 根因 | 处置 |
|---|---|---|
| `task_bind` 报 `任务不存在` | id 拼错 / 不在本 team | 先 `task_list` 取 id，不要手拼 |
| `401 missing_user_key` | 没配 `userKeyRef`，或把 memory 系统账号当 user key | 用**真人** user key 存进受管凭证库 |
| `403/creator 不匹配` | 用 A 的 key 关 B 建的任务 | 只有 creator 能关；需要管理员改 Panel |
| 绑定后 brief 里没有旧记忆 | 新桶为空（P6 设计如此） | 依赖 agent 级 L2/L3；不要回填旧桶 |
| worker 意外建了任务 | 子代理继承了 `taskAdmin: true` | 给 worker 独立 profile（`taskAdmin: false`）或收权 |
| 绑定文件损坏 | 手改/断电 | 读取失败回落空表，不影响记忆读写；删除该文件即可重置 |

## 6. 验收

1. `node plugins/agent-memory-native/selftest.mjs` → **70 ok / 0 FAIL**（含 5b 绑定、5c meta、5d brief 预算断言）。
2. 真实引擎：建任务 → 绑定 → `echoOf` 回显 `task_id` 一致 → 聊一轮 → 查 `l1_records` / `l0_conversations` 该行 `task_id` = 绑定值。
3. 解绑/关闭后，新写入回到 `config.taskId` 桶。
4. 绑定文件只含 `task_id/title/bound_at`，**不含任何 key**。

## 7. 回滚

- 插件：`./install.sh --uninstall` 或回退 profile 里的 `plugins/agent-memory-native` 三个文件；
- 绑定：删除 `%DSH_HOME%/.dsh-memory-task-bindings.json`；
- 任务实体：`task_close`（软关闭）；硬删走 `/v3/meta/task/delete`（creator，不可恢复）。
