# dsh-launcher 生态化路线图 —— 「一个 exe 走天下」

> 目标形态:身上只携带一个 `dsh-launcher.exe`,走到任何一台新 Windows 机器,双击(或一条命令),
> 按需拉起**整个 dsh 生态**:核心 → 插件 → 技能 → 周边客户端 → 个人配置,5 分钟内可用。
>
> 修订:v2(2026-09-02)——按独立审查报告([ECOSYSTEM-PLAN-REVIEW.md](ECOSYSTEM-PLAN-REVIEW.md))落实:P0×3 全部修正,P1×5 全部补充,P2×5 采纳,P3 采纳 4 条(P3-1 无需修改)。
>
> 修订:v3(2026-09-02)——按深度审查报告([ECOSYSTEM-PLAN-REVIEW-DEEP.md](ECOSYSTEM-PLAN-REVIEW-DEEP.md))落实:新增 D8 监督者协调协议与 M0 前置修复(clearLaunchToken 竞态 P0-4、日志 token 泄漏 P1-6),供应链校验转强制(P1-7),Phase 4 白名单按实测精确化,收窄「零改动跟随」承诺;深度报告的 P3-6/P3-7 经核验为过时项(v2 已修),未采纳。

## 1. 生态分层模型

先定义清楚「生态」是什么,launcher 才知道要拉什么:

| 层 | 内容 | 现在由谁负责 | 载体 |
|---|---|---|---|
| L0 载体 | dsh-launcher.exe(内置 Chromium+Node,零依赖) | launcher | 随身携带 |
| L1 运行时 | Node.js ^22.19 \|\| >=24 | **用户预装(缺口)** | 目标机器 |
| L2 核心 | dsh(deepseek-harness 构建,GitHub tag / npm 双源) | launcher `install` | 网络拉取 |
| L3 插件 | dsh-plugins 11 个插件包 + install-* 技能 | **dsh 会话内聊天装(缺口)** | git 子模块随行 |
| L4 周边 | dsh-desktop / dsh-vscode / dsh-remote | 各自 Releases(手动,缺口) | 可选拉取 |
| L5 个人层 | `%DSH_HOME%`:settings.yaml、profiles、skills、watchlist、stock 等 | **不随行(缺口)** | 漫游包 |
| L6 连接层 | 可连的 dsh 实例:本机(端口可配多组)+ 广域网(dsh-remote 部署) | `launch-token.json` 仅单组记录,launcher 只会启本地 3080(**缺口**) | `%DSH_HOME%\connections.json` |

敏感红线(永不进任何同步/清单流):`.credentials.yaml`、`launch-token.json`、`connections.json`(各组连接 token,见 D5)、`sessions/`。

## 2. 现状盘点

**已具备**(launcher v0.6.4):
- 单文件便携 exe + NSIS 安装版,dsh 绑定子进程启动/停止,关窗即停(**现状;Phase 6 将把默认行为变更为关窗=隐藏到托盘**)
- GitHub 源码构建(锁最新 `dsh-v*` tag,支持代理)/ npm registry 双源安装
- token 自动登录 + `launch-token.json` 与 dsh-vscode 共享
- dsh-plugins 以 git 子模块随行;升级检测(dsh + 启动器自身);`move` 挪移
- 自持隐藏控制台,工具执行不弹窗

