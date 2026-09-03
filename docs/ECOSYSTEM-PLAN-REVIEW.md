# dsh-launcher 生态化路线图 —— 独立审查报告

## 1. 审查元信息

| 项目 | 值 |
|---|---|
| 被审文档 | `F:\Project\dsh-dev\dsh-launcher\docs\ECOSYSTEM-PLAN.md` |
| 审查模型 | xiaomi/mimo-v2.5-pro (MiMo-v2.5-pro) |
| 审查日期 | 2026-09-02 |
| 核对仓库 | dsh-launcher (`src/`)、dsh-plugins (`plugins/`、`skills/`)、dsh-vscode (`src/`、`package.json`) |
| 审查范围 | 内部一致性、与现状技术对齐、完整性、可执行性、插件合并方案 |

---

## 2. 总评

路线图整体思路清晰——以 launcher 为核心串联 dsh 生态的七个缺口,分层模型(L0–L6)定义明确,设计决策(D1–D7)边界合理。插件合并方案(§8)的「凭证与模式聚合」判据站得住,11→7 映射与 dsh-plugins 实际包结构基本吻合。文档结构完整,Phase 依赖关系可追溯,风险对策有针对性。

但存在若干需要修正的问题:**P0 级有 3 条**——工具数统计与实际不符(会误导合并后的工具清单)、`read_audio` 工具名虚构(实际是 `transcribe_audio` + `understand_audio` 两个独立工具)、关窗行为语义自相矛盾(§2 说"关窗即停",Phase 6 说"默认关窗=隐藏到托盘",但未标注哪个是现状哪个是目标);**P1 级有 5 条**——connections.json 中 remote 连接 token 存储与 D2 红线措辞矛盾、0600 权限在 Windows 上实际无效但文档未说明、launcher-registration.json 的心跳段未定义刷新频率和过期策略、Electron portable 临时解压目录对注册文件持久性的影响未讨论、dsh-remote 连接的 token 刷新机制缺失。

**结论:修订后执行。** 文档框架可直接推进,但应先修正 P0 问题并补充 P1 的技术细节,否则执行时会产生返工。

---

## 3. 问题清单

### P0 — 阻断级(不修会导致方案失败)

#### P0-1: §8 dsh-media 工具名与实际不符

**位置:** §8 合并映射表,dsh-media 行

**问题:** 文档声称 dsh-media 合并后有 6 个工具,工具列表为 `read_audio(转写/理解)、speak_text、describe_image、read_video、read_document`。但实际 `audio-read` 插件注册的是**两个独立工具**——`transcribe_audio`(ASR 转写,mimo-v2.5-asr)和 `understand_audio`(音频理解,mimo-v2.5)——并无名为 `read_audio` 的工具。实际工具数为 **2+1+1+1+1 = 6 个**,总数虽然凑对,但名称与映射关系错误。

**为什么是问题:** `audio-read/index.js` 第 191 行和第 255 行分别注册了 `transcribe_audio` 和 `understand_audio`。文档若按 `read_audio` 发布合并后的工具清单,dsh 的 skill 文档、工具索引、用户预期都会出错。此外,工具数"6"的计算方式也应明确说明是 2(音频)+1(TTS)+1(图片)+1(视频)+1(文档)。

**修复建议:** 将表格中 `read_audio(转写/理解)` 改为 `transcribe_audio、understand_audio`,并在合并后工具总数旁注明组成。

---

#### P0-2: §2 现状描述与 Phase 6 目标对关窗行为自相矛盾

**位置:** §2 现状盘点第 1 行(第 25 行)、Phase 6 第 100 行

**问题:** §2 写"关窗即停"作为现状特性(第 25 行:「关窗即停」),Phase 6 写"默认**关窗=隐藏到托盘**(dsh 继续跑),设置项保留「关窗即停」旧行为"(第 100 行)。两处都没标注哪个是"现状"哪个是"目标态",读者无法判断当前行为到底是什么。更关键的是,README.zh-CN.md 第 63 行明确写"点 **×** 关闭窗口时**会同时停止 dsh**",说明当前确实是关窗即停。

**为什么是问题:** 这不是真正的矛盾(一个描述现状,一个描述目标),但文档未做时态区分,会让执行者误以为 Phase 6 已经落地。在一份路线图中,现状和目标态的界限必须明确。

