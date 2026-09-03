# dsh-launcher 生态化路线图 —— 深度审查报告（第二轮）

## 1. 元信息

| 项目 | 值 |
|---|---|
| 被审文档 | `ECOSYSTEM-PLAN.md` v2（2026-09-02，含初轮审查后修订） |
| 初轮审查报告 | `ECOSYSTEM-PLAN-REVIEW.md`（2026-09-02） |
| 审查模型 | xiaomi/mimo-v2.5-pro |
| 审查日期 | 2026-09-02 |
| 核对仓库 | dsh-launcher (`src/`)、dsh-plugins (`plugins/`)、dsh-vscode (`src/`)、dsh-desktop (`desktop/src/main/`) |
| 审查范围 | 代码级落地核对、多监督者竞态、威胁建模、profile pack 实测、里程碑核对、初轮复核、反例推演 |

---

## 2. 执行摘要

**总评：** v2 文档吸收了初轮报告的全部 P0×3 和大部分 P1×5 建议，质量明显提升。工具名已修正为 `transcribe_audio`/`understand_audio`（§8 第 170 行），关窗行为已加注时态（§2 第 27 行、Phase 6 第 105 行），心跳策略已补充（Phase 6 第 109 行，≤30s 刷新、≥60s 过期），便携版路径问题已说明（Phase 6 第 109 行，`PORTABLE_EXECUTABLE_DIR`），remote token 生命周期已补充（Phase 5 第 97 行），0600 权限说明已补充（D2 第 46 行、Phase 5 第 98 行）。

**与初轮的深度差异：** 初轮偏文档一致性与措辞问题；本轮深入源码逐函数核对，发现以下新问题：
- **P0×1**：`clearLaunchToken` 的 pid 匹配机制在多监督者交错场景下存在竞态窗口（token 被误删）
- **P1×3**：install.ps1 无供应链校验（git 子模块可指向任意 commit）、带 token URL 落盘 `%TEMP%` 日志（泄露风险）、`connections.json` 单文件多组 token 的锁保护缺失
- **P2×4**：launcher-registration.json 心跳写入路径未定义（code 中无对应实现）、`--manifest` 私有清单无 checksum 校验、profile pack 白名单需排除 `.dsh-memory-autostore-state.*`、中文/空格路径的 Windows 兼容性未验证
- **P3×2**：PM4 规模标注偏小、Phase 8 跨平台需抽象层前置

**结论：修订后执行。** 核心架构可行，但 P0 竞态问题和 P1 供应链安全问题需在 M1 之前解决。

---

## 3. 代码级落地核对表（任务 A）