**八个缺口**(对照愿景):
1. 插件/技能要「先装好 dsh → 开会话 → 说一句安装」才能落地,launcher 本身不会装
2. 没有「我的生态」清单:哪些插件、哪个版本、要不要 desktop/vscode,全靠记忆
3. 个人层不随行:换机器后 settings/profiles/watchlist/股票自选全部从零开始
4. 新机器前置要求 Node(+github 源还要 git/pnpm),不算真正「零依赖」
5. 没有回传:B 机用出来的状态(新装插件、自选股变更)回不到 A 机
6. 启动模型单一:launcher 只认「本地 3080」一组(端口写死在 launcher.json);广域网 dsh(dsh-remote 部署)无法由 launcher 管理/切换;vscode 虽有 `dsh.remote` / `dsh.serverUrl` / `dsh.token` 但只是**单组静态配置**;web 与 desktop 只读 `launch-token.json` 的当前记录——三个端对「多组连接」没有共同语义
7. 生命周期交互原始:launcher 无托盘常驻,关窗即停 dsh;重启全靠手动关开;dsh 侧(插件安装技能的「重启并验证」步骤)没有借外部程序完成自身重启的通道
8. 插件粒度过细:11 个包 11 套 install.ps1/SKILL.md——感知类 4 件套(audio/video/image/document)与 TTS 共用 MIMO_API_KEY 却拆 5 个包,DeepSeek 账户 2 个单工具包,安装面与 cordis.patch 冲突面都被放大(详见 §8)

## 3. 核心设计决策(动手前先定规则)

- **D1 谁来写 `%DSH_HOME%`**:launcher 保持「不直接手写 DSH_HOME」的原则——生态组件的安装一律**调用插件自带的 `install.ps1` / `install-skills.ps1`**(安装逻辑唯一真源仍在 dsh-plugins),launcher 只做编排、进度展示,并把结果记在**自己目录**的 `ecosystem-state.json`。GUI 明示「将安装组件到 ~/.dsh」。
- **D2 凭证红线**:`.credentials.yaml` 永不明文进**外部存储**(仓库/U 盘/清单/漫游同步)。统一基线:`launch-token.json`、`connections.json` 内的 token 以**明文仅存本地**为既定形态(0600 仅 POSIX 生效,Windows 下依赖 NTFS 默认 ACL),永不进外部存储;远期可选系统凭据保护(Windows DPAPI)。新机器凭证要么首次手填(credentials 插件),要么走加密包(见 Phase 4)。
- **D3 清单即生态**:一切版本与组件由 `ecosystem.json` 声明;默认清单随 launcher 仓库走,支持 `--manifest <url|file>` 指向**私有清单**实现个性化覆盖。
- **D4 目录边界不变**:core 在 `%LOCALAPPDATA%\dsh`,个人层在 `%DSH_HOME%`,生态状态在 exe 旁——三处各管各的,继续互不越界。(`launch-token.json` 与新的 `connections.json` 是 launcher 在 `%DSH_HOME%` 的两个**显式启动 seam**,延续 v0.5.0 共享 token 文件机制,不算越界。)
- **D5 连接即启动项**:所有可连的 dsh 实例(本机不同端口、广域网)统一声明为 `~/.dsh/connections.json` 里的**连接组**;launcher 的启动/停止/状态/开浏览器全部作用于「当前激活连接」——local 组绑子进程启动,remote 组不 spawn、只做健康检查并带 token 打开浏览器。激活连接解析后照写 v1 `launch-token.json`——desktop 完全跟随;vscode 的 **token 认证跟随**(`dsh.serverUrl` 为静态配置不自动切换,见 Phase 5 收窄表述);`connections.json` 含 token,仅存本地(0600),永不进漫游同步。
- **D6 重启委托给管理者**:dsh 不自行重启(进程内自替换无法优雅收尾,且会脱离 launcher 的绑定关系)——谁持有 dsh 的生命周期,谁负责重启。dsh 通过**两级发现 seam** 定位 launcher:① 运行时——launcher spawn dsh 时注入 `DSH_LAUNCHER_EXE` 等环境变量(只覆盖 launcher 亲手拉起的进程);② 持久——launcher 在 `%DSH_HOME%\launcher-registration.json` **注册自己**(安装即注册、启动/停止/挪移时更新),任何启动方式下 dsh 都能找到它。检测到任一 seam 即把「重启」委托给 launcher(`restart` = 优雅停止 → 等端口释放 → 重启 → 重抓 token 照写共享文件);两级都无(机器上没装 launcher)才降级为提示人工重启。
- **D7 插件按「凭证与模式」聚合,不按工具拆分**:同一把凭证、同一种「主模型 text-only + 外挂感知」模式的工具合为一个插件包(包内 `--only` 支持子集安装);launcher 的宿主能力(重启/连接/状态)以 **dsh-launcher 插件**成为 dsh 的一等工具面,而非隐式环境变量约定;新插件入集合前先问「能不能并进既有层」(详见 §8)。
- **D8 监督者协调协议**:launcher、dsh-vscode、手动 `dsh web` 三方都可能启停 dsh,互不感知必生竞态(深度审查场景 2/4)。协调基线:① `clearLaunchToken` 原子化——仅 `source`+`pid` 双匹配且删除前复读确认(修 P0-4);② 端口锁文件 `%DSH_HOME%\.dsh-port-<port>.lock`({pid, source, startedAt},spawn 前检查、退出清理);③ active 切换写 `%DSH_HOME%\.dsh-connection-changed` 标记(含时间戳),消费端重连前检查;④ connections.json 等多写者共享文件一律原子写(临时文件 + rename,必要时文件锁,修 P1-8)。

