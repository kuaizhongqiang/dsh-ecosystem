# agent-memory-dsh-plugin

把「[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)」这套长期记忆
（L0 对话 → L1 原子事实 → L2 场景 → L3 画像）接入 DSH web profile 的**安装包**。默认走
**原生 cordis 插件**（进程内直连引擎 + 进程内自动入库），也可回退到 MCP 双通道模式。

> 分层：**引擎是第三方上游**（腾讯云，MIT），**`<伞仓>/agent-memory/` 是我们自己的协议桥源码**
> （MCP 桥 / HTTP 桥 / autostore 脚本），**本包是安装器 + 原生插件 + 模板**。

## 两种模式（`--mode native|mcp`，默认 native）

| | **native（默认）** | **mcp（兼容）** |
|---|---|---|
| 载体 | 一个原生 cordis 插件 `tool-agent-memory`（`plugins/agent-memory-native/`） | 两条 `@deepseek-ai/dsh-mcp-client` 通道 |
| 工具 | 11 个，工具名**无前缀**：`recall_memory` / `store_memory` / `search_memories` + `code_*` ×8 | 同 11 个，但叫 `mcp__agent-memory__*` / `mcp__agent-memory-codegraph__code_*` |
| 依赖 | **零外部依赖**（只用 fetch 打引擎 HTTP） | `npx tencent-agent-memory-mcp-bridge@0.4.0`（需公网/npm）+ 本地 codegraph server 子进程 |
| 自动入库 | **进程内**：`ctx.on('session/event')` 在 `turn/end` 直提 L0 | 外部守护（Linux systemd / Windows 计划任务）扫 `sessions/` 提交 |
| 适合 | DSH 本机（默认） | 其它平台（Claude Code / CodeBuddy / OpenClaw）与无插件能力的 headless 场景 |

去重游标两种模式**共用** `%DSH_HOME%/.dsh-memory-autostore-state.json`（按 `session_id + turn`），
因此来回切换不会重复提交。

## 工具（native 模式，11 个）

| 工具 | 作用 |
|---|---|
| `recall_memory` | 召回当前 task 的 L1 事实（+可选 L3 persona / L2 场景索引） |
| `store_memory` | 显式把一轮对话写进 L0 |
| `search_memories` | L1 原子记忆语义检索（可按 type 过滤） |
| `code_graph_list` | 列出当前 team 可见的 code-graph 索引 |
| `code_search` / `code_callers` / `code_callees` / `code_impact` / `code_explore` / `code_node` / `code_files` | 代码图谱只读检索（符号/调用/影响面/文件） |

身份（`team_id`/`agent_id`/`user_id`）与 `task_id` 由插件 config 固定，**工具调用方不能传身份**；
返回值带 `_context` 回显当前隔离域。

## 前置：引擎（第三方）

引擎不是本包内容，需另行部署（Linux/systemd 或 docker）：

```bash
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory
# 本团队部署验证过的 ref：分支 upgrade-v2.0.1（本地部署分支，含 pnpm 11 lockfile 重建，不回推上游）
```

服务与端口：`MemoryCore` :8422（v3 元数据/gateway）、`MemoryKnowledge` :8421（knowledge + code-graph）、
`MemoryProxy` :8096、`MemoryPanel` :8123、`TDAI HTTP Gateway` :8420（外加我们的 HTTP 桥 `bridge-server` :3000）。
引擎侧 LLM key 放 `~/.config/memory-gateway/{llm,embedding}_key.txt`（600），由
`templates/engine/start-gateway-full.sh` 读取。Windows 下引擎走 WSL2 或 docker。

## 远端部署（引擎不在本机）

`memoryEndpoint` 与 `knowledgeEndpoint` 是**两个不同的服务**，远端网关通常只暴露前者：