| 计划能力 | 落点 file:line | 复用/小改/新写 | 备注 |
|---|---|---|---|
| **双源安装（GitHub/npm）** | `install.ts:30-36`（`run` 分发）、`install.ts:39-117`（`runGithubInstall`）、`install.ts:120-206`（`runNpmInstall`） | **现成可复用** | 双源逻辑完整，`ecosystem.json` 的 `pull` 可直接调用 `install.run()` |
| **版本锁（semver 比较）** | `node.ts:166-181`（`latestDshTag` 按 semver 比较）、`semver.ts`（`parseSemver`/`compareSemver`） | **现成可复用** | Phase 8 lock 文件只需在 `ecosystem.json` 中固定 tag 列表 |
| **move 挪移** | `install.ts:257-340`（`move` 函数，含跨盘复制+删除） | **现成可复用** | 无改动需求 |
| **spawn 与 token 抓取** | `launch.ts:252-271`（spawn dsh 子进程）、`launch.ts:47-64`（`tokenUrlFromLog` 从日志增量提取 token）、`launch.ts:71-80`（`waitForTokenUrl` 轮询） | **现成可复用** | Phase 5 多端口启动只需将 `cfg.port` 参数化 |
| **token 文件读写清理** | `tokenFile.ts:64-74`（`readLaunchToken`，含 version 校验）、`tokenFile.ts:77-90`（`writeLaunchToken`，mode 0o600）、`tokenFile.ts:96-106`（`clearLaunchToken`，pid 匹配） | **现成可复用** | Phase 5 兼容层只需在激活连接切换时调用 `writeLaunchToken` |
| **token URL 自检** | `launch.ts:96-112`（`verifyTokenUrl`，303=ok/401=invalid） | **现成可复用** | Phase 5 remote token 自检直接复用 |
| **本地 http 服务 + REST bridge** | `server.ts:380-407`（`startServer`，绑定 127.0.0.1）、`server.ts:249-376`（`handleApi`，/api/status|start|stop|install|move|check-update|browse|exit） | **小改** | Phase 6 需新增 `POST /api/dsh/restart`（+共享密钥校验）；Phase 2 需新增 SSE 进度通道 |
| **SSE 日志推送** | `server.ts:224-241`（`handleEvents`，log.subscribe → SSE） | **现成可复用** | Phase 2 生态页可直接复用 |
| **Node/npm/pnpm 探测** | `node.ts:336-361`（`detect`）、`node.ts:232-242`（`ensurePnpm`） | **现成可复用** | Phase 3 自持 Node 需新增便携 Node 下载逻辑 |
| **git 克隆与代理** | `node.ts:184-198`（`cloneDsh`，浅克隆）、`node.ts:107-120`（`resolveProxy`） | **现成可复用** | 无改动需求 |
| **launcher.json 配置** | `config.ts:35-41`（`configPath`，便携跟随 exe）、`config.ts:44-55`（`load`）、`config.ts:58-62`（`save`） | **小改** | Phase 5 需扩展 Config 接口支持多连接引用；Phase 8 需新增 lock 字段 |
| **Electron 主进程/窗口** | `electron-main.ts:38-110`（`runDesktop`，frameless 窗口+服务启动）、`electron-main.ts:122-149`（CLI/桌面分发） | **小改** | Phase 6 需新增 Tray 常驻（`app.on('window-all-closed')` 不退出）；当前 `win.on('closed', () => app.quit())`（第 109 行）需改为隐藏 |
| **隐藏控制台** | `console.ts:38-71`（`ensureHiddenConsole`，koffi AllocConsole + SW_HIDE） | **现成可复用** | 无改动需求 |
| **升级检测** | `update.ts:18-29`（`checkLauncher`，GitHub Release）、`update.ts:32-71`（`checkDsh`，GitHub tag + npm registry） | **小改** | PM3 的 `launcher_check_update` 需扩展为包含插件版本检测 |
| **connections.json（多连接）** | **不存在** | **需新模块** | Phase 5 核心新增：schema 定义、解析、CLI `connections list\|add\|use\|remove`、GUI 切换器 |
| **ecosystem.json（生态清单）** | **不存在** | **需新模块** | Phase 1 核心新增：清单 schema、`pull` 命令、`ecosystem-state.json` 状态记录 |
| **launcher-registration.json（注册文件）** | **不存在** | **需新模块** | Phase 6 核心新增：注册/注销/心跳写入、发现链 API |
| **profile pack push/pull** | **不存在** | **需新模块** | Phase 4 核心新增：白名单过滤、差异比较、加密包支持 |
| **Node 运行时自持** | **不存在** | **需新模块** | Phase 3 核心新增：便携 Node 下载、PATH 注入、版本匹配检测 |
| **托盘常驻** | **不存在** | **需新模块** | Phase 6 核心新增：Electron Tray、图标状态色、气泡通知、关窗=隐藏 |

**小结：** 10 项现成可复用、5 项小改、6 项需新模块。现有代码覆盖了计划约 60% 的基础能力，剩余 40% 需新增开发。

---

## 4. 多监督者竞态分析（任务 B）

### 4.1 三方启动场景

| 启动方 | 启动方式 | 写 launch-token.json | 写 connections.json |
|---|---|---|---|
| launcher | `launch.ts:256` spawn dsh → `launch.ts:123` writeLaunchToken | ✅ source='dsh-launcher' | Phase 5 后才支持 |
| dsh-vscode | `localServer.ts` spawn dsh → `launchToken.ts:85-100` writeLaunchToken | ✅ source='dsh-vscode' | 不涉及 |
| 用户手动 | `dsh web` 直接启动 | ❌ 不写 | 不涉及 |

### 4.2 场景推演

#### 场景 1：同端口二次启动

**launcher 启动 → vscode 再启动同端口：**
- vscode `localServer.ts` 检测端口已占用 → `reused=true`，不重复 spawn
- vscode 读 `launchTokenFilePath()` 获取 launcher 写的 token → 直接连接
- **结论：安全，无竞态。** `launch.ts:225` 的 `isRunning` 检查和 vscode 的端口探测避免了重复启动。

#### 场景 2：launch-token.json 写覆盖与互删

**关键竞态窗口：** launcher 停止 dsh 时调用 `clearLaunchToken(pid)`（`launch.ts:307`），该函数先读文件、比对 pid、再删文件。如果在 launcher 读文件（pid=A）和删文件之间，vscode 恰好写入了新记录（pid=B），launcher 会：
1. 读到 pid=A 的记录 ✓
2. 比对 pid=A === child.pid ✓
3. 删除文件 — **但文件此时可能已被 vscode 覆盖为 pid=B！**