## 4. 分阶段路线图

### Phase 1 — 生态清单 + `pull` 命令(CLI 先行)
- 新增 `ecosystem.json`:声明 dsh 版本策略、插件集合、技能集合、可选周边(dsh-desktop/vscode)及来源
- 供应链校验(强制,修 P1-7):清单内每个插件包声明 `sha256`,`pull` 执行 install.ps1 前逐文件验哈希;`--manifest` 私有清单**强制 HTTPS**;dsh-plugins 子模块**锁 commit**(不依赖 `--remote` 拉远端 HEAD)
- 新命令 `pull [--manifest <url|file>] [--plugins a,b] [--with-desktop] [--all]`:
  对照清单补齐缺口——core 用现有 `install`;插件逐个跑其 `install.ps1`;技能跑 `install-skills.ps1`;结果写入 `ecosystem-state.json`
- 验收:新机器上 `dsh-launcher.exe install && dsh-launcher.exe pull` 两条命令拉齐 core+插件+技能

### Phase 2 — GUI「生态」页
- 插件/技能列表(读子模块或远端 dsh-plugins)+ 勾选安装 + SSE 实时进度(复用现有日志通道)
- 生态状态卡片:已装/未装/版本漂移一眼可见;「一键拉齐全家桶」按钮

### Phase 3 — Node 运行时自持(真·零依赖新机器)
- 检测无 Node → 自动下载便携版 node.zip → `%LOCALAPPDATA%\dsh\runtime\`,仅注入 dsh 子进程 PATH,不污染系统
- 备选评估:Electron 自带 Node 运行时若满足 dsh 要求(^22.19 || >=24)可直接复用省去下载;版本不匹配则走便携 node.zip(默认方案)
- 安装源降依赖:默认优先 npm 源/官方产物(无需 git/pnpm);源码构建降级为高级选项
- 离线包支持:`--offline <目录>` 直接吃本地 runtime + dsh 包 + 插件包

### Phase 4 — 个人层漫游(profile pack)
- 同步白名单(实测合计仅 ~0.21 MB):`settings.yaml`、`profiles/web/cordis.patch.yml`、`profiles/web/plugins/`、`skills/`、`stock/watchlist.json`、`stock/reports/`(可选)
- 显式排除(深度审查 §6 实测依据):`sessions/`(44.6 MB)、`profiles/node_modules/` 与 `.dsh-module-fallback/`(可重建,正常安装后可达数百 MB)、`.dsh-memory-autostore-state.*`(机器绑定运行时状态)、`attachments/`、`storages/`、`llm-deepseek/`、`.anonymous-user-id`(每机独立)、`stock/daily/` 与 `stock/kline-cache.json`(可重采);**凭证与 token 文件**(D2)永不进同步
- 凭证三选一:a. 新机手填(最安全,推荐默认) b. 加密包(age/zip+密码)随 U 盘或私有仓 c. 私有 git 仓 + credential manager
- 新命令 `profile push|pull [--exclude ...]`;清单里声明个人层来源

### Phase 5 — 多连接启动项(本机 / 广域网)

- 连接文件 `%DSH_HOME%\connections.json`(**多组连接 + 各组 token 都在这里**):

  ```json
  {
    "version": 1,
    "active": "local-3080",
    "connections": [
      { "id": "local-3080", "kind": "local",  "name": "本机 dsh",             "port": 3080 },
      { "id": "local-3081", "kind": "local",  "name": "本机 dsh(第二实例)",  "port": 3081 },
      { "id": "wan-main",   "kind": "remote", "name": "广域网 dsh",
        "url": "https://<domain>", "token": "<启动 token>", "extraHeaders": { } }
    ]
  }
  ```

- 字段说明:`extraHeaders` 对齐 dsh-vscode 的 `dsh.extraHeaders` 配置,用于 Cloudflare Access 等需要自定义认证头的场景;`token` 可留空(见下条 remote token 生命周期)
- CLI:`connections list|add|use|remove`;`start [--connection <id>]`(local → 在该端口绑子进程启动,端口不再写死 3080;remote → 不 spawn,健康检查后带 token 打开浏览器);`stop` / `status` 语义跟随激活连接
- GUI:窗口顶部**连接切换器**(下拉 + 状态点:local=子进程健康,remote=HTTP ping);启动/停止/打开按钮按连接类型语义化;广域网组 token 可留空(认证交给 Cloudflare Access)
- 兼容层(关键):激活连接无论 local/remote,解析后照写 v1 `launch-token.json`(`url`/`token`/`port`/`source`,规范不变)。跟随能力**收窄表述**(深度审查竞态场景 4):dsh-desktop 按 launch-token 的 url 连接,**完全跟随**;dsh-vscode 的 **token 自动跟随**,但 `dsh.serverUrl` 是静态配置**不会自动切换**——切到 remote 组后需同步更新 serverUrl;远期二者升级为直接读 `connections.json` 才实现全自动多组切换
- 监督者协调(D8):spawn 前检查端口锁文件、退出清理;active 切换写 `.dsh-connection-changed` 标记;connections.json 原子写(临时文件 + rename)
- remote token 生命周期:token 留空 → 认证交给 Cloudflare Access 等外部机制;token 非空 → launcher 打开浏览器/健康检查前先做 token 自检(复用 `launch.ts` 现有校验逻辑),失效(401)即提示用户更新该组 token;远期考虑 remote 端提供 token 轮换接口
- 红线(与 D2 基线一致):各组 token 明文仅存本地——0600 仅 POSIX 生效,Windows 下依赖 NTFS 默认 ACL(当前用户可读写);永不进 profile pack 同步等外部存储;远期可选 DPAPI

### Phase 6 — 托盘常驻 + 重启 seam(生命周期升级)

**托盘化**
- Electron Tray 常驻:显示/隐藏窗口、启动/停止/**重启** dsh、打开浏览器(按激活连接)、连接切换(列出 `connections.json` 各组,点击即 `use` 并连接)、检查更新、退出(停止 dsh 后退出)
- 图标状态色:灰=未运行 / 绿=运行中 / 黄=有更新 / 红=异常(与 GUI 状态点同一语义);dsh 启动/停止/更新可用弹气泡通知
- 关窗行为变更(变更自现状「关窗即停」):默认**关窗=隐藏到托盘**(dsh 继续跑),设置项保留「关窗即停」旧行为;真正退出走托盘菜单

**重启 seam(dsh 知道可以借外部程序重启自己)**
- 发现机制:launcher spawn dsh 时注入环境变量 `DSH_LAUNCHER_EXE`(绝对路径)、`DSH_LAUNCHER_PID`、`DSH_LAUNCHER_CONNECTION`(激活连接 id);`launch-token.json` 增加可选字段 `managedBy: "dsh-launcher"`(读取方忽略未知字段,向后兼容)
- 持久注册 `%DSH_HOME%\launcher-registration.json`:**安装即注册、卸载即注销、挪移/升级时更新、运行中写心跳**。内容 `{ version, launcherExe, launcherVersion, dshInstallDir, pid?, api?, bridgeKey?, running, registeredAt, updatedAt }`(pid/api/bridgeKey 为心跳段,随启动/停止刷新);文件 0600,与 launch-token 同规范。环境变量只覆盖 launcher 亲手拉起的 dsh 进程,注册文件让「机器上装了 launcher」成为**任何启动方式都可发现的持久事实**——这是 dsh-launcher 插件在 dsh 非 launcher 拉起时仍能工作的前提;含本机绝对路径,**不进漫游同步**(Phase 4 白名单机制天然排除)。命名注意:与 exe 旁既有的 `launcher.json`(便携配置)是两个文件,互不相干。**心跳策略**:launcher 运行期间每 ≤30s 刷新 `updatedAt`(启停/状态变化即时刷新);消费者判定:距今超过 2× 心跳间隔(≥60s)即视为陈旧,必须以 pid 存在性 + api 健康检查复核,不得仅凭 `running: true` 信任。**便携版路径**:`launcherExe` 记录用户放置 exe 的**原始路径**(经 `PORTABLE_EXECUTABLE_DIR` 解析),绝不记录 Electron 临时解压路径(退出即删);NSIS 版记录安装路径。**实现落点**:`launch.ts` 的 start()(spawn 成功后注册)/stop()(注销),`electron-main.ts` 定时器刷新心跳
- launcher 侧:新增 `restart` 命令 + 托盘/GUI 重启按钮——优雅 stop → 等端口释放 → start → 重抓 token URL → 照写 `launch-token.json`(30 天 cookie 机制下**重启后免手动重登**);CLI `restart` 经单实例检测转交运行中的 launcher(复用其本地 http 服务的 REST bridge,新增 `POST /api/dsh/restart`)
- dsh 侧(配套,跨仓库):会话/技能里的「重启 dsh」动作(如各 install-* 技能的「重启并验证」步骤)按**发现链**委托 launcher——① `DSH_LAUNCHER_EXE` 环境变量 → ② `%DSH_HOME%\launcher-registration.json` 注册(exe 存在性校验;优先调用其 REST bridge,其次 `& <launcherExe> restart` 经单实例转交)→ ③ 都无才提示用户手动重启
- 安全:`POST /api/dsh/restart` 仅绑 127.0.0.1 + 随机共享密钥(写入 `%DSH_HOME%`,0600);激活连接为 remote 时 restart 语义 = 重连/重开浏览器,不重启远端

### Phase 7 — 新机器一条龙向导(把 Ph1–6 串成一条线)
- GUI:双击 exe → 环境检测(缺 Node 自动装)→ 选源(网络/离线包/私有清单)→ 装 core → 勾插件 → 可选拉个人层 → 选/建连接(本机端口或广域网 URL,见 Phase 5)→ `start` + token 自动登录
- CLI 无头版:`dsh-launcher.exe setup --all --manifest <url> --connection <id>` 单命令全自动,适合脚本化部署

### Phase 8 — 多机一致性与回传(远期)
- manifest 锁版本(lock 文件):多台机器收敛到同一版本组合;`check-update` 升级需主动确认后更新 lock
- 状态回传:B 机产生的 watchlist/新装插件 → `profile push` 回源;冲突策略 last-write-wins,profiles 手动合并
- 远期:插件清单开放第三方仓库(生态从「我的插件」长成「社区清单」)
- 远期(独立子阶段,非换个 target 即可):macOS/Linux 构建——进程管理(taskkill/netstat)、隐藏控制台(koffi AllocConsole)、目录选择(PowerShell)均为 Windows 专属,需先抽象平台适配层

## 5. 三种携带形态

| 形态 | 组成 | 适用 |
|---|---|---|
| 纯 exe(最轻) | 只带 launcher.exe,一切从 GitHub/npm 拉 | 有网环境 |
| U 盘离线包 | exe + `offline/`(node.zip、dsh 包、plugins 包) | 无网/内网/企业受限机器 |
| exe + 私有云 | exe + 私有 manifest + 加密个人层(私有仓/网盘) | 多机长期漫游 |

## 6. 里程碑与依赖

| 里程碑 | 内容 | 规模 | 依赖 |
|---|---|---|---|
| M0 | **M1 前置修复**:`clearLaunchToken` 原子化(source+pid 双匹配 + 复读确认,修 P0-4);`launch.ts:184` 日志脱敏 + child log 迁出 %TEMP%(移至 %DSH_HOME% 或退出清理,修 P1-6) | S | 无 |
| M1 | ecosystem.json + `pull` CLI | M | 无(复用 install/子模块;sha256 供应链校验随 M1 落地) |
| M2 | GUI 生态页 | M | M1 |
| M3 | Node 自持 + 离线包 | M | 可与 M2 并行 |
| M4 | profile pack(push/pull + 加密) | M–L | 无强依赖,建议 M1 后 |
| M5 | 多连接启动项(connections.json + 切换 CLI/GUI + launch-token 兼容) | M | 无强依赖,**可提前做**(前提:先定稿 connections.json schema 与 launch-token v1 兼容层设计,无需等 M1/M6) |
| M6 | 托盘常驻 + 重启 seam(Tray 菜单/图标状态 + `restart` + `DSH_LAUNCHER_EXE` 注入) | M | 无强依赖,建议 M5 后(共用连接语义) |
| M7 | setup 向导整合(GUI + `setup --all`) | S | M1–M6 |
| M8 | 版本 lock + 回传 | L | M4 |

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 凭证随同步泄漏 | 红线 D2:排除表硬编码在 launcher 内,push 前强制过滤并复检 |
| launcher 越界写 DSH_HOME 引发信任问题 | D1:只执行插件官方 install.ps1,不自写路径;UI 明示授权 |
| 企业网 GitHub 不通 | 已有 `--proxy`;叠加 M3 离线包 |
| manifest / install.ps1 供应链(P1-7) | 私有清单强制 HTTPS;ecosystem.json 声明每个插件包 sha256、pull 执行前验哈希(随 M1);子模块锁 commit |
| 便携版无法固定任务栏 | 维持 NSIS 安装版互补(现状方案) |
| `connections.json` 明文 token 落盘 | 0600 仅 POSIX 生效,Windows 依赖 NTFS 默认 ACL(对齐 launch-token 现状);排除出一切同步;远期可选 Windows DPAPI;跨平台构建时需重新验证权限语义 |
| 托盘常驻让用户忘记 dsh 仍在运行 | 图标状态色 + 气泡通知明示;「关窗即停」保留为设置项 |
| restart 端点被本地任意进程滥用 | 仅 127.0.0.1 + 随机共享密钥(0600 落盘);CLI 路径校验调用方为自己的子进程树 |
| 插件合并破坏已装环境 | 旧包 deprecated 一个版本周期 + 幂等迁移/卸载脚本;凭证与 settings 在 DSH_HOME 层,不受合并影响 |
| `launcher-registration.json` 被篡改或失效(exe 被移走/卸载残留) | launcher 每次启动**自愈重写**注册;插件调用前校验 exe 存在性与 api 健康;卸载流程清理注册;重启执行走 bridgeKey 校验,不盲信注册路径 |
| 多监督者竞态:token 误删 / 连接漂移(P0-4、竞态场景 2/4) | D8 协调协议:clearLaunchToken source+pid 双匹配原子化、端口锁文件、active 变更广播、共享文件原子写 |
| 中文/空格用户名路径(P2-9) | Node fs 在 Windows 通常正确处理 Unicode 路径;CI 增加中文用户名用例实测验证 |

## 8. 插件体系优化计划(11 → 7)

> 工作仓:dsh-plugins,与 launcher 解耦可独立推进;PM3 依赖 launcher M5/M6 的 seam。

**问题**:11 个插件 = 11 套 install.ps1 + SKILL.md + cordis.patch 条目。感知类(audio-read / audio-speak / describe-image / video-read)与 document-read 全部消费同一把 `MIMO_API_KEY`、同一种「主模型保持 text-only」模式,却拆成 5 个包;deepseek-balance / deepseek-recharge 是两个单工具包共用 `DEEPSEEK_API_KEY`。安装面、补丁冲突面、会话技能列表都被放大。

**合并映射(11 → 7)**:

| 新插件 | 合并自 | 工具数 | 共享凭证 / 模式 |
|---|---|---|---|
| **dsh-media**(新) | audio-read + audio-speak + describe-image + video-read + document-read | 6 = transcribe_audio + understand_audio + speak_text + describe_image + read_video + read_document(音频 2 + 语音 1 + 图 1 + 视频 1 + 文档 1;audio-read 实际注册两个独立工具) | `MIMO_API_KEY` + vision 端点;「text-only 主模型 + 外挂感知/生成」 |
| **dsh-deepseek**(新) | deepseek-balance + deepseek-recharge | 2 | `DEEPSEEK_API_KEY`;账户运维 |
| dsh-credentials | credentials(原样保留) | 4 | 最底层凭证 seam,不与任何包耦合 |
| dsh-github | github(保留) | 8 | 域大,自成一体 |
| dsh-stock | stock(保留) | 9 | 域大,自成一体 |
| dsh-unity | unity-mcp(保留) | 48(MCP 桥) | 外部 MCP,桥接型独立 |
| **dsh-launcher**(新增) | — | 5(见下) | 无新凭证,seam 全在 DSH_HOME 文件与环境变量 |

**dsh-launcher 插件**(把 D6 的 seam 升级为一等工具面——会话里直接说「重启 dsh」「切到广域网」即可执行):
- `launcher_restart` — 按 D6 发现链(环境变量 → `launcher-registration.json` 注册)委托重启;注册存在但 exe 失效/心跳过期时给出重装或重注册指引
- `launcher_status` — launcher / dsh 运行态 + 激活连接 + 端口健康汇总
- `launcher_connections` — 列出 / 切换 `connections.json` 连接组(切换可按需触发重启)
- `launcher_open` — 按连接带 token 打开浏览器
- `launcher_check_update` — 检查 launcher 与 dsh 升级;scope 含**插件版本检测**(对齐 M1 ecosystem-state 的版本漂移),PM3 实现时与 M1 对齐
- 配套安装技能 `install-launcher`;依赖 launcher 侧 M5(connections.json)与 M6(restart API + 环境变量注入)

**分层规范与准入规则**(D7 落地):
1. 分层:基础设施(credentials)/ 感知(media)/ 域工具(github、stock)/ 桥接(unity、launcher)/ 账户(deepseek)
2. 包内多服务,`--only audio,video` 子集安装;工具名统一前缀,合并后零冲突
3. 新插件准入三问:**独立凭证?独立外部系统(MCP)?工具数 ≥8?**——三者皆否,并入既有层。≥8 的依据:工具数越大,API surface 与独立维护成本越高,并入域插件会稀释内聚性(github=8、stock=9 即按此边界保留独立);阈值随实践校准,非硬常数

**迁移与兼容**:
- 旧包保留一个 deprecated 版本周期:新包 `install.ps1` 幂等,附带 `uninstall-old.ps1`(卸载 audio-read 等 7 个旧包);凭证与 settings 在 DSH_HOME 层,合并只动插件包与挂载
- launcher 的 `ecosystem.json`(M1)默认清单直接采用新集合,旧包名作兼容别名

**里程碑(PM)**:

| 里程碑 | 内容 | 规模 | 依赖 |
|---|---|---|---|
| PM1 | 分层规范 + 插件模板重构(install.ps1 `--only` 子集、SKILL.md 模板化) | S | 无 |
| PM2 | dsh-media(5→1)+ dsh-deepseek(2→1)+ 迁移脚本 + 旧包 deprecated 标记 | M | PM1 |
| PM3 | dsh-launcher 插件(5 个工具 + install-launcher 技能) | S | launcher M5/M6 |
| PM4 | ecosystem.json 默认清单切新集合;skills 11→7;dsh-plugins 整体版本化与 launcher 子模块联动 | M | PM2、M1 |