| 通道 | 服务 | 网关路由 | 缺失时 |
|---|---|---|---|
| 主记忆（3 工具） | MemoryCore :8422 | `/v3/conversation|atomic|core|scenario` | `recall_memory` / `store_memory` / `search_memories` 失败 |
| 代码图谱（8 工具） | MemoryKnowledge :8421 | `/v3/code-graph/*` | `code_graph_list` 及 7 个 `code_*` 全部失败 |

- MemoryCore 网关**不路由** `/v3/code-graph/*`（它只有 `/v3/knowledge/*` 元数据，返回索引的
  `service_url`/`summary`）。把 `knowledgeEndpoint` 指到 `memory.<域名>` 只会得到
  `404 Not found: POST /v3/code-graph/list`；完全不带 Bearer 则先得到 `401 Unauthorized`。
- 引擎在远端时，必须给客户端一个**可达的 Knowledge 地址**（在网关上单独暴露 MemoryKnowledge）：

  ```yaml
  memoryEndpoint: https://memory.<域名>          # MemoryCore 网关
  knowledgeEndpoint: https://knowledge.<域名>    # MemoryKnowledge（独立暴露，默认端口 :8421）
  apiKeyRef: AGENT_MEMORY_API_KEY                # 两个通道都会发 Authorization: Bearer
  # knowledgeApiKeyRef: AGENT_MEMORY_KNOWLEDGE_KEY   # 仅当 Knowledge 接受的 key 与 MemoryCore 不同
  ```

- code-graph 客户端自 v0.1.1 起与 memory 通道对齐：请求带 `Authorization: Bearer`
  （专属 `knowledgeApiKey`/`knowledgeApiKeyRef` 优先，未配则回落 `apiKey`/`apiKeyRef`；
  都没有时不发该头，本机免鉴权的 MemoryKnowledge 照常可用），并把失败翻译成可执行诊断
  （401 缺 key / 404 指错网关 / 连接不可达），不再只抛 401/404 原文。
- 验证：`KNOWLEDGE_ENDPOINT=https://knowledge.<域名> node selftest.mjs --live` 会分别报告
  两条通道，一条不可用不会中断另一条。

## 安装

Linux/macOS：

