# agent-memory — L5 记忆层（伞仓内目录 + L3 插件包）

| 项 | 值 |
|---|---|
| 来源仓 | [kuaizhongqiang/TencentAgentMemoryBridge](https://github.com/kuaizhongqiang/TencentAgentMemoryBridge)（并入伞仓后作为上游保留，DSH 侧不再单独维护；无 gh CLI 故未在 GitHub 侧归档） |
| 形态 | **伞仓内目录 `agent-memory/`**（我们的协议桥源码）+ **L3 插件包 `dsh-plugins/plugins/agent-memory-dsh-plugin/`**（安装器与模板） |
| 生态位 | L5 记忆层：把第三方记忆引擎接入 DSH 与其它 Agent 平台 |
| 并入 HEAD | `4080826`（含 1 笔当时未提交的 autostore 修复，已随并入落库） |
| 当前版本 | 0.3.0（`agent-memory/package.json`） |
| 引擎 | **第三方上游**：[TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)（MIT）。本团队部署验证 ref：分支 **`upgrade-v2.0.4` @ tag `v2.0.4`**（2026-11-18 发布，2026-11-20 升级；**本地部署分支，不回推上游**），故不按 submodule 锁基线 |

## 角色：三层职责

```
DSH / Claude Code / CodeBuddy / OpenClaw
        │  MCP（stdio）                     │  HTTP
        ▼                                   ▼
 mcp-bridge（本仓 packages/mcp-bridge）   bridge-server（本仓 packages/bridge-server）
        │                                   │
        └──────────────► TDAI gateway :8420 ◄┘
                              │
        ┌─────────────────────┼──────────────────────┐
        ▼                     ▼                      ▼
 MemoryCore :8422     MemoryKnowledge :8421    MemoryProxy :8096 / MemoryPanel :8123
        └──────────── 第三方引擎（TencentDB Agent Memory） ────────────┘
```

- **引擎（第三方）**：L0 对话 → L1 原子事实 → L2 场景 → L3 画像的沉淀与检索（BM25 + 向量 + RRF，
  带条数/字符预算/超时约束），由四个服务加 TDAI gateway 组成。
- **我们的桥（本目录）**：`packages/mcp-bridge`（MCP stdio server，npm 包 `tencent-agent-memory-mcp-bridge`）、
  `packages/bridge-server`（HTTP 鉴权 + 代理）、`scripts/dsh-memory-autostore.mjs`（DSH 侧自动入库守护）。
- **接入器（L3 插件包）**：把上述能力装进 DSH web profile（两条 MCP 通道 + autostore 守护 + 引擎单元模板），
  见 [dsh-plugins/plugins/agent-memory-dsh-plugin](../../dsh-plugins/plugins/agent-memory-dsh-plugin/README.md)
  与技能 [install-memory](../../dsh-plugins/skills/install-memory/SKILL.md)。

## DSH 侧接入：native（默认）与 mcp 两种模式

| 模式 | cordis id | 工具 | 自动入库 | 依赖 |
|---|---|---|---|---|
| **native（默认）** | `tool-agent-memory`（`plugins/agent-memory-native/`） | 17 工具，**无前缀**：`memory_brief` + `recall/store/search` + `task_*` ×5 + `code_*` ×8 | **进程内**：`ctx.on('session/event')` 的 `turn/end` 直提 L0 | 零（只用 fetch 打引擎 HTTP） |
| mcp（兼容） | `mcp-agent-memory` / `mcp-agent-memory-codegraph` | 9 个 memory 工具（含 `memory_brief` / `task_*`）+ codegraph 独立 server，带 `mcp__*__` 前缀 | 外部守护扫 `sessions/` | `npx tencent-agent-memory-mcp-bridge@0.5.0` + 本地子进程 |

两种模式**共用去重游标** `%DSH_HOME%/.dsh-memory-autostore-state.json`（`session_id + turn`），可互换不重复提交。

> **任务绑定协议（TBP v1，v0.1.2+）**：`task_id` 由 `task_create` 服务端发号（`meta_tasks`），
> `task_bind` 做**会话级**绑定；绑定后该会话所有读写（含自动入库）都落到这个桶。
> 只隔离 L0/L1；L2/L3 仍是 `(team, agent)` 级。规格见
> [task-binding-protocol.md](../../dsh-plugins/plugins/agent-memory-dsh-plugin/docs/task-binding-protocol.md)。
L1（语义事实）与 code-graph（确定性代码检索）**不复用同一 namespace**；设计见
[agent-memory-codegraph.md](agent-memory-codegraph.md)。原生插件的纯逻辑在 `plugins/agent-memory-native/lib.js`，
可用 `node selftest.mjs`（mock **67 项** / `--live` 打真实引擎）独立验证。

### 两条通道的端点与鉴权（issue #29）

`memoryEndpoint`（MemoryCore :8422）与 `knowledgeEndpoint`（MemoryKnowledge :8421）是**两个服务**：
`/v3/code-graph/*` 只由 MemoryKnowledge 提供，MemoryCore 网关只有 `/v3/knowledge/*` 元数据、
**不代理** code-graph。因此远端部署（客户端只连 `memory.<域名>`）会让 8 个 `code_*` 工具失败：
不带 Bearer → `401`，带上 Bearer → `404 Not found: POST /v3/code-graph/list`。

插件侧已对齐两条通道（v0.1.1）：code-graph 请求同样发 `Authorization: Bearer`
（专属 `knowledgeApiKey`/`knowledgeApiKeyRef` 优先，未配则回落共享 `apiKey`/`apiKeyRef`；
都没有时不发该头，本机免鉴权的 MemoryKnowledge 照常可用），并把三类失败翻译成可执行诊断
（401 缺 key / 404 指错网关 / 连接不可达），不再只抛 401/404 原文。
部署侧要么在网关上**单独暴露 MemoryKnowledge**（如 `https://knowledge.<域名>`）并把它写进
`knowledgeEndpoint`，要么给客户端一个内网/隧道可达的 `:8421` 地址。

## 运维控制台（agent-memory-admin，v0.1.2）

`dsh-plugins/plugins/agent-memory-admin/` 是独立的 native 插件（8 工具），给**维护者**用：

| 工具 | 作用 |
|---|---|
| `memory_overview` | 引擎健康 + L0/L1/L2/L3 计数 + 按类型 + Top 任务/Agent + task 实体 + 绑定 + 游标 + DB 大小 |
| `memory_health` | 健康 + 计数 + 绑定 + capture |
| `memory_list` | 团队级 L1 分页（task/agent/user/type/时间窗） |
| `memory_search` | 团队级检索（不限当前 task） |
| `memory_get` | 读 L2 路径 / L3 画像 / task 实体 |
| `memory_edit` | 改/删 L1、写/删 L2、写 L3（删除需 confirm） |
| `memory_prompts` | 查看生效提示词与 settings（只读） |
| `memory_tasks` | task list/get/create（支持自定义 id）/close |

**团队级作用域**：数据面默认把缺失的身份填成 `default`，所以只传 `team_id` 查不到真实数据。
控制台通过 `x-tdai-admin-key` + body `scope:"team"` 获得团队级视图；网关只在
`TDAI_ADMIN_KEY` 匹配时才跳过默认桶填充，否则忽略 `scope=team`（不放宽隔离）。
密钥放 `~/.config/memory-gateway/admin_key.txt`（600）与凭证库 `AGENT_MEMORY_ADMIN_KEY`。

**端点必须把 `x-tdai-admin-key` 原样透传**：`bridge-server` 早期 `/v3/*` 白名单只有
`authorization` / `x-tdai-service-id` / `content-type` / `accept`，过桥的身份头与管理头透传不完整 →
`scope=team` 被忽略、按 `default` 桶静默返回 0（看起来像 key 配错或"没有记忆"）。
2026-11-27 起 `bridge-server` 改为按 `x-tdai-*` 前缀全转发；插件 0.1.2 起在"团队级计数为 0 但本机
`vectors.db` 有 L1"时直接抛诊断，不再让 0 冒充结果。

**计数口径（验收必看）**：`/v3/atomic/count` 只带 `scope:"team"` 返回的是**跨团队**聚合；
带 `team_id` 才是本团队计数。2026-11-27 实测同一端点两次请求：不带 `team_id` → 9928，
带 `team_id=team-w7eai9w6kc` → **9530**（= `memory_health` 的 L1）。验收 curl 必须带 `team_id`。

详见 [agent-memory-admin/README.md](../../dsh-plugins/plugins/agent-memory-admin/README.md)。

## 自动入库（建议即沉淀）

`agent-memory/scripts/dsh-memory-autostore.mjs` 监听 `%DSH_HOME%/sessions`，每个 `turn/end` 把该轮
user + assistant 文本提交进 MemoryCore（默认提交、按需取回，不自动注入 prompt）。守护模式 10s 轮询；
游标 `%DSH_HOME%/.dsh-memory-autostore-state.json` 为**机器绑定状态**，在 launcher profile 同步白名单里被显式排除。

> 注意：该脚本**不做密钥脱敏**——会话里粘贴过的明文密钥会被原样提交进记忆库。凭据请勿经聊天传递。

## 凭证接入（引用式）

原生插件支持 `apiKeyRef` / `userKeyRef`（以及 code-graph 专属的 `knowledgeApiKeyRef`）：`cordis.patch.yml` 只写引用名，
真值放受管凭证库 `%DSH_HOME%/.credentials.yaml`（`refs:` 段，0600、原子写、热生效），解析优先级
**凭证 seam（`ctx.get('credentials')` + `credentialRef`/`resolve`）> 同名环境变量 > 内联值**。
好处：轮换 key 不必改 patch、密钥不再散落在 profile 配置里；内联值仅作切换期兜底。
凭证写入门径见 credentials 插件（v0.0.2；本部署 approval 策略为 `never`，需 `requireApproval: false`）。

## 数据与红线

- 记忆数据在引擎 `data.baseDir`（本机 `/home/kuai/memory-tdai/`；L0–L3、场景块、persona）→ **本机数据，永不入仓**。
- `.dsh-memory-task-bindings.json`（会话级 task 绑定）为机器绑定状态，**不含任何 key**，同样不入仓。
- 引擎 LLM key 放 `~/.config/memory-gateway/{llm,embedding}_key.txt`（600），由
  `templates/engine/start-gateway-full.sh` 读取，避免 systemd 明文。
- 团队身份（`TEAM_ID` / `AGENT_ID` / `USER_ID` / `USER_KEY`）与桥 `API_KEY` 一律走
  `cordis.patch.yml` 的 env 占位符，仓库内只保留 `<...>` 模板。
- `node_modules/`、`dist/`、`.turbo/` 不入库（与上游 `.gitignore` 一致）。

## 验收

1. 引擎服务：`systemctl --user status memory-core... `（本机为 memory-gateway-full / memory-knowledge / memory-panel / memory-proxy / tdai-gateway / memory-bridge）。
2. **重启 dsh web**（本部署未启用 HMR，改代码/增删条目必须重启）后，
   `journalctl --user -u dsh | grep agent-memory` 出现 `[agent-memory] ready v0.1.2: tools=17 capture=on`。
3. native 模式工具名无前缀：`memory_brief` / `recall_memory` / `task_list` / `code_graph_list`；mcp 模式为 `mcp__agent-memory__*` / `mcp__agent-memory-codegraph__code_*`（mcp 尚未带 TBP 工具）。
4. 自动入库：native 看 `[agent-memory] capture 已提交 session=… turn=N`；mcp 看
   `journalctl --user -u dsh-memory-autostore` 的增量计数。

## 已知限制

- native 模式零依赖；mcp 模式的 npm 只发布到 `0.4.0`（**不含 TBP**）；要 TBP 用伞仓源码构建的 `dist/index.js`（0.5.0 / 0.6.0 均未发布 npm，见 issue #64），
  要离线自持需在 `agent-memory/` 内构建后把 `args` 指向本地 `dist/index.js`。
- native 的进程内入库是 fire-and-forget：引擎不可达时该轮不重试（要回填用守护的 `--backfill`）。
- **`cordis.patch.yml` 的 `name` 不能写 `?v=N`**：本部署 loader 把查询串当字面路径，
  实测报 `ERR_MODULE_NOT_FOUND` 并让整棵插件树加载失败（2026-09-13 实测）。改插件后建议重启
  （实测有时会被热加载，不可依赖）。
- 引擎用本地部署分支，升级须人工验证并记录 ref（不随伞仓 tag 自动推进）。最近一次：
  **v2.0.3 → v2.0.4（2026-11-20）**，过程与备份/回滚点见 [WORKLOG](../WORKLOG.md)。
- **本机 pnpm 补丁（v2.0.3 起必要）**：`MemoryKnowledge` 的 PDF 抽取靠 `officeparser` 在 Node 下
  `require.resolve('pdfjs-dist/...')` 找 worker，而 pnpm 严格布局不把传递依赖 `pdfjs-dist` 提到顶层 →
  启动 warn `PDF_WORKER_MISSING`（PDF 导入必失败）。修复写在本机 **untracked** 的
  `MemoryKnowledge/pnpm-workspace.yaml`：`publicHoistPattern: [pdfjs-dist]`，再 `CI=true pnpm install`
  （hoist 布局变更会重建 modules，非 TTY 下必须带 `CI=true`）。上游用 npm（新增 `package-lock.json`）无此问题。
- **构建类安装别在 `NODE_ENV=production` 下跑 npm**：会静默 omit devDependencies（`MemoryPanel/web`
  的 `tsc` 就报 `react-dom/client` 缺类型）；用 `NODE_ENV=development npm install --include=dev`，
  且**别用 `cmd | tail` 取退出码**（管道会把失败吞成 0）。
- **`atomic/update` 不刷新 `l1_vec` 的 `updated_at`**（2026-11-27 实测）：内容与检索侧已同步（新措辞能命中），
  但向量索引里的时间戳仍是旧值 —— 同一条记录 `l1_records.updated_time = 2026-11-27T13:22:25.752Z`，
  而 `memory_search` 返回 `updated_at: 2026-06-12T14:51:36.995Z`（正是修复前"最老基线行"抄错的时间）。
  按时间排序/衰减的召回会把它误判成旧记忆，待引擎侧补刷向量 metadata。
- Windows 下引擎侧需 WSL2/docker；native 插件与 autostore 计划任务可用。

## 相关文档

- 插件包：[dsh-plugins/plugins/agent-memory-dsh-plugin](../../dsh-plugins/plugins/agent-memory-dsh-plugin/README.md)（安装/卸载/凭证/验收）
- 代码图谱通道设计：[agent-memory-codegraph.md](agent-memory-codegraph.md)
- 桥源码：`agent-memory/README.md`、`agent-memory/docs/`（团队版角色模型、MCP 桥 v3、DSH 接入等 7 篇）
