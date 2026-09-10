# agent-memory MCP × code-graph：通道设计（milestone #3 / issue #25）

> 状态：**设计定稿**（2026-09-10）。调研事实清单见 issue #24 评论；实现见
> `dsh-plugins/plugins/agent-memory-codegraph-dsh-plugin/`（issue #26）；端到端验收见 issue #27。
> 前置阅读：`docs/modules/README.md`（模块文档约定）、本机 MemoryCore/MemoryKnowledge 部署（feat/server_team @ 0a568c3）。

## 1. 位置：独立只读检索通道（并列于 L1/L2/L3，不复用 recall）

- code-graph 是**仓库资产级**的确定性检索（符号/调用/文件），与 L1「事实记忆」的
  语义检索语义不同。设计上**不复用** `recall_memory/search_memories` 的 namespace
  （混入会让两类检索都不可预期），而是提供**独立 MCP 通道**：
  一个新的 mcp-client 实例 `serverName: agent-memory-codegraph`，工具
  `mcp__agent-memory-codegraph__code_*`（8 个，全部只读）。
- 触发方式：agent 面对「符号被谁调用 / 模块依赖 / 变更影响 / 代码在哪」类问题
  **显式调用** code_* 工具；`recall_memory` 不做 code-graph 自动注入，保持确定性。
- 与 L1/L2/L3 的边界：L1=task 级对话事实（TASK_ID 隔离）、L2=场景索引、L3=人格/团队纪律；
  code-graph=team/user 级**仓库图谱资产**，不与这三层合并存储，也不参与 prompt 自动组装。

## 2. 数据模型与隔离维度

- 图谱本体由 MemoryKnowledge（本机 `:8421`）持有：每个索引 = 一个仓库
  `(service_id, team_id, code_graph_id, repo_url, branch)`，内含文件/符号节点
  （function/method/class/interface/type/variable/route/component）与调用边，
  支持 search/callers/callees/impact/explore/node/files/status。
- 元数据镜像在 MemoryCore knowledge（`:8422`，`type="code-graph"`）：
  `knowledge_id=cg-*`、`repo_url`、`summary`（文件数/符号数）、`service_url`。
- 隔离：除了上游已用的 TASK_ID（L1 记忆项目标签），code-graph 维度为
  **service_id + team_id + user_id**（即 `x-tdai-service-id` + env `TEAM_ID`）。
  本通道**只列出/查询 env TEAM_ID 可见的索引**，调用方永远无法传入身份。
- 当前本 team（team-w7eai9w6kc）可见索引 3 个（2026-09-09 23:16 同步，均 ready）：
  dsh-ecosystem（cg-oinaqfs3，136 文件/2389 符号）、MCV_Module（cg-eai0n5eu）、
  threejs-test（cg-ee0dync2）。

## 3. 同步与新鲜度

- 由 MemoryKnowledge 的 auto-sync 调度器负责（仓库索引建/更新/事件拉齐），
  本通道不建索引、不写图谱。查询总是打**实时引擎实例**，不存在本层 TTL 过期问题。
- 本层仅缓存「可见索引列表」用于 repo→code_graph_id 解析（TTL 60s，可环境变量调），
  并在 `code_graph_list` 时强制刷新。

## 4. 检索面：工具签名草案（v1）

全部只读；`repo` 支持完整 URL 或短名；引擎返回 markdown 文本证据（含 文件:行）。

| 工具 | 参数 | 备注 |
|---|---|---|
| `code_graph_list` | — | 列出 team 可见索引（cg-id/仓库/状态/规模） |
| `code_search` | query*, repo?, kind?, limit?(1-100,默认10) | 符号/语义搜索 |
| `code_callers` | symbol*, repo?, limit?(默认20) | “被谁调用” |
| `code_callees` | symbol*, repo?, limit?(默认20) | “调用了谁” |
| `code_impact` | symbol*, repo?, depth?(1-10,默认2) | 变更影响面 |
| `code_explore` | query*, repo?, maxFiles?(1-200,默认12) | 语义定位文件 |
| `code_node` | symbol*, repo?, includeCode?, file?, line? | 符号定义详情 |
| `code_files` | repo?, path?, pattern?, format?, includeMetadata?, maxDepth? | 文件树/平铺/分组 |

返回裁剪：limit/depth/maxFiles 白名单与引擎一致，避免把整图塞进上下文；
引擎文本过长由引擎侧负责分页/截断，本层不加额外裁剪（保持证据完整）。

## 5. 权限、边界与失败策略

- 只读：无任何写路径；不把私有代码特征写入跨项目共享层（查询直接打在本地
  MemoryKnowledge，不出本机）。
- 失败显式化（issue #26）：服务不可达 / code!=0 / 引擎 isError / 未知 repo /
  缺 repo 且多索引 → 一律 `isError:true` + 明确文案，绝不静默空结果。
- 超时：HTTP 12s（可调）+ mcp-client `toolCallTimeoutMs` 30s。
- 身份 env 缺失（TEAM_ID）→ 启动即退出，不提供无隔离的降级服务。

## 6. 验收判据（供 issue #27）

- 真实仓库（dsh-ecosystem，cg-oinaqfs3）端到端：`code_search`/`code_callers`/
  `code_impact`/`code_files` 拿到带 文件:行 的证据；
- 负向：未索引仓库 → 显式报错并提示 `code_graph_list`；服务宕机 → 显式报错；
  跨 team 不可见（list 只返回本 team 索引）；
- 过程可复现：`node mcp-tests.mjs`（mock 23 项）+ `REAL=1 ...`（真实链路）。

## 7. 未决/演进

- 授权模型：平台侧 agent 资产面板显示 `code_graph×N`（按 agent 授权），与本通道
  的 team 级可见口径可能不同——后续若按 agent 精确授权，只需在 `refreshIndexes`
  处收紧过滤条件。
- 上游 bridge 若未来原生支持 code-graph，本通道可平滑收敛（去掉独立实例并对齐工具名）。