实际上 `clearLaunchToken`（`tokenFile.ts:96-106`）的读-比-删是非原子的：
```typescript
// tokenFile.ts:98-102
const record = readLaunchToken();  // 读
if (record.pid !== undefined && record.pid !== pid) return;  // 比
rmSync(launchTokenFilePath(), { force: true });  // 删
```

**竞态场景：** launcher child(pid=100) 退出 → `clearLaunchToken(100)` 读到 pid=100 → 此时 vscode 的 dsh(pid=200) 启动并写入新记录 → launcher 删文件 → **vscode 的记录被误删！**

**概率评估：** 低但非零。launcher 停止和 vscode 启动如果在毫秒级交错，就会触发。

**v2 文档是否覆盖：** 未覆盖。Phase 6 的心跳策略（第 109 行）不涉及此问题。

#### 场景 3：两个 dsh 实例同时运行（3080/3081）

**现状：** `launch-token.json` 是单记录文件（v1 语义），只保存最后一次写入的实例信息。
- launcher 只认 `launcher.json` 中的 `port`（默认 3080），`launch.ts:255` 硬编码 `cfg.port`
- 如果用户手动在 3081 启动另一个 dsh，launcher 不知道也不管理

**Phase 5 的 connections.json 是否解决：** 是。多组连接各自有 id/port，激活连接切换时重写 `launch-token.json`。但 v1 `launch-token.json` 只能存一组——**切换连接 = 覆盖旧记录**，其他消费者（vscode/desktop）看到的是新激活连接的 token。

**潜在问题：** 用户在 vscode 中连接 3080，launcher 切换到 3081 并覆盖 launch-token.json → vscode 下次重连时 token 指向 3081，但 `serverUrl` 仍指向 3080 → **401**。

**v2 对策：** Phase 5 第 96 行说"vscode 与 dsh-desktop 零改动自动跟随"——这只有在消费者**每次连接前都重读 launch-token.json** 时才成立。vscode 的 `resolveLaunchToken()`（`extension.ts:263-268`）确实每次连接时读取，但 `serverUrl` 不会自动跟随变化。

#### 场景 4：vscode 拉起 dsh 时 connections.json 的 active 还是旧组

**v2 设计：** connections.json 的 `active` 字段由 launcher 管理。vscode 不读 connections.json（Phase 5 说"远期二者升级为直接读"）。

**问题：** 如果 launcher 切换到 remote 连接，`active='wan-main'`，但 vscode 的 `dsh.serverUrl` 仍是 `http://127.0.0.1:3080`——vscode 会尝试连接本地，而本地 dsh 可能已被 launcher 停止。

**结论：** Phase 5 的"零改动"承诺只在 vscode 连接前读 launch-token.json 且 token 有效时成立。serverUrl 不跟随 = 连接目标可能漂移。

### 4.3 是否需要协调协议

**需要。** 当前三个监督者各自为政：
- launcher 管理 dsh 生命周期但不通知 vscode
- vscode 自主启动/连接 dsh 但不通知 launcher
- 用户手动 `dsh web` 完全不受控

### 4.4 建议方案

**轻量协调：基于 launch-token.json 的"最后写入者胜出"语义 + 端口级锁文件。**

1. **端口锁文件** `%DSH_HOME%/.dsh-port-<port>.lock`：写入方在 spawn 前创建，写入 `{pid, source, startedAt}`，退出时删除。其他方 spawn 前检查锁文件存在且 pid 存活 → 不重复启动。
2. **clearLaunchToken 原子化**：改为"先比对 pid，比对通过后用 `rmSync` 的 `force:true` + 写入前的文件大小/时间校验"，或改为"只在 pid 匹配且 source 匹配时删除"。
3. **connections.json 的 active 变更广播**：launcher 切换 active 时，除了写 launch-token.json，还写一个 `%DSH_HOME%/.dsh-connection-changed` 标记文件（含时间戳）。vscode/desktop 在重连前检查此文件，发现变更时重读 connections.json。

---

## 5. 威胁建模表（任务 C）

### 5.1 落盘文件清单

