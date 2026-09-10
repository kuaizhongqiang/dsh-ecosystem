# launcher UI 重构（#17/#18/#19）—— 设计前置物：信息架构 + 低保真稿

> 状态：**草稿**（只读分析产出，未 commit / 未 push，等待评审后动 `ui/`）
> 覆盖 issue：[#17 launcher UI 布局重构：分区化信息架构](https://github.com/kuaizhongqiang/dsh-ecosystem/issues/17)、[#18 长内容块折叠化](https://github.com/kuaizhongqiang/dsh-ecosystem/issues/18)、[#19 概览卡片](https://github.com/kuaizhongqiang/dsh-ecosystem/issues/19)（同属 milestone「launcher UI：信息架构与折叠化布局」）
> 依据代码快照：`dsh-launcher/ui/{index.html, app.js, launcher.css, tokens.css}`、`dsh-launcher/src/{config.ts, server.ts, electron-main.ts}`、`docs/modules/dsh-launcher.md`、`docs/WORKLOG.md`（v0.8.5 之后的工作树）
> 分析基线：UI 全部行号引用自当前 `ui/app.js` / `ui/index.html`，实现时以实际文件为准。

---

## 0. 摘要（给评审人先看结论）

- **推荐导航方案**：顶部固定「概览条（健康聚合 + 快速动作）」+ 内容卡片分区（单列、可折叠、分区跳转条做锚点导航），**不用**纯顶部 tab 全屏切换、**不用**固定侧栏。理由见 §2。
- **分区清单**（#17 建议分区的落地形态）：概览 / 安装与升级 / 生态（插件·技能·清单）/ 连接 / 日志与设置，卡片化；每个卡片的内部长块再按 #18 折叠。默认展开/收起策略见 §3。
- **关键数据缺口**（影响 #19 概览卡）：当前 `/api/status`、`/api/ecosystem`、`/api/connections` **均无 vscode / desktop 版本字段**；GUI 也没有「打开 dsh UI」的 bridge 契约（只在托盘 `electron-main.ts openActiveBrowser()`）。这两处需要后端配合新增，详见 §4/§8。
- **「重钉工具说明」动作**：现有 ui/ 与后端均无对应实现/契约，语义需与 issue 作者确认（见 §4 与「未决问题」）。
- 状态记忆（#18）走 **launcher.json 新增可选 `ui` 字段 + 后端 GET/POST `/api/ui-state` 桥**；注意 `config.ts save()` 是全量覆盖写，存在互相覆盖丢状态的风险，需要 load→merge→save 纪律（§6）。

---

## 1. 现状问题清单（对照 app.js 实际渲染区块与动作）

当前 `index.html` 结构：`.titlebar`（品牌 + `#ver` + 连接 pill `#connSelect` + 最小化/关闭）→ `main.content` 单列 `flex column` 依次堆叠 5 块：

| # | 区块 | 容器 / 关键 id | 数据/动作来源（app.js 函数） | 问题点 |
|---|---|---|---|---|
| 1 | 运行状态磁贴 | `section.tiles`，5 个 `div.tile[data-key=node/npm/dsh/port/update]`，值 `#node #npm #dsh #port #update`，点 `.dot` | `refreshStatus()`（app.js:162-223）经 `bridge.getStatus()`；渲染辅助 `setValue()`/`setDot()`（:153-160）；DOM 缓存 `fields`/`rowEls`（:105-114） | 状态平铺 5 格、与动作分离；「端口」与「连接」语义重叠（remote 时端口行被改写为连接语义，:207-211） |
| 2 | 运行控制条 | `section.panel.run-panel`；`#btnStart #btnStop #btnRestart #btnSetup #btnUpdate #btnExit`；进度 `#progress/#progressText` | `onStart`(:251) `onStop`(:269) `onRestart`(:630) `onSetup`(:645) `onUpdate`(:360) `onExit`(:661)；按钮态统一 `renderButtons()`(:225-237) ← `setBusy()`(:239)；进度 `setProgress()`(:244) | 动作与状态混排且不固定：内容变长后滚动即离开视口（desktop 下 `.content` 滚动由 body.desktop 兜底，launcher.css:150） |
| 3 | dsh 安装与版本 | `section.panel`；`#pathInput #btnBrowse #btnInstall #btnMove #verSelect #btnRefreshTags` | `onBrowse`(:351) `onInstall`(:286) `onMove`(:333) `refreshTags`(:309)；`init()` 预填路径（:744-753）读 `getStatus().installedDir/defaultDir` | 表单常显占高；低频（移动/指定版本）与高频（安装）不分层；设置类内容（proxy/registry/closeAction 等 launcher.json 字段）GUI 完全不露 |
| 4 | 生态（插件与技能） | `section.panel.eco-panel`；`#ecoMeta #ecoState #ecoPkgs`；`#ecoCore #ecoSkills`；`#btnEcoRefresh #btnEcoDry #btnEcoPull #btnEcoUpdate` | `refreshEcosystem()`(:438-491) 经 `bridge.getEcosystem()`；勾选状态存内存 `eco.rows`（:385, :471-486）；`onEcoPull`(:493) `onEcoUpdate`(:545)（各自 1.5s 轮询 `getEcosystem().busy`）；`renderEcoButtons()`(:427) | 7 包勾选网格 + 摘要 + 动作全量常显；包明细（dir）只在 `title` tooltip（:484），**sha256 明细当前 UI 根本不展示**（sha 在生态源 `ecosystem.json`/后端，`/api/ecosystem` manifest 不含）→ #18 要的「7 包明细+sha」是新增展示面 |
| 5 | 日志控制台 | `section.panel.log-panel`；`#log`（`aria-live="polite"`，index.html:142） | `log()`(:119-138) 追加行：服务端行带 `[ts]` 不再加时间、300 行上限截断、总是 `scrollTop=scrollHeight` 自动滚底；真实模式 `bridge.onLog` → SSE（init :717-719）；预览 mock `streamInstallLogs/streamEcoLogs/streamUpdateLogs` | 无「只看错误/清空/暂停」控件；固定 148px 高 + 300 行上限是唯一约束；实时追加期间无法稳定上翻查历史；每行一个 `div`，上限内 DOM 尚可，改大后需虚拟化 |

标题栏：`#ver`（真实版由 `server.ts` bridgeScript 注入 `window.launcherVersion`，app.js:721-723）；`#connSelect` 连接切换（`refreshConnections()`:583-605 / `onConnUse()`:607-619，`GET/POST /api/connections`、`POST /api/connections/use`）。

由问题反推的缺陷清单（实现照着改）：

- **P1 无分区/无导航**：`.content` 单列直铺 5 块，无概览聚合、无跳转；长内容（生态+日志）把下方动作推远。
- **P2 高频动作不固定**：启动/停止/一键更新分散在两块里（run-panel 与 eco-foot），滚动即消失（#17/#19 核心诉求）。
- **P3 状态信息散、重复、缺“整机一句话”**：launcher 版本在标题栏、dsh 版本在磁贴、插件集 commit 在 ecoMeta、vscode/desktop 版本不存在；端口/连接重复出现；无健康总点（#19）。
- **P4 生态与安装表单全量常显**（#18）；包级 sha 明细无展示面。
- **P5 连接无“列表/详情”视图**：只有标题栏下拉（id(kind:port)·token✓）；后端有 list（含 name/url/hasToken，mock :67-77）与 add/remove 端点（server.ts `/api/connections/add|remove`），GUI 未用 → #18 的“连接列表”长块、#17 的“连接”分区都要新增卡片。
- **P6 日志无工具条、无过滤、滚动体验差**（#18）。
- **P7 “设置”无分区内容**：安装面板兼任设置；无端口/代理/关窗行为面。
- **P8 与 #20 自适应的冲突点**：`desktopAutoSize()`(:681-705) 把窗口高度撑到内容自然高（`electron-main.ts` `win:autosize`，上限 `desktopMaxH = workArea-20`，下限 560）；一旦改为「固定视口 + 分区内滚动/折叠」，窗口高度策略需重新定义（固定高 or 随折叠收缩），否则高度跳变/裁剪（§8 Step 4）。
- **P9 GUI 动作缺口**：「打开 dsh UI」「重钉工具说明」在 ui/ 无按钮、bridge 无方法（打开浏览器只在托盘 `openActiveBrowser()`，electron-main.ts:178-193；start 的 already 分支只写日志 app.js:253,260）。
- **P10 可访问性**：折叠化后需管理 `aria-expanded`/`aria-controls`、分区锚点；日志 `aria-live` 与高频插入的冲突（§7）。
- 视觉资产本身健康：aurora 背景、`.panel` 磨砂、`.dot` 状态点、`.btn` 变体全部消费 tokens.css 的 dsw token，无硬编码色（launcher.css 头注）——重构应延续。

---

## 2. 目标信息架构：导航方案取舍

候选方案（约束：窗口 720px 宽、非 resizable、高度受限 ≤ 工作区；#19 要求开窗 3 秒内看到状态并点到主动作；#18 要求长块可折叠且默认单屏可读）：

| 方案 | 形态 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A. 纯顶部 tab | 顶 tab 切整页内容 | 单屏极简、每页内容宽裕 | 概览与其他分区互相不可见（无法边看日志边盯生态更新）；状态记忆面扩大；与“3 秒总览+动作”冲突 | 不推荐做主结构 |
| B. 固定侧栏 | 左 icon/文字导航 + 右侧内容 | 分区感最强、可扩展 | 720px 宽砍 150px+ 后卡片区变窄，恶化 #19“窄窗口不破碎”；frameless 拖拽热区与侧栏冲突；本产品是“一眼总览”工具而非多页后台 | 不推荐 |
| **C. 顶部概览条固定 + 内容卡片分区 + 锚点跳转（推荐）** | 顶：健康总点+组件版本 chips+端口/连接+快速动作（常驻）；其下：分区跳转条 + 单列内容卡片（每卡可折叠） | 高频动作/概览永不被推走（#17）；长块天然走 #18 折叠；宽度零损耗；开窗即“这台机器什么样+我能做什么”（#19 验收直通）；结构改动小、可渐进（先重排 DOM 不引入交互，见 §8） | 单列高度仍受窗口限制 → 依赖折叠与分区内滚动；分区“导航感”弱于侧栏 | **推荐** |

**推荐理由（C）**：launcher 的信息本质是「一个总览 + 若干低频明细/操作」，不是平行页面。顶部常驻的概览条同时解决 #17（固定动作）与 #19（聚合总览 + 联动入口：点版本 chip → 滚动到对应卡片并展开）；下方按 #17 建议的五个分区落成卡片，天然成为 #18 折叠单元；锚点跳转条提供“导航”而无需牺牲任何内容可见性。A/B 的成本（隐藏内容、收窄 720px）换不来对应收益。

**布局骨架（desktop 真机形态，自上而下固定三层）**：

```
┌────────────────────────────────────────────────────┐
│ titlebar   logo dsh-launcher  v0.8.5   [连接 pill] ─ × │  ← 现有标题栏不动
├────────────────────────────────────────────────────┤
│ ▍概览条（sticky/常驻，不滚动）                        │
│   ●●●●● 健康总点 + 版本 chips + 端口 + 连接名         │
│   [启动][停止][重启][一键更新][打开 UI][重钉?…]        │  ← #17/#19 固定动作
├────────────────────────────────────────────────────┤
│ 分区跳转（锚点 chips，滚动联动高亮）                  │
│   [概览详情] [安装与升级] [生态] [连接] [日志与设置]    │
├────────────────────────────────────────────────────┤
│ 内容滚动区（卡片堆叠，每卡=分区，卡内长块可折叠）      │
│   …（§5 低保真）                                     │
└────────────────────────────────────────────────────┘
```

落地口径（评审确认项）：概览条与内容区的垂直比例；跳转条是「仅锚点滚动」还是「tab 真切换内容」（首版建议仅锚点，改动最小）。

---

## 3. 分区清单：内容 + 默认展开/收起策略（对照 #18/#19 块清单）

块 id 采用建议命名（实现可按需改）；「默认」指首次无记忆时的状态，一旦用户手动折叠/展开即写入 uiState（§6），重开窗口按记忆恢复。

### 分区一：概览（= 顶部概览条；#19 卡片，常驻，不折叠）

- 内容：健康总点（node / npm / dsh / 端口 / 更新可用性 的点或总点）、组件版本 chips（launcher / dsh / vscode / desktop / 插件集 commit）、运行端口与连接名（local 端口 / remote URL 语义）、快速动作（§4 清单）。
- 联动：点某版本 chip → 滚动到对应分区卡片并自动展开目标子块（点 dsh → 安装与升级卡「dsh 版本与更新」；点插件集 commit → 生态卡「清单」子块）。（#19「点版本看详情」）

### 分区二：安装与升级（卡片可折叠；#18 目标块之一）

| 子块 | 内容 | 默认 |
|---|---|---|
| `sec-install` dsh 安装 | 安装目录（编辑+浏览+安装+移动）、版本选择+刷新列表 | **收起**（常态只需读值）；**dsh 未安装时自动展开**（状态驱动默认，可被记忆覆盖） |
| `sec-update` 更新 | 检查更新结果 + dsh/launcher 可升级提示 | **展开**（头部摘要行常显：目录、当前版本、更新可用性） |

### 分区三：生态（插件/技能/清单）（卡片默认**收起为摘要**；#18 主战场）

| 子块 | 内容 | 默认 |
|---|---|---|
| `eco-summary` | 生态源 label · 插件集 commit · dsh 源/版本 · skills ✓ · 上次拉齐（N ok / core） | 摘要行**常显**（即卡片头，不再另占一行正文） |
| `eco-packages` 插件包 | 7 包勾选网格 + 包级行：id / dir / install.ps1 sha256 / 已装·未装 chip | **收起**；展开才显示明细（sha 需后端随 `/api/ecosystem` 补 `packages[].sha256`，§4） |
| `eco-skills` 技能 | 技能集合状态与「含技能」开关 | **收起** |
| `eco-manifest` 清单 | 默认清单（repo/commit/sha 来源，读 ecosystem.json） | **收起** |
| 动作 | 拉齐勾选项 / 仅校验(dry-run) / 刷新 | 放卡片头（右侧），与「一键更新」在概览条形成主次两级 |

### 分区四：连接（卡片默认**收起**）

| 子块 | 内容 | 默认 |
|---|---|---|
| `conn-summary` | 激活连接名/kind/端口或 URL + 健康点（概览条已有，此处显示同源详情） | 卡片头摘要 |
| `conn-list` | 全部连接行：name / kind / port·url / hasToken / active 标记 + [使用][编辑][删除]（后端已有 add/remove/use） | **收起**，展开可见列表 |

### 分区五：日志与设置（拆两块卡）

| 卡 | 内容 | 默认 |
|---|---|---|
| `log-card` 运行日志 | 工具条：「只看错误」开关（三态：全部 / 警告+错误 / 仅错误 可作增强）、清空、暂停自动滚动、行数/高度上限；正文滚动区 | **展开**（安装/更新/拉齐的实时进度都经 SSE 打到这里，必须默认可见） |
| `settings-card` 设置 | 现有 GUI 无独立设置面；候选内容：安装目录读值、端口（读 launcher.json，改需后端写）、代理/registry、关窗行为 closeAction、恢复默认布局 | **收起**（本轮可先只放“安装目录 + 恢复布局/清空日志缓存”，其余留待后续） |

全局控件：卡片头提供「展开/折叠本卡」，概览条提供「全部折叠/全部展开/重置布局」（重置 = 清 uiState 相关键）。

---

## 4. 概览卡字段来源 + 快速动作清单（#19）

### 4.1 字段 → 数据来源（现状可用的直接标注出处；缺失的标 ☐缺口）

| 概览字段 | 来源函数 / 数据链 | 现况 |
|---|---|---|
| launcher 版本 | `window.launcherVersion`（server.ts bridgeScript 注入；app.js:721） | ✅ 现成 |
| dsh 版本 | `refreshStatus()` → `getStatus().dsh.version`（`/api/status`；后端 statusPayload 读 `launcher.json dshVersion` 或 `node.dshVersionFromPackage`） | ✅ 现成 |
| node / npm 版本 | `getStatus().node.version / npm.version`（后端 `safeDetect`/`safeNpm`） | ✅ 现成 |
| 运行端口 | `getStatus().port.number`（local = 连接端口，否则 cfg.port）；remote 语义见 `.connection` | ✅ 现成 |
| 健康点 | `setValue`/`setDot` 的 dot-green/red/dim/brand（launcher.css:214-233）；总健康 = 需新增聚合计算（node∧npm∧dsh.installed 且端口可达…） | ⚠️ 分点现成，总点/总健康文案需新增纯前端逻辑 |
| 连接名 | `getStatus().connection`（id/kind/name/port/url，statusPayload 现成返回，app.js 只在 remote 分支用 :208）＋ `getConnections().active`（`refreshConnections`） | ✅ 现成（connection.name 目前被 UI 忽略，改版直接消费） |
| 更新可用性 | `getStatus().update.{checking,dshAvail,launcherAvail}`（后端 updateState） | ✅ 现成 |
| 插件集 commit | `refreshEcosystem()` → `getEcosystem().manifest.pluginsCommit`（截 8 位，:451） | ✅ 现成 |
| vscode 版本 | — | ☐ 缺口：无任何现成字段；需后端新增（候选：statusPayload 增 `components.vscode`，读 dsh profile 内已装扩展版本；或伞仓发布元数据） |
| desktop 版本 | — | ☐ 缺口：同上（候选：已装 npm 包 `@kuaizhongqiang/dsh-desktop` 版本 / registry 元数据） |
| 插件包 sha256 | — | ☐ 缺口：`/api/ecosystem` manifest 无 sha；后端有（随包 ecosystem.json / 内嵌清单），需在接口补 `packages[].sha256` 供 #18 明细展示 |
| 实时日志（非状态） | `bridge.onLog` ← SSE `/api/events`（server.ts handleEvents；`lineKind` 把 `[ERROR]→err / [WARN]→warn / [DEBUG]→''`） | ✅ 现成（只推新行，不重放） |

> 结论要点：#19 概览卡 60% 字段已现成可聚合（launcher/dsh/node/npm/端口/连接/更新/插件集 commit），真正的后端工作集中在 **vscode/desktop 版本字段** 与 **打开 dsh UI** 两个缺口。

### 4.2 快速动作清单（固定可达区）

| 动作 | 复用现有 | 备注 |
|---|---|---|
| 启动 / 停止 / 重启 | `onStart/onStop/onRestart`（按钮态由 `renderButtons()` 统一驱动，改版后同一函数控制概览条动作钮） | 启动钮按 `state.running` 变「已运行」文案 |
| 一键更新（插件） | `onEcoUpdate`（含 confirm + busy 轮询） | 概览条主按钮之一；与拉齐 busy 互斥由 eco.busy 承接 |
| 一键部署 | `onSetup`（可选放概览条次要位） | — |
| 打开 dsh UI | ☐ 新增：GUI 无契约；托盘 `openActiveBrowser()`（electron-main.ts:178-193）已有完整逻辑（local：launch-token URL 或 `http://127.0.0.1:<port>/`；remote：`buildRemoteTarget(conn)`） | **建议抽成后端 `openActiveBrowser` 同一函数 + 新增 `GET /api/open`，bridge 加 `open()`**（SEA/浏览器版按平台开外链） |
| 检查更新 | `onUpdate` | 次要，可入安装与升级卡 |
| 重钉工具说明 | ☐ 无对应实现 | 语义未定义，见「未决问题」；首版可在概览条占位 + 文案待确认 |
| 退出 | `onExit` | 放概览条最右次要位或保持标题栏语义，不进“主动作”区 |

---

## 5. 低保真布局（ASCII 线框）

### 5.1 桌面主形态（≈720 宽；顶概览条 + 跳转条固定，内容滚动）

```
┌────────────────────────────────────────────────────────────┐
│ ● dsh-launcher  v0.8.5            [🔗 本机dsh(3080) · token✓] ─ × │  titlebar
├────────────────────────────────────────────────────────────┤
│ ▍概览                                    ●=绿 ○=停 ●=需更新     │
│  ●●○●●  本机健康：node ✓ npm ✓ dsh 运行中·3080 · 连接:本机dsh   │
│  组件：launcher 0.8.5 · dsh v0.8.5 · vscode? · desktop? ·     │
│        插件集 56bfcbb[点此看清单]                             │
│  ┌───────────────────────────────────────────────┐          │
│  │ [▶ 启动] [⏹ 停止] [↻ 重启] [⚡一键更新] [🌐打开UI] … │          │ ← 固定动作
│  └───────────────────────────────────────────────┘          │
├────────────────────────────────────────────────────────────┤
│ [概览详情] [安装与升级] [生态] [连接] [日志与设置]        (跳转) │
├────────────────────────────────────────────────────────────┤
│ ┌─ ▸ 安装与升级 ── dsh v0.8.5 · 目录 C:\…\dsh · 已最新 ────┐  │  默认收起
│ ┌─ ▾ 生态(摘要常显)─────────────────────────────────────┐  │
│ │   源:默认(内嵌) · 插件集 56bfcbb · skills ✓ · 上次拉齐 7ok │  │
│ │   [拉齐勾选项] [仅校验] [刷新]                    [▸明细] │  │
│ │   └ 展开后: 7包勾选网格 / 技能开关 / 清单(sha)         │  │
│ ┌─ ▾ 连接(激活: 本机dsh · local:3080) ────────────────┐  │
│ │   [▸ 连接列表] …                                    │  │
│ ┌─ ▾ 运行日志 ───────────────────────────────────────┐  │
│ │   [只看错误:○] [暂停滚动] [清空] 行高:▮▮▮▯          │  │
│ │   ┌────────────────────────────────────────────┐  │  │
│ │   │ 21:00:12 [INFO] 已启动 dsh(3080)            │  │  │
│ │   │ 21:00:13 [INFO] 插件源同步完成               │  │  │ ← 日志区可滚动
│ │   └────────────────────────────────────────────┘  │  │
│ └─ ▸ 设置 ──────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
  （内容超窗高 → 中部滚动；顶部三层永不滚走）
```

### 5.2 窄窗口 / 内容单屏折叠态（#18 验收参考）

```
┌────────────────────────────────┐
│ 概览条(压缩为: ●●● 点展开明细)  │  ← 概览条允许折成一行健康点+动作，
│ [▶启动][⏹停止][⚡更新][🌐]      │     动作钮 icon 化（窄于 480px）
├────────────────────────────────┤
│ [安装][生态][连接][日志]  (tab化)│
│ ▸ 安装与升级  (摘要行)          │
│ ▸ 生态  (摘要行)                │
│ ▸ 连接  (摘要行)                │
│ ▾ 运行日志                      │
│   [只看错误]  …日志…            │
└────────────────────────────────┘
  （CSS: .tiles 已有 ≤560px 两列 precedent，launcher.css:189）
```

### 5.3 折叠单元交互约定

- 每个可折叠块 = 一行头（标题 + 摘要 + 状态点）+ 可展开体；`<button aria-expanded aria-controls>` 驱动。
- 摘要行必须可独立表达“这块值不值得展开”（如生态卡头的“上次拉齐 7ok / core 已装”）。
- 卡片头右侧动作位放该分区主动作（生态卡 → 拉齐/校验/刷新），不淹没在展开体里。

---

## 6. 状态记忆存储方案（#18：展开状态持久化）

### 6.1 现状盘点（重要前提）

- **`ui/app.js` 目前零持久化**：勾选状态只存内存 `eco.rows`（:385/:471），刷新即丢；没有 localStorage、没有读写后端配置。
- `launcher.json` 由后端 `src/config.ts` 独占管理：`configPath()`（便携，与 exe 同目录）、`load()`（容忍 BOM，缺省返回 null）、`save()`（`writeFileSync` **整体覆盖写** `JSON.stringify(c, null, 2)`）。Config 是 typed 白名单接口。
- 后端桥 `server.ts`：REST `/api/*` 一个 switch（handleApi :302）+ bridgeScript 注入 `window.launcherBridge`（:76-114）+ SSE `/api/events`。UI 只经桥访问后端，**页面本身无文件写权限**（资源是内存 assets）。
- Electron 窗口：`contextIsolation:true, nodeIntegration:false`（electron-main.ts:131-133），renderer 无 Node。

### 6.2 结论：扩展 launcher.json（按 issue 字面）+ 后端桥，不用 localStorage

理由：localStorage 以 origin（`http://127.0.0.1:<port>`）为界，端口随 launcher.json 变化、浏览器预览版换 profile 都会丢；本项目既有的“便携设置载体”就是 launcher.json，跨模式一致且与 exe 一起走。因此状态落 launcher.json，但**一切写入必须经后端桥**。

### 6.3 数据形状（建议）

```jsonc
// launcher.json 新增可选顶层字段（Config 接口同步扩展）
"ui": {
  "collapsed": { "sec-install": true, "eco-packages": true, "conn-list": true, "settings-card": true, "log-card": false },
  "log": { "errorsOnly": false, "maxLines": 2000 },
  "layout": { "navMode": "anchor" }        // 未来布局选项
}
```

### 6.4 读写点与纪律（实现注意，逐个列清）

1. **`src/config.ts`**：`Config` 加 `ui?: UiSettings`；新增 `loadUi(): UiSettings`（从 load() 结果取，缺省合并默认值）与 `saveUi(patch: Partial<UiSettings>)` —— 内部**先 load() 再浅合并再 save()**。
2. **⚠️ 防覆盖纪律**：`config.save()` 是全量覆盖写且被 CLI/install/setup/launch 多处调用（各自构造 Config 对象）。任何新增写路径必须走「load → merge → save」，或在这些旧调用点改为先 load 再填字段；否则 UI 写一次、别的流程再 save 一次就会互相丢字段。**顺手把 `config.save()` 改 tmp+rename 原子写**（本仓 connections.ts 已有 D8 原子写先例；save 目前非原子，UI 高频写会放大风险）。
3. **`src/server.ts`**：新增 `GET /api/ui-state`（返回 `config.loadUi()`）与 `POST /api/ui-state`（body = 全量或 patch，merge 后 save）；在 handleApi switch 注册两 case；bridgeScript 增 `getUiState/setUiState`。
4. **`ui/app.js`**：底部契约注释（:770-790）同步补方法；**mock 层**（:10-87）补 `getUiState/setUiState`（内存对象即可）保证预览可用；`init()` 首帧 `getUiState()` → 应用到各折叠块与日志工具条（SSE 就绪前即可应用）。
5. 写入时机：折叠/展开、只看错误、maxLines 变更 → **debounce ~300ms** 调 `setUiState`（避免动画期连写）。
6. 折叠状态影响窗口高度 → 每次展开/折叠 settle 后调用现有 `scheduleAutoSize()`（:702，与 #20 自适应协作）。
7. 预览（mock）与真实模式的 origin 不同源时状态互不相通属预期（预览本来就是无持久化环境）；文档注明即可。

---

## 7. #18 日志「只看错误 / 上限滚动」与 SSE 推送共存的实现注意点

现状链路：`/api/events`（server.ts handleEvents :277-294）`log.subscribe(line)` → push `{line, kind}`，kind 由 `lineKind()` 判定：`[ERROR]→err`、`[WARN]→warn`、`[DEBUG]→''`、其余 `''`；**只推新行、断线重连不重放**。客户端 `log()`（:119-138）还会产生本地行（kind：ok/warn/err/brand/dim/''，自带时间戳；服务端行以 `[ts]` 前缀识别不再加时间）。

实现注意点（按风险排序）：

1. **过滤语义统一**：`kind` 有两个来源且规则不同（服务端按 `[ERROR]/[WARN]/[DEBUG]` 文本；客户端按调用方传参）。「只看错误」不能只信 kind —— 建议判定 = `kind==='err'` **或** 文本命中错误特征（`/error|fail|失败|错误|拒绝/i`），并明确 `warn` 不含（可做三态：全部 / 警告+错误 / 仅错误）。`lineKind` 服务端已把 `[ERROR]` 归 err，客户端 `log(msg,'err')` 也归 err，两边能对齐大部分。
2. **缓冲优先于 DOM**：改为「环形缓冲数组（行对象 `{text,kind}`，容量=uiState.log.maxLines，默认 2000）+ 视图派生」。行数/高度上限应作用在 buffer，而不是像现在只 `while(children>300) removeChild`（:136）删 DOM —— 否则“只看错误”开着时，被过滤掉的旧行没进 buffer，切回“全部”历史就丢了。
3. **自动滚动只在贴底**：现在无条件 `scrollTop=scrollHeight`（:137）。新方案：仅当用户处于底部（`scrollHeight - scrollTop - clientHeight < 阈值`）才跟随；用户上翻查历史时暂停跟随，有新行到达则在工具条显示「N 条新日志」角标，点它回到底部并跟随 —— 这是“实时推送 + 可查历史”不打架的关键交互。
4. **aria-live 与高频插入冲突**：`#log` 现带 `aria-live="polite"`（index.html:142），每行一个 div 持续插入会刷屏读屏。建议移除行级 announce，改为“新日志到达且贴底”时对容器做低频摘要 announce（或维持 aria-live 但仅在有新行且用户贴底时触发）。
5. **渲染节流**：SSE `onmessage` 可高频到来；`log()` 每次同步 append 一个 div 在 2000 行量级仍可接受，但若做虚拟滚动/大上限，须按帧合并批量插入（rAF 或 ~100ms 分片），避免长任务卡 UI。
6. **虚拟滚动的取舍**：先做「高度上限 + 溢出滚动 + buffer 截断」；只有当 maxLines 设得很大（如 1e4+）或真机卡顿时再上窗口化渲染（只渲染可视行 ± 缓冲）。窗口化时保证：贴底跟随、新行角标、过滤切换后滚动位置语义不变。
7. **不破坏 SSE 本身**：过滤/截断全部是前端行为，`/api/events` 连接保持原样；`bridge.onLog` 订阅点（init :717-719）不变，只是 `log()` 内部改为 buffer 追加 + 视图刷新。若未来要“历史回放”，**另开**只读 `GET /api/logs?since=`（后端可留日志环形队列），不与 SSE 抢同一通道。

---

## 8. 分步实施顺序建议（先结构后细节；每步可独立提交/回退）

> 变更范围提醒：`ui/*` 是纯前端（mock 模式可独立开发预览）；涉及后端桥的步骤需动 `src/server.ts`/`src/config.ts` 并跑 `npm run build` + `verify:m2`（UI e2e 冒烟）与真机冒烟；开发用 npm，勿用 pnpm（WORKLOG 技术备忘）。

- **Step 0（独立、先行）状态记忆地基**：config.ts `ui` 字段 + load/saveUi（load→merge→save 纪律）+ `config.save` 原子化 + `GET/POST /api/ui-state` + bridge/mock 补方法。无 UI 改动，可单独提交验证（`verify:mX` 与真机接口冒烟）。**#18 的其余部分都依赖它**。
- **Step 1（#17 结构骨架）**：index.html 重排为「顶概览条壳 + 分区卡片容器 + 跳转条」；**只移动现有 DOM 与按钮，保留全部 id 与事件函数不变**（行为不变量：mock 下点任何原按钮与改版前一致）；CSS 补卡片/跳转样式。这一步是纯结构 commit，视觉与交互回归风险最小。
- **Step 2（#19 概览卡 + 后端缺口）**：概览聚合渲染函数（消费 refreshStatus/refreshEcosystem 已有数据一次成型）；后端补 `statusPayload.components.{vscode,desktop}` 数据源（需先定探测方案，见未决问题）与 `GET /api/open`（抽托盘 `openActiveBrowser` 共用）+ bridge `open()`；概览条动作钮接入 `renderButtons()`。
- **Step 3（#18 折叠 + 日志工具条）**：折叠组件化（统一 accordion 交互/aria/动画/状态记忆，逐块接入 uiState）；生态明细（含 `packages[].sha256` 接口补充）与连接列表卡；日志工具条（只看错误/清空/暂停跟随/行数高度上限，按 §7 改造 buffer + 贴底语义）。可与 Step 2 并行开发但合入在后。
- **Step 4（#17 视觉收尾 + 自适应联调）**：dsw 视觉细调（概览条状态点、卡片磨砂、焦点态）、窄窗口 media query（概览条压缩态，§5.2）、**窗口高度策略拍板**（固定视口 + 中部滚动，或随折叠收缩的 autosize 变体）→ 同步改 `desktopAutoSize`/electron-main 高度逻辑（#20 关联）。本步含产品决策，最后合。
- 独立提交切分建议：Step 0 单独 PR；Step 1 单独 PR；Step 2（前端+后端缺口）一个 PR（后端两缺口绑定同批验收：#19 验收）；Step 3 按「折叠骨架 → 生态明细+sha → 日志工具条」可再拆 3 个 commit；Step 4 单独 PR。
- 每步验收以 #17/#18/#19 验收句为锚：开窗 3 秒说出本机状态并点到主动作（#19）；默认视图单屏可读、折叠/记忆可复现、日志实时（#18）；高频动作固定可达（#17）。

---

## 9. 未决问题（需 issue 作者 / 评审确认后再动工）

1. **「重钉工具说明」动作的准确语义**：现有 ui/、`src/server.ts`、bridge 契约、launcher 插件（PM3）里都没有同名操作；仓内「重钉」出现在发布级 `pin-ecosystem.mjs`（插件集 commit 重钉，发布工具，非 GUI 动作）。推测可能是「dsh 侧工具/技能说明随生态更新后一键重载（重钉工具说明）」——请确认动作内容、触发对象与后端落点，或从 #17 动作清单中删除/改名。
2. **vscode / desktop 版本数据源**：#19 概览卡要展示，但 /api/status、/api/ecosystem、connections、registration 均无字段。候选：a) 后端探测已装组件（dsh profile 扩展版本 / desktop npm 包版本）；b) 伞仓 release 元数据（三组件同 tag vX.Y.Z）由 updateState 携带；c) 本轮先展示 launcher/dsh/插件集 commit，vscode/desktop 后补。请拍板口径与验收是否需要这三者同时可见。
3. **窗口形态**：保持 720 固定宽 + autosize 高，还是允许 resizable / 固定高内滚动？直接决定 §5 低保真与 §8 Step 4 的落地（#19 窄窗口验收口径也依赖此）。
4. **分区跳转条**：锚点滚动（推荐）还是真 tab 切内容？
5. **「设置」分区内容范围**：本轮只做「安装目录读值 + 恢复布局」，还是顺带暴露 launcher.json 里 GUI 已有写能力的字段（closeAction 等需新桥）？

---

## 附：术语与引用

- 数据/桥契约权威注释：`ui/app.js:770-790`（launcherBridge 类型清单）；后端实现 `src/server.ts:74-114`（bridgeScript 注入）。
- SSE 日志：`src/server.ts:268-294`（lineKind / handleEvents）；客户端订阅 `ui/app.js:717-719`。
- launcher.json：`src/config.ts`（configPath/load/save/isInstalled）；D8 原子写先例 `src/connections.ts`。
- 桌面窗口高度策略：#20 相关 `ui/app.js:681-705`（desktopAutoSize/scheduleAutoSize）与 `src/electron-main.ts:40,79,121-134,354-362`（win:autosize，desktopMaxH）。
- 托盘「打开浏览器」语义（做 /api/open 的参照）：`src/electron-main.ts:178-193`（openActiveBrowser：local=launch-token URL 或 `http://127.0.0.1:<port>/`；remote=buildRemoteTarget）。
- 生态数据：`/api/ecosystem` ↔ `refreshEcosystem`；插件集清单随包 `dsh-launcher/ecosystem.json`（7 包 + install.ps1 sha256 + skills sha）。
