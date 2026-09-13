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
- **迁移**:旧 7 包已标 `DEPRECATED.md`(保留一个版本周期);仓库根 uninstall-old.ps1 清理旧载荷与 patch 节
- **技能 11→7**:install-media / install-deepseek / install-launcher 新增,旧 7 技能删除
- 验证:`node scripts/verify-pm2.mjs`(23 用例)、`verify-pm3.mjs`(13)、`verify-pm4.mjs`(8)

## 目录结构

```
dsh-plugins/
├── plugins/                    插件安装包（自包含，可直接独立安装）
│   ├── dsh-media-dsh-plugin/    感知合并包（音频/语音/视频/文档）
│   ├── dsh-deepseek-dsh-plugin/ DeepSeek 账户合并包（余额/充值）
│   ├── dsh-launcher-dsh-plugin/ launcher 桥接（重启/状态/连接）
│   ├── credentials-dsh-plugin/
│   ├── unity-mcp-dsh-plugin/
│   ├── ue-mcp-dsh-plugin/
│   ├── video-read-dsh-plugin/
│   ├── audio-read-dsh-plugin/
│   ├── audio-speak-dsh-plugin/
│   ├── stock-dsh-plugin/
│   ├── deepseek-balance-dsh-plugin/
│   ├── deepseek-recharge-dsh-plugin/
│   ├── document-read-dsh-plugin/
│   └── github-dsh-plugin/
├── scripts/                    校验工具（validate-patch.mjs 与 verify-pm*.mjs）
├── skills/                     安装技能：描述每个插件的安装方法，可选择安装
│   ├── README.md               技能机制与安装说明
│   ├── install-skills.ps1      一键把技能装进 %DSH_HOME%\skills（可选子集）
│   ├── install-media/SKILL.md
│   ├── install-deepseek/SKILL.md
│   ├── install-launcher/SKILL.md
│   ├── install-unity-mcp/SKILL.md
│   ├── install-ue-mcp/SKILL.md
│   ├── install-credentials/SKILL.md
│   ├── install-stock/SKILL.md
│   └── install-github/SKILL.md
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
| [unity-mcp](plugins/unity-mcp-dsh-plugin/README.md) | MCP for Unity 桥：模型获得 `mcp__unity__*`（48 个 Unity Editor 工具），自带监督器自动拉起服务器 | Unity 项目 + MCP for Unity 客户端包 + uv/uvx | `install-unity-mcp` |
| [ue-mcp](plugins/ue-mcp-dsh-plugin/README.md) | UE 内置 Unreal MCP 桥：模型获得 `mcp__unreal__*` 工具（list_toolsets/describe_toolset/call_tool 驱动编辑器场景、Actor、蓝图、PIE 等），自带监督器按配置拉起 `UnrealEditor -ModelContextProtocolStartServer` | UE 5.8+ 工程（已启用 ModelContextProtocol/AllToolsets 插件） | `install-ue-mcp` |
| [dsh-deepseek](plugins/dsh-deepseek-dsh-plugin/README.md) | DeepSeek 账户合并包：`deepseek_balance` 余额查询（官方 `GET /user/balance`）+ `deepseek_recharge` 充值辅助（打开平台充值页） | `DEEPSEEK_API_KEY` | `install-deepseek` |
| [credentials](plugins/credentials-dsh-plugin/README.md) | 凭证管理工具：`credentials_list` / `credentials_set` / `credentials_unset` / `credentials_verify` 在对话里管理 `%DSH_HOME%\.credentials.yaml`，走官方 seam、永不暴露 key 值；`requireApproval` 默认关（本部署 approval 策略为 `never`，开了必拒） | 无 | `install-credentials` |
| [github](plugins/github-dsh-plugin/README.md) | GitHub 仓库管理：`github_repo`/`github_files`/`github_file_write`/`github_issue`/`github_pr`/`github_commit`/`github_search` 8 工具 + `github_sync` 本地工作区同步（clone/pull/commit/push，全局/项目双 scope，token 一次性注入不落盘） | `GITHUB_TOKEN`（可选：匿名只读公开仓库） | `install-github` |

> 单工具旧包（`audio-read` / `audio-speak` / `video-read` / `document-read` /
> `deepseek-balance` / `deepseek-recharge`）为 DEPRECATED，只作历史保留，不要新装；
> `describe-image` 已**删除**——图片由主模型原生多模态直读，不需要外挂工具。

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
