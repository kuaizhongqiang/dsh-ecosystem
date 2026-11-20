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

## 工具（native 模式，17 个）

| 工具 | 作用 |
|---|---|
| `memory_brief` | **会话简报**：绑定任务 + 未结 `work_task` + L3 画像摘要 + L2 场景索引 + 最近事实，压进 ~2.7K token 预算 |
| `recall_memory` | 召回当前 task 的 L1 事实；`include_persona` 默认 **false**，`include_scenes` 只返索引；支持 `type` / 时间窗 |
| `store_memory` | 显式把一轮对话写进 L0 |
| `search_memories` | L1 原子记忆语义检索（可按 type / 时间窗过滤） |
| `task_create` | **serve agent 专用**：建任务实体（服务端发号 `task-xxxx`）并自动绑定当前会话 |
| `task_bind` | 把**当前会话**绑定到一个 running 任务（校验存在/team/状态） |
| `task_get` / `task_list` | 读任务实体与关联 agent（只读） |
| `task_close` | **serve agent 专用**：置 completed 并解绑当前会话 |
| `code_graph_list` | 列出当前 team 可见的 code-graph 索引 |
| `code_search` / `code_callers` / `code_callees` / `code_impact` / `code_explore` / `code_node` / `code_files` | 代码图谱只读检索（符号/调用/影响面/文件） |

身份（`team_id`/`agent_id`/`user_id`）由插件 config 固定，**工具调用方不能传身份**；
`task_id` 的解析优先级是 **会话绑定 > `config.taskId` > cwd 目录名**；返回值带 `_context`
回显当前隔离域与 `task_source`。

## 任务绑定协议（TBP v1，v0.1.2 起）

`task_id` 从「随手拼的字符串」升级为**服务端发号 + 会话级绑定**：

1. serve agent 调 `task_create` → 引擎生成不可变 `task_id`（`meta_tasks`），当前会话自动绑定；
2. 派活时把 `task_id` 传给 worker；worker 调 `task_bind(task_id)`（校验存在 / 同 team / running）；
3. 绑定后该会话的**所有读写（含进程内自动入库）**都用这个 task_id；
4. 任务结束 `task_close`（仅 creator）→ 桶转只读；可复用方法应提前提炼到 agent 级 L2。

**边界**：只隔离 L0/L1；L2 场景与 L3 画像是 `(team, agent)` 级资产，跨任务共享（任务结束、方法论留下）。

完整规格（权限矩阵、失败模式、验收、回滚）见
[docs/task-binding-protocol.md](docs/task-binding-protocol.md)。

## 前置：引擎（第三方）

引擎不是本包内容，需另行部署（Linux/systemd 或 docker）：