**修复建议:** §2 中"关窗即停"后加注"(现状,Phase 6 将变更为默认隐藏到托盘)";Phase 6 中加注"(变更自现状:关窗即停)"。

---

#### P0-3: §8 dsh-media 工具数"6"的来源不透明,合并后 SKILL.md 将无法对应

**位置:** §8 合并映射表,dsh-media 行"工具数"列

**问题:** 表格写"6:read_audio(转写/理解)、speak_text、describe_image、read_video、read_document"。如 P0-1 所述,实际工具名不对。但更深层问题是:audio-read 现有 2 个工具、audio-speak 1 个、describe-image 1 个、video-read 1 个、document-read 1 个,合计 **6**。如果读者按文档的"read_audio"去计数,会以为是 5 个工具(把 read_audio 算 1 个),导致安装技能的 `--only` 子集参数无法正确映射。

**为什么是问题:** Phase 1 的 `ecosystem.json` 和 PM1 的 `--only` 子集安装都依赖精确的工具名。工具名写错,子集安装就会失败。

**修复建议:** 同 P0-1,修正工具名,并建议在表格旁补充一行注释说明各来源插件的工具数贡献。

---

### P1 — 重要级(执行前应解决)

#### P1-1: connections.json 中 remote 连接的 token 存储与 D2 凭证红线措辞冲突

**位置:** Phase 5 第 75–88 行、第 93 行,D2 第 44 行

**问题:** Phase 5 示例中 remote 连接含明文 `"token": "<启动 token>"`,第 93 行说"各组 token 明文仅存本地(文件权限 0600)";但 D2 写的是"`credentials.yaml` 永不明文进仓库/U 盘/清单"。虽然 connections.json 不是 credentials.yaml,但文档的"敏感红线"(第 20 行)明确将 connections.json 列为"永不进任何同步/清单流"的对象,却在 connections.json 内存明文 token——这两处的措辞强度不一致:一处说"永不明文",一处说"明文仅存本地"。

**为什么是问题:** 不是说不能存明文(token 必须落盘才能用),而是文档在不同章节对同一敏感文件的安全承诺措辞不一致,会让安全审计人员产生疑问。

**修复建议:** 统一措辞:在 D2 或敏感红线中明确"connections.json 内各组 token 以明文存储于本地(0600),永不进入同步/漫游流;远期可选 DPAPI 加密"。删除"永不明文"的绝对表述,改为"永不明文进外部存储"。

---

#### P1-2: 0600 文件权限在 Windows 上实际无效,文档未说明

**位置:** Phase 5 第 93 行,Phase 6 第 104 行,D6 第 48 行

**问题:** 文档多处提到文件权限 0600(对齐 launch-token 规范)。但 `tokenFile.ts` 第 86 行的 `mode: 0o600` 在 Windows 上被 Node.js 忽略——Windows 不支持 POSIX 文件权限。实际上 launch-token.json 在 Windows 上的保护依赖 NTFS ACL(默认只有当前用户可读写),但文档从未提及这一差异。

**为什么是问题:** 如果团队中有非 Windows 背景的成员,会误以为 0600 在 Windows 上生效。更重要的是,Phase 8 提到"远期 macOS/Linux 构建",届时 0600 才真正生效——文档应该提前标注这一平台差异,避免跨平台时出现安全假设错误。

**修复建议:** 在 D2 或风险对策表中补充说明:"0600 权限仅在 POSIX 系统生效;Windows 上依赖 NTFS 默认 ACL(当前用户可读写);跨平台构建时需验证文件权限语义。"

---

#### P1-3: launcher-registration.json 心跳段未定义刷新频率和过期策略

**位置:** Phase 6 第 104 行

**问题:** 文档定义了 `launcher-registration.json` 的字段 `{ version, launcherExe, launcherVersion, dshInstallDir, pid?, api?, bridgeKey?, running, registeredAt, updatedAt }`,其中 `pid/api/bridgeKey` 为"心跳段,随启动/停止刷新"。但未说明:心跳刷新频率是多少?如果 launcher 异常崩溃(来不及更新注册文件),`running: true` 和过期的 `pid` 会残留多久?其他消费者(dsh-launcher 插件)如何判断注册是否过期?

**为什么是问题:** 没有过期策略的注册文件 = 永久信任。如果 launcher 崩溃后注册文件残留 `running: true` + 旧 `pid`,dsh 侧的发现链会尝试连接一个不存在的 REST bridge,超时后才能降级——用户体验差。

