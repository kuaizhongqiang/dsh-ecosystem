# agent-memory-dsh-plugin

把「[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)」这套长期记忆
（L0 对话 → L1 原子事实 → L2 场景 → L3 画像）接入 DSH web profile 的**安装包**。一个条目下提供
三件事（可用 `--only` 子集安装）：主记忆 MCP 通道、代码图谱只读通道、自动入库守护。

> 分层：**引擎是第三方上游**（腾讯云，MIT），**`<伞仓>/agent-memory/` 是我们自己的协议桥源码**
> （MCP 桥 / HTTP 桥 / autostore 脚本），**本包是安装器与模板**。三层职责不要混。

## 服务（`--only`）

| 服务 | 装什么 | 关键产物 |
|---|---|---|
| `memory` | 主记忆 MCP 通道 `mcp-agent-memory`（`recall_memory` / `store_memory` / `search_memories`） | `cordis.patch.yml` 条目（`npx tencent-agent-memory-mcp-bridge@0.4.0` 固定版本，可换本地构建） |
| `codegraph` | 代码图谱只读通道 `mcp-agent-memory-codegraph`（`code_*` 8 工具，查 MemoryKnowledge 图谱） | `profiles/web/plugins/agent-memory-codegraph/` + patch 条目 |
| `autostore` | 自动入库守护：每轮 `turn/end` 把该轮对话提交进 MemoryCore（**默认提交、按需取回**） | Linux：`systemd --user` 单元；Windows：计划任务 + 隐藏窗口 VBS |
| `engine` | 第三方引擎的单元/配置**模板渲染**（不下载引擎本体） | `templates/systemd/*.service`、`templates/engine/*` |

默认集合 = `memory,codegraph,autostore`；`engine` 必须显式指定（它依赖另一份引擎检出）。

## 前置：引擎（第三方）

引擎不是本包内容，需另行部署（Linux/systemd 或 docker）：

```bash
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory
# 本团队部署验证过的 ref：分支 upgrade-v2.0.1（本地部署分支，含 pnpm 11 lockfile 重建）
#   本机检出：~/projects/TencentDB-Agent-Memory（该分支不回推上游）
```

引擎四个服务与端口：`MemoryCore` :8422（v3 元数据/gateway）、`MemoryKnowledge` :8421（knowledge + code-graph）、
`MemoryProxy` :8096（透明 LLM 上下文代理）、`MemoryPanel` :8123（团队记忆面板），外加 `TDAI HTTP Gateway` :8420
与我们的 HTTP 桥 `bridge-server` :3000。

- 引擎侧 LLM key **不写进仓库**：放 `~/.config/memory-gateway/llm_key.txt`、`embedding_key.txt`（600），
  由 `templates/engine/start-gateway-full.sh` 读取（避免 systemd 明文暴露）。
- Windows：引擎走 WSL2 或 docker（上游 `deploy/global-images`），本包的 `autostore` 有原生计划任务路径。

## 安装

Linux/macOS：

```bash
./install.sh                                  # memory,codegraph,autostore
./install.sh --only memory,codegraph          # 子集
./install.sh --only engine --engine-dir ~/projects/TencentDB-Agent-Memory
./install.sh --uninstall
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Only memory,codegraph
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

幂等：载荷覆盖复制；`cordis.patch.yml` 按 `# >>> agent-memory-dsh-plugin: <id> >>>` … `<<<` 标记块增删，
重复执行不产生重复条目，卸载按标记精确剥离。

**装完必做**：把条目 `env` 里的 `<...>` 占位符换成真实值（见 [.env.example](.env.example)），
然后重启 `dsh web`（cordis 条目在进程启动时加载）。

## 凭证清单（都不许入库）

| 值 | 用途 | 从哪来 |
|---|---|---|
| `TEAM_ID` / `AGENT_ID` / `USER_ID` | v3 隔离三元组 | Memory Panel（:8123）/ 团队管理员 |
| `USER_KEY`（`sk-mem-…`） | 团队记忆 key | 同上 |
| `API_KEY` | bridge-server 鉴权（单元里存 `sha256(API_KEY)`） | 自定 |
| `TASK_ID` | L1 事实的项目标签 | 自定（如 `normal-manager`） |
| 引擎 LLM key | 记忆提炼 | 放 600 权限文件，见上 |

## 验收

1. `systemctl --user status dsh-memory-autostore` → `active (running)`；
   `journalctl --user -u dsh-memory-autostore -n 5` → 出现 `轮询完成：无新轮次` 之类心跳。
2. 重启 dsh web 后，会话里应出现 `mcp__agent-memory__*`（3 工具）与 `mcp__agent-memory-codegraph__code_*`（8 工具）。
3. `code_graph_list` 能列出本 team 可见索引；`recall_memory` 能召回既有 L1 事实。
4. autostore 生效验证：新开一轮对话后 `journalctl` 出现提交计数（不是"无新轮次"）。

## 数据与排除项

- 运行时记忆数据在 `~/.openclaw/memory-tdai/`（L0–L3、场景块、persona）—— **本机数据，不进任何仓库**。
- 会话游标 `%DSH_HOME%/.dsh-memory-autostore-state*.json` 为机器绑定状态，伞仓的 profile 同步白名单**明确排除**。
- `agent-memory/` 内的 `node_modules/`、`dist/`、`.turbo/` 不入库（与上游 `.gitignore` 一致）。

## 已知限制

- 主记忆通道默认用 npm 上的 `tencent-agent-memory-mcp-bridge@0.4.0`（固定版本、需公网可达）；
  要离线自持，先在 `<伞仓>/agent-memory` 构建，再把条目 `args` 指向本地 `dist/index.js`。
- 引擎使用**本地部署分支**（非上游 commit），因此不按 submodule 锁基线；升级引擎须人工验证后记录 ref。
- Windows 下引擎侧需 WSL2/docker；`autostore` 之外的服务不提供 Windows 单元。

## 卸载

```bash
./install.sh --uninstall                   # 或 powershell ... -Uninstall
```

卸载不改动 `~/.openclaw/memory-tdai/` 数据；引擎单元模板如由本包渲染，会提示你手动清理。