```bash
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory
# 本团队部署验证过的 ref：分支 upgrade-v2.0.4 @ tag v2.0.4（本地部署分支，含 pnpm 11 lockfile 重建与抗 429 补丁，不回推上游）
# 注意 v2.0.3 起 MemoryKnowledge 的 PDF 抽取靠 pnpm 提升 pdfjs-dist（本机补丁见 docs/modules/agent-memory.md）；
# v2.0.4 起自定义记忆提示词支持 template（替换）模式，且 L2 场景整理分批可续跑
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
| `taskId` | 未绑定会话的默认 task 标签（**不是** agent_id） | 自定（如 `normal-manager`）；不配则取会话 cwd 目录名 |
| `taskAdmin` | 是否允许 `task_create` / `task_close`（serve agent 开 `true`；worker 保持 `false`） | 布尔，默认 `false` |
| `taskBindingPath` | 会话级绑定文件 | 默认 `%DSH_HOME%/.dsh-memory-task-bindings.json` |
| `briefBudgetChars` | `memory_brief` 字符预算 | 默认 `8000`（≈2.7K token） |
| `memoryEndpoint` / `knowledgeEndpoint` | MemoryCore / MemoryKnowledge 地址 | 本机端口或**远端可达地址**（见「远端部署」） |
| 引擎 LLM key | 记忆提炼 | 600 权限文件，见上 |

**引用式（推荐）**：`cordis.patch.yml` 里只写 `*Ref` 名，真值放 `%DSH_HOME%/.credentials.yaml`
（0600、原子写、热生效、永不回显）。存法二选一：

- 会话里让模型调 `credentials_set`（值会经过一次对话上下文；需要 credentials 插件 v0.0.2
  且该条目 `config.requireApproval: false`，否则本部署的 `never` 审批策略会直接拒绝）；
- 或**直接编辑** `%DSH_HOME%/.credentials.yaml` 的 `refs:` 段（更保守，改完无需重启）。

解析优先级：**凭证 seam（ref）> 同名环境变量 > 内联 `apiKey`/`userKey`**。内联值仅作切换期兜底；
两者同时存在时以凭证库为准，因此在凭证库里轮换 key **不需要**改 patch。

## ⚠️ 安全提示：引擎网关 key 曾以明文入库

`templates/engine/tdai-gateway.full.yaml` 的 `server.apiKey` 在历史提交
`2165f6c`（已推送 `origin/main`）里是**明文**，2026-11-20 已改为 `${TDAI_GATEWAY_API_KEY}`
占位。**仅改内容不能消除历史暴露**：如果这个 key 曾用于任何可从公网到达的网关，请按下面顺序轮换——

1. 改引擎配置 `MemoryCore/tdai-gateway.full.yaml` 的 `server.apiKey`（或改成 env 注入）；
2. 更新受管凭证库 `.credentials.yaml` 的 `AGENT_MEMORY_API_KEY`（`apiKeyRef` 指向它）；
3. 重启 `memory-gateway-full` 与 `dsh web`；
4. 旧 key 立即失效，历史里的字符串不再有利用价值。

本仓库的**团队 user key（`sk-mem-…`）从未入库**（只出现在 profile 的 `cordis.patch.yml`
与受管凭证库，二者都不在仓库内）。新增文档/模板时请沿用 `<...>` 与 `${ENV}` 占位，
不要把真值写进任何被 git 跟踪的文件。

## 验收

1. **离线自检**（纯逻辑层，不需要 dsh）：`cd plugins/agent-memory-native && node selftest.mjs` → **70 ok**
   （含 code-graph 诊断、会话绑定、meta 通道、brief 预算断言）。
2. **真实引擎自检**：`node selftest.mjs --live`（只读）/ `--live --live-write`（含一次 L0 写入自检）；
   配置从环境变量或 profile 的 `cordis.patch.yml` 自动解析（native 与旧 mcp 条目都认）。
3. **重启后**：`journalctl --user -u dsh | grep agent-memory` 应出现
   `[agent-memory] ready v0.1.2: tools=17 capture=on ...`。
4. 会话里直接调 `memory_brief` / `recall_memory` / `code_graph_list`（native 模式无 `mcp__` 前缀）。
   任务协议：`task_create` → `_context.task_id` 应为 `task-xxxx`；`task_list` 能看到它。
5. 自动入库：聊完一轮后日志出现 `[agent-memory] capture 已提交 session=… turn=N`，
   且 `%DSH_HOME%/.dsh-memory-autostore-state.json` 游标推进。

## 数据与排除项

- 记忆数据在引擎 `data.baseDir`（本机 `/home/kuai/memory-tdai/`，L0–L3、场景块、persona）→ **本机数据，永不入仓**。
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
- **L2/L3 不参与任务隔离**：画像作用域是 `(team, agent)`，同一 agent 的所有任务共享场景与画像。
  若要任务级场景，必须改引擎（profile 路径加 task 维度），代价大且会让画像碎片化。
- **绑定是会话级的**：子代理/新会话不会继承，需要各自 `task_bind`。`taskAdmin` 是 profile 级，
  子代理会继承；硬隔离 worker 请用独立 profile（`taskAdmin: false`）。
- **历史桶只读保留**：31 个历史 `task_id` 不迁移；新任务走 TBP 后旧桶与新桶互不影响。

## 卸载

```bash
./install.sh --uninstall                  # 或 powershell ... -Uninstall
```

只剥离插件侧内容（native 载荷 + MCP 载荷 + cordis 标记块 + autostore 守护/计划任务）；
**不动** `~/.openclaw/memory-tdai/` 记忆数据，也不动第三方引擎。手工添加的旧条目（无
`# >>> agent-memory-dsh-plugin:` 标记）本包不会擅自动，会提示你手工处理。