**修复建议:** 补充定义:① 心跳刷新间隔(建议 ≤30s);② `updatedAt` 与当前时间差超过阈值(建议 2×心跳间隔)即视为过期;③ 插件侧校验时同时检查 `pid` 存在性和 `api` 健康。

---

#### P1-4: Electron portable 临时解压目录对 launcher-registration.json 持久性的影响未讨论

**位置:** Phase 6 第 104 行,D6 第 48 行

**问题:** README.zh-CN.md 第 50 行明确说明:"便携版把程序解压到临时目录、退出即删"。`launcher-registration.json` 存在 `%DSH_HOME%`(~/.dsh),不受此影响;但注册文件中的 `launcherExe` 字段指向的是临时解压目录中的 exe 路径。如果用户用的是便携版,每次双击 exe 临时解压路径可能不同(如 `C:\Users\xxx\AppData\Local\Temp\...`),注册文件中的 `launcherExe` 路径会失效。

**为什么是问题:** D6 的发现链第二级依赖 `launcherExe` 路径存在性校验。便携版的 exe 路径不稳定,会导致注册文件频繁失效,发现链降级为"提示用户手动重启"。

**修复建议:** 在 D6 或 Phase 6 中补充说明:便携版场景下,`launcherExe` 应指向用户放置 exe 的原始路径(而非临时解压路径),可通过 `PORTABLE_EXECUTABLE_DIR` 环境变量获取;或在注册时同时记录原始路径和临时路径,优先使用原始路径。

---

#### P1-5: dsh-remote 连接的 token 刷新机制缺失

**位置:** Phase 5,D5

**问题:** Phase 5 定义了 remote 连接组的结构(含 `token` 字段),但未说明 token 的生命周期。local 连接的 token 由 dsh 每次启动生成(30 天 cookie),launcher 自动抓取并写入 launch-token.json。但 remote 连接的 token 是**用户手动填入** connections.json 的——如果 remote 端的 dsh 重启了(生成新 token),本地 connections.json 中的旧 token 就失效了。

**为什么是问题:** remote 连接的 token 刷新完全依赖用户手动更新,没有自动发现机制。这与 local 连接的"自动抓取 token"体验差距过大,用户会困惑为什么 remote 连接突然 401。

**修复建议:** 在 Phase 5 中补充:① remote 连接支持 token 留空(由 Cloudflare Access 等外部认证接管);② token 非空时,launcher 打开浏览器前先做 verifyTokenUrl 自检(复用 launch.ts 第 96 行逻辑),401 时提示用户更新 token;③ 远期考虑 remote 端暴露 token 刷新接口。

---

### P2 — 建议级

#### P2-1: Phase 1–8 依赖关系表中 M5 标注"可提前做"但未说明前提

**位置:** §6 里程碑与依赖表,M5 行

**问题:** M5 标注"无强依赖,**可提前做**"。但 M5 的 connections.json 需要与 launch-token.json 兼容层配合,而兼容层的设计(D5)又需要理解当前 tokenFile.ts 的写入逻辑。如果 M5 在 M1 之前做,ecosystem.json 中还没有连接层的声明;如果在 M6 之前做,重启 seam 的环境变量注入还没有——M5 的"可提前做"是有隐含前提的。

**修复建议:** 在 M5 行补充:"可提前做,但需先完成 connections.json schema 定义与 launch-token.json 兼容层设计(无需等 M1/M6)"。

---

#### P2-2: Phase 4 漫游白名单缺少 `stock/` 子目录的递归说明

**位置:** Phase 4 第 69 行

