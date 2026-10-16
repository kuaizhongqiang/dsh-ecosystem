# agent-modes — 7 个开发阶段模式的 preset 包

面向原生 dsh 的**声明型**插件包:它不提供任何工具,而是往 web profile 注入 7 个
**Agent Preset(模式)** 声明,让同一个 dsh 能按「开发阶段」切换工具面与人格。

## 它解决什么

两个具体痛点:

1. **每个阶段的插件/技能需求不同**,单一通用会话把所有工具都背着 —— 只为一个文档任务,也要为
   Unity 桥的 48 个工具、股票工具的 22 个工具付 schema 成本。
2. **Agent 自动化意愿过高**:只需要它做需求分析,它做完就顺手开始写代码;只需要它写文档,
   它写完就顺手实现 —— 与人的工作流不符。

本包用**机制**回答,而不是用提示词:

- preset 决定一个会话**挂哪些工具行**。没挂写能力的模式,物理上写不了文件。
- 7 个模式里**一律不挂** `tool-goal` / `command-goal` / `tool-ralph` / `tool-schedule` /
  `tool-subagent` / `tool-subagent-fork` / `tool-workflow`。`tool-goal` 的语义是「跨自动续跑轮次
  保持工作」,正是要禁止的行为;`tool-ralph` 是自驱死磕工具。没有它们,**做完就停**。
- 阶段推进只能由**人换模式**。换模式是人的物理动作,agent 触发不了 —— 这是最强的一道闸门。

## 7 个模式

| 模式 | id | 写文件 | shell | web | 提问 | present | 行数 |
|---|---|:-:|:-:|:-:|:-:|:-:|--:|
| 需求 | `clarify` | ✗ | ✗ | ✓ | ✓ | ✗ | 11 |
| 文档·写 | `doc-write` | ✓ | ✗ | ✓ | ✓ | ✓ | 12 |
| 文档·审 | `doc-review` | ✗ | ✗ | ✓ | ✗ | ✗ | 10 |
| 设计·美化 | `design` | ✓ | ✗ | ✓ | ✓ | ✓ | 12 |
| 实现 | `impl` | ✓ | ✓ | ✓ | ✓ | ✓ | 14 |
| 测试反馈 | `verify` | ✗ | ✓ | ✗ | ✗ | ✗ | 11 |
| 交付·仓库 | `ship` | ✓ | ✓ | ✗ | ✗ | ✓ | 12 |

设计意图:

- **需求 / 文档·审 / 测试反馈** 三个模式没有写能力 —— 澄清、审查、验证这三类活本来就不该有写权限。
- **测试反馈**能跑不能改:挂了 `tool-pwsh`,但 `tool-fs` 的 `write`/`edit` 关死。
- **需求 / 文档·写 / 文档·审 / 设计** 一律不挂 shell。理由:`tool-pwsh` 是万能钥匙,挂了它,
  `tool-fs` 的只读形同虚设(照样能 `Set-Content` 写文件)。
- **实现**是唯一带完整写+执行能力的模式,也是唯一允许派活的地方。

## 安装

```powershell
cd dsh-plugins\plugins\agent-modes-dsh-plugin
powershell -ExecutionPolicy Bypass -File .\install.ps1                     # 浏览器版 profile
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop    # 桌面版 profile
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall [-Profile desktop]
```

`-Profile` 选择目标 profile(默认 `web`):

| profile | 目录 | 适用 |
|---|---|---|
| `web` | `%DSH_HOME%\profiles\web` | 浏览器版 `dsh web` |
| `desktop` | `%DSH_HOME%\profiles\desktop` | 桌面版 |

**两个 profile 各自独立**:preset 声明必须**分别安装** —— 只装一个,另一个的模式选择器里看不到。
`install.ps1` 还会检查目标 profile 的 `package.json`,若同一批 preset 已作为 bundle 安装则直接拒绝
(见下节)。

安装器做的事:把 `presets/cordis.patch.yml` 追加进 `%DSH_HOME%\profiles\web\cordis.patch.yml`,
节头 `# --- dsh-agent-modes: agent-modes (native dsh) ---`,以 `preset-clarify` 判重(幂等)。
写入前会先跑 `scripts/validate-patch.mjs` 结构门,不通过就**不落盘**。

`-Only agent-modes` 可写可不写(单服务包)。

装完**重启 `dsh web`**,再新建会话,在模式选择器里应能看到 7 个模式。

## ⚠️ 与 bundle 安装路径互斥

本包也可以打成 bundle(`package.json` + `dsh.bundle.patch`)用 `plugin_manager install_bundle`
安装。**两条路径不能同时存在** —— 它们声明同一批 preset id,同时存在会造成重复 id。
`install.ps1` 会检查 profile 的 `package.json`,发现 `@local/dsh-agent-modes` 就直接拒绝并给出移除指引。

