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

> ⚠️ 本部署**未启用 `cordis-plugin-hmr`**：改插件 JS 或增删条目都必须重启 dsh web。
> 另**不要**把 `name:` 写成 `./plugins/xxx/index.js?v=N`——loader 会把查询串当字面路径，
> 报 `ERR_MODULE_NOT_FOUND` 并让**整棵插件树加载失败**（已实测）。

## 凭证清单（都不许入库）

| config 键 | 用途 | 从哪来 |
|---|---|---|
| `teamId` / `agentId` / `userId` | v3 隔离三元组 | Memory Panel（:8123）/ 团队管理员 |
| `userKey`（`sk-mem-…`） | 团队记忆 key | 同上 |
| `apiKey` | 网关门禁 key（`Authorization: Bearer`） | 自定/团队 |
| `taskId` | L1 事实的项目标签（**不是** agent_id） | 自定（如 `normal-manager`）；不配则取会话 cwd 目录名 |
| `memoryEndpoint` / `knowledgeEndpoint` | MemoryCore / MemoryKnowledge | 本地部署地址 |
| 引擎 LLM key | 记忆提炼 | 600 权限文件，见上 |

## 验收

1. **离线自检**（纯逻辑层，不需要 dsh）：`cd plugins/agent-memory-native && node selftest.mjs` → 25 ok。
2. **真实引擎自检**：`node selftest.mjs --live`（只读）/ `--live --live-write`（含一次 L0 写入自检）。
3. **重启后**：`journalctl --user -u dsh | grep agent-memory` 应出现
   `[agent-memory] ready v0.1.0: tools=11 capture=on ...`。
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

## 卸载

```bash
./install.sh --uninstall                  # 或 powershell ... -Uninstall
```

只剥离插件侧内容（native 载荷 + MCP 载荷 + cordis 标记块 + autostore 守护/计划任务）；
**不动** `~/.openclaw/memory-tdai/` 记忆数据，也不动第三方引擎。手工添加的旧条目（无
`# >>> agent-memory-dsh-plugin:` 标记）本包不会擅自动，会提示你手工处理。
