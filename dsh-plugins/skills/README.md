# skills/ — 插件安装技能

本目录存放 **DSH 技能（skill）**：每个技能描述一个插件的安装方法，让你在
dsh 会话里**选择安装哪些插件**——只装你想用的，Agent 按技能正文一步步执行。

## 机制：DSH skill 是什么

DSH 内置 `dsh-skill-filesystem`，从若干“根目录”发现技能（发现深度为一层：
只认 `<root>/<name>/SKILL.md` 与 `<root>/<name>.md`）。每个技能是一个
`<name>/SKILL.md` 目录包，frontmatter 必填 `name`（kebab-case）与
`description`，可选 `whenToUse` 等。调用方式：

- **用户显式**：在对话里输入 `/技能名`（如 `/install-describe-image`）
- **模型调用**：直接说需求（如“安装 describe-image 插件”），模型会自动加载对应技能

技能文件随目录变化**热刷新**，新会话即可发现最新技能。

## 安装技能到 dsh

技能根目录（rank 从近到远，越近优先）：

| rank | 根目录 | 作用域 |
|------|--------|--------|
| 100 | `<项目根>/.dsh/skills` | 仅该项目 |
| 200 | `<项目根>/.agents/skills` | 仅该项目 |
| 400 | `%DSH_HOME%\skills` | 用户全局（推荐） |
| 500 | `%DSH_AGENTS_HOME%\skills`（缺省 `~/.agents/skills`） | 用户全局 |

推荐装到用户全局根：

```powershell
# 安装全部技能（幂等，可重复执行）
powershell -ExecutionPolicy Bypass -File .\skills\install-skills.ps1

# 只装选中的插件技能（“选择安装哪些插件”）
powershell -ExecutionPolicy Bypass -File .\skills\install-skills.ps1 -Skills install-unity-mcp
powershell -ExecutionPolicy Bypass -File .\skills\install-skills.ps1 -Skills install-unity-mcp,install-describe-image
powershell -ExecutionPolicy Bypass -File .\skills\install-skills.ps1 -DryRun   # 只看会装什么
```

或手动拷贝：把 `skills/<name>` **子目录**复制到 `%DSH_HOME%\skills\`。

> ⚠️ 不要把整个 `skills/` 目录（含 README.md、install-skills.ps1）直接当作
> 技能根目录：根下平铺的 `README.md` 会被当成畸形平铺技能而以警告丢弃。
> 只复制 `<name>/SKILL.md` 包目录，或使用 `install-skills.ps1`。

装完后，在新会话里输入 `/install-describe-image`，或直接说“安装 X 插件”即可。

## 技能清单

| 技能 | 对应插件 | 说明 |
|------|----------|------|
| `install-describe-image` | `plugins/describe-image-dsh-plugin` | describe_image 图片理解工具（需 MIMO_API_KEY） |
| `install-unity-mcp` | `plugins/unity-mcp-dsh-plugin` | MCP for Unity 桥（需 Unity + uv/uvx） |
| `install-ue-mcp` | `plugins/ue-mcp-dsh-plugin` | UE 内置 Unreal MCP 桥：mcp__unreal__* 工具 + 监督器拉起编辑器（需 UE 工程启用 MCP 插件，无需 key） |
| `install-video-read` | `plugins/video-read-dsh-plugin` | read_video 视频理解工具（需 MIMO_API_KEY） |
| `install-audio-read` | `plugins/audio-read-dsh-plugin` | transcribe_audio 转写 + understand_audio 理解（需 MIMO_API_KEY） |
| `install-audio-speak` | `plugins/audio-speak-dsh-plugin` | speak_text 语音合成工具（需 MIMO_API_KEY） |
| `install-credentials` | `plugins/credentials-dsh-plugin` | 对话里管理凭证：list/verify/set/unset（无额外依赖） |
| `install-stock` | `plugins/stock-dsh-plugin` | A股行情/技术指标/自选股/每日收集/报告（腾讯公开接口，无依赖） |
| `install-deepseek-balance` | `plugins/deepseek-balance-dsh-plugin` | DeepSeek 余额查询（需 DEEPSEEK_API_KEY） |
| `install-deepseek-recharge` | `plugins/deepseek-recharge-dsh-plugin` | DeepSeek 充值辅助：余额上下文 + 跳转充值页（需 DEEPSEEK_API_KEY） |
| `install-document-read` | `plugins/document-read-dsh-plugin` | read_document 文档理解：Word/Excel/PDF 文字 + 内嵌图片 vision 描述（需 Python 解析库 + MIMO_API_KEY） |

## 新增技能的约定

1. 一个插件配一个技能，技能名 `install-<插件名>`（kebab-case）
2. 目录 `skills/install-<插件名>/SKILL.md`
3. frontmatter：`name`、`description`（≤500 字符，会进模型目录）、`whenToUse`
4. 正文要**自包含**，覆盖：前置检查 → 定位插件包（仓库 `plugins/<name>-dsh-plugin`）→
   执行 install.ps1 → 按机器改配置 → 重启验证 → 排查 → 卸载
5. 正文里的路径引用仓库内相对路径；目标机器没有仓库克隆时，先
   `git clone https://github.com/kuaizhongqiang/dsh-plugins` 或下载 Release 压缩包解压

## 注意

- skill 发现只认一层：`<name>/SKILL.md` 或 `<name>.md`，不支持嵌套树
- `name` 必须是 kebab-case；非法条目（如驼峰拼写的调用字段）会被发现流程
  以警告丢弃
- 本目录不包含任何 API key；密钥按各插件说明单独配置