本仓采用 patch 合并路径,因为它与其余 9 个插件包一致,且支持 `-Uninstall` 与幂等。

## 技能隔离

每个模式挂**自己那份** `dsh-skill-filesystem`,配置为:

```yaml
providerName: modes-<mode>
includeDefaultRoots: false
customSkillDirs:
  - '<DSH_HOME>\skills-modes\<mode>'
```

`includeDefaultRoots: false` 是有意的:它让该模式**看不到**项目技能、`<DSH_HOME>\skills` 下的
用户技能、以及 dsh 自带技能 —— 只看到自己那个目录。这是「每阶段只看自己那批」的机制。

**代价要说清楚**:这 7 个模式默认**看不到** `install-*` 等既有技能。想让某个模式恢复共享技能,
把该模式的 `includeDefaultRoots` 改成 `true` 即可(一行)。

## 设计要点(改这个包前先读)

- **`install.ps1` 必须保留 UTF-8 BOM,且所有文本读取必须走 `Read-TextUtf8`。**
  Windows PowerShell 5.1(系统自带的 `powershell.exe`,也是本仓文档推荐的解释器)对**无 BOM**
  文件按 ANSI(GBK) 解码,踩到两个坑:
  1. 脚本自身解析失败 —— 中文注释会吞掉紧随其后的 `` ` `` / `{` / `}` 等字节,实测报 3 处
     `Missing closing`。加 BOM 后解析干净。
  2. `Get-Content -Raw` 读 YAML 时,中文行尾字节与换行符配对,**把整行连同换行一起吞掉** ——
     载荷被拼成一行(`- insert:` 被吞进注释),而且**读进来的 profile patch 已是 mojibake,
     写回就会破坏其中的中文注释**。

  第 2 条是"一旦发生就是数据损坏"的坑。结构门拦住了这次事故(坏内容未落盘,已验证备份与当前
  文件哈希相同),但**不要依赖门来兜底**:改动本脚本后请复验 `install.ps1` 仍能通过
  `Parser::ParseFile`,并且读文件一律用 `Read-TextUtf8`。
- **不含 `plan-mode`**。plan mode 会阻断**一切**写操作,只允许用 `exit_plan_mode` 提交方案等审批;
  而「设计」模式的工作恰恰是写设计文档,套上它反而堵死。「先规划后动手」由**工具面 + 计划文档**承担。
- **shell 只挂 `tool-pwsh`,不用 `!!js process.platform` 条件分支**。条件分支是内置 preset 的写法,
  但它会让 YAML 解析器遇到未知 tag、令结构门失效。用单一 pwsh 行换取 patch **可被完整校验**。
- **`persona` 只设 `prefix`**,不设 `complete`、不设 `suffix`:保留第一方系统提示词与运行态上下文快照。
- **不挂 delegation 行**。Agent Teams 由 profile 层的 bundle 提供;在 preset 里再挂
  `subagent`/`subagent_fork` 会与团队层「禁用同名全局控件」的约定打架。
- **`impl` 模式的一主多身**:团队层下 teammate 无法切换模式(`spawn_teammate` 无 `agent_preset`,
  且团队层显式禁用了 `subagent`/`subagent_fork`),所以「一主多身」是这一层下唯一的可能,不是可选风格。
  `spawn_teammate` 的 `context: fork` 继承 Lead 上下文(主力),`fresh` 用于规格已写全的独立工作项。

## 修改载荷后怎么验

```powershell
# 结构门(与 profile 同一份校验器)
node dsh-plugins\scripts\validate-patch.mjs dsh-plugins\plugins\agent-modes-dsh-plugin\presets\cordis.patch.yml

# preset 级断言(重复 id / 禁用行 / 顺序唯一)
node dsh-plugins\plugins\agent-modes-dsh-plugin\presets\check-presets.mjs dsh-plugins\plugins\agent-modes-dsh-plugin\presets\cordis.patch.yml
```

## 已知边界

- 结构门 `validate-patch.mjs` 原先**不认识块标量**,任何带 prompt/persona 正文的 patch 都会被
  逐行误报(本包首次提交时报 41 处)。该 lint 已修:块标量正文与其中的空行被跳过,块标量**之后**的
  连续空行仍然拦得住。若在其他机器上遇到同类误报,先确认校验器版本。
- 本包**不裁剪 profile 层的既有插件**。`mcp-unity`(48 工具)、`stock`(22 工具)等仍挂在
  profile 层,因此**每个模式照样背着它们**。把这类插件下移到 preset 是下一步,且需要先验证
  本地 `./plugins/*` 相对路径能否在 preset 作用域解析。
- `spawn_teammate` 的 `fresh` 子级**不继承上下文**;跨会话的实现阶段必须**重读计划文档**。
  跨会话进度真相建议只由 Lead 回写,避免多写者冲突(团队层的写入范围只是建议,不是锁)。

## License

MIT © 2026 kuaizhongqiang
