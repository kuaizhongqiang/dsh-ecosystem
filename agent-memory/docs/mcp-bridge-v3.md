# mcp-bridge v3 使用指南

> **版本**: 0.4.0 · 面向团队版（MemoryCore `/v3/*`）
> **状态**: 全量重写完成，直连 MemoryCore Gateway，不再依赖 bridge-server

## 概述

mcp-bridge v3 是 MCP（Model Context Protocol）服务器，把 AI Agent 的记忆工具调用**直连**到 MemoryCore Gateway（团队版 `/v3/*` 数据面）。相比 v0.2：

- ❌ 移除 bridge-server 中转（已退役）
- ❌ 移除 sender 隔离（改为 v3 隔离三元组 team/agent/user）
- ❌ 移除 `end_session` 工具（v3 无对应端点，session 只是客户端 key）
- ✅ 新增多层级召回（`recall_memory` 合并 L1 事实 + L3 persona + L2 场景索引）
- ✅ 0.4.0：task_id 防混用校验（拒绝身份前缀）+ 工具结果 `_context` 回显隔离域

## 配置

### 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MEMORY_ENDPOINT` | ✅ | MemoryCore Gateway 地址（如 `https://memory.kuai-private.top`） |
| `API_KEY` | ✅ | 网关门禁 key（`Authorization: Bearer`，多 agent 共用） |
| `SERVICE_ID` | ✅ | memory 实例 id / spaceId（`x-tdai-service-id`） |
| `TEAM_ID` | ✅ | v3 隔离：团队 id |
| `AGENT_ID` | ✅ | v3 隔离：agent id（每平台一个） |
| `USER_ID` | ✅ | v3 隔离：user id |
| `USER_KEY` | 仅 task_* | 团队 user_key；`/v3/meta/*` 只认 `x-tdai-user-key`（只有 Bearer 会 401）。不配则 task_* 不可用，记忆读写不受影响 |
| `TASK_ID` | ❌ | task_id（项目级隔离标签）；未设则**自动从项目路径派生**（cwd 目录名）；**拒绝身份前缀 `agt-`/`team-`/`usr-`/`sk-`（≥0.4.0）** |
| `SESSION_KEY` | ❌ | 本 MCP 会话的绑定键；缺省自动生成 `<AGENT_ID>-<YYYY-MM-DD>` |
| `TIMEOUT_MS` | ❌ | 请求超时（毫秒，默认 15000） |
| `TASK_ADMIN_AGENT_IDS` | ❌ | serve 白名单（逗号分隔的 `AGENT_ID`）；只有名单内的 agent 能 `task_create`/`task_close`，默认空 = 全部拒绝 |
| `TASK_BINDING_PATH` | ❌ | 会话级 task 绑定文件（默认 `~/.tencent-agent-memory/task-bindings.json`，只存 task_id/title/bound_at） |
| `BRIEF_BUDGET_CHARS` | ❌ | `memory_brief` 字符预算（默认 8000 ≈ 2.7K token） |

完整占位符示例见 [`packages/mcp-bridge/.env.example`](../packages/mcp-bridge/.env.example)。

### MCP settings.json 示例（Claude Code / CodeBuddy）

```jsonc
{
  "mcpServers": {
    "agent-memory": {
      "command": "npx",
      "args": ["-y", "tencent-agent-memory-mcp-bridge@0.5.0"],
      "env": {
        "MEMORY_ENDPOINT": "https://memory.kuai-private.top",
        "API_KEY": "<gate-api-key>",
        "SERVICE_ID": "default",
        "TEAM_ID": "<team-id>",
        "AGENT_ID": "<agent-id>",
        "USER_ID": "<user-id>",
        "USER_KEY": "<team-user-key>"
      }
    }
  }
}
```

> ⚠️ 不要填真实 key 到仓库文件；通过本机 `.env`（已被 `.gitignore` 排除）或 MCP settings 的 env 字段注入。

### task_id（项目级隔离，与身份严格分离）

mcp-bridge 支持 **task_id** 做项目级区分：

