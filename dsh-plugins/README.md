# dsh-plugins — DSH 插件合集

面向原生 dsh（npm 版 `@deepseek-ai/dsh`）的插件合集。每个插件是一个
**自包含安装包**（`install.ps1` + `plugins/` + 说明文档），并配套一个
**安装技能（skill）**：技能描述该插件的安装方法，让你在 dsh 会话里
按需**选择安装哪些插件**。

## PM1–PM4(路线图 §8 11→7 已落地)

- **分层规范与模板**:docs/PLUGIN-SPEC.md(分层/准入三问/install.ps1 规范/SKILL 模板要素) + `_templates/`
- **合并包已落地**:
  - plugins/dsh-media-dsh-plugin —— 感知四合一(audio-read/audio-speak/video-read/document-read),`-Only` 子集安装(图片由主模型原生多模态直读,不再内置 describe_image)
  - plugins/dsh-deepseek-dsh-plugin —— DeepSeek 账户二合一(balance/recharge)
  - plugins/dsh-launcher-dsh-plugin —— launcher 桥接(restart/status/connections/open/check_update,依赖 M5/M6 seam)
  - plugins/dsh-image-dsh-plugin —— 图片生成(`generate_image`,豆包 Seedream 5.0 / 火山方舟;文生图 · 图生图 · 多图融合 · 组图,结果落盘),独立凭证 `ARK_API_KEY`
