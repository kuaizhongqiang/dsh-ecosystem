# agent-memory-codegraph — MemoryCore code-graph MCP 通道（本地增强层）

把 MemoryKnowledge（本机 `:8421`，`/v3/code-graph/*`）的代码图谱查询面暴露成 **MCP stdio 工具**，
让 agent 能经 memory MCP 通道问出带出处的问题：`XX 符号被谁调用 / XX 调用了谁 / 变更影响面 / 符号在哪 / 仓库文件结构`。
对应 dsh-ecosystem **milestone #3（issue #24/#25/#26/#27）** 的实现交付。

零第三方运行时依赖（只用 Node 内置 `fetch`/`http`/`crypto`），实现为最小 MCP JSON-RPC stdio server。

## 为什么是「本地增强层」而不是 fork / 上游 PR（决策记录）

- 上游 `tencent-agent-memory-mcp-bridge`（官方轻量基线）只暴露 `recall_memory/store_memory/search_memories`，
  且以 `npx -y` 方式接入，属于上游包，迭代节奏不受我们控制。
- MemoryCore 的 code-graph **数据面**（MemoryKnowledge）与**元数据面**（MemoryCore knowledge，`type=code-graph`）
  已在本机就绪并归本 team 所有——真正缺的只是「MCP 工具暴露」这一段，属典型的本地增强层。
- 因此采用**增量接入**：上游 bridge 原样保留，本包以**另一个 mcp-client 实例**（`serverName: agent-memory-codegraph`）
  注入 web profile。工具命名空间独立（`mcp__agent-memory-codegraph__code_*`），互不影响、可单独回滚。
- 若未来上游桥原生支持 code-graph，可平滑迁移（去掉本实例，把工具名对齐即可），本包退化为过渡层。

## 提供的工具（8 个，全部只读）

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `code_graph_list` | 列出当前 team 可见索引（仓库/cg-id/状态/规模） | — |
| `code_search` | 符号/语义搜索（找函数、类、变量定义位置） | query, repo?, kind?, limit? |
| `code_callers` | “XX 被谁调用” | symbol, repo?, limit? |
| `code_callees` | “XX 调用了谁” | symbol, repo?, limit? |
| `code_impact` | 变更影响面（沿调用链外扩 depth 层） | symbol, repo?, depth? |
| `code_explore` | 语义定位相关文件 | query, repo?, maxFiles? |
| `code_node` | 符号定义详情（可带源码） | symbol, repo?, includeCode?, file?, line? |
| `code_files` | 仓库文件树/平铺/分组 | repo?, path?, pattern?, format?, ... |

`repo` 参数接受完整 URL 或短名（如 `dsh-ecosystem`），由本 server 解析到 `code_graph_id`；
解析结果来自 `POST /v3/code-graph/list { team_id }`（**只返回本 team 可见的索引，身份由环境注入，调用方无法指定**）。
多个索引都省略 `repo` 时会明确报错并提示先用 `code_graph_list`——不做静默默认。

## 失败语义（issue #26 要求）

图谱服务不可达 / 查询失败 / 未知 repo / 未知工具 → 一律**显式错误**（`isError: true` + 明确文案），
绝不静默返回空结果。

## 运行环境（env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `TEAM_ID` | **必填** | 身份隔离——只列出/查询该 team 的索引；缺失则启动即退出 |
| `KNOWLEDGE_ENDPOINT` | `http://127.0.0.1:8421` | MemoryKnowledge 服务 |
| `SERVICE_ID` | `default` | 透传 `x-tdai-service-id` 头 |
| `USER_ID` / `AGENT_ID` | 可选 | 结果 `_context` 回显 |
| `KNOWLEDGE_HTTP_TIMEOUT_MS` | `12000` | 单次 HTTP 超时 |
| `KNOWLEDGE_META_TTL_MS` | `60000` | 索引列表缓存 TTL |

## 部署到 web profile（cordis.patch.yml）

把本目录复制到 profile 的插件区：

```bash
# Linux/macOS
PROF=~/.dsh/profiles/web
mkdir -p "$PROF/plugins"
cp -r plugins/agent-memory-codegraph "$PROF/plugins/"
# Windows 见 install.ps1
```

在 `cordis.patch.yml` 增加一个 mcp-client 实例（身份 env 与上游桥一致，追加 `KNOWLEDGE_ENDPOINT`）：

```yaml
# --- agent-memory code-graph channel (本地增强层, milestone #3) ---
# mcp__agent-memory-codegraph__code_* 工具；只读；身份/隔离沿用三元组 env。
# 回滚 = 删除本 insert 块（上游 agent-memory 桥不受影响）。
- insert:
    - id: mcp-agent-memory-codegraph
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agent-memory-codegraph
        transport: stdio
        command: node
        args: ['/绝对路径/plugins/agent-memory-codegraph/index.mjs']
        env:
          KNOWLEDGE_ENDPOINT: 'http://127.0.0.1:8421'
          SERVICE_ID: default
          TEAM_ID: team-w7eai9w6kc
          USER_ID: usr-w7easao7jg
          AGENT_ID: agt-k4p9q8w7zm
        toolCallTimeoutMs: 30000
```

> `args` 用绝对路径指向 profile 内复制后的 `index.mjs`（dsh 的 mcp-client 以独立子进程 spawn，
> cwd 不是 profile 目录，不要用相对路径）。`patchReload` 为 `live` 时保存即生效（新增实例，
> 不影响既有 agent-memory 工具）；为 `startup` 时下次启动生效。

## 测试

```bash
# 单元（mock 知识服务，不依赖真实环境）：23 项
node mcp-tests.mjs

# 集成（打真实本机 MemoryKnowledge :8421，需以本 team 身份）：
TEAM_ID=team-w7eai9w6kc REAL=1 node mcp-tests.mjs
```

覆盖：握手 / 工具清单 / 列表隔离 / repo 解析与转发 / 未知 repo、缺 repo、服务宕机、未知工具的显式报错 /
真实链路检索证据。

## 目录

- `index.mjs` — MCP stdio server（零依赖）
- `mcp-tests.mjs` — mock 单元 + REAL 集成测试
- `package.json` — 元数据（`npm test` = mock 单测）

## 维护纪律

- 不改上游 bridge；升级上游版本时本包无需改动（数据面在 MemoryKnowledge）。
- 数据面/元数据面由 MemoryKnowledge/MemoryCore 负责（索引同步、状态、授权）；本包只做查询暴露。
- 若 `code_graph_id` 解析口径变化（如按 user 而非 team 授权），只改 `index.mjs` 的 `refreshIndexes/resolveIndex`。