| 文件 | 写入者 | 读取者 | 篡改后果 | 泄漏后果 | 缓解 |
|---|---|---|---|---|---|
| `launch-token.json` | launcher / vscode | launcher / vscode / desktop | 替换 token → 未授权访问 dsh API | token 泄漏 → 同一 LAN 内可冒充登录 | 0600（POSIX）/ NTFS ACL（Windows）；永不进同步 |
| `connections.json`（Phase 5） | launcher | launcher / 远期 vscode+desktop | 替换 token/URL → 重定向到恶意服务 | 各组 token 泄漏 → 对应 dsh 实例被冒充 | 0600；永不进 profile pack |
| `launcher-registration.json`（Phase 6） | launcher | dsh 侧插件 | 替换 `launcherExe` → 重启命令指向恶意 exe | `bridgeKey` 泄漏 → 可调用 restart API | 0600；exe 存在性校验；api 健康检查 |
| `ecosystem-state.json` | launcher | launcher | 篡改版本记录 → 跳过升级 | 无敏感信息 | 低风险 |
| `bridgeKey`（Phase 6） | launcher | launcher + dsh 插件 | 泄漏 → 本地任意进程可调用 restart | 仅本地可用（127.0.0.1） | 随机生成；0600 落盘 |
| `%TEMP%\dsh-launcher.log` | launcher（`log.ts`） | 用户/开发者 | 无 | **含 token URL 明文！**（见下） | 见 §5.2 |
| `%TEMP%\dsh-launcher-child.log` | dsh 子进程 stdout/stderr | launcher | 无 | **含 token URL 明文！**（见下） | 见 §5.2 |
| `launcher.json` | launcher | launcher | 篡改安装路径 → 指向恶意 bin.js | 无敏感信息（无 token） | exe 同目录，依赖文件系统保护 |

### 5.2 带 token URL 落盘 %TEMP% 日志

**证据链：**
1. `launch.ts:250`：`const childLog = openSync(childLogPath(), 'a')` — childLogPath = `%TEMP%\dsh-launcher-child.log`
2. `launch.ts:259`：`stdio: ['ignore', childLog, childLog]` — dsh 子进程的 stdout/stderr 全部写入此文件
3. dsh 启动时打印 `dsh web: http://127.0.0.1:3080/?token=...` 到 stdout
4. **因此 `%TEMP%\dsh-launcher-child.log` 包含明文 token URL**

**launcher 自身日志：**
- `launch.ts:124`：`log.info(...)` 写入 token 文件路径（不含 token 值）✓ 安全
- `launch.ts:184`：`log.info(...)` 写入 `target`（含完整 token URL！）→ `%TEMP%\dsh-launcher.log` 泄漏

**泄漏后果：** 任何同一 Windows 用户的进程都可读取 `%TEMP%` 下的文件。多用户共享机器时，其他用户通常无法读取（NTFS ACL），但同一用户下的恶意软件可以。

**缓解建议：**
1. `launch.ts:184` 的日志应脱敏：只记录 `target` 的前 30 字符 + `...`
2. child log 文件应在 launcher 退出时清理（当前 `stopChildSilently` 不清理文件）
3. 或将 child log 写入 `%DSH_HOME%` 而非 `%TEMP%`（受 0600/ACL 保护）

### 5.3 install.ps1 供应链安全