- **迁移**:旧 7 包曾标 `DEPRECATED.md` 保留一个版本周期,**已于 2026-09-28 从仓库清场**(git 历史保留);
  仓库根 uninstall-old.ps1 清理旧载荷、patch 节 **与旧技能**(技能清理**默认执行**,`-KeepSkills` 可保留)
  —— 仓库删包 ≠ 本机干净:留着旧技能,会话里仍可据此把已下线的服务装回来(issue #31)
- **技能**:11→7 后新增 install-ue-mcp / install-memory / install-image / install-continuity /
  install-agent-modes,当前 12 个;旧 7 技能删除
- 验证:`node scripts/verify-pm2.mjs`(安装/幂等/卸载/迁移)、`verify-pm3.mjs`(launcher 桥接 + 输出契约)、
  `verify-pm4.mjs`(技能集合与清单一致性)、`verify-image.mjs`(图片生成插件)、`verify-continuity.mjs`(63)、
  `verify-agent-modes.mjs`(阶段模式 preset 断言:重复 id / 禁用行 / 顺序唯一)
- **声明型插件**:`agent-modes` 是集合里第一个**不提供工具**的包 —— 它的载荷是 preset 声明
  (`presets/cordis.patch.yml`),安装动作是把这份 YAML 片段合并进 profile 的 `cordis.patch.yml`
  而不是复制插件目录;详见该包 README 与 PLUGIN-SPEC §4 的适配说明

## 第 8 包:dsh-continuity(2026-10-04,PM4 之后)

- **域**:**任务连续性** —— 不变量是「任务不因载体(会话/上下文窗口/进程)更替而中断」,
  比 session 更大:后续 restart 恢复、跨会话 resume 索引、brief 自动维护、历史任务召回都归本包。
- **v1 服务** `handoff`:`/handoff` 命令 + `handoff_start` 工具(交接文档 → 同 workspace 新开会话
  → 克隆 goal(轮次归零) → 播种并自动开跑)。无凭证、无外部系统。
- **为什么破例开新包**:准入三问(独立凭证?独立外部系统?工具数 ≥8?)三条全否,按
  `docs/PLUGIN-SPEC.md` §2 本应并入既有层;但既有各包(感知/账户/凭证/图片/域工具/桥接/记忆)
  **没有 session 域**,无层可并 —— 这是规范盲点。按「域独立例外」处理,并把该例外补进 §2(见规范)。
- **不谈合并的内置能力**:`session.fork`(整段前缀复制,不释放 token)、自动 compaction +
  `/compact`(会话内腾空间)已在 dsh 内;本包只补「干净会话 + 蒸馏交接」这条缺失路径。
- 默认清单不含本包(会话内用 `install-continuity` 技能安装,与 `ue-mcp` 同理)。

### 与 agent-modes 的关系(第 9 包)

- **handoff 管「载体更替」,agent-modes 管「阶段边界」**:前者让任务跨会话/上下文不中断,
  后者让会话按阶段裁工具面、做完就停。两者正交,一起用才是完整链路:
  需求 → (handoff) → 文档 → (handoff) → 设计 → (handoff) → 实现 → (handoff) → 测试反馈 → (handoff) → 交付。
- **已实现**:`handoff_start` / `/handoff` 支持 `preset` / `--preset`,可把交接直接落到指定模式;
  各阶段模式的「阶段交接:」一节写明下一步该传哪个 id,并**要求同时自写 `brief`**(否则会生成空任务书,
  handoff 会就此打警告)。文档的「写 ↔ 审」是**循环**,已在 `doc` 模式内部闭合 —— 审由
  `spawn_teammate({ context: 'fresh' })` 做,**不再走交接**(换模式 = 换会话,每审一轮烧一个会话)。
- **Unity 通道**:profile 级 `mcp-unity` / `mcp-ue` 已 `disabled: true`,改由 `impl` / `verify`
  这两个**有 shell 的模式**各自挂载 —— 无 shell 的模式不得持有编辑器代码执行通道
  (`mcp__unity__execute_code` 能在 Unity Editor 里跑任意 C#,比 pwsh 更强)。

## 目录结构

```
dsh-plugins/
├── plugins/                    插件安装包（自包含，可直接独立安装）
│   ├── dsh-media-dsh-plugin/    感知合并包（音频/语音/视频/文档）
│   ├── dsh-deepseek-dsh-plugin/ DeepSeek 账户合并包（余额/充值）
│   ├── dsh-launcher-dsh-plugin/ launcher 桥接（重启/状态/连接/CLI 安装）
│   ├── dsh-image-dsh-plugin/    图片生成（Seedream 5.0；文生图/图生图/组图）
│   ├── dsh-continuity-dsh-plugin/ 任务连续性域（handoff：交接文档 + 新会话续跑 + goal clone）
│   ├── credentials-dsh-plugin/
│   ├── stock-dsh-plugin/
│   ├── unity-mcp-dsh-plugin/
│   ├── ue-mcp-dsh-plugin/       需本地 UE 工程，不入默认清单
│   ├── agent-memory-dsh-plugin/ 记忆层接入器
│   ├── agent-modes-dsh-plugin/  6 个开发阶段模式（preset 声明，无工具载荷）
│   └── github-dsh-plugin/
│   （6 个 deprecated 旧包 audio-read / audio-speak / video-read / document-read /
│     deepseek-balance / deepseek-recharge 已于 2026-09-28 清场，git 历史保留）
├── scripts/                    校验工具（validate-patch.mjs 与 verify-pm*.mjs）
├── skills/                     安装技能：描述每个插件的安装方法，可选择安装
│   ├── README.md               技能机制与安装说明
│   ├── install-skills.ps1      一键把技能装进 %DSH_HOME%\skills（可选子集）
│   ├── install-media/SKILL.md
│   ├── install-deepseek/SKILL.md
│   ├── install-launcher/SKILL.md
│   ├── install-image/SKILL.md
│   ├── install-unity-mcp/SKILL.md
│   ├── install-ue-mcp/SKILL.md
│   ├── install-credentials/SKILL.md
│   ├── install-stock/SKILL.md
│   ├── install-memory/SKILL.md
│   ├── install-github/SKILL.md
│   ├── install-continuity/SKILL.md
│   └── install-agent-modes/SKILL.md
├── README.md
└── LICENSE                     MIT
```

## 快速开始

1. **装技能**（把“怎么装插件”教给 dsh，只需一次）：

   ```powershell
   # 安装全部技能（幂等，可重复执行）
   powershell -ExecutionPolicy Bypass -File .\skills\install-skills.ps1

   # 或只装选中的插件技能（“选择安装哪些插件”）
   powershell -ExecutionPolicy Bypass -File .\skills\install-skills.ps1 -Skills install-unity-mcp
   ```

2. **选插件**：在 dsh 会话里输入 `/install-media`，或直接说
   “安装 video-read 插件”，Agent 会加载对应技能并按正文一步步执行安装。

3. **验证**：重启 `dsh web` 后按各插件 README 的“重启并验证”步骤确认。

> 每个插件包也可脱离技能独立使用：进入 `plugins/<name>-dsh-plugin/` 目录
> 直接运行 `install.ps1`，详见各包 README。

## 插件清单

| 插件 | 功能 | 额外依赖 | 安装技能 |
|------|------|----------|----------|
| [dsh-media](plugins/dsh-media-dsh-plugin/README.md) | 感知合并包：`transcribe_audio`/`understand_audio`/`speak_text`/`read_video`/`read_document`（音频 · 语音 · 视频 · 文档）。图片无需工具——主模型原生多模态直读 | `MIMO_API_KEY`（文档内嵌图描述另需 vision 端点） | `install-media` |
| [dsh-image](plugins/dsh-image-dsh-plugin/README.md) | 图片生成：`generate_image`（豆包 Seedream 5.0 / 火山方舟）——文生图 / 图生图（1 张参考图）/ 多图融合（2~14 张）/ 组图（`count`），支持 `web_search` 时效提示词与 `extra` 参数直通；结果一律落盘为文件 | `ARK_API_KEY`（火山方舟 API Key；走中转网关可复用已有 key 名） | `install-image` |
| [unity-mcp](plugins/unity-mcp-dsh-plugin/README.md) | MCP for Unity 桥：模型获得 `mcp__unity__*`（48 个 Unity Editor 工具），自带监督器自动拉起服务器 | Unity 项目 + MCP for Unity 客户端包 + uv/uvx | `install-unity-mcp` |
| [ue-mcp](plugins/ue-mcp-dsh-plugin/README.md) | UE 内置 Unreal MCP 桥：模型获得 `mcp__unreal__*` 工具（list_toolsets/describe_toolset/call_tool 驱动编辑器场景、Actor、蓝图、PIE 等），自带监督器按配置拉起 `UnrealEditor -ModelContextProtocolStartServer` | UE 5.8+ 工程（已启用 ModelContextProtocol/AllToolsets 插件） | `install-ue-mcp` |
| [dsh-deepseek](plugins/dsh-deepseek-dsh-plugin/README.md) | DeepSeek 账户合并包：`deepseek_balance` 余额查询（官方 `GET /user/balance`）+ `deepseek_recharge` 充值辅助（打开平台充值页） | `DEEPSEEK_API_KEY` | `install-deepseek` |
| [credentials](plugins/credentials-dsh-plugin/README.md) | 凭证管理工具：`credentials_list` / `credentials_set` / `credentials_unset` / `credentials_verify` 在对话里管理 `%DSH_HOME%\.credentials.yaml`，走官方 seam、永不暴露 key 值；`requireApproval` 默认关（本部署 approval 策略为 `never`，开了必拒） | 无 | `install-credentials` |
| [github](plugins/github-dsh-plugin/README.md) | GitHub 仓库管理：`github_repo`/`github_files`/`github_file_write`/`github_issue`/`github_pr`/`github_commit`/`github_search` 8 工具 + `github_sync` 本地工作区同步（clone/pull/commit/push，全局/项目双 scope，token 一次性注入不落盘） | `GITHUB_TOKEN`（可选：匿名只读公开仓库） | `install-github` |
| [agent-memory](plugins/agent-memory-dsh-plugin/README.md) | 长期记忆接入（**native 原生插件为默认**，`--mode mcp` 可回退 MCP）：11 工具（`recall_memory`/`store_memory`/`search_memories` + `code_*` 8 个代码图谱工具）+ **进程内自动入库**（`turn/end` 直提 L0，无需守护/子进程）；引擎为第三方上游（TencentDB Agent Memory） | 团队身份三元组 + `USER_KEY`（本机自托管引擎） | `install-memory` |
| [dsh-continuity](plugins/dsh-continuity-dsh-plugin/README.md) | **任务连续性域**（第 8 包）：`/handoff` 命令 + `handoff_start` 工具——确定性交接文档 → 同 workspace 新开会话 → 克隆 goal（轮次归零）→ 播种首条消息并自动开跑；plan mode（计划未批准）时拒绝 | 无（只用 dsh 自身 session/goal/plan 投影） | `install-continuity` |
| [agent-modes](plugins/agent-modes-dsh-plugin/README.md) | 6 个开发阶段模式的 **preset 声明包**（不提供任何工具）：需求 / 文档 / 设计·美化 / 实现 / 测试反馈 / 交付·仓库。按阶段裁工具面 —— 两个模式无写能力、测试反馈「能跑不能改」；一律不挂 `tool-goal`/`tool-ralph`，做完就停，阶段推进只能由人换模式。**Unity MCP 只挂给 `impl` / `verify`**（无 shell 的模式不得持有编辑器代码执行通道） | 无 | `install-agent-modes` |

> 单工具旧包（`audio-read` / `audio-speak` / `video-read` / `document-read` /
> `deepseek-balance` / `deepseek-recharge`）为 DEPRECATED，**已于 2026-09-28 从仓库移除**（git 历史保留），
> 这些名字现在只作为合并包的 `-Only` 子服务名存在；`describe-image` 已**删除**——图片由主模型原生
> 多模态直读，不需要外挂工具。本机若还残留旧载荷 / `install-describe-image` 等旧技能，
> 跑仓库根 `uninstall-old.ps1`（技能清理已默认执行）。

## 环境要求（目标电脑）

- Node.js `^22.19 || >=24`
- dsh 已安装：`npm install -g @deepseek-ai/dsh`（或用 `npx @deepseek-ai/dsh`）
- 至少启动过一次 `dsh web`（初始化 `%DSH_HOME%\profiles\web`）
- 各插件额外依赖见上表与各包 README

## 贡献约定

- 新插件放 `plugins/<name>-dsh-plugin/`，结构：`install.ps1`（幂等，可重复执行）
  + `plugins/<name>/`（插件代码）+ `README.md` +（如需要）`.env.example`
- **必须**配套安装技能：`skills/install-<name>/SKILL.md`，约定见
  [`skills/README.md`](skills/README.md)
- 包内不含任何 API key；密钥配置走 `%DSH_HOME%\.credentials.yaml` 或环境变量，
  不要把真实 key 写进仓库或分享的文件
- **版本字段（必填）**：`plugins/<name>/package.json` 必须带 `version`（SemVer，
  单一事实来源）；`index.js` 运行时读取（`fileURLToPath` + `readFileSync`）并导出
  `version`，`apply()` 里 `console.info` 一行便于日志确认实际加载版本；
  `install.ps1` 复制后打印版本。升级 = 重跑 `install.ps1`（幂等覆盖）

## License

MIT © 2026 kuaizhongqiang
