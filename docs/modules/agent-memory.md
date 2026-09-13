# agent-memory — L5 记忆层（伞仓内目录 + L3 插件包）

| 项 | 值 |
|---|---|
| 来源仓 | [kuaizhongqiang/TencentAgentMemoryBridge](https://github.com/kuaizhongqiang/TencentAgentMemoryBridge)（并入伞仓后作为上游保留，DSH 侧不再单独维护；无 gh CLI 故未在 GitHub 侧归档） |
| 形态 | **伞仓内目录 `agent-memory/`**（我们的协议桥源码）+ **L3 插件包 `dsh-plugins/plugins/agent-memory-dsh-plugin/`**（安装器与模板） |
| 生态位 | L5 记忆层：把第三方记忆引擎接入 DSH 与其它 Agent 平台 |
| 并入 HEAD | `4080826`（含 1 笔当时未提交的 autostore 修复，已随并入落库） |
| 当前版本 | 0.3.0（`agent-memory/package.json`） |
| 引擎 | **第三方上游**：[TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)（MIT）。本团队部署验证 ref：分支 `upgrade-v2.0.1`（**本地部署分支，不回推上游**），故不按 submodule 锁基线 |

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
| **native（默认）** | `tool-agent-memory`（`plugins/agent-memory-native/`） | `recall_memory` / `store_memory` / `search_memories` + `code_*` 8 工具，**无前缀** | **进程内**：`ctx.on('session/event')` 的 `turn/end` 直提 L0 | 零（只用 fetch 打引擎 HTTP） |
| mcp（兼容） | `mcp-agent-memory` / `mcp-agent-memory-codegraph` | 同名 11 工具，带 `mcp__*__` 前缀 | 外部守护扫 `sessions/` | `npx tencent-agent-memory-mcp-bridge@0.4.0` + 本地子进程 |

两种模式**共用去重游标** `%DSH_HOME%/.dsh-memory-autostore-state.json`（`session_id + turn`），可互换不重复提交。
L1（语义事实）与 code-graph（确定性代码检索）**不复用同一 namespace**；设计见
[agent-memory-codegraph.md](agent-memory-codegraph.md)。原生插件的纯逻辑在 `plugins/agent-memory-native/lib.js`，
可用 `node selftest.mjs`（mock 25 项 / `--live` 打真实引擎）独立验证。

## 自动入库（建议即沉淀）

`agent-memory/scripts/dsh-memory-autostore.mjs` 监听 `%DSH_HOME%/sessions`，每个 `turn/end` 把该轮
user + assistant 文本提交进 MemoryCore（默认提交、按需取回，不自动注入 prompt）。守护模式 10s 轮询；
游标 `%DSH_HOME%/.dsh-memory-autostore-state.json` 为**机器绑定状态**，在 launcher profile 同步白名单里被显式排除。

> 注意：该脚本**不做密钥脱敏**——会话里粘贴过的明文密钥会被原样提交进记忆库。凭据请勿经聊天传递。

## 凭证接入（引用式）

原生插件支持 `apiKeyRef` / `userKeyRef`：`cordis.patch.yml` 只写引用名，真值放受管凭证库
`%DSH_HOME%/.credentials.yaml`（`refs:` 段，0600、原子写、热生效），解析优先级
**凭证 seam（`ctx.get('credentials')` + `credentialRef`/`resolve`）> 同名环境变量 > 内联值**。
好处：轮换 key 不必改 patch、密钥不再散落在 profile 配置里；内联值仅作切换期兜底。
凭证写入门径见 credentials 插件（v0.0.2；本部署 approval 策略为 `never`，需 `requireApproval: false`）。

## 数据与红线

- 记忆数据在 `~/.openclaw/memory-tdai/`（L0–L3、场景块、persona）→ **本机数据，永不入仓**。
- 引擎 LLM key 放 `~/.config/memory-gateway/{llm,embedding}_key.txt`（600），由
  `templates/engine/start-gateway-full.sh` 读取，避免 systemd 明文。
- 团队身份（`TEAM_ID` / `AGENT_ID` / `USER_ID` / `USER_KEY`）与桥 `API_KEY` 一律走
  `cordis.patch.yml` 的 env 占位符，仓库内只保留 `<...>` 模板。
- `node_modules/`、`dist/`、`.turbo/` 不入库（与上游 `.gitignore` 一致）。

## 验收

1. 引擎服务：`systemctl --user status memory-core... `（本机为 memory-gateway-full / memory-knowledge / memory-panel / memory-proxy / tdai-gateway / memory-bridge）。
2. **重启 dsh web**（本部署未启用 HMR，改代码/增删条目必须重启）后，
   `journalctl --user -u dsh | grep agent-memory` 出现 `[agent-memory] ready v0.1.0: tools=11 capture=on`。
3. native 模式工具名无前缀：`recall_memory` / `code_graph_list`；mcp 模式为 `mcp__agent-memory__*` / `mcp__agent-memory-codegraph__code_*`。
4. 自动入库：native 看 `[agent-memory] capture 已提交 session=… turn=N`；mcp 看
   `journalctl --user -u dsh-memory-autostore` 的增量计数。

## 已知限制

- native 模式零依赖；mcp 模式默认用 npm 上的 `tencent-agent-memory-mcp-bridge@0.4.0`（需公网），
  要离线自持需在 `agent-memory/` 内构建后把 `args` 指向本地 `dist/index.js`。
- native 的进程内入库是 fire-and-forget：引擎不可达时该轮不重试（要回填用守护的 `--backfill`）。
- **`cordis.patch.yml` 的 `name` 不能写 `?v=N`**：本部署 loader 把查询串当字面路径，
  实测报 `ERR_MODULE_NOT_FOUND` 并让整棵插件树加载失败（2026-09-13 实测）。改插件后建议重启
  （实测有时会被热加载，不可依赖）。
- 引擎用本地部署分支，升级须人工验证并记录 ref（不随伞仓 tag 自动推进）。
- Windows 下引擎侧需 WSL2/docker；native 插件与 autostore 计划任务可用。

## 相关文档

- 插件包：[dsh-plugins/plugins/agent-memory-dsh-plugin](../../dsh-plugins/plugins/agent-memory-dsh-plugin/README.md)（安装/卸载/凭证/验收）
- 代码图谱通道设计：[agent-memory-codegraph.md](agent-memory-codegraph.md)
- 桥源码：`agent-memory/README.md`、`agent-memory/docs/`（团队版角色模型、MCP 桥 v3、DSH 接入等 7 篇）