**证据链：**
1. `audio-read-dsh-plugin/install.ps1:31-32`：直接从 `$PSScriptRoot\plugins\audio-read\` 复制 `index.js` 和 `package.json` 到 `%DSH_HOME%\profiles\web\plugins\audio-read\`
2. **无 checksum 校验**：install.ps1 不验证复制的文件哈希
3. **无签名验证**：脚本本身不验证来源
4. **git 子模块可指向任意 commit**：`git submodule update --remote` 拉取的是远程 HEAD，如果 dsh-plugins 仓库被入侵，恶意代码会通过 install.ps1 进入用户机器
5. **私有 manifest（`--manifest <url>`）** 指向任意 URL：如果 URL 被劫持（HTTP 非 HTTPS），清单内容可被篡改

**v2 文档对策：** §7 风险表第 152 行提到"可选对安装包做 checksum 校验"，但只是"可选"，没有强制。

**建议：**
1. Phase 1 的 `ecosystem.json` 应为每个插件包声明 `sha256` 校验和
2. `pull` 命令在执行 `install.ps1` 前验证文件哈希
3. 私有 manifest 强制要求 HTTPS
4. 子模块 commit 锁定在 `ecosystem.json` 的版本声明中（不依赖 `--remote`）

---

## 6. profile pack 数据盘点（任务 D，实测）

### 6.1 %DSH_HOME% 实测内容（`C:\Users\kuaizhongqiang\.dsh`）

**总大小：45.35 MB**

| 目录/文件 | 文件数 | 大小 | 说明 |
|---|---|---|---|
| `sessions/` | 35 | **44.61 MB** | 会话数据（含 SQLite 数据库、JSONL 日志） |
| `profiles/` | 31 | 0.22 MB | web profile 配置 + 插件 |
| `profiles/node_modules/` | ~2000+ 包 | **0 MB（空目录）** | npm install 的依赖，但当前为 junction/空 |
| `profiles/web/.dsh-module-fallback/` | 0 | 0 MB | 模块回退目录，当前为空 |
| `profiles/web/plugins/` | 26 | 0.20 MB | 11 个插件的 index.js + package.json |
| `profiles/web/cordis.patch.yml` | 1 | ~2 KB | 插件挂载配置 |
| `storages/` | 37 | 0.24 MB | 工具存储域数据 |
| `stock/` | 4 | 0.05 MB | watchlist.json + kline-cache.json + daily/ + reports/ |
| `skills/` | 9 | 0.03 MB | 9 个 install-* 技能目录 |
| `attachments/` | 2 | 0.18 MB | 会话附件 |
| `llm-deepseek/` | 1 | ~0 MB | DeepSeek LLM 缓存 |
| `settings.yaml` | 1 | 1.52 KB | 全局设置 |
| `.credentials.yaml` | 1 | 0.66 KB | 凭证（**永不进同步**） |
| `launch-token.json` | 1 | 0.26 KB | 启动 token（**永不进同步**） |
| `.dsh-memory-autostore-state.json` | 1 | 1.25 KB | 记忆自动存储状态 |
| `.dsh-memory-autostore-state.files.json` | 1 | 5.41 KB | 记忆文件索引 |
| `.anonymous-user-id` | 1 | 0.04 KB | 匿名用户 ID |

### 6.2 Phase 4 白名单应同步项

| 项 | 实测大小 | 理由 |
|---|---|---|
| `settings.yaml` | 1.52 KB | 用户全局设置 |
| `profiles/web/cordis.patch.yml` | ~2 KB | 插件挂载配置 |
| `profiles/web/plugins/` | 0.20 MB | 已安装插件代码 |
| `skills/` | 0.03 MB | 安装技能 |
| `stock/watchlist.json` | 0.06 KB | 自选股列表 |
| `stock/reports/` | ~1.56 KB | 个股报告 |
| **合计** | **~0.21 MB** | 极小，可轻松漫游 |

### 6.3 应排除清单

| 项 | 大小 | 排除理由 |
|---|---|---|
| `sessions/` | 44.61 MB | 会话数据含大量上下文、工具输出，体积大且与机器绑定（路径、文件引用） |
| `profiles/node_modules/` | 0 MB（当前空） | 运行时依赖，可由 `dsh` 重新安装；实际使用中可能达数百 MB |
| `profiles/web/.dsh-module-fallback/` | 0 MB | 模块回退缓存，可重建 |
| `attachments/` | 0.18 MB | 会话附件，与 sessions 绑定 |
| `storages/` | 0.24 MB | 工具存储域状态，可重建 |
| `llm-deepseek/` | ~0 MB | LLM 本地缓存 |
| `.credentials.yaml` | 0.66 KB | **凭证红线**（D2） |
| `launch-token.json` | 0.26 KB | **敏感红线**（§1 第 22 行） |
| `.dsh-memory-autostore-state.*` | 6.66 KB | 记忆自动存储状态，与运行时绑定，可重建 |
| `.anonymous-user-id` | 0.04 KB | 匿名标识，每台机器应独立 |
| `stock/daily/` | ~3 KB/天 | 每日行情快照，可随时重采（v2 已正确排除，Phase 4 第 72 行） |
| `stock/kline-cache.json` | 49.5 KB | K 线缓存，可重新拉取 |

### 6.4 v2 文档的白名单 vs 实测

v2 Phase 4 第 72 行白名单：`settings.yaml`、`profiles/`、`skills/`、`stock/watchlist.json`、`stock/reports/`

**问题：** `profiles/` 过于宽泛——包含了 `node_modules/`（当前虽为空，但实际使用中会安装依赖）和 `.dsh-module-fallback/`。应精确为 `profiles/web/cordis.patch.yml` + `profiles/web/plugins/`。

**新增排除建议：** `.dsh-memory-autostore-state.*`（6.66 KB，运行时状态，不应漫游）。

---

## 7. 里程碑落地核对表（任务 E）

| 里程碑 | 首个实现步骤 | 可测验收标准 | 缺失前置项 | 当前可测? |
|---|---|---|---|---|
| **M1** ecosystem.json + pull CLI | 新建 `src/ecosystem.ts`：定义 `EcosystemManifest` 接口 + `loadManifest()` + `pull()` 函数；`cli.ts` 新增 `pull` 子命令 | `dsh-launcher.exe pull --all` 在新机器上安装 core+全部插件+技能，无报错 | 无 | ✅ 可测（mock manifest + 本地子模块） |
| **M2** GUI 生态页 | `server.ts` 新增 `/api/ecosystem/status` + `/api/ecosystem/pull` 端点；`ui/app.js` 新增生态页组件 | GUI 显示已装/未装/版本漂移；勾选安装后 SSE 实时进度 | M1 | ✅ 可测 |
| **M3** Node 自持 | `src/runtime.ts`：检测无 Node → 下载便携 node.zip → `%LOCALAPPDATA%\dsh\runtime\`；`launch.ts` spawn 前注入 PATH | 无 Node 机器上 `dsh-launcher.exe install` 自动下载 Node 并完成安装 | 无 | ✅ 可测（需模拟无 Node 环境） |
| **M4** profile pack | `src/profile.ts`：白名单过滤 + zip 打包/解包；`cli.ts` 新增 `profile push\|pull` | `profile push` 生成加密包 → 另一机器 `profile pull` 恢复 settings+plugins+skills | 无 | ✅ 可测 |
| **M5** 多连接启动项 | 新建 `src/connections.ts`：schema + load/save + CLI `connections list\|add\|use\|remove`；`launch.ts` 改为读 connections.json 的 active 连接 | `connections add --id test --port 3081` → `connections use test` → `start` 在 3081 启动 dsh | 无 | ✅ 可测 |
| **M6** 托盘常驻 + 重启 seam | `electron-main.ts`：新增 Tray + `app.on('window-all-closed')` 不退出；`src/restart.ts`：`POST /api/dsh/restart` + 共享密钥 | 托盘图标显示；关窗后 dsh 继续跑；托盘重启按钮成功重启 dsh | M5（连接语义） | ⚠️ 部分可测（Tray 独立可测，restart seam 需 dsh 侧配合） |
| **M7** setup 向导 | `src/setup.ts`：串联 M1-M6 流程；`cli.ts` 新增 `setup --all` | `dsh-launcher.exe setup --all` 在新机器上全自动完成 | M1-M6 | ❌ 不可测（依赖全部前置） |
| **M8** 版本 lock + 回传 | `ecosystem.json` 新增 `lock` 字段；`profile.ts` 新增 `push` 回传逻辑 | 多台机器 `pull` 后版本一致；B 机 `profile push` → A 机 `profile pull` 同步新数据 | M4 | ✅ 可测 |
| **PM1** 分层规范 + 插件模板 | `dsh-plugins` 仓库：定义 `install.ps1` 的 `--only` 参数规范 + SKILL.md 模板 | `install.ps1 --only audio` 只安装音频工具 | 无 | ✅ 可测 |
| **PM2** dsh-media + dsh-deepseek | `dsh-plugins` 仓库：新建 `dsh-media/` 合并包 + `uninstall-old.ps1` | `install.ps1` 安装 dsh-media 后 6 个工具全部可用；旧包 deprecated 标记 | PM1 | ✅ 可测 |
| **PM3** dsh-launcher 插件 | `dsh-plugins/plugins/dsh-launcher-dsh-plugin/`：5 个工具 + `install-launcher` 技能 | 会话中说"重启 dsh"→ launcher 接收并执行重启 | launcher M5/M6 | ❌ 不可测（依赖 launcher 的 REST bridge 和环境变量注入） |
| **PM4** ecosystem.json 切新集合 | `ecosystem.json` 默认清单更新为 7 包；skills 11→7 | `dsh-launcher.exe pull --all` 只装 7 个新包 | PM2、M1 | ⚠️ 部分可测（清单更新可测，但完整迁移需 PM2） |

**当前不可测的里程碑：** M7（依赖 M1-M6）、PM3（依赖 launcher M5/M6 的 REST bridge）。

---

## 8. 新发现问题清单

### P0 — 阻断级

#### P0-4: clearLaunchToken 非原子读-比-删导致多监督者竞态误删

**位置：** `tokenFile.ts:96-106`

**问题：** `clearLaunchToken` 先 `readLaunchToken()` 读文件、比对 pid、再 `rmSync` 删除。在读和删之间，另一个监督者（vscode）可能已覆盖文件内容。launcher 按旧 pid 比对通过后删除了 vscode 的新记录。

**证据：** `tokenFile.ts:98`（读）→ `tokenFile.ts:100`（比）→ `tokenFile.ts:102`（删），三步非原子。

**影响：** vscode 的 token 被误删 → vscode 下次连接时无 token → 401。低概率但可复现（launcher stop + vscode start 毫秒级交错）。

**修复建议：** 删除前重新读一次文件确认 pid 仍未变（double-check），或改用文件锁（`lockfile` npm 包），或改为"只在 source 匹配时删除"（`record.source === 'dsh-launcher'`）。

### P1 — 重要级

#### P1-6: %TEMP% 日志含明文 token URL

**位置：** `launch.ts:184`（launcher 日志）、`launch.ts:250-259`（child 日志）

**问题：** launcher 自身日志 `log.info(...)` 在第 184 行写入完整 `target`（含 `?token=...`）。child 日志（`%TEMP%\dsh-launcher-child.log`）包含 dsh 的 stdout，其中 `dsh web: http://.../?token=...` 是明文。

