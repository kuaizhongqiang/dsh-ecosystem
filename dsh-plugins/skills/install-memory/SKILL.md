---
name: install-memory
description: 把 TencentDB Agent Memory（L0 对话→L1 原子事实→L2 场景→L3 画像）接入 dsh web：主记忆 MCP 通道（recall_memory/store_memory/search_memories）、代码图谱只读通道（code_* 8 工具）、自动入库守护（每轮 turn/end 提交进 MemoryCore）。数据源为本机自托管引擎（MemoryCore :8422 / MemoryKnowledge :8421），需团队身份三元组与团队 key。当用户要求安装/卸载/排查 agent-memory、记忆不生效、code_graph 查不到仓库、或对话没有被自动入库时使用。
whenToUse: 用户想给 dsh 加长期记忆（跨会话记住事实/场景/画像）或代码图谱检索能力、要求安装或卸载 agent-memory 插件、或记忆相关功能不可用（MCP 工具缺失、召回为空、autostore 不提交）需要排查时。
---

# 安装 agent-memory 插件

把 `TencentDB Agent Memory` 在 DSH 侧的接入装进目标电脑的 dsh web。分三层，别混：

- **引擎（第三方）**：MemoryCore :8422 / MemoryKnowledge :8421 / MemoryProxy :8096 / MemoryPanel :8123 +
  TDAI gateway :8420。属上游项目，需另行部署（Linux systemd 或 docker）。
- **协议桥（我们自己的源码）**：伞仓 `agent-memory/`（MCP 桥、HTTP 桥 `bridge-server`、`dsh-memory-autostore.mjs`）。
- **安装器（本技能）**：伞仓 `dsh-plugins/plugins/agent-memory-dsh-plugin/`。

## 0. 定位插件包

插件包在伞仓 `dsh-plugins/plugins/agent-memory-dsh-plugin/`，二选一获取：

- 本地已有伞仓克隆：直接用 `<伞仓根>/dsh-plugins/plugins/agent-memory-dsh-plugin`
- 没有克隆：`git clone https://github.com/kuaizhongqiang/dsh-ecosystem.git`

安装脚本从包目录上溯三级找伞仓根，据此定位 `agent-memory/` 里的 autostore 脚本。

## 1. 检查前置

1. Node.js `^22.19 || >=24`；`%DSH_HOME%\profiles\web` 已初始化（至少启动过一次 `dsh web`）
2. **引擎可 reachable**：`curl -s http://127.0.0.1:8422/health`、`http://127.0.0.1:8421/health`
   （引擎未起时，MCP 通道能装上但调用会报端点错误——属前置缺失，不是插件故障）
3. 取得团队身份：`TEAM_ID` / `AGENT_ID` / `USER_ID` / `USER_KEY`（Memory Panel :8123 或管理员）

## 2. 执行安装

Linux/macOS：

```bash
cd <伞仓>/dsh-plugins/plugins/agent-memory-dsh-plugin
./install.sh                          # memory,codegraph,autostore
./install.sh --only memory,codegraph  # 只装通道，不装守护
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本幂等（载荷覆盖复制 + `cordis.patch.yml` 按标记块增删）。

## 3. 填凭证并重启

把生成的 `cordis.patch.yml` 条目里 `<TEAM_ID>` / `<AGENT_ID>` / `<USER_ID>` / `<USER_KEY>` / `API_KEY`
换成真实值（对照 `.env.example`），然后**重启 `dsh web`** —— cordis 条目在进程启动时加载，
只改文件不重启不生效。

## 4. 验收

1. `systemctl --user status dsh-memory-autostore` → `active (running)`；
   `journalctl --user -u dsh-memory-autostore -n 5` 有心跳（`轮询完成：无新轮次`）。
2. 会话里出现 `mcp__agent-memory__*`（3 个）与 `mcp__agent-memory-codegraph__code_*`（8 个）工具。
3. `code_graph_list` 能列出本 team 可见索引；`recall_memory` 能召回既有事实。
4. 自动入库：新聊一轮后 `journalctl` 出现增量提交计数（不再是"无新轮次"）。

## 5. 排查

- MCP 工具没出现：`cordis.patch.yml` 条目是否被加载（重启过 dsh web？`id:` 是否重复）；`npx` 能否联网取到 `tencent-agent-memory-mcp-bridge@0.4.0`
- 召回为空：`TASK_ID` 是否与当初写入时一致（L1 按 task_id 隔离）；`TEAM_ID/AGENT_ID/USER_ID` 三元组是否正确；引擎 `memory-gateway-full` / `memory-knowledge` 是否在跑
- `code_graph_list` 为空：MemoryKnowledge 侧该 repo 是否已建索引（图谱由引擎 auto-sync 维护，本通道只读）
- autostore 一直"无新轮次"：`%DSH_HOME%/sessions` 是否有新会话文件；游标文件 `%DSH_HOME%/.dsh-memory-autostore-state.json` 是否可写；桥端点 `MEMORY_ENDPOINT` 是否可达
- 想重放历史轮次：`node agent-memory/scripts/dsh-memory-autostore.mjs --backfill`（守护启动前用，慎用）

## 6. 卸载

```bash
./install.sh --uninstall   # 或 powershell ... -Uninstall
```

只剥离插件侧内容（载荷 + cordis 标记块 + autostore 单元/计划任务）；**不动** `~/.openclaw/memory-tdai/`
记忆数据，也不动第三方引擎。