- **显式设置**：`TASK_ID=<project-name>` 环境变量
- **自动派生**：未设时读 `process.cwd()`（客户端启动 MCP 时的项目目录）取目录名，如 `TencentAgentMemoryBridge`
- **防混用（≥0.4.0）**：启动时校验，`agt-` / `team-` / `usr-` / `uky-` / `sk-` / `key-` 前缀的 `task_id` 直接报错拒绝——**`task_id` 是项目级标签，不是身份 id**。绝不能把 `AGENT_ID`（`agt-*`）/ `TEAM_ID`（`team-*`）/ `USER_ID`（`usr-*`）/ key 填进 `TASK_ID`（否则所有项目共享同一个"task"，项目级隔离失效）

写入（`conversation/add`）和召回（`atomic/search`）都会带 `task_id`：

- **L1 事实按项目隔离**（项目 A 的事实不进项目 B 的召回）
- **L3 persona / L2 场景仍跨项目共享**（按 team+agent 维度）

### TBP v1：任务绑定（≥0.5.0）

mcp-bridge 0.5.0 起支持任务绑定协议：

1. **serve agent**（`AGENT_ID` 在 `TASK_ADMIN_AGENT_IDS` 白名单内且有 `USER_KEY`）调 `task_create`
   → 引擎发号 `task-xxxx` 并自动绑定当前 MCP 会话；
2. 派活时把 `task_id` 原样交给 worker；
3. **worker** 用 `task_bind(task_id)` 绑定（校验存在 / 同 team / running），**不要自己拼 id**；
4. 绑定后本会话所有读写（含 `store_memory`）都用该 task_id；换任务重 bind；
5. serve agent `task_close` 收尾（置 completed + 解绑）。

- 绑定是**会话级**的（键 = `SESSION_KEY`），落盘 `TASK_BINDING_PATH`，重启后恢复；
- serve 能力由**部署方**通过 `TASK_ADMIN_AGENT_IDS` 控制，客户端无法自行提权；
- 只隔离 L0/L1；L2/L3 仍是 `(team, agent)` 级。

> 工具结果带 `_context` 回显 `{team_id, agent_id, user_id, task_id, task_source}`，
> `task_source=binding|config` 可确认当前是否已绑定。

## 工具

| 工具 | 映射到 v3 | 说明 |
| --- | --- | --- |
| `memory_brief(max_chars?)` | `/v3/core/read` + `/v3/scenario/ls` + `/v3/atomic/query` ×2 | 绑定任务 + 未结 work_task + 画像摘要 + 场景索引 + 最近事实，预算内裁剪 |
| `recall_memory(query, limit?, type?, time_start?, time_end?, include_persona?, include_scenes?)` | `/v3/atomic/search` + core/scenario | `include_persona` 默认 **false**（需要时返回摘要）；scenes 只返索引 |
| `store_memory(user_content, assistant_content, session_key?)` | `/v3/conversation/add` | 写 L0，必填 session；返回 `{accepted_ids, _context}` |
| `search_memories(query, limit?, type?, time_start?, time_end?)` | `/v3/atomic/search` | L1 语义搜索，返回 `{items, _context}` |
| `task_create(title, description?, status?, agent_ids?)` | `/v3/meta/task/create` | **serve only**：发号并自动绑定当前会话 |
| `task_bind(task_id)` | `/v3/meta/task/get` | 校验后绑定当前会话（幂等） |
| `task_get(task_id)` / `task_list(status?, limit?)` | `/v3/meta/task/get` / `list` | 读任务与关联 agent |
| `task_close(task_id)` | `/v3/meta/task/update` | **serve only**：置 completed + 解绑 |

> 工具不接受 `agent_id` / `team_id` / `user_id` 参数——身份由 MCP env 注入；`task_id` 只能通过 `task_bind` / `task_create` 产生，**不要手拼**。

## 本地测试

```bash
cd packages/mcp-bridge
# 配置真实 key 到本机 .env（勿提交）
pnpm build
pnpm test
```

## 安全

- 真实 key 只放本机 `.env` / 环境变量，`/f/Project/TencentAgentMemoryBridge/.gitignore` 已排除 `.env`
- 网关门禁 `API_KEY` 多 agent 共用；agent 身份由 `AGENT_ID` + `USER_ID` 区分
- 数据面写入需隔离三元组；测试时用独立 `spaceId`（如 test-space-002）避免污染生产
