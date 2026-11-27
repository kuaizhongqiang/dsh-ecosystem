# agent-memory-admin — 记忆系统运维控制台（native dsh 插件）

> 与 `tool-agent-memory`（工作台）互补：工作台按**当前 task** 读写；控制台**不绑定** task，
> 可跨团队盘点、检索、修改、删除，并管理 task 实体 / 场景 / 画像 / 提示词 / 健康状态。
> 目的：维护记忆系统时不必再 `curl` + `sqlite3` + 翻一大段记忆。

## 工具（8 个）

| 工具 | 作用 |
|---|---|
| `memory_overview` | 一次看清：引擎健康、L0/L1/L2/L3 计数、L1 按类型、Top 任务/Agent（抽样）、task 实体、会话绑定、入库游标、`vectors.db` 大小 |
| `memory_health` | 健康详情 + L0/L1 计数 + 绑定 + capture 游标 |
| `memory_list` | 团队级 L1 分页（可按 task / agent / user / type / 时间窗收窄） |
| `memory_search` | 团队级关键词/语义检索（不限于当前 task） |
| `memory_get` | 读单个对象：`l2` 场景路径 / `l3` agent 画像 / `task` 实体 + 关联 agent |
| `memory_edit` | 改 L1（content/type/priority）、删 L1、写/删 L2、写 L3；**删除需 `confirm: true`** |
| `memory_prompts` | 查看 L1/L2/L3 生效提示词 + 已应用的 settings（只读；编辑仍在 Panel） |
| `memory_tasks` | task 实体 list/get/create/close；create 支持**自定义 task_id**（serve 控制面） |

## 团队级作用域（关键）

数据面默认把缺失的 `user_id/agent_id/session_id` 填成 `default`，所以只传 `team_id` 查不到真实数据。
本插件使用部署方密钥走**团队级作用域**：

- 网关启动时导出 `TDAI_ADMIN_KEY`（读 `~/.config/memory-gateway/admin_key.txt`）；
- 插件请求带 `x-tdai-admin-key` + body `scope: "team"`；
- 网关只在密钥匹配时跳过默认桶填充，**否则 `scope=team` 被忽略**（不会放宽隔离）。

因此本插件必须配置 `adminKeyRef`，**而且端点必须把 `x-tdai-admin-key` 原样透传到网关**。

> ⚠️ `adminKey` 配了 ≠ 生效。网关只看"到达它的那个头"：如果中间还有一层 HTTP 桥
> （`bridge-server` 的 `/v3/*` 透明转发）而它的白名单没带 `x-tdai-admin-key`，
> 网关会**静默忽略** `scope=team`，按 `default` 桶返回 **0 且不报错**。
> 实测（2026-11-27）：`bridge-server` 早期 `FORWARDED_HEADERS` 只有
> `authorization / x-tdai-service-id / content-type / accept`，
> 尾网 `:3000` 上 `atomic/count {scope:team}` 返回 0，同一条请求直连 `:8422` 返回 9909。
> 排查口诀：**同一个 key、同一条 curl，直连网关有数、过桥为 0 ⇒ 端点不透传头**，
> 不是 key 配错、也不是"没记忆"。0.1.2 起 `atomicCount` 在"团队级计数为 0 但本机
> `vectors.db` 有 L1"时直接抛诊断错误，不再让 0 冒充结果。

因此本插件必须配置 `adminKeyRef`，否则所有查询会返回 0（会显式报错）；端点不透传时同样会显式报错。

## 配置（`cordis.patch.yml` 条目）

```yaml
- insert:
    - id: tool-agent-memory-admin
      name: './plugins/agent-memory-admin/index.js'
      config:
        memoryEndpoint: http://127.0.0.1:8422
        apiKeyRef: AGENT_MEMORY_API_KEY
        userKeyRef: AGENT_MEMORY_USER_KEY
        adminKeyRef: AGENT_MEMORY_ADMIN_KEY      # 凭证库里是同一个 TDAI_ADMIN_KEY
        serviceId: default
        teamId: '<TEAM_ID>'
        userId: '<USER_ID>'                       # 建任务时的 creator
        agentId: '<AGENT_ID>'                     # 默认关联 agent
        dataDir: /home/kuai/memory-tdai           # 本机引擎数据目录（L2/L3 计数 + DB 大小）
        timeoutMs: 15000
        allowDestructive: true                    # 仍要求每次 confirm
```

凭证：`AGENT_MEMORY_API_KEY` / `AGENT_MEMORY_USER_KEY` / `AGENT_MEMORY_ADMIN_KEY` 都放
`%DSH_HOME%/.credentials.yaml`，**不要**写进 patch 或仓库。

## 安装 / 验收

```bash
cp -r plugins/agent-memory-admin ~/.dsh/profiles/web/plugins/
# 在 cordis.patch.yml 追加上面的条目，然后：
systemctl --user restart dsh
journalctl --user -u dsh | grep agent-memory-admin   # ready v0.1.0: tools=8
```

离线自检：`node selftest.mjs`（15 ok）。

## 安全

- 删除类操作（`l1_delete` / `l2_delete`）必须 `confirm: true`，且 `allowDestructive` 不能为 false；
- `memory_edit` 的 L2/L3 写入要求显式 `agent_id`（画像/场景按 `team+agent` 隔离，避免写错人）；
- `adminKey` 是**控制面**凭证：只装在本机 profile，不下发到 worker / MCP 客户端；
- 历史 task 桶与数据不受 `memory_tasks close` 影响（只置 completed，不删记忆）。