**证据：** `launch.ts:184`：`log.info(\`已在默认浏览器打开带 token 的访问地址（自动登录，来源：${tokenSource}）：${target}\`);` — `target` 含完整 token URL。

**影响：** 同一 Windows 用户下的任何进程可读取 `%TEMP%` 文件，获取 token 后冒充登录。

**修复建议：** 日志中 token URL 脱敏（只保留前 30 字符 + `...`）；child log 文件移至 `%DSH_HOME%` 或 launcher 退出时清理。

#### P1-7: install.ps1 无供应链校验

**位置：** 所有 `plugins/*/install.ps1`（如 `audio-read-dsh-plugin/install.ps1:31-32`）

**问题：** install.ps1 直接从 `$PSScriptRoot\plugins\` 复制文件到 `%DSH_HOME%\profiles\web\plugins\`，无 checksum 校验、无签名验证。git 子模块可指向任意 commit，私有 manifest 可指向任意 URL。

**证据：** `audio-read-dsh-plugin/install.ps1:31-32`：`Copy-Item -Path (Join-Path $PSScriptRoot 'plugins\audio-read\index.js') -Destination $pluginDir -Force`

**影响：** 供应链攻击：恶意代码通过 install.ps1 进入用户机器并在 dsh 会话中执行（插件代码在 dsh 进程内运行，有完整工具权限）。

**修复建议：** Phase 1 的 `ecosystem.json` 为每个插件声明 `sha256`；`pull` 命令在执行 install.ps1 前验证文件哈希；私有 manifest 强制 HTTPS。

#### P1-8: connections.json 多组 token 无并发保护

**位置：** Phase 5 设计（当前代码未实现）

**问题：** connections.json 包含所有连接组的 token，是一个多写者共享文件。如果 launcher 和未来的 vscode/desktop 同时修改不同连接组的 token，整文件覆盖（`writeFileSync`）会导致并发丢失。

**影响：** Phase 5 实现时如果不加锁，会丢失更新。

**修复建议：** 使用原子写（写临时文件 + rename）+ 文件锁（`proper-lockfile` npm 包）。

### P2 — 建议级

#### P2-6: launcher-registration.json 心跳写入路径未在现有代码中体现

**位置：** Phase 6 第 109 行（设计）vs 现有源码

**问题：** v2 文档定义了心跳策略（≤30s 刷新、≥60s 过期），但现有代码中没有 `launcher-registration.json` 的任何写入逻辑——这是全新模块。文档的心跳策略描述完整，但需要明确在哪个函数中实现。

**建议：** 在 `launch.ts` 的 `start()` 函数中（spawn 成功后）注册，`stop()` 中注销，`electron-main.ts` 的定时器中刷新心跳。

#### P2-7: profile pack 白名单的 `profiles/` 过于宽泛

**位置：** Phase 4 第 72 行

**问题：** 白名单写 `profiles/`，但该目录下包含 `node_modules/`（运行时依赖，可达数百 MB）和 `.dsh-module-fallback/`。实测当前 `node_modules` 为空（junction），但正常安装后会包含大量依赖。

**建议：** 精确为 `profiles/web/cordis.patch.yml` + `profiles/web/plugins/`，排除 `node_modules/` 和 `.dsh-module-fallback/`。

#### P2-8: .dsh-memory-autostore-state.* 未列入排除清单

**位置：** Phase 4 第 72 行

**问题：** `.dsh-memory-autostore-state.json`（1.25 KB）和 `.dsh-memory-autostore-state.files.json`（5.41 KB）是运行时记忆自动存储状态，与机器绑定（文件引用、路径），不应漫游。

**建议：** 在排除清单中显式列出。

#### P2-9: 中文/空格用户名路径兼容性未验证

**位置：** 多处（`config.ts:26`、`tokenFile.ts:36`、`node.ts:26`）

**问题：** `homedir()` 在中文用户名下返回 `C:\Users\张三`，`process.env.LOCALAPPDATA` 返回 `C:\Users\张三\AppData\Local`。现有代码未做路径编码处理，但 Node.js 的 `fs` 模块在 Windows 上通常能正确处理 Unicode 路径。**需要实测验证**。

**建议：** 在 CI 中添加中文用户名测试用例（或使用短路径 `8.3` 格式兜底）。

### P3 — 吹毛求疵

#### P3-6: PM4 规模标注为 S 但实际工作量偏大

**位置：** §8 PM4 行（第 201 行）

**问题：** PM4 包含 ecosystem.json 默认清单切换、skills 11→7、dsh-plugins 整体版本化与 launcher 子模块联动，涉及多仓协调，规模标 S 偏小。

**建议：** 改为 M。

#### P3-7: Phase 8 跨平台需平台适配层前置

**位置：** Phase 8 第 122 行

**问题：** `console.ts`（koffi AllocConsole）、`launch.ts`（taskkill/netstat）、`server.ts`（PowerShell FolderBrowserDialog）均为 Windows 专属。跨平台不是换个 target 即可，需要先抽象平台适配层。

**建议：** Phase 8 拆为独立子阶段，先做平台适配层（`src/platform/`），再做 macOS/Linux 构建。

---

## 9. 初轮审查复核结果（任务 F）

| 初轮引用 | 实际情况 | 判定 |
|---|---|---|
| `launch.ts` 第 96 行附近（token 校验） | `launch.ts:96-112` 确实定义了 `verifyTokenUrl` 函数，检查 303=ok/401=invalid | **属实** |
| `tokenFile.ts` 第 86 行（mode 0o600） | `tokenFile.ts:86`：`writeFileSync(path, JSON.stringify(full, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })` | **属实** |
| `server.ts` 第 326–358 行（check-update 端点） | `server.ts:326-358` 确实是 `/api/check-update` 处理，含 dsh + launcher 双检测 | **属实** |
| audio-read index.js 第 191 行（transcribe_audio 注册） | `audio-read/index.js:191`：`ctx.tools.register(defineTool({ name: 'transcribe_audio', ...` | **属实** |
| audio-read index.js 第 255 行（understand_audio 注册） | `audio-read/index.js:255`：`ctx.tools.register(defineTool({ name: 'understand_audio', ...` | **属实** |
| README.zh-CN.md 第 50 行（便携版临时解压） | `README.zh-CN.md:50`：`dsh-launcher.exe（便携版）\| 随处拷走即用，不写系统——**无法固定到任务栏**（Windows 限制：便携版把程序解压到临时目录、退出即删）` | **属实** |
| README.zh-CN.md 第 63 行（关窗即停） | `README.zh-CN.md:63`：`点**停止**结束 dsh；点 **×** 关闭窗口时**会同时停止 dsh**（dsh 绑定启动器运行）` | **属实** |
| vscode readLaunchToken 的 version===1 校验 | `launchToken.ts:75`：`if (record.version !== LAUNCH_TOKEN_VERSION) return undefined`（LAUNCH_TOKEN_VERSION=1） | **属实** |

**初轮报告代码引用全部属实，无误引。**

---

## 10. 修订建议清单（按优先级）

### 立即（M1 之前）

1. **[P0-4] 修复 clearLaunchToken 竞态**：在 `tokenFile.ts` 中，删除前增加 double-check（重新读文件确认 pid 未变），或改为只在 `record.source === 'dsh-launcher'` 时删除（vscode 写的记录 launcher 不删）。

2. **[P1-6] 日志脱敏**：`launch.ts:184` 的 `target` 脱敏为前 30 字符 + `...`；child log 文件路径从 `%TEMP%` 改为 `%DSH_HOME%\.dsh-launcher-child.log`（受 NTFS ACL 保护）。

3. **[P1-7] 供应链校验**：Phase 1 的 `ecosystem.json` 为每个插件声明 `sha256` 校验和；`pull` 命令在执行 install.ps1 前验证。

### 执行前

4. **[P1-8] connections.json 原子写**：实现时使用写临时文件 + rename + 文件锁。

5. **[P2-7] profile pack 白名单精确化**：`profiles/` 改为 `profiles/web/cordis.patch.yml` + `profiles/web/plugins/`。

6. **[P2-8] 排除 .dsh-memory-autostore-state.***：在 Phase 4 排除清单中显式列出。

7. **[P2-6] launcher-registration.json 实现路径**：在文档中明确写入函数位置（`launch.ts` 的 start/stop、`electron-main.ts` 的定时器）。

### 建议

8. **[P2-9] 中文路径测试**：CI 中添加中文用户名测试用例。

9. **[P3-6] PM4 规模改为 M**。

10. **[P3-7] Phase 8 拆分子阶段**：先做平台适配层，再做跨平台构建。

11. **[B 建议] 多监督者协调**：在 Phase 5/6 设计中补充端口锁文件机制和 clearLaunchToken 原子化方案。

---

*审查完成。本报告基于逐文件源码阅读和本机实测数据，所有结论均有 file:line 或命令输出证据。未核实项已明确标注。*