```bash
./install.sh                                     # native（memory,codegraph）
./install.sh --mode mcp                          # 回退 MCP 双通道 + 守护
./install.sh --only memory,codegraph             # 子集
./install.sh --only engine --engine-dir <路径>    # 渲染引擎 systemd 单元模板
./install.sh --uninstall                         # 清两种模式的产物
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Mode mcp
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

装完把 config 里的 `<...>` 换成真实值（见 [.env.example](.env.example)），然后**重启 `dsh web`**。

> ⚠️ 本部署**未启用 `cordis-plugin-hmr`**；但实测 profile 条目新增/文件覆盖**会被运行中的实例拾取**
> （有延迟、不确定，见 WORKLOG 2026-09-13 的三条时间线证据），因此**改动后建议重启 dsh web** 以求一致。
> 另**不要**把 `name:` 写成 `./plugins/xxx/index.js?v=N`——loader 会把查询串当字面路径，
> 报 `ERR_MODULE_NOT_FOUND` 并让**整棵插件树加载失败**（已实测）。

## 凭证清单（都不许入库）

| config 键 | 用途 | 从哪来 |
|---|---|---|
| `teamId` / `agentId` / `userId` | v3 隔离三元组（非密钥） | Memory Panel（:8123）/ 团队管理员 |
| `userKeyRef` → `AGENT_MEMORY_USER_KEY` | 团队记忆 key（`sk-mem-…`） | 存进**受管凭证库**（见下） |
| `apiKeyRef` → `AGENT_MEMORY_API_KEY` | 网关门禁 key（`Authorization: Bearer`） | 存进**受管凭证库**（见下） |
| `knowledgeApiKeyRef` → `AGENT_MEMORY_KNOWLEDGE_KEY` | Knowledge 专属 key（**可选**，仅两者不同时） | 存进**受管凭证库**（见下） |
| `taskId` | L1 事实的项目标签（**不是** agent_id） | 自定（如 `normal-manager`）；不配则取会话 cwd 目录名 |
| `memoryEndpoint` / `knowledgeEndpoint` | MemoryCore / MemoryKnowledge 地址 | 本机端口或**远端可达地址**（见「远端部署」） |
| 引擎 LLM key | 记忆提炼 | 600 权限文件，见上 |

**引用式（推荐）**：`cordis.patch.yml` 里只写 `*Ref` 名，真值放 `%DSH_HOME%/.credentials.yaml`
（0600、原子写、热生效、永不回显）。存法二选一：

- 会话里让模型调 `credentials_set`（值会经过一次对话上下文；需要 credentials 插件 v0.0.2
  且该条目 `config.requireApproval: false`，否则本部署的 `never` 审批策略会直接拒绝）；
- 或**直接编辑** `%DSH_HOME%/.credentials.yaml` 的 `refs:` 段（更保守，改完无需重启）。

解析优先级：**凭证 seam（ref）> 同名环境变量 > 内联 `apiKey`/`userKey`**。内联值仅作切换期兜底；
两者同时存在时以凭证库为准，因此在凭证库里轮换 key **不需要**改 patch。

## 验收

1. **离线自检**（纯逻辑层，不需要 dsh）：`cd plugins/agent-memory-native && node selftest.mjs` → 47 ok
   （含 code-graph Bearer 头与 401/404/不可达 诊断断言）。
2. **真实引擎自检**：`node selftest.mjs --live`（只读）/ `--live --live-write`（含一次 L0 写入自检）；
   配置从环境变量或 profile 的 `cordis.patch.yml` 自动解析（native 与旧 mcp 条目都认）。
3. **重启后**：`journalctl --user -u dsh | grep agent-memory` 应出现
   `[agent-memory] ready v0.1.1: tools=11 capture=on ...`。
4. 会话里直接调 `recall_memory` / `code_graph_list`（native 模式无 `mcp__` 前缀）。
5. 自动入库：聊完一轮后日志出现 `[agent-memory] capture 已提交 session=… turn=N`，
   且 `%DSH_HOME%/.dsh-memory-autostore-state.json` 游标推进。

## 数据与排除项

- 记忆数据在 `~/.openclaw/memory-tdai/`（L0–L3、场景块、persona）→ **本机数据，永不入仓**。
- 游标 `%DSH_HOME%/.dsh-memory-autostore-state*.json` 为机器绑定状态，伞仓 profile 白名单已排除。
- `node_modules/`、`dist/`、`.turbo/` 不入库。

## 已知限制

- native 模式零依赖；mcp 模式默认从 npm 取 `tencent-agent-memory-mcp-bridge@0.4.0`（要离线自持可在
  `<伞仓>/agent-memory` 内构建后把 `args` 指向本地 `dist/index.js`）。
- 引擎用**本地部署分支**，不按 submodule 锁基线；升级须人工验证并记录 ref。
- 进程内入库是 fire-and-forget：引擎不可达时该轮不重试（守护模式才有重试/回填；需要回填用
  `node agent-memory/scripts/dsh-memory-autostore.mjs --backfill`）。
- code-graph 通道的可用性取决于 **MemoryKnowledge 对客户端可达**：MemoryCore 网关只提供
  `/v3/knowledge/*` 元数据，不代理 `/v3/code-graph/*`（见「远端部署」）。远端部署只暴露
  MemoryCore 时，8 个 `code_*` 工具会显式报错并给出应指向的地址，主记忆 3 个工具不受影响。

## 卸载

```bash
./install.sh --uninstall                  # 或 powershell ... -Uninstall
```

只剥离插件侧内容（native 载荷 + MCP 载荷 + cordis 标记块 + autostore 守护/计划任务）；
**不动** `~/.openclaw/memory-tdai/` 记忆数据，也不动第三方引擎。手工添加的旧条目（无
`# >>> agent-memory-dsh-plugin:` 标记）本包不会擅自动，会提示你手工处理。