**问题:** 白名单写 `stock/` 但 stock 插件的数据存储在 `%DSH_HOME%\stock\` 下(含 `daily/` 子目录和 `reports/` 子目录)。文档未明确是同步整个 `stock/` 目录还是只同步 `watchlist.json`(stock 的自选股列表在 `%DSH_HOME%\stock\watchlist.json`,但每日行情快照在 `stock\daily\YYYY-MM-DD.json`)。

**为什么是问题:** `stock\daily\` 下的文件会持续增长(每天一个 JSON),如果全部同步会浪费空间。建议明确白名单粒度。

**修复建议:** 将 `stock/` 改为 `stock/watchlist.json`(或 `stock/watchlist.json,stock/reports/`),排除 `stock/daily/` 行情快照(可重新采集)。

---

#### P2-3: §8 准入规则"工具数 ≥8"的阈值缺乏论证

**位置:** §8 分层规范与准入规则第 3 条(第 183 行)

**问题:** "三者皆否,并入既有层"——如果工具数 < 8 且无独立凭证/独立外部系统,就并入既有层。但 github 插件有 8 个工具却保留独立;stock 有 9 个工具也保留独立。准入规则的"≥8"阈值恰好卡在 github 的边界上,看起来是事后拟合而非事前推导。

**修复建议:** 补充说明 ≥8 阈值的推导逻辑(例如:工具数多意味着 API surface 大、独立维护成本低、合并后包体积过大等),或改为更通用的判据(如"工具数多且域边界清晰")。

---

#### P2-4: Phase 3 Node 自持方案未讨论 Electron 自带 Node 的复用可能

**位置:** Phase 3 第 63–66 行

**问题:** Phase 3 计划"检测无 Node → 自动下载便携版 node.zip"。但 launcher 本身是 Electron 应用,Electron 内置了 Node.js 运行时。dsh 的子进程 spawn 用的是 `node` 命令(系统 PATH 中的),但理论上可以配置为使用 Electron 内置的 Node。文档未讨论这一可能性。

**为什么是问题:** 不是说一定要用 Electron 内置 Node(Electron 的 Node 版本可能与 dsh 要求不匹配),但作为"零依赖"方案的一个选项值得评估——如果可行,可以省去下载 node.zip 的步骤。

**修复建议:** 在 Phase 3 中补充一句:"备选方案:评估 Electron 内置 Node 是否满足 dsh 的版本要求(^22.19 || >=24);若满足可直接复用,否则走下载便携版路线。"

---

#### P2-5: dsh-launcher 插件(§8)的 5 个工具中 `launcher_check_update` 与现有 `/api/check-update` 端点语义不完全对齐

**位置:** §8 dsh-launcher 插件工具列表第 177 行

**问题:** `launcher_check_update` 工具描述为"检查 launcher 与 dsh 升级"。但现有 `server.ts` 的 `/api/check-update` 端点(第 326–358 行)只检查 GitHub tag 和 npm registry 的版本,不检查插件版本。如果 ecosystem.json(M1)引入了插件版本管理,`launcher_check_update` 应该也涵盖插件升级检测,否则与 M1 的"生态状态卡片:版本漂移一眼可见"语义脱节。

**修复建议:** 明确 `launcher_check_update` 的 scope:是否包含插件版本检测。如果包含,需要在 PM3 时与 M1 的 ecosystem-state.json 对齐。

---

### P3 — 吹毛求疵

#### P3-1: §1 生态分层表"L3 插件"行的"11 个插件包 + install-* 技能"表述,skills 目录下实际有 11 个 install-* 技能(对应 11 个插件包)

**位置:** §1 第 15 行

**问题:** 表格写"11 个插件包 + install-* 技能",暗示技能数与插件包数一致。实际上 skills/ 目录下有 11 个 `install-*` 技能(对应 11 个插件包)+ 1 个 `install-skills.ps1` 批量安装脚本 + 1 个 `README.md`。表述无误但不够精确。

**修复建议:** 无需修改,仅标注。

---

#### P3-2: §2 第 39 行"八个缺口"实际列了 8 条,但编号从 1 到 8,与标题"七个缺口"矛盾

**位置:** §2 第 31 行标题"**七个缺口**"、第 39 行缺口 8

**问题:** 标题写"七个缺口",但实际列了 8 条(第 32–39 行)。缺口 8 是关于插件粒度过细的,看起来是后加的但标题未更新。

**修复建议:** 将标题改为"**八个缺口**"。

---

#### P3-3: Phase 5 示例 JSON 中 `extraHeaders` 字段未说明用途

**位置:** Phase 5 第 85 行

**问题:** remote 连接示例中有 `"extraHeaders": { }`,但文档未解释该字段的用途。dsh-vscode 的 `config.ts` 中有 `dsh.extraHeaders` 配置项(用于自定义 HTTP/WebSocket 头),可能是为了对齐 vscode 的能力,但文档未建立关联。

**修复建议:** 补充一句说明:"`extraHeaders` 对齐 dsh-vscode 的 `dsh.extraHeaders` 配置,用于 Cloudflare Access 等需要自定义认证头的场景。"

---

#### P3-4: §6 里程碑表中 PM4 规模标注为"S",但涉及 ecosystem.json 默认清单切换 + skills 11→7 + 整体版本化,工作量可能不止 S

**位置:** §8 PM4 行(第 196 行)

**问题:** PM4 内容包括 ecosystem.json 默认清单切新集合、skills 11→7、dsh-plugins 整体版本化与 launcher 子模块联动。这些工作涉及多仓协调,规模标 S(小)可能低估。

**修复建议:** 评估后考虑改为 M。

---

#### P3-5: Phase 8 提到"远期:macOS/Linux 构建",但 launcher 的技术栈(Electron + koffi 隐藏控制台 + taskkill + netstat)高度 Windows 绑定

**位置:** Phase 8 第 116 行

**问题:** 不是说不能跨平台,但 `console.ts`(koffi AllocConsole)、`launch.ts`(taskkill /F /T、netstat -ano)、`server.ts`(PowerShell FolderBrowserDialog)都是 Windows 专属实现。Phase 8 的"macOS/Linux 构建"不是简单换 target,而是需要重写进程管理、控制台隐藏、目录选择等核心模块。

**修复建议:** 在 Phase 8 中补充:跨平台需要抽象进程管理层(替代 taskkill/netstat)、移除 koffi 依赖(或用 platform-specific 代码)、替换 PowerShell 目录选择器。建议将此作为独立子 Phase 而非一句话带过。

---

## 4. 亮点

1. **分层模型(L0–L6)定义清晰**:每一层的内容、责任方、载体、缺口一目了然,为后续所有设计决策提供了稳定的参照系。

2. **D5 "连接即启动项"设计精巧**:通过 connections.json 统一 local/remote 连接,激活连接解析后照写 v1 launch-token.json 实现向后兼容——dsh-vscode 和 dsh-desktop 零改动即可支持广域网连接,这是最小侵入性的演进方案。

3. **D6 "重启委托给管理者"的两级发现 seam**:环境变量(运行时) + launcher-registration.json(持久)的双保险设计,既覆盖了 launcher 亲手拉起的场景,也覆盖了 vscode 等其他启动方式的场景。降级策略(提示人工重启)也很务实。

4. **D7 "凭证与模式聚合"的准入三问**:独立凭证?独立外部系统?工具数 ≥8?——简洁有效的判断框架,避免了"每个工具一个包"的碎片化。

5. **敏感红线的显式声明**:第 20 行明确列出永不进同步流的文件清单(.credentials.yaml、launch-token.json、connections.json、sessions/),这种"安全边界前置"的做法值得肯定。

6. **Phase 7 向导的 CLI 无头版**:`setup --all` 单命令全自动,适合脚本化部署——这说明设计者考虑了不只是 GUI 用户的场景。

---

## 5. 结论与下一步

### 优先级排序的修订动作

| 优先级 | 动作 | 对应问题 |
|---|---|---|
| **立即** | 修正 §8 dsh-media 工具名:将 `read_audio(转写/理解)` 改为 `transcribe_audio、understand_audio`,注明实际工具数 6 的组成 | P0-1, P0-3 |
| **立即** | 修正 §2 标题"七个缺口"→"八个缺口" | P3-2 |
| **立即** | 在 §2 和 Phase 6 中为"关窗行为"添加时态标注(现状 vs 目标态) | P0-2 |
| **执行前** | 统一 D2/红线/Phase 5 中对 connections.json token 的安全措辞 | P1-1 |
| **执行前** | 补充 0600 权限在 Windows 上的实际行为说明 | P1-2 |
| **执行前** | 为 launcher-registration.json 定义心跳刷新频率和过期策略 | P1-3 |
| **执行前** | 讨论 Electron portable 临时解压目录对注册文件路径的影响 | P1-4 |
| **执行前** | 补充 remote 连接的 token 刷新/验证机制 | P1-5 |
| **建议** | 明确 M5 提前做的前提条件 | P2-1 |
| **建议** | 细化 Phase 4 漫游白名单中 stock/ 的粒度 | P2-2 |
| **建议** | 补充准入规则 ≥8 阈值的推导逻辑 | P2-3 |
| **建议** | Phase 3 补充 Electron 内置 Node 复用评估 | P2-4 |
| **建议** | 明确 launcher_check_update 的 scope | P2-5 |
| **可选** | PM4 规模从 S 改为 M | P3-4 |
| **可选** | Phase 8 跨平台拆为独立子 Phase | P3-5 |
