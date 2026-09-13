---
name: install-memory
description: 把 TencentDB Agent Memory（L0 对话→L1 原子事实→L2 场景→L3 画像）接入 dsh web。默认装**原生 cordis 插件** tool-agent-memory：11 个工具（recall_memory/store_memory/search_memories + code_* 8 个代码图谱工具）+ 进程内自动入库（turn/end 直提 L0），零外部依赖、无需 npx 与守护；也可 --mode mcp 回退到 MCP 双通道 + 外部守护。数据源为本机自托管引擎（MemoryCore :8422 / MemoryKnowledge :8421），需团队身份三元组与团队 key。当用户要求安装/卸载/排查 agent-memory、记忆不生效、code_graph 查不到仓库、或对话没有被自动入库时使用。
whenToUse: 用户想给 dsh 加长期记忆（跨会话记住事实/场景/画像）或代码图谱检索能力、要求安装或卸载 agent-memory 插件、或记忆相关功能不可用（工具缺失、召回为空、autostore 不提交）需要排查时。
---

# 安装 agent-memory 插件

把 `TencentDB Agent Memory` 在 DSH 侧的接入装进目标电脑的 dsh web。分三层，别混：

- **引擎（第三方）**：MemoryCore :8422 / MemoryKnowledge :8421 / MemoryProxy :8096 / MemoryPanel :8123 +
  TDAI gateway :8420。属上游项目，需另行部署（Linux systemd 或 docker）。
- **协议桥（我们自己的源码）**：伞仓 `agent-memory/`（MCP 桥、HTTP 桥 `bridge-server`、`dsh-memory-autostore.mjs`）。
- **接入器（本技能）**：伞仓 `dsh-plugins/plugins/agent-memory-dsh-plugin/`
  - `plugins/agent-memory-native/`：原生插件（默认路径，含工具与进程内入库）
  - `plugins/agent-memory-codegraph/`：MCP 模式的代码图谱 server

## 0. 定位插件包

插件包在伞仓 `dsh-plugins/plugins/agent-memory-dsh-plugin/`，二选一获取：

- 本地已有伞仓克隆：`<伞仓根>/dsh-plugins/plugins/agent-memory-dsh-plugin`
- 没有克隆：`git clone https://github.com/kuaizhongqiang/dsh-ecosystem.git`

安装脚本从包目录上溯三级找伞仓根。

## 1. 检查前置

1. Node.js `^22.19 || >=24`；`%DSH_HOME%\profiles\web` 已初始化（至少启动过一次 `dsh web`）
2. **引擎可达**：`curl -s http://127.0.0.1:8422/health`、`http://127.0.0.1:8421/health`
3. 取得团队身份：`TEAM_ID` / `AGENT_ID` / `USER_ID` / `USER_KEY`（Memory Panel :8123 或管理员）

## 2. 执行安装

```bash
cd <伞仓>/dsh-plugins/plugins/agent-memory-dsh-plugin
./install.sh                                   # native（默认）：插件 + 进程内入库
./install.sh --mode mcp                        # 回退 MCP 双通道 + 外部守护
./install.sh --only engine --engine-dir <路径>  # 渲染第三方引擎 systemd 模板
```

Windows：`powershell -ExecutionPolicy Bypass -File .\install.ps1 [-Mode mcp] [-Uninstall]`。

## 3. 填凭证（建议重启）

把生成的 `cordis.patch.yml` 条目里的 `<...>`（teamId/agentId/userId/taskId）换成真实值（对照 `.env.example`）。

密钥走**引用式**：条目里只有 `apiKeyRef: AGENT_MEMORY_API_KEY` / `userKeyRef: AGENT_MEMORY_USER_KEY`，
真值存受管凭证库 `%DSH_HOME%/.credentials.yaml` 的 `refs:` 段（0600、热生效）。存法二选一：

- 会话里调 `credentials_set`（需 credentials 插件 **v0.0.2** 且该条目 `config.requireApproval: false`，
  否则本部署的 `never` 审批策略会直接拒绝写入）；
- 或直接编辑 `%DSH_HOME%/.credentials.yaml`（更保守，改完无需重启）。

解析优先级 `凭证 seam > 同名环境变量 > 内联 apiKey/userKey`——在凭证库里轮换 key 不必改 patch。然后**重启 `dsh web`**：

```bash
systemctl --user restart dsh      # 本机部署方式
```

> 本部署**未启用 `cordis-plugin-hmr`**；实测条目/文件改动有时会被热加载（有延迟、不确定），**建议重启**以求一致。
> **不要**把 `name:` 写成 `./plugins/agent-memory-native/index.js?v=N`——loader 会把 `?v=N`
> 当字面路径，报 `ERR_MODULE_NOT_FOUND`，并让**整棵插件树加载失败**（已实测）。

## 4. 验收

1. 离线自检：`cd plugins/agent-memory-native && node selftest.mjs` → 25 ok；
   真实引擎：`node selftest.mjs --live`（只读）/ `--live --live-write`（含一次 L0 写入）。
2. 重启后 `journalctl --user -u dsh | grep agent-memory` 出现
   `[agent-memory] ready v0.1.0: tools=11 capture=on ...`。
3. 会话里调 `recall_memory` / `code_graph_list`（native 模式工具名**无** `mcp__` 前缀）。
4. 自动入库：聊一轮后日志出现 `[agent-memory] capture 已提交 session=… turn=N`，
   且 `%DSH_HOME%/.dsh-memory-autostore-state.json` 游标推进。

## 5. 排查

- 工具没出现：条目是否被加载（**重启过 dsh web 吗**）；`?v=` 写法是否误用；`id:` 是否重复
- 启动即失败 `plugin tree failed to load`：先看是不是 `name` 路径写错（含 `?v=` 必挂）
- 召回为空：`taskId` 是否与写入时一致（L1 按 task_id 隔离）；三元组是否正确；引擎是否在跑
- `code_graph_list` 为空：MemoryKnowledge 侧该 repo 是否已建索引（图谱由引擎 auto-sync 维护，本通道只读）
- 入库不动：native 模式看日志 `capture` 行与游标文件写权限；mcp 模式看
  `systemctl --user status dsh-memory-autostore`
- 引擎不可达时：native 入库是 fire-and-forget（该轮不重试）；需要回填用
  `node agent-memory/scripts/dsh-memory-autostore.mjs --backfill`

## 6. 卸载

```bash
./install.sh --uninstall
```

只剥离插件侧内容（native/MCP 载荷 + cordis 标记块 + 守护/计划任务）；**不动**
`~/.openclaw/memory-tdai/` 记忆数据与第三方引擎。手工添加的旧条目（无本包标记）不会被动，会提示手工处理。
