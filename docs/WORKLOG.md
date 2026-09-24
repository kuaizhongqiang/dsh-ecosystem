# dsh-launcher 生态计划 —— 工作日志

## 2026-09-24(已发 v0.11.5 —— launcher 插件适配 dsh 0.1.7 + Linux/macOS 安装器)

- **版本与发布**:四处组件 `0.11.4 → 0.11.5`;插件源重钉 `da74a66`(已用 `git cat-file -t` 与
  `git show --stat` 核验该 sha 真实且含插件改动);tag `v0.11.5` 的 CI **7 个 job 全绿**;
  npm:`@kuaizhongqiang/dsh-cli@0.11.5`;资产含 `dshcli-linux-x64` / `dshcli-0.11.5-linux-x64` 等。
- **发现方式值得复用**:没有直接重启，而是**先用桩直接 `apply()` 插件** —— 于是发现 launcher 插件在
  dsh 0.1.7 上**加载即抛错**:`JsonSchemaError: schema.properties.state.additionalProperties must be
  explicitly true or false`(0.1.7 的 "deny incompatible bundles" 加固要求 object 显式声明
  additionalProperties)。**若当时直接重启，插件加载失败会连累整个 profile**——本机根本没装过这个
  插件，所以它从未在 0.1.7 上被加载过，这个雷一直埋着。
  → **教训/新 SOP**:升级本体后、装或启用任何插件前，先 `dsh --profile web --dump-config` 看组合，
  再**用桩 apply() 验加载**;不要拿生产实例试错(重启会连累整棵 profile 树)。
- **第二个真 bug(Windows 同样存在)**:插件第 16 行只 import `{ execFile, spawn }`，但
  `probeCliVersion()` 与 `installCliSkill()` 用的是 `spawnSync` → ReferenceError 被各自 try/catch
  吞掉:技能说明永远落不了盘、装完记下的版本是"来源字符串"而不是真实版本
  (实测 `skillReason="spawnSync is not defined"`、version 记成 `/tmp/dshcli-linux-dl`)。补 import 即好。
- **Linux / macOS 安装器**:新增 `install.sh`(POSIX，与 `install.ps1` 等价):装/卸载、幂等、
  `--profile` / `DSH_HOME` 可指定;写 patch 后调 `validate-patch.mjs` 校验，不过则**非零退出**
  (不让人带着坏 patch 去重启)。README 与 `install-launcher` 技能补平台段落与非 Windows 能力边界。
- **`validate-patch.mjs` 认不出 0.1.7 的新 patch 形态**:升级后 profile patch 里多了**扁平行**
  (`{id,name,config}`，不裹 `insert:`)——设置迁移(`ui-*`/`permission`/`llm-pi-ai`/`agent-default-model`)
  就是这么写进去的。老校验器要求"每条必须是单键 insert"，对升级后的 profile **全线误报 FAIL**
  (实测 6 条)。现在两种形态都接受，并分别列出 insert / direct row。
- **本机验收(桩直调 `launcher_cli`)**:status / install(`from` 本地) / update 三条路径均正确 ——
  Linux 资产名解析出 `…/releases/download/v9.9.9/dshcli-9.9.9-linux-x64`、装完 `chmod 755`、
  sha256 与发布资产一致(`0ff818a1…`)、update 同版本不重装、state 记 `platform: linux`;
  `launcher_status` 在无 launcher 时优雅降级、`launcher_restart` 给出明确手动指引。
- **运维事实(值得记)**:dsh **0.1.7 下服务端 profile 补丁不热重载** —— 本机 profile 仍写着
  `patchReload: live`，但装完插件数分钟后工具仍不出现，日志里**没有任何重载记录**;必须重启 web 实例。
  这与 launcher 把 `patchReload` 钉成 `startup`(issue #52)是同一结论。

## 2026-09-24(已发 v0.11.4 —— dsh-cli 首个 Linux 单文件产物 + 修 `run` 必失败的真 bug)

- **版本与发布**:四处组件 `0.11.3 → 0.11.4`;插件源重钉 `92b752c`;tag `v0.11.4` 的 CI **7 个 job 全绿**
  (新增 `Build dsh-cli (Linux single-file)` 的 ubuntu job)。资产:`dshcli-linux-x64` /
  `dshcli-0.11.4-linux-x64`(126,749,888 B,两个资产 sha256 一致 `0ff818a1…`)、
  `dshcli.exe` / `dshcli-0.11.4.exe`(**旧名保持不变**,93,824,000 B)、launcher / desktop / vscode 各资产;
  npm:`@kuaizhongqiang/dsh-cli@0.11.4`(dist-tag `latest` 已切)。
- **真 bug(本次主线)**:SEA 自包含产物里 `process.execPath` 指向 **dshcli 自己**、不是 node。而
  `findDshBin()` 的 npm-shim 候选写成 `{ command: process.execPath, args: [bin.js] }`,于是实际执行的是
  `dshcli <bin.js>` → 「未知命令:…/lib/bin.js」→ **`dshcli run` 必然 failed**(而 `version`/`tools`/`doctor`
  全部正常,属最难发现的那类)。**Windows 的 `dshcli.exe` 同样中招**,这不是 Linux 独有的问题。
  本机复现证据:`task-7fb85e16` `status=failed` / `error.code=exit_nonzero`。
  修法:新增 `isNodeInterpreter()`(按 `--version` 形状判定——node 输出 `v22.x.y`、dshcli 输出 `dshcli: x.y.z`)
  与 `findNodeInterpreter()`(优先 `process.execPath`,否则退回 PATH 上的 node);拿不到真 node 时**整条候选作废**,
  让报错回到「未找到 dsh 可执行文件」,不再伪装成「未知命令」。
- **Linux 单文件产物(原先只有 Windows)**:`build-exe.mjs` 导出 `platformTag()`,非 Windows 产出显式平台名
  `dshcli-linux-x64` / `dshcli-<ver>-linux-x64`;Windows 资产名**刻意为不变**(既不打断老消费者、也不重复上传
  94MB×2);`release.yml` 新增 `dsh-cli-linux` job(质量门 → 构建 → 冒烟含 ELF 校验与可执行位 → 上传资产,
  npm 发布仍只在 Windows job,避免双发竞态);launcher 插件 `launcher_cli` 改为按平台选资产名 + 非 Windows
  **补可执行位**(EACCES 是「Linux 上装了不能用」的另一半成因)+ 未知平台给「改用 npm」的明确提示
  (插件 0.3.0 → 0.3.1);`SKILL.md` 安装章节改平台表 + Linux 手工命令 + npm 兜底。
- **质量门**:`verify-cli.mjs` 新增 §14(4 条),含不变式「凡是以 `.js` 为参数 spawn 的候选,`command` 必须是真 node」,
  **95 通过 / 0 失败**(原 91)。这条不变式正是旧实现在 SEA 下被破坏的那条。
- **本机真机验收**(已发布产物,非本地构建):Linux 单文件 0.11.4 装到 `$DSH_HOME/bin/dshcli` → `doctor`
  `ok/degraded 空`、`dshBin.command` 是真 node、`run` 写出文件 `status=ok`;npm 版 0.11.4 同样 `run` 通
  (回归覆盖 `process.execPath` 就是 node 的场景)。
- **环境备注(非产品问题)**:本机**直连 GitHub 下载 release 资产极慢/超时**(实测 4KB/s,下到 1.3MB 断;
  另一次 132s 连接超时),必须走 `-x socks5h://127.0.0.1:10808`;API 与 npm 直连正常。若日后要让
  受限网络也能一键安装,可考虑在技能里补一句代理提示。

## 2026-09-24(已发 v0.11.3 —— dsh-cli v3 会话日志兼容 + document-read PDF 修复)

- **版本与发布**:四处组件 `0.11.2 → 0.11.3`;插件源重钉 `0b9566f`(含本次插件内容的提交);tag `v0.11.3`
  的 CI **6 个 job 全绿**(Init release / dsh-cli / launcher / desktop / vscode / plugins)。资产:
  `dshcli.exe`·`dshcli-0.11.3.exe`(93,622,784 B)·`dsh-launcher(-setup-0.11.3).exe`·
  `dsh-vscode-0.11.3.vsix`·`dsh-desktop-0.11.3-setup.exe` + blockmap + `latest.yml`;
  npm:`@kuaizhongqiang/dsh-cli@0.11.3`(dist-tag `latest` 已切;registry 可见性约 1 分钟延迟)。
- **修复 1(issue #54,dsh-cli)**:上游把事件日志改名为 `session.v3.jsonl.zstd` 且**会话头与事件同文件**,
  而 `session-log.js` 硬编码旧名 → `readSessionHeader()` 全候选落空 → `listSessions()` 把整个会话跳过,
  `session.history / report / stats / artifact` 一起**静默变空**(本机实测:37 个会话之后新产生的 37 个
  一个都看不见,而 `doctor` 仍报 `ok: true / degraded: []`)。修:文件名改候选列表(v3 优先)+
  `parseEvents()` 剔除同文件里的会话头(否则事件条数/between/seqRange 全多 1)+ 兼容门新增
  「sessions 根下有会话目录、却一个都读不到 → 报 `sessions-layout` 降级」。
- **修复 2(document-read)**:PDF 全挂,报 `python parser produced invalid JSON`。根因不是缺依赖——
  PyMuPDF ≥ 1.26 的 `import fitz` 弃用警告打到 **stdout**,而 `parse_document.py` 的 JSON 也写 stdout,
  警告行成了 JSON 首行。修:优先 `import pymupdf as fitz`,仅旧版回退 `fitz`。
- **质量门**:`verify-cli.mjs` **85 通过 → 91 通过 / 0 失败**,新增 §12「v3 与旧版会话并存」夹具
  (发现 / `logFileOf` / 会话头 / 事件全量)与 §13「目录在但读不到 → 必须降级」。其中 §12-5 第一次跑就
  FAIL(读到 9 条而非 8 条),正是它逼出了上面「会话头被当事件」的同源问题。dsh-cli job 会跑这道门,
  所以 v3 兼容从此有 CI 覆盖。
- **本机闭环**:`npm i -g @kuaizhongqiang/dsh-cli@0.11.3` 后 `doctor` ok / degraded 空、会话数 **37 → 75**、
  `run` 真实执行写出文件并回 `out`;`read_document` 对 xlsx / docx / pdf 三种格式实读通过。
- **观察(未修)**:dsh-cli 的 npm 包内 `src/*.js` 与 `skills/*.md` 是 **CRLF** 行尾(伞仓是 LF)——推测
  dsh-cli job 跑在 `windows-latest`,checkout 的 autocrlf 把工作区转成 CRLF 后打进 tarball。后果:装完
  `dshcli skill --where` 立刻报「与内嵌不一致」,要 `skill --install` 刷一次;逐行 diff 也会整篇标红。
- **未动**:`deepseek-harness` 子模块指针保持 v0.11.2 时已验证的 `46a7f68`(本地检出为 `47f9438`,
  故 `git status` 显示该子模块 `M`——纯本地检出状态,未进任何提交)。

## 2026-09-24(已发 v0.11.2 —— #52 应用侧加固下发)

- **版本与发布**:四处组件 `0.11.1 → 0.11.2`;插件源重钉 `14eb25c`;tag `v0.11.2` 的 CI **6 个 job 全绿**
  (launcher 3m26s / desktop 2m42s / dsh-cli 58s / vscode 29s / plugins 6s / init 9s)。
  资产:`dshcli.exe`·`dshcli-0.11.2.exe`·`dsh-launcher(-setup-0.11.2).exe`·`dsh-vscode-0.11.2.vsix`·
  `dsh-desktop-0.11.2-setup.exe` + blockmap + `latest.yml`;npm:`@kuaizhongqiang/dsh-cli@0.11.2` 与
  `@kuaizhongqiang/dsh-desktop@0.11.2`(desktop 日志确认 `+ @kuaizhongqiang/dsh-desktop@0.11.2` 已发布,
  registry 可见性有几分钟处理延迟)。
- **本轮补的 CI 接线**:launcher 发布 job 增加 `npm run verify:m5` —— 此前 `verify:m0..m8` 从不进 CI
  (只人肉跑),所以 #52 的新断言此前没有任何自动化覆盖。接上后 CI 里 `tsc --noEmit` 与 m5 全段都真跑了
  (日志可见 `6-1 没有清单时创建（patchReload=startup）` 通过)。
- **踩坑**:release.yml 里我新加的步骤名写成了裸 plain scalar 且内含「冒号+空格」(`name: Verify gates (m5: …)`)
  → **YAML 解析失败,工作流 0s 即挂**,v0.11.2 第一次的 tag run 与 main push run 都是这个原因(未创建 release)。
  修法:带冒号的 name 必须加引号(`name: "Verify gates (m5: …)"`);已自查全文件其余 name,只有这一处。
  随后删掉远端 tag 并在修复提交 `f21d3eb` 上重打 `v0.11.2`(当时 release 尚未创建,重打无副作用)。
- **本地闭环**:launcher 装上依赖后 `npx tsc --noEmit` **exit 0**、`npm run build` 成功、
  `node scripts/verify-m5.mjs` **35/0**(含 §6 六条;#47/#52 涉及的 4/5 段 CLI/UI e2e 也过了)。

## 2026-09-24(#52 应用侧加固 —— spawn dsh web 前落 profile 清单)

- **#52 真修点只有一处**:桌面端**不自己 spawn dsh**,而是委托 launcher CLI(`desktop/src/main/launcher.ts` 只 spawn
  launcher 可执行);所以修 `dsh-launcher/src/launch.ts` 即同时覆盖「launcher 拉起 dsh web」与「桌面拉起 dsh web」两条路。
- **新增 `dsh-launcher/src/webProfile.ts`** 的 `ensureWebProfileManifest(home)`(幂等):无清单 → 按上游模板**同形状**
  创建(bundles = dsh-base + dsh-web-app,`patchReload=startup`);`patchReload=live`(或缺 `profile` 段)→ 修正为
  `startup` 且**其余字段原样保留**;已经对 → 不动;JSON 读不出来 / `profile` 为 null → 跳过不猜(留给 dsh 重建)。
  `start()` 在 spawn 前调用,成功打一行日志,失败只 warn **不挡启动**。上游只在该字段**缺失**时才套模板默认,
  所以显式值不会被改回去。
- **门**:`verify-m5` 新增 §6(创建 / 幂等 / `live→patched` 且 bundles 不动 / 坏 json skipped)。
  本地 launcher 缺 `node_modules` + `dist`(m5 的 4/5 段依赖构建产物),§6 用同款 TS loader **独立跑通 8 条断言**;
  `tsc --noEmit` 与完整 m5 只能在发布 CI(launcher job)里跑 —— 下次发版时留意这一步。
- **未发版**:此修复在 main(`279b839` + `6524652`),要用户能拿到得再发一次(launcher / desktop 的 exe 才会带上)。

## 2026-09-24(已发 v0.11.1 —— #47 desktop CI 修复 + #48/#49 下发)

- **#47 desktop CI 红**：**根因不是 npm 没跑 install scripts(那是红鲱鱼)**,而是上游 dsh `0.1.2-alpha.4` 的
  `PROFILE_TEMPLATES` 里**只有 web 是 `patchReload: "live"`**(acp/headless/sdk 都是 startup);live 需要 Cordis HMR
  服务,纯 npm 安装布局起不来 → `watchUserPatches` 抛错,`suppressShutdownError` 在「未关闭且 app 活跃」时**再抛** → exit 1。
  **全新 DSH_HOME 必踩**(本地已复现:同版本、同参数、同全新 home → exit=1;把 `profiles/web` 清单改成 `startup` → 正常常驻)。
  v0.10.0 之所以绿:那次复用了缓存的 `.ci-dsh` 旧树(config 里 dshVersion 两次都是 `0.1.2-alpha.4`,没变)。
  修法(PR #51):smoke 起 dsh 前把 `profiles/web` 清单落成 `patchReload="startup"`(上游允许的取值,显式值不会被改回);
  本地端到端验证 `smoke.mjs --dsh <alpha.4 bin.js>` → 401 / token 交换 ok / authed-rpc 200 / **PASS**。
- **遗留已立 issue #52**:应用侧(launcher `launch.ts` / desktop `main/connect.ts`)在**新机器**上拉起 `dsh web` 仍会撞
  同一个上游行为,需要在应用侧同样显式落清单(或退版)。dsh-cli 走 headless 不受影响。
- **v0.11.1 全量发布**:四处版本 0.11.0 → 0.11.1 + 插件源重钉(`ac2e974`);tag `v0.11.1` 的 CI **6 个 job 全绿**
  (desktop 2m44s / dsh-cli 1m0s / launcher 3m8s / vscode 33s / plugins 6s / init 8s)。
  资产:`dshcli.exe`·`dshcli-0.11.1.exe`·`dsh-launcher(-setup-0.11.1).exe`·`dsh-vscode-0.11.1.vsix`·
  **`dsh-desktop-0.11.1-setup.exe` + blockmap + `latest.yml`**;npm:`@kuaizhongqiang/dsh-cli@0.11.1` 与
  `@kuaizhongqiang/dsh-desktop@0.11.1` 均已发布。

## 2026-09-24(cmd 面两层 + 技能随 exe —— T7 #48 / T8 #49)

主人定的形态(2026-09-24):dshcli 要**两个层面**,第一接触命令输出「建议先看 skill」;**skill 放 exe 同级**。

- **参数元数据 78 个全量**(`dsh-cli/src/tools.js`):每个工具声明 `positional` + `params`(flag / 类型 / 说明),
  一份表同时驱动 层 2 子命令、`--help`、`GET /tools` 自描述、参数校验。已实现的 28 个 = **真实契约**;
  未实现的 50 个 = **已声明契约**(调用明确报 `not_implemented`,不静默)。`TOOLS_PENDING` 改由
  TOOLS / IMPLEMENTED 推导,不再手抄(消掉一处易漂移的重复)。
- **层 1 主命令 + 短开关别名**:`-h -v -l -i -c -t -r -s`(`-c` = continue 续最近会话,主人定);
  修饰符(`-j -m -p -w -n`)只在子命令之后。
- **层 2**:`dshcli <组> <名> [--参数]` 由元数据全自动生成;`call --args '<json>'` 保留兜底。
  **撞名规则**(`report` / `status` / `skill` 既是主命令又是工具组):第二个词能匹配到该组工具就走层 2
  (`dshcli report facts`),否则走主命令(`dshcli report --since …`)。
- **技能随 exe**:正文 `dsh-cli/skills/dshcli.SKILL.md`(唯一源)→ 构建期 esbuild `define: __DSHCLI_SKILL__`
  **内嵌进 exe**;运行时与 `dshcli.exe` **同级**(`dshcli.SKILL.md`),**首次运行自动落一份**
  (只读目录静默降级);`dshcli skill` 打印 / `--install [--to <目录>]` 落盘 / `--where` 报路径·是否落盘·
  **与内嵌是否一致**(不一致提醒刷新 —— 覆盖「exe 升级了、技能还是旧的」这个坑)。
- **第一接触提示**:`-h` / `-i` / `-v` / `doctor` 人读给三行(含技能绝对路径),`--json` 给结构化
  `hint.skill` + `advice` —— agent 拿到路径就该去读技能。
- **launcher 侧**:`launcher_cli {action:'install'|'update'}` 换完 exe 调 `dshcli.exe skill --install --json`,
  `summary` 明说技能路径;`skill:false` 可关;**技能失败不影响 exe 安装**(如实报出原因)。

**踩到并修掉的坑**(记录以免重犯):

1. `return promise` 在 `try/catch` 里**不会被捕获** → `not_implemented` 会变成未捕获异常把进程带崩
   (改 `return await`);
2. 主命令与工具组同名的消歧(见上);
3. `tools --group/--pending`、`serve --port` 这类**CLI 自己的开关**不在工具参数池里,得单独声明一份。

**门**:`verify-cli` **85 通过 / 0 失败**(新增 §10 命令面 13 项 + §11 技能 6 项);
`verify-pm3` **34 通过 / 0 失败**(新增 §7 launcher 技能链 5 项);其余门不变。

## 2026-09-24(全量发布 v0.11.0 —— dsh-cli 首发:终端 CLI + 本机工具服务)

一轮做完 **T1–T6**(每阶段独立分支 → PR → rebase 合并;施工计划 `docs/dsh-cli-execution.md`):

| 阶段 | issue | PR | 合并 commit | 内容 |
|---|---|---|---|---|
| T1+T2 | #37 #38 | #43 | `6829cba` | 引擎:多帧 zstd 读会话日志 / 分段契约 / 归属写保护 / 工具面 + cmd 面 |
| T3+T4 | #39 #40 | #44 | `b60b460` | 工作情况与汇报 / 兼容检测与上游跟随 |
| T5 | #41 | #45 | `47e33ff` | launcher 侧 **dsh-cli 安装与更新入口**(`launcher_cli`) |
| T6 | #42 | #46 | `298264d` `acd7244` `0393d58` | 发布接入:自包含 exe / CI job / 四处版本门 + `release: prepare v0.11.0` |
| — | — | — | `9a381f6` | 插件源重钉(指向含本轮的提交) |

**关键选型(证据驱动)**:数据源取**会话事件日志**,不用 `dsh --profile headless --json` ——
实测后者投影**会裁**(每串/键 8KiB、每事件行 32KiB、深度 64),而主人拍板 agent 面**不裁**。
会话语义先取证再写代码:`tool/result.data` 只有三种键组合,**带 `error` 键即失败**(实测 12/533);
`usage` 字段 = input/output/total/cacheRead/reasoning。

**真机只读复核**(主人机器,46 个会话):4.8MB / 20,571 事件日志 **448ms** 读完;15 轮 / **369 步 → 369 条步记录** /
533 次工具调用;`between` 覆盖 16 类事件;`stats.*` 聚合 8 个大会话 = **729 次调用 / 17 次失败**
(edit=196 pwsh=155 read=142 …);`report.facts`(近 7 天)活跃会话 0 —— 与事实相符(本机最大 dsh 会话最后写入
2026-09-03,近 7 天确实没有 dsh 侧活动)。

**门**:`dsh-cli/scripts/verify-cli.mjs` **66/0**(桩 dsh 端到端、不触网、不需要装 dsh)、
`verify-pm3` **29/0**(新增 §6 离线验整条安装/更新链)、pm2 34/0、pm4 9/0、verify-image 42/0、
伞仓 `verify-release.mjs`(新增**四处组件版本一致**校验)OK。

**发布 v0.11.0**(tag → CI):新 job `build-dsh-cli` **54s 通过**(质量门 → esbuild → Node SEA → postject →
exe 冒烟 → 上传资产);Release 资产 `dshcli.exe` + `dshcli-0.11.0.exe` 就位;
npm `@kuaizhongqiang/dsh-cli@0.11.0`(`latest`)已发布 —— **CLI 发布成功**。
launcher 侧 `launcher_cli {action:'install'}` 默认取的正是 `releases/latest/download/dshcli.exe` 这个稳定资产名。

**遗留 / 注意**:

1. **desktop job 在本次 tag 上失败**(`Smoke: shared-server protocol`,与本轮改动无关 —— v0.10.0 时是绿的)。
   CI 日志证据:smoke 装 `@deepseek-ai/dsh@0.1.2-alpha.4` 时 npm 报
   `5 packages have install scripts not yet covered by allowScripts`(node-pty / koffi /
   **`@deepseek-ai/dsh-subprocess-local` 的 `ensure-spawn-helper.mjs`**),随后 dsh 进程在 `runProfile` 崩掉、
   服务没起来 → smoke FAIL。方向:让 CI 的 npm 真正跑 postinstall(或 smoke 显式放行)。已开 issue 跟踪;
   **desktop 的 0.11.0 npm 包因此没发**(npm 上 desktop 仍是 0.10.0)。
2. `dsh-cli` 的 `report.narrate` / `artifact.diff` / `stats.*` 已实现;其余候选(plugin / skill / cred /
   ecosystem / runtime 等)仍 `not_implemented`(清单里打 `pending`,当前 **28/78**),留后续 P5 收口。
3. 本机 npm 策略会拦 esbuild 的 postinstall:先 `node node_modules/esbuild/install.js` 再 `npm run build:exe`
   (已写进 `.AGENT.md` §6)。

## 2026-09-24(harness 子模块 bump + dsh-cli 方案调研)

- **子模块 bump**:`deepseek-harness` 指针 `ddefc45f`(`dsh-v0.1.6-alpha.2`,2026-09-17)
  → **`46a7f68b`(= 官方 tag `dsh-v0.1.7-rc.1`,2026-09-23)**,且该 commit 就是官方 `origin/master` 尖端
  (`rev-parse dsh-v0.1.7-rc.1^{commit}` 与 `origin/master` 一致,`merge-base --is-ancestor` 通过)。
  本仓不构建 harness(CI/scripts 均不引用该目录),验证口径同前 = 锁定官方 tag + gitlink 可解析,
  未做本机构建验证(如实记录)。指针记录同步四处:根 README 组件清单、`docs/modules/README.md`、
  `docs/modules/deepseek-harness.md`、`docs/modules/dsh-vscode-embed-design.md`(其依据的本地工作副本
  `dsh-v0.1.5-alpha.1` 现更旧)。
- **dsh-cli 方案调研(只读,未动代码)**:为「cmd 里用 dsh」+「其他 agent 应用调用 dsh 本体」两个用途
  取证上游现状,结论 —— **上游已有 CLI 与三条程序化通道,不该重写**:`@deepseek-ai/dsh`(bin `dsh`)的
  profile 体系含 `headless`(一次性非交互:位置参数/stdin、`--json` NDJSON、`--session-id`、退出码 0/1)、
  `sdk`/`sdk-minimal`(JSON-RPC over stdio + Python/Node SDK:`@deepseek-ai/dsh-sdk-client`)、
  `acp`(Agent Client Protocol,含 `session/request_permission`)。**上游确实缺的四处**:
  ① 无 MCP server 模式(只有 mcp-client)——「别的 agent 调 dsh」最通用的入口缺失;
  ② 无跨进程连接/凭证文件(token 只在进程内 `WeakMap`,跨进程只能解析启动日志里带 token 的 URL);
  ③ SDK 无 mid-turn cancel、无 per-prompt result 关联、无 server→client 请求(approval 仅 ACP/进程内);
  ④ 无生态运维面(profile/插件/凭证/manifest)。方案取向:生态级 `dsh-cli` = **薄入口层**
  (包 headless / sdk / acp,**不自建 agent loop**),补齐上述 4 处,MCP server 作首发增量。
- **环境备忘**:本机工作副本被外部反复 `git checkout FETCH_HEAD`(reflog 可见),HEAD 两次处于游离态;
  提交前务必确认 `git branch --show-current` = 目标分支,否则会提交到旧提交之上(本次已当场纠正)。

## 2026-09-22(已发 v0.10.0 —— issue #30 / #31 / #32 / #34 全量下发)

- **发布准备**(commit `543abc8`):launcher / vscode / desktop 三组件 0.9.4 → **0.10.0**(与 tag 一致,
  CI 逐组件断言)。语义按 RELEASING:修复 → patch、生态功能 → minor;本轮含新能力(新增 dsh-image
  图片生成插件与 `generate_image` 工具),故取 **minor**。
- **插件集随本轮 pin** = `12e8545b`:含 #32 新包 dsh-image、#31 describe-image 残留清理、#34 迁移脚本
  接管保护、#30 launcher_status 无损 JSON 修复;launcher 默认清单 8 → **9 包**。
- **本地质量门**:dsh-plugins `verify-pm2` **34/0**、`verify-pm3` **19/0**、`verify-pm4` **9/0**、
  `verify-image` **42/0**;伞仓 `verify-release.mjs` OK;launcher `verify-m1` **15/0**。
  launcher 的 tsc/build 与 vscode / desktop 构建本机无 node_modules(desktop 另受 os:win32 限制),
  由 CI windows-latest 覆盖(与 v0.9.4 记录一致)。
- **发布**:`git tag -a v0.10.0` → CI run `35690466950` **五个 job 全绿**(Init / Verify plugins manifest /
  vscode / desktop / launcher,**3m17s**)。
- **上线核验(不凭界面判断)**:Release `dsh-ecosystem v0.10.0` 资产齐备 —— `dsh-launcher.exe`、
  `dsh-launcher-setup-0.10.0.exe`、`dsh-desktop-0.10.0-setup.exe` + blockmap + `latest.yml`、
  `dsh-vscode-0.10.0.vsix`;Open VSX `latest = 0.10.0`;npm `@kuaizhongqiang/dsh-desktop = 0.10.0`。
- **issue 收口**:#31 / #32 / #34 随 PR #33 / #35 自动关闭;#30 由本次发布确认后关闭(附复查建议)。
- **待办(需用户)**:①升级 launcher 到 0.10.0 并跑一次 pull,才会拿到新插件载荷与带回退保护的迁移脚本;
  ②本机 `%DSH_HOME%\skills` 的 6 个旧技能随后可安全清理(`uninstall-old.ps1`);
  ③出图验收要先配 `ARK_API_KEY`。M0–M8 / PM1–PM4 旧里程碑 issue(#3、#5–#16)按 WORKLOG 除 M8(远期,
  `verify-m8` 的 lock 断言仍红)外均已落地 —— 是否关闭由用户决定,**未擅自关闭**。

## 2026-09-22(issue #31 describe-image 收尾 + issue #32 generate_image 出图能力)

- **issue #31 定性**:`describe_image` 的**载荷与 patch 条目**当天 09:04 已清除(备份
  `cordis.patch.yml.bak-20260922-090408-pre-describe-removal`),但**清理没有闭环** —— 本机
  `%DSH_HOME%\skills\install-describe-image` 仍在(另有 5 个 PM4 旧技能)。技能就是「给 Agent 看的
  安装说明书」:仓库删包只删了货源,本机留着技能仍可把已下线服务装回来(且旧包已不在仓库,会装到
  来路不明的载荷)。仓库侧另有死引用:`dsh-vscode/media/webview.html` 的 `describe_image` 图标映射。
- **#31 改动**:`uninstall-old.ps1` 的旧技能清理由可选 `-Skills` 改为**默认执行**(新增 `-KeepSkills`;
  保留时打印残留清单并警示);`webview.html` 去掉 `describe_image` 图标键;
  `github-dsh-plugin/DESIGN.md` 增「历史引用说明」段(**不改历史正文**,只标注已下线与现行范本);
  dsh-plugins README 与 `install-media` SKILL 补「迁移必须连技能一起清」。回归:`verify-pm2` 新增 §6
  (默认清旧技能 / 新技能不受影响 / `-KeepSkills` 保留 / 仓库无可安装 describe-image 的包目录)。
- **issue #32 新能力**:新包 `dsh-plugins/plugins/dsh-image-dsh-plugin/`(服务 `image-gen`,工具
  `generate_image`,载荷 v0.1.0),调火山方舟 `POST /api/v3/images/generations` 上的 **Doubao Seedream
  5.0**(`doubao-seedream-5-0-260128`;旗舰 `doubao-seedream-5-0-pro-260628` 可配)。**一个工具三模式**
  ——由 `image` 字段决定(不给=文生图 / 1 张=图生图 / 2~14 张=多图融合),另支持**组图**(`count>1` →
  `sequential_image_generation: auto` + `max_images`)、`size`(档位/预设/像素)、`seed`、`watermark`
  (默认关)、`output_format`、`web_search`(5.0 的 `tools`)、`optimize_prompt`,以及 `extra` JSON
  直通。参考图支持本地路径(插件读文件转 data URI —— 接口不支持文件上传)、公网 URL、data URI。
  **结果一律落盘**再回 `paths[]`(`url` 下载 / `b64_json` 直接解码;官方 url 仅 24h 有效),输出遵守
  PLUGIN-SPEC §7(无损 JSON)。
- **#32 配套**:独立成包的理由 = **独立凭证 `ARK_API_KEY`**(与 dsh-media 的 `MIMO_API_KEY` 不同源,
  对齐 D7「按凭证聚合」);`install.ps1`(幂等 / `-Only` / `-Uninstall` / 写后跑 `validate-patch.mjs`)、
  `.env.example`(只有键名)、README(参数表 + 排查 + 网关替换法:baseURL / imageField / apiKeyEnv)、
  技能 `install-image`;`PLUGIN-SPEC` §1 增「生成 | dsh-image」层;launcher 默认清单纳入 dsh-image
  (8 → 9 包,`verify-m1` 1-2 同步)。
- **回归门(新)**:`dsh-plugins/scripts/verify-image.mjs` —— 安装/幂等/卸载 + 临时桩
  `@deepseek-ai/{dsh-tools,dsh-credentials,schemastery}` 直载真载荷,断言三模式请求体形状
  (文生图无 `image` / 单图为字符串 / 多图为数组)、组图参数、`size` 归一、落盘路径 `-N` 后缀、
  mode 一致性、本地图 data URI;**桩 fetch 端到端**(不触网)断言落盘字节、Bearer 头、组图 3 张、
  缺凭证 / 401 的可读诊断。`verify-pm4` 技能集合 9 → 10。
- **#34(在 #31 的验收路径上发现,同批修掉)**:`uninstall-old.ps1` 会**无条件删除** `plugins\<svc>`,而
  PM2 合并后新包与旧包**共用同名目录**(`plugins\audio-read` 等),只有 patch 节头不同 —— 于是「先装新包
  再跑迁移」会把刚装好的新包载荷删掉(patch 新节还在),插件指向不存在的 `index.js`。脚本自带的提示与
  `install-media` SKILL 写的正是这个危险顺序,而 `verify-pm2` §5 只覆盖了安全顺序,所以一直全绿。
  修法:迁移脚本加**接管保护**(patch 里已有 `dsh-media: <svc>` / `dsh-deepseek: <svc>` 节 → 只剥旧节、
  保留载荷;`describe-image` 无接管方照常删除),两种顺序都安全;文档顺序同步;`verify-pm2` 新增 §7。
- **门结果**:pm2 **34/0**、pm3 **19/0**、pm4 **9/0**、verify-image **42/0**、伞仓 `verify-release` OK、
  launcher `verify-m1` **15/0**(`verify-m7`/`verify-m8` 的 lock 类断言仍失败,属 M8「版本 lock」远期项,
  与本次改动无关)。
- **流程**:三个 issue(#31 / #32 / #34)→ 分支 → PR → merge → 合并后在 main 重钉 `ecosystem.json`
  插件源(commit 前移到含本改动的提交):PR **#33**(`feat/31-32-image-tools`,merge 后 main = `5eef95a`)、
  PR **#35**(`fix/34-uninstall-old-takeover`)。
- **待办(需用户)**:本机 `%DSH_HOME%\skills` 仍有 6 个旧技能待清 —— **本轮已具备安全清理条件**
  (PR #35 的接管保护先落库再去跑 `uninstall-old.ps1`,旧版本会连 `plugins\audio-read` 等新包载荷一起删掉);
  出图验收要先配 `ARK_API_KEY`(本机现无方舟凭证):文生图 1 张 / 单图生图 / 3 张组图;
  下一轮全量发布才会把新 pin 带给用户机。

## 2026-09-22(harness 子模块 bump + issue #30 launcher_status 输出契约)

- **子模块 bump(官方 tag 人工确认)**:`deepseek-harness` 指针 `47f94385`(2026-08-13,`#2519 feat/npm-public`)
  → **`ddefc45f`(= `dsh-v0.1.6-alpha.2`,2026-09-17 官方 release merge)**。本仓不构建 harness(CI、`scripts/`
  均不引用该目录),故验证口径 = 锁定的**确实是官方 tag 提交**(`git rev-parse dsh-v0.1.6-alpha.2^{commit}`
  与 gitlink 一致)+ gitlink 可解析;未做本机构建验证(与本仓 CI 无关,如实记录)。指针记录同步三处:
  根 `README.md` 组件清单、`docs/modules/README.md`、`docs/modules/deepseek-harness.md`;
  `docs/modules/dsh-vscode-embed-design.md` 的「依据版本」相应改写 —— bump 后伞仓指针**新于**该文档依据的
  本地工作副本 `dsh-v0.1.5-alpha.1-2-g767b1e7673`,该文档事实与行号仍以本地工作副本为准。
- **issue #30 定性复核**:`launcher_status` 的 `detail` 里 `{ ...active, token: undefined }`(原 L245)与
  `byPid: intent.byPid ?? undefined`(原 L255)是**值为 `undefined` 的自有属性**;dsh 侧按自有属性校验工具结果,
  带 `undefined` 即判 `value is not lossless JSON` → 工具**整条不可用**(含 `clearRestartIntent` 分支),
  「重启/连接/升级」链上唯一状态查询入口失效。`JSON.stringify` 的静默丢键掩盖了这一点,故不能靠序列化兜底。
- **修复**(`dsh-plugins/plugins/dsh-launcher-dsh-plugin/plugins/launcher/index.js`,载荷 0.1.0 → **0.1.1**):
  1. 新增 `jsonSafe()`:**出口递归清洗** —— 对象剔除 `undefined` 属性、数组项 `undefined` 与 `NaN`/`Infinity`
     归 `null`、`Date` 转 ISO;统一 `return { summary, detail: jsonSafe(detail) }`,从根上覆盖同类回归
     (注册缺 `api`/`pid`/`updatedAt`、`launchToken.port`、`restartIntent.requestedAt` 等同样可能缺)。
  2. 新增 `stripToken()`:连接对象按解构剔除 `token` 键(D2 红线),不再用「写 `undefined` 当脱敏」。
  3. `byPid` 去掉无意义的 `?? undefined`;`requestedAt` 与 `reason` 口径对齐(`?? ''`)。
- **回归门**:`dsh-plugins/scripts/verify-pm3.mjs` 新增 §5 —— 临时目录桩 `@deepseek-ai/dsh-tools` 后**直载真载荷**,
  用「带 token 的 connections.json + 缺 `byPid` 的旧意图文件 + 缺 `api` 的注册文件」跑 `launcher_status.execute`,
  再递归扫输出路径上的 `undefined` 值。结果 **19 通过 / 0 失败**(原 13 项全绿)。
- **硬约束落文档**:`dsh-plugins/docs/PLUGIN-SPEC.md` 新增 §7「工具返回值硬约束:输出必须是无损 JSON」
  (禁止 undefined 占位、外部文件字段出口过 `jsonSafe`、回归范式指向 verify-pm3 §5);launcher 插件 README
  补「输出契约」小节。
- **待办**:`dsh-launcher/ecosystem.json` 插件源 pin 随本修复 commit 重钉(下一轮全量发布下发)。

## 2026-09-13(已发 v0.9.4 —— issue #29 code-graph 修复下发)

- **发布准备**（commit `4de4654`）：launcher / vscode / desktop 三组件 0.9.3 → **0.9.4**（与 tag 一致，
  CI 逐组件断言）；插件集沿用 `840693d` 落库的 pin（插件源 = `2e2d61f7`，agent-memory `install.ps1`
  sha256 = `531001b1…`）。
- **本地质量门**：launcher `tsc --noEmit` + `build` OK，`dist/launcher.cjs` 内嵌清单已解析为
  `2e2d61f7…` / `531001b1…`，CLI `--version` = v0.9.4；`verify-m1` 1-1..5-2 全绿
  （含 1-3「默认清单插件源锁 = 仓库清单(2e2d61f7)」；第 6 步真实 pull 需 Windows `powershell`，
  本机 Linux 无，交由 CI `windows-latest` 覆盖）；vscode `typecheck` + **116 passed / 2 skipped**；
  desktop 依赖声明 `os:win32`（本机 `npm ci` 报 notsup，不可本地构建，由 CI 覆盖）；
  `verify-release.mjs` OK；`deepseek-harness` 子模块未动。
- **发布**：`git tag -a v0.9.4` → CI run `34747199230` **五个 job 全绿**
  （Init / launcher / desktop / vscode / plugins，16:17:59 completed success）。
- **上线核验（不凭界面判断）**：Release `dsh-ecosystem v0.9.4` 资产齐备
  （`dsh-launcher.exe` 64.9MB + `dsh-launcher-setup-0.9.4.exe` 71.4MB、`dsh-desktop-0.9.4-setup.exe`
  89.4MB + blockmap + `latest.yml`、`dsh-vscode-0.9.4.vsix`）；Open VSX `latest = 0.9.4`；
  npm `@kuaizhongqiang/dsh-desktop latest = 0.9.4`。
- **供应链复核（fresh clone @ v0.9.4）**：8 个插件包 `install.ps1` + skills 脚本 sha256 **全部与
  ecosystem.json 一致** —— 顺带验证了 `.gitattributes`（blob 存 LF、`*.ps1` 检出强制 CRLF）这条
  约定在 CI/用户机/本机三处口径一致（直接抓 raw blob 比对会因 LF/CRLF 差异误报）。

## 2026-09-13(issue #29：code-graph 通道鉴权对齐 + 远端可达性定位)

- **issue #29 定性复核**：`memory.<域名>` 只网关到 MemoryCore（:8422，`/health` 仅 MemoryCore 组件），
  `/v3/code-graph/*` 带 Bearer 仍 `404 Not found: POST /v3/code-graph/list`；但**同一引擎的 MemoryKnowledge
  已在 `knowledge.<域名>` 独立暴露**（`/health` 与 `/v3/code-graph/list`、`/v3/code-graph/search` 实测可用）。
  即「网关无 code-graph 路由」只对 `memory.<域名>` 成立 —— 客户端把 `knowledgeEndpoint` 指向 Knowledge 主机即全通，
  无需新建部署（原 issue 的建议 1 实际已满足，只是地址口径没写进配置/文档）。
- **插件侧修复（native 0.1.0 → 0.1.1）**：`createCodeGraphClient` 与 memory 通道对齐 —— 发
  `Authorization: Bearer`（专属 `knowledgeApiKey`/`knowledgeApiKeyRef` 优先，未配则回落共享 `apiKey`/`apiKeyRef`；
  都没有时不发该头，本机免鉴权的 MemoryKnowledge 照常可用）；失败按三类给可执行诊断：401（缺 key）、
  404 且路径含 code-graph（指错网关 → 应指向 MemoryKnowledge）、连接不可达；其余错误原样透传。
  旧 MCP codegraph 通道同一缺陷一并修（1.0.1，新增 `KNOWLEDGE_API_KEY`，回落 `API_KEY`）。
- **验证**：native mock 自检 35 → **47 ok / 0 FAIL**；旧 MCP 套件 23 → **30 passed / 0 FAIL**；
  live 双形态实测（本机 `:8421` 与远端 `memory.<域名> + knowledge.<域名>`）各 **7 ok / 0 FAIL**；
  故意把 `knowledgeEndpoint` 指到 `memory.<域名>` 时得到 `404 → 该地址未暴露 code-graph 路由…应指向 MemoryKnowledge` 的可读诊断。
- **顺带修掉 live 自检的两处历史缺陷**：`parseLiveConfig()` 仍在读 MCP 时代的 `mcp-agent-memory` 条目
  （team 落回 `team-test`、可见索引 0，repo 解析失败直接抛栈中断整个 live 跑），改为优先读 native 条目；
  live-write 用例的事件形状缺 `source.kind==='user'` / `message.role==='assistant'`，会被 capture 过滤而不入库。
- **口径落文档**：包 README 新增「远端部署（引擎不在本机）」+ `.env.example` / SKILL 排查项 /
  codegraph 模块页 §5·§7 / 安装器注释同步；明确 `memoryEndpoint`(MemoryCore) 与 `knowledgeEndpoint`(MemoryKnowledge)
  是**两个服务**，MemoryCore 网关只有 `/v3/knowledge/*` 元数据、不代理 code-graph。

## 2026-09-13(凭证接入：credentials v0.0.2 上线 + agent-memory 引用式密钥)

- **凭证写入门径打通**：线上 profile 原为 credentials **v0.0.1**（279 行）且 `tool-credentials` 条目没有
  `config`，因此 `credentials_set` 一直被 approval seam 拒（本部署策略 `never`）。本轮把仓库里的
  **v0.0.2**（298 行）复制进线上并给条目补 `config.requireApproval: false` → `credentials_set` 成功
  （`GITHUB_TOKEN` 已入受管库，`credentials_verify` 报 `configured (source=file)`）。
- **踩坑自曝**：首次用脚本把两个记忆密钥写入 `.credentials.yaml` 时追加到了**顶层**，而该文件有
  `version/refs/records` schema —— 已改为写入 `refs:` 段并做了 YAML 解析校验（9 个 ref、权限 0600 未变）。
- **agent-memory 引用式密钥**：新增 `apiKeyRef`/`userKeyRef` + 可测试的 `resolveSecretValue()`
  （优先级 **凭证 seam > 同名环境变量 > 内联值**）；`AGENT_MEMORY_API_KEY` / `AGENT_MEMORY_USER_KEY`
  已存入受管库，cordis 条目同时保留 ref 与内联值（切换期兜底，同一时刻内联仅在被 ref 命中前生效）。
  selftest 增 6 组断言 → **35 ok / 0 FAIL**；安装器默认生成 ref 式配置并提示存储方式。
- **热重载结论再修正**：本轮 patch 变更与插件文件覆盖**都未能**触发重载（15:37/15:38 两次 `ready`
  之后再无），因此**重启仍是唯一可靠路径**；文档措辞保持「改动后建议重启」。当前线上运行的仍是
  上一版代码（内联值兜底），ref 版代码已同步到 profile，待下次重启生效后再撤掉内联值。

## 2026-09-13(更正：本部署并非「完全不热加载」+ 线上入库实测生效 + 守护撤除)

- **证据（同一天三条时间线）**:① 15:17 追加 native 条目 → **15:18:42 运行中的实例（pid 1357）即打 `ready`**;
  ② ~15:29 覆盖 `index.js`/`lib.js`（global 订阅 + 注入过滤 + 截断）→ **15:30:33 同一进程 `capture 已提交
  session=session-dca2c796… turn=7`**（该 session 即本工作区会话，游标同步 = 7）;③ 15:31:03 重启后新进程 `ready`。
  结论:profile 条目新增/文件覆盖**会被运行中的实例拾取**（有延迟、不确定），此前「必须重启/不会监听」的措辞过强，
  已改为「改动后建议重启以求一致；`?v=` 写法绝对禁用」。
- **线上入库确认生效**:15:30:33 那次成功捕获即 native 进程内入库在真实 3080 实例工作（工具面此前已由裸名
  `recall_memory` 调用验证）。
- **撤除外部守护**:守护按 `cordis.patch.yml` 的 `mcp-agent-memory` 条目读凭证，而 native 模式已移除该条目 →
  服务崩溃重启 28 次（`缺少凭据: MEMORY_ENDPOINT, API_KEY, …`）。已 `disable --now` 并删除单元；
  入库由插件进程内接管（两种模式共用游标，不会重复提交）。`install.sh --mode mcp` 仍可重新装回守护。

## 2026-09-13(agent-memory 进程内入库修复：global 订阅 + 注入过滤 + 上限截断；端到端跑通)

用户重启后实测发现「工具能用、入库不动」(游标停在 15:16:51、无捕获日志),根因逐个挖出并修复:

1. **`session/event` 必须带 `{ global: true }`**(核心根因):该事件是**会话作用域**事件,
   profile 级插件用 `ctx.on('session/event', fn)` 收不到任何事件 —— harness 官方订阅均为
   `ctx.on(..., { global: true })`(`core/tools/src/invariant.ts:79`、`sdk/server/src/server.ts:95`)。
   这也解释了当年 v1 `memory-bridge` 原生插件为何被放弃、改用文件轮询守护。
2. **只认真人输入**:`user/message` 事件混有 `agent.inject()` 的合成上下文(AGENTS.md/技能/环境提示),
   全部累积会直接撑爆引擎上限 —— 实测 `400 messages.0.content: Too big: expected <=8192 characters`。
   现按守护同口径过滤 `source.kind === 'user' && role === 'user'`,助手侧只认 `message.role === 'assistant'`,
   并在无新真人输入时沿用上一轮文本(pendingUser 语义)。
3. **8192 上限保护**:单条 content 超过上限自动截断(留余量 8000 + 截断标记),避免长回复/长输入触发 400。

- **端到端验证**(用 `--profile headless --patch` 起一轮真实对话,**不动线上 web 会话**):
  日志 `[agent-memory] ready … tools=11 capture=on` → 任务答复正常 → `[agent-memory] capture 已提交
  session=session-6a5d63a8-… turn=1`,探针游标文件同步写入该会话 turn=1。
  selftest 扩到 **mock 28 ok / 0 FAIL**(含注入过滤、pendingUser 沿用、超限截断三组新用例)。
- **线上状态**:工具面在重启后已生效(本会话直接调用裸名 `recall_memory` 成功,返回 `_context` 带
  service_id —— native 实现特征);入库修复已同步进 profile,**需再重启一次**才在线上生效。

## 2026-09-13(agent-memory 重启上线验证 + 两处修复)

- **用户重启 dsh 后实测**(15:24:54 重启,新进程 pid 11752):日志出现
  `[agent-memory] ready v0.1.0: tools=11 capture=on memory=…:8422 knowledge=…:8421 team=team-w7eai9w6kc`
  —— **native 插件在真实线上实例生效**;同时 `agent-memory-codegraph] ready` 计数为 **0**,MCP 通道确已退出。
- **修复 1(重启后立刻暴露的真 bug)**:`capture` 在**只有单侧文本**的轮次会把空 content 传上去,
  引擎判 `400 messages.0.content: Too small: expected string to have >=1 characters`(日志 15:23:21 实测)。
  现与 autostore 守护同口径:**缺任一侧文本的轮次直接跳过**(不推进游标、不刷错误日志,`debug` 级别记录)。
  selftest 新增 3 例(缺 assistant / 缺 user / 跳过轮次不推进游标)→ mock **28 ok / 0 FAIL**。
- **修复 2(本轮自身缺陷,已坦白)**:安装器 `SYSTEMD_DIR` 未跟随 `DSH_HOME/PROFILE_DIR` 作用域,
  导致「临时 profile 演练」的 `--uninstall` 把**真实的** `dsh-memory-autostore.service` 删掉了。
  已加 `SYSTEMD_USER_DIR` 覆盖项(演练指向临时目录)并把 systemd 目录打印进脚本头部;
  真实单元已用 `./install.sh --only autostore` 恢复(`active`)。native 模式下守护属冗余,
  是否保留由用户决定(两种模式共用游标,不会重复提交)。
- **线上 profile 已同步修复后的 `lib.js`**(纯逻辑改动,下次重启生效;不影响已加载实例的常规轮次)。

## 2026-09-13(agent-memory 原生插件 —— 去 MCP 化 + 进程内入库；附带 `?v=` 陷阱)

- **背景**(用户:「agent-memory 能不能作为一个插件？而不是 mcp?」→ 选「全量原生」):把 DSH 侧的
  agent-memory 从**两条 MCP 通道**改为**一个原生 cordis 插件**(工具面 + 进程内入库),MCP 保留为
  `--mode mcp` 兼容路径给其它平台(Claude Code / CodeBuddy / OpenClaw)。
- **改动**:
  1. `plugins/agent-memory-native/`(新):`index.js`(cordis 接线:Config + 11 个 `defineTool` +
     `ctx.on('session/event')`)、`lib.js`(**纯逻辑层,零 dsh 依赖**:MemoryCore/MemoryKnowledge 裸 HTTP
     客户端 + 身份/task_id 语义 + 进程内入库)、`package.json`、`selftest.mjs`(mock + `--live` + `--live-write`)。
     工具:3 主记忆 + 8 代码图谱,**工具名不再带 `mcp__` 前缀**;零外部依赖(不再 `npx`,无子进程)。
  2. 进程内入库:`turn/end` 直提 L0,**与 autostore 守护共用同一份游标**
     (`%DSH_HOME%/.dsh-memory-autostore-state.json`,按 `session_id + turn`),两种模式可互换不重复提交;
     native 模式缺省不再安装守护。
  3. `install.sh` / `install.ps1`:`--mode native|mcp`(默认 native)、`--only`、`--uninstall`、`--dry-run`;
     按标记块幂等增删;**只删本包管理的块**(手工旧条目提示不擅动)。
  4. 文档:包 README / 技能 `install-memory` / `docs/modules/agent-memory.md` / `dsh-plugins/README.md` 同步;
     清单 `agent-memory` 的 install.ps1 sha256 重算 `584e96d7… → f6acb34b…`。
- **安装实测**(用户要求「改完先给自己安装测试,跑通再提交」):
  1. 离线自检 `selftest.mjs` → **25 ok / 0 FAIL**;
  2. 真实引擎 `selftest.mjs --live` → **7 ok**(atomic/search、core/read、code-graph/list+search);
     `--live --live-write` → **8 ok**(真实 L0 写入);
  3. 接线测试(用真实 dsh 运行时模块 `profiles/node_modules/@deepseek-ai/{dsh-tools,schemastery}` + 真实引擎,
     stub ctx)→ **9 ok**:Config 校验、apply() 注册 **11** 工具、订阅 `session/event`、
     `recall_memory`/`code_graph_list` 打真引擎、喂一轮事件后真实写 L0 且游标落盘;
  4. 真机 dsh 加载:在 **3081 端口另起一个临时 dsh web 实例**(不打断线上 3080 会话)加载 live profile →
     日志出现 `[agent-memory] ready v0.1.0: tools=11 capture=on …`。
- **踩到的真坑(已修,写进文档)**:从旧 README 继承的「热重载」写法 `name: './plugins/xxx/index.js?v=N'`
  **在本部署会让整棵插件树加载失败** —— loader 把查询串当字面路径 `import()`,报
  `ERR_MODULE_NOT_FOUND: …/index.js%3Fv=2`(3081 实例实测复现)。已把安装器与线上条目改回纯路径,
  并把 stock 包 README 里同一段错误说明改写为「改插件必须重启 dsh web;本部署未启用 `cordis-plugin-hmr`」。
  另修:selftest 从 `cordis.patch.yml` 解析 YAML 值时未剥引号 → `Bearer 'xxx'` 被引擎判 401。
- **状态**:插件已装到本机 profile(native 条目 + 真实凭证注入,旧 MCP 块保留待重启后清理);
  **线上 3080 实例仍跑 MCP,需一次 `systemctl --user restart dsh` 切到 native**(重启会中断当前会话)。

## 2026-09-13(memory 融入 eco —— L5 记忆层组件 + 第 8 个插件包)

- **背景**(用户:「我要把 memory 融入 eco」):先做全栈盘点,确认 memory 是四层混合体——
  ① **引擎(第三方)** TencentCloud/TencentDB-Agent-Memory(MIT;MemoryCore :8422 / MemoryKnowledge :8421 /
  MemoryProxy :8096 / MemoryPanel :8123 + TDAI gateway :8420);② **我们的协议桥**
  `kuaizhongqiang/TencentAgentMemoryBridge`(MCP 桥 + HTTP 桥 + autostore 脚本);③ **DSH 接入层**
  (cordis 两条 MCP 实例 + codegraph 包);④ **本机数据** `~/.openclaw/memory-tdai`(126M,L0–L3+场景+画像)。
  关键事实:引擎检出的 HEAD `03335b9` 提交信息自述「**本地分支,不回推上游**」,且引擎仓内
  `MemoryCore/start-gateway-full.sh`、`tdai-gateway.full.yaml` 等全是 `??` untracked 本机定制 →
  **不适合按 submodule 锁基线**(锁的应是上游 commit,我们跑的是本地分支)。
- **决策**(用户拍板):① 插件包**单包合并**——现有 `agent-memory-codegraph-dsh-plugin` 并入新的
  `agent-memory-dsh-plugin`(`--only memory,codegraph,autostore,engine`),符合 PLUGIN-SPEC「包内多服务」惯例;
  ② 引擎不进子模块,以「外部前置 + bootstrap/模板」方式管理;③ 源仓 `TencentAgentMemoryBridge`
  **不单独处理**(DSH 侧改从伞仓装,原仓不再作为 DSH 依赖;因本会话无 gh CLI,未在 GitHub 侧归档)。
- **改动**:
  1. **组件目录 `agent-memory/`**(squash 快照,57 文件/520K;commit message 记来源仓 + 源 HEAD `4080826`):
     `packages/mcp-bridge`(npm 公开包 `tencent-agent-memory-mcp-bridge@0.4.0`)、`packages/bridge-server`、
     `scripts/dsh-memory-autostore.mjs`(含并入时那笔未提交修复:YAML 引号剥离 + 守护基线只对新会话建立,
     避免重启吞掉未提交轮次)、Windows VBS、docs 7 篇、examples、`.claude`/`.codebuddy` 技能。
     删除嵌套 `.git`;`node_modules/`、`dist/`、`.turbo/` 不入库。
  2. **插件包 `dsh-plugins/plugins/agent-memory-dsh-plugin/`**:`install.sh`(Linux/macOS,systemd user 单元)与
     `install.ps1`(Windows,计划任务 + 隐藏 VBS),均支持 `--only/-Only`、`--uninstall/-Uninstall`、`--dry-run`;
     `cordis.patch.yml` 按 `# >>> agent-memory-dsh-plugin: <id> >>>` 标记块幂等增删;
     `templates/systemd/*.service`(7 个,`@ENGINE_DIR@/@MEMORY_HOME@/@NODE_BIN@` 占位符化 +
     bridge 单元里的 `apiKeyHash` 全部替换为 `<sha256(apiKey)>`)、`templates/engine/*`(启动脚本 + gateway yaml 脱敏导出)、
     `.env.example`、`templates/cordis-patch.example.yml`、README(三层职责/前置/凭证/验收/已知限制)。
  3. **技能 `skills/install-memory/SKILL.md`**(第 8 个技能)。
  4. **清单与断言**:`dsh-launcher/ecosystem.json` 增第 8 包 `agent-memory`(install.ps1 sha256,CRLF 口径
     `584e96d7…`);`verify-pm4.mjs` skills 期望 7→8;`verify-m1.mjs` 1-2「默认清单含 8 个插件包」。
  5. **文档**:新增 `docs/modules/agent-memory.md`;同步 `README.md`(结构树 + 组件表)、`docs/modules/README.md`、
     `.AGENT.md`(插件合集 8 包 + 记忆层红线)、`dsh-plugins/README.md`、`dsh-plugins/skills/README.md`、
     `dsh-plugins/docs/PLUGIN-SPEC.md`(新增「记忆」层)、`docs/ECOSYSTEM-PLAN.md`(L3 计数 + L5 记忆数据)。
- **验证**:`install.sh` 在临时 profile 上端到端演练——安装(2 条 patch 条目)→ 幂等复跑(2 SKIP)→
  卸载(0 残留)→ 重复卸载(2 SKIP);`bash -n install.sh`、`node --check codegraph/index.mjs` 通过;
  `node scripts/verify-release.mjs` **8 包全绿**;launcher `verify:m1` 检查 1–5 **10 ok / 0 FAIL**
  (第 6 节需 Windows PowerShell,Linux 下 `spawn powershell ENOENT` 属环境限制);
  `dsh-launcher npm run check`(tsc)通过。
- **红线执行**:记忆数据 `~/.openclaw/memory-tdai/`、游标 `.dsh-memory-autostore-state*`、
  引擎 LLM key(`~/.config/memory-gateway/*.txt`)、团队 `USER_KEY`/`API_KEY` **一律不入仓**;
  仓库内只有 `<...>` 占位符;已 grep 自检吸收目录与模板无 `/home/kuai`、无 key 残留。
- **并发提交整合 + 清单修复**(与 `e6c55bb` fix(credentials) 撞车):推送时发现远端多出
  `e6c55bb`(修 credentials approval gate + 下线 describe-image;同样改了 `dsh-plugins/README.md`、
  `verify-pm4.mjs`、`skills/README.md`)。处理:
  1. `git rebase origin/main` 解决三处冲突——保留其 describe-image 下线与「单工具旧包 DEPRECATED」表述,
     并入本轮的 `agent-memory` 行;skills 期望清单合并为 **9 个集合**(其 `install-ue-mcp` + 本轮 `install-memory`)。
  2. **修复远端遗留的发布门失败**:`e6c55bb` 改了 `dsh-media` / `dsh-credentials` 的 `install.ps1` 与
     `skills/install-skills.ps1`,却**没同步清单 sha256** → `origin/main` 上 `node scripts/verify-release.mjs`
     直接 FAIL(3 处不匹配),launcher 供应链校验会拒绝安装这些包。本轮按 CRLF 工作树口径重算并写回
     (`af6852ef…` / `812643a25e33…` / `a3bd073e…`),修复随内容提交一起入库。
  3. rebase 改写了内容提交 sha,故 pin 由 `a90749d` 重指为 **`2165f6c`**(内容提交);并在该 pin 提交树内
     复算了全部 8 包 + skills 的 sha256 → **全部一致**(launcher 拉取路径可通)。
- **遗留/下一步**:主记忆通道默认走 npm 上的 `tencent-agent-memory-mcp-bridge@0.4.0`(要离线自持需在
  `agent-memory/` 内构建并把 `args` 指向本地 `dist/index.js`);引擎升级须人工验证后记录 ref;
  Windows 下引擎侧仍需 WSL2/docker;原仓 npm 发布通道保留但 DSH 侧不再依赖。
  另:`ue-mcp` 在伞仓里有包 + 技能但**不在 launcher 清单**(与本次之前的 codegraph 同状况),是否纳入待定。

## 2026-09-13(股票插件交易层入库 v0.2.0 —— 模拟盘/舆情/建议 + 日周期时间模型)

- **背景**(用户提问「股票插件有改动吗？需要提交一下」):核对发现权威仓已随 2026-09-04 monorepo 化迁入伞仓,
  但伞仓 `dsh-plugins/plugins/stock-dsh-plugin/` 仍是 **960 行 / 9 工具 / v0.1.0** 的轻量基线,
  `grep -r paper_settle` 全伞仓无命中;线上实际运行的 **2755 行 / 22 工具 / v0.2.0**
  (含 5 个 `paper_*` 模拟盘工具 + 日周期时间模型 `phase`/`dataDate`)只存在于
  `%DSH_HOME%\profiles\web\plugins\stock\` —— 即交易层在本仓缺失,且线上版**无任何版本控制副本**。
  归档只读仓 `kuaizhongqiang/dsh-plugins` 本地检出的两处未提交改动(README 热重载 SOP +
  index.js `+91/-8`:多因子信号分 `signalScoreFor`、报告文件名 hash 截断、schema 补
  `signalScore/confidence/factors`)已逐项确认被线上版完整包含,故以线上版为准回灌。
- **改动**(显式 pathspec,5 文件 +1920/-54):
  1. `dsh-plugins/plugins/stock-dsh-plugin/plugins/stock/index.js` ← 线上 v0.2.0 运行版(2755 行/22 工具);
     同目录 `package.json` 版本 `0.1.0 → 0.2.0`(install.ps1 按此打印版本)。
  2. 包 `README.md` 重写:22 工具分四组表(行情 9 / 舆情 4 / 建议与持仓 4 / 模拟盘 5)、
     日周期运行模型(T+1 按建议日之后第一个交易日实际高低价区间验单、股数口径 100 股整数倍)、
     `advice_calc` 多因子信号分与定档说明、热重载 SOP(改 JS 免重启,`name` 版本号 +1 触发重载)。
  3. `dsh-plugins/skills/install-stock/SKILL.md`:描述与验证清单同步 22 工具;clone 源由归档的
     `dsh-plugins` 改为伞仓 `dsh-ecosystem`(路径 `dsh-plugins/plugins/stock-dsh-plugin/`);
     补 `paper_settle` / `sentiment_pick` 排查项与挂单/T+1 口径。
  4. `docs/ECOSYSTEM-PLAN.md`:dsh-stock 工具数 9 → 22(合并映射表 + 准入三问依据句)。
- **验证**:线上文件 `node --check` 通过;伞仓根 `node scripts/verify-release.mjs` **全绿**
  (7 包 install.ps1 + skills 脚本 + `src/ecosystem.ts` 单一来源);**未改 `install.ps1` → 清单 sha256 无需重算**;
  另确认 CI 的「Assert version matches tag」只作用于伞仓根/launcher/desktop/vscode,不约束插件子包版本。
- **插件源 pin 与全链同步**(同日追加提交,用户要求「stock 相关全额提交推送到 eco」):
  1. 文档同步:`dsh-plugins/README.md`(stock 行改 22 工具闭环描述)、`skills/README.md`
     (install-stock 能力补舆情/建议/模拟盘)、`docs/PLUGIN-SPEC.md`(域工具层标注 github 8 / stock 22)。
  2. `dsh-launcher/ecosystem.json` 的 `plugins.source.commit` `56bfcbb → eeaaaa6`(RELEASING「两步提交」第二步);
     已核验 `install.ps1` blob 在 pin 前后完全相同 → `.gitattributes` 的 `*.ps1 eol=crlf` 口径下清单 sha256 无需重算。
  3. 顺手修复 `dsh-launcher/scripts/verify-m1.mjs` 检查 1-3 的硬编码过期断言(写死 `9f47279`,自 9/9 re-pin 起即 FAIL):
     改为与仓库清单(单一事实来源)比对。修复后 M1 检查 1–5 **10 ok / 0 FAIL**
     (第 6 节需 Windows PowerShell,Linux 下 `spawn powershell ENOENT` 属环境限制,非代码问题)。
- **遗留**:随包内嵌默认清单由 esbuild 构建期内联(`src/ecosystem.ts`),已安装的启动器需重建/发版后才生效
  (「一键更新」按伞仓 HEAD 清单路径可即时读到新 pin);归档仓 `dsh-project/dsh-plugins` 的两处未提交改动
  内容已在伞仓,按用户决定处理(默认原样保留不触碰)。

## 2026-09-11(dsh-vscode 0.9.3 —— 费用估算改按官方调价历史 + 峰谷时段)

- **问题**(用户报):用量栏「累计费用 ¥」没跟上官方调价,且峰谷判档不看星期;实测当下(9/11 周五 15:22)费用 chip **根本不显示**。
  三处根因:①峰谷规则按「9-12、14-18」判档但**未排除周末** —— 官方口径是「周一至周五 …,其余为空闲时段」,周六周日被按峰价翻倍;
  ②价表键仍是 `deepseek-v4-flash`,而 2026-09-10 12:00 起官方模型名改 `deepseek-flash`(本机 `~/.dsh/settings.yaml` 已切),
  查表未命中 → `estimateCostCny` 返回 undefined;③费率过期(Flash 现行峰价 2/0.04/8,旧条目 3/0.1/9)且无生效期概念,
  历史会话无法按当时价目复算。
- **数据基线**(官方文档,2026-09-11 核对):2026-08-17 00:00 起首次峰谷定价(闲时 = 峰价 50%);
  2026-09-10 12:00 起 V4.1 Flash 上线并降价:flash 2/0.04/8、pro 9/0.3/27 未变;
  旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 按公告路由到 V4.1 Flash 并按 Flash 价计费。
  **2026-09-14 12:00 的 `deepseek-v4-pro` 路由变更按用户要求暂不编码**,仅在价表注释与 README 留待办(到点加一段即可)。
- **改动**:
  1. 新增纯计算层 `dsh-vscode/src/pricing.ts`(不 import vscode):峰谷时段(周一至周五 + 周末全天闲时)、
     `pricingAt`(按 `effectiveFrom` 选段 + 峰/闲选档 + 最长前缀别名回落)、`computeCostCny`、默认价目历史表;`config.ts` 转出保持旧 import 路径。
  2. `dsh.pricing` 支持分段写法 `[{ effectiveFrom, peak, offPeak }]`,旧扁平写法兼容为「一段无生效期」;`chatPanel` 改为 `pricingAt(...)` 取档。
  3. **计费基准时点**改为会话最早事件时间(`ChatModel` 新增 `onSessionEvent` 回调 → `chatPanel.noteSessionStart`),
     打开面板的当刻不再影响口径(旧实现按当刻取档,跨 12:00/18:00 或跨调价日会把整段重算)。
  4. 单测 `src/pricing.test.ts` 20 项(时段边界/周末/调价切换/别名/折算/官方价表 offPeak=peak÷2);
     `package.json` 默认值同步 + 版本 0.9.2→0.9.3;README 与设置项描述同步。
- **验证**:vitest 全量 12 文件 114 passed;typecheck ✓;build ✓;`check-webview-js` ✓。
  真机反算(会话 `session-055ae4eb…`,首事件 9/9 20:55 北京、跨 9/10 12:00 调价):旧实现 ¥0.4511 → 新实现 ¥0.2255,
  与「每步按当时价档」的理想值 ¥0.2255 完全一致(该口径与限制已写进 README 已知限制)。
- **发布**:tag `v0.9.3`(全量),CI run [34575316996](https://github.com/kuaizhongqiang/dsh-ecosystem/actions/runs/34575316996) 五 job 全绿
  (Init / launcher / desktop / **vscode+Open VSX** / plugins 校验);Release 资产齐全
  (launcher portable+setup、desktop setup+blockmap+latest.yml、`dsh-vscode-0.9.3.vsix`);
  Open VSX 已上架 0.9.3(扩展内置「检查更新」可直接升级)。
- **决策记录**(用户委托):计费精度取「分段价目 + 整段按会话最早事件时间取档」(不逐时分摊,已知限制已入 README);
  旧模型名口径取**官方公告**(旧名路由 V4.1 Flash 并按 Flash 价)。

## 2026-09-11(dsh-ecosystem v0.9.2 发布 —— 代理支持无令牌服务器)

- **问题**:0.9.1 的本地代理强制要求 launch-token;连无认证(或仅靠 extraHeaders)的 dsh 时会报「代理启动失败(令牌缺失)」。
- **修复**:token 可选 + 复用连接层会话 cookie(`DshConnection.cookieHeader`);启动后预检根路径,401/403 明确提示
  `auth-required`(引导填 `dsh.token` 或改用启动器),网络失败提示 `unreachable`;超大请求体改为流式透传(不再截断)。
- **验证**:代理单测 8 项;vitest 96 passed;typecheck/build ✓。
- **发布**:tag `v0.9.2`,CI 五 job 全绿,Open VSX 已上架 0.9.2,Release 资产齐全。

## 2026-09-11(dsh-ecosystem v0.9.1 发布 —— 无 seam dsh 的本地兼容内嵌)

- **背景**:0.9.0 在连官方发布版 dsh(无 embed seam)的机器上只能降级「浏览器打开」。
- **方案**:扩展侧本机回环代理 `src/embed/embedProxy.ts` —— launch-token 换上游 cookie 后转发
  HTTP/WebSocket(401 自动刷新重试、绝对 Location 重写、set-cookie/浏览器身份头剥离);
  seam 缺失且有 token 时自动走代理内嵌,代理失败仍降级浏览器打开。
- **验证**:代理单测 5 项(cookie/Host/401 重试/Location/相对重定向/POST);vitest 93 passed;
  真机:代理直连运行中的 dsh 3080 → 首页 200 + `__DSH_BOOT__` 注入。
- **发布**:tag `v0.9.1`,三组件 bump 0.9.0→0.9.1,CI 五 job 全绿,Open VSX 已发布 0.9.1。

## 2026-09-11(dsh-ecosystem v0.9.0 发布 —— M1/M2/M3 三 milestone 交付)

- **发布**:tag `v0.9.0`,三组件 bump 0.8.5→0.9.0;CI 五个 job(init/launcher/desktop/vscode+Open VSX/plugins)全绿;
  Release 资产:launcher portable+setup、desktop setup+latest.yml+blockmap、vscode vsix;Open VSX 已上架 0.9.0。
- **M1 launcher UI**:分区化信息架构(顶部固定概览条+分区跳转+折叠卡片)、`/api/ui-state` 展开/日志偏好持久化(原子写)、
  概览聚合、生态包 sha 明细、连接列表、日志工具条(只看错误/暂停跟随/环形缓冲)、`/api/open`。
- **M2 dsh-vscode**:侧栏 `dsh.web` 内嵌 dsh web(seam 认证;缺失/版本不兼容时降级浏览器打开)、聊天中聊天(独立子会话卡片)、
  编辑器上下文注入(选中/当前文件)、断线保活提示、embed seam 版本兼容矩阵。
  认证 seam 实现在 dsh 本体(本地 `browser-auth`:capability + `/api/embed/open`,embed=1 时 SameSite=None/Partitioned),
  上游未推;真机:真 VS Code 侧栏渲染 + 扩展生产连接层流式 `STREAM-OK`(920ms)。
- **M3 agent-memory**:新增 `dsh-plugins/plugins/agent-memory-codegraph-dsh-plugin`(本地增强层 MCP server,8 个 code_* 工具,
  TEAM_ID 隔离、失败显式报错);profile 注入后线上已生效(code_graph_list/search/callers 实测)。
- 验证:launcher `tsc`+build;vscode typecheck+vitest 88 passed+build+vsce;connection 包 170/170;`verify-release.mjs` OK。

## 2026-09-09(dsh-ecosystem v0.8.5 发布 —— 一键升级插件真正下发)

- **发布**:tag `v0.8.5`(基于 B 分支交付修复 + 插件集重钉),三组件 bump 0.8.4→0.8.5。
- **修复(launcher 一键更新 B 分支)**:此前「发现新插件集」分支会要求 target 提交自身的清单自钉
  (两段式发布不可能满足)→ 从未真正下发过新插件。改为**以伞仓 HEAD 自声明清单为准**安装:
  `runPull` 新增 `manifestObject`(直接接收 HEAD 清单),目标检出仅做 sha256 供应链校验;
  `syncPluginsSourceRobust` 补「目录缺 .git(中断遗留)自动重建」。
- **插件集重钉**:`dsh-launcher/ecosystem.json` 的 plugins.source.commit 9a6427e → 本版(含
  v0.8.0 后 launcher 插件重启 seam 等真实内容);老机器(0.8.0–0.8.4)一键更新将进入 B 分支
  **真实验证通过**(沙盒 DELIVERY-TEST:对齐 target → sha256 全过 → 落盘新 lock)。
- 注意:老版本 launcher(≤0.8.4)的 B 分支仍带旧自检,请先升级 launcher 到 v0.8.5 再一键更新。

## 2026-09-09(dsh-ecosystem v0.8.4 发布 —— launcher 一键更新兼容修复)

- **发布**:tag `v0.8.4`(main 基于 `b1a6756` 修复 commit + release prep),三组件 launcher/vscode/desktop 统一 bump 0.8.3→0.8.4。
- **修复(launcher 一键更新/生态拉齐)**:旧布局(monorepo 化前 dsh-plugins.git 的 lock/检出)与中断/损坏
  检出现场会报「同步后的伞仓缺少清单 dsh-launcher/ecosystem.json」→ `loadUsableLock` 忽略旧布局 lock
  并告警迁移、`syncPluginsSourceRobust` 检出 origin 不符自动重建、`readManifestWithRepair` 缺清单自动
  重建重试;默认清单单一事实来源改为随包 ecosystem.json(构建期内联,消灭 src/json 双份漂移);
  新增 `scripts/pin-ecosystem.mjs` 发布重钉工具(--dry-run 预览)。verify-release.mjs 同步适配单一来源。
- 验证:launcher `npm run check`(tsc)与 esbuild bundle 通过;沙盒 T1 旧布局迁移自愈 / T2 全新默认回归 /
  T3 损坏检出自动重建 全绿。

## 2026-09-08(dsh-ecosystem v0.8.3 发布 —— vscode 侧边栏「优雅升级」)

- **功能(vscode 优雅升级)**:侧边栏首页功能入口区新增「检查更新」卡片(展示当前版本;
  发现新版时卡片高亮并带「升级」角标),一键检测 **Open VSX** 最新版 → 有新版自动下载 vsix →
  `workbench.extensions.installExtension` 静默安装 → 提示重新加载窗口生效;网络或安装任一步失败,
  自动回退打开 Open VSX 下载页手动安装。更新源只依赖 Open VSX API(免鉴权),不依赖 VS Code 官方市场
  更新推送(本插件未上架微软市场,README 已注明)。
- 实现:`src/updater.ts`(fetchLatestFromOpenVsx / compareVersions / downloadTo)+ 首页卡片渲染
  (`sidebarView.ts`/`sidebarViewHtml.ts`,snapshot.home 增 version/update)+ `dsh.checkUpdate` 命令
  (`extension.ts`,含 upgradeTo/openUpdatePage 兜底);package.json 登记命令并在命令面板隐藏。
- 验证:tsc 零错误、vitest **47 通过**(新增 updater 5 用例:版本比较 3 + vsix URL 2)、esbuild 构建通过、
  webview 内联 JS 校验通过。
- 文档:扩展 README(Open VSX 市场页同源,打包自动随 vsix)补功能/命令表/架构/「更新」小节;
  伞仓 docs/modules/dsh-vscode.md 与根 README 版本同步。
- **发布**:tag `v0.8.3`(main 基于 `bbb90c2` 功能提交 + release prep),三组件 launcher/vscode/desktop 统一
  bump 0.8.2→0.8.3;v0.8.2 侧边栏空白修复已验证覆盖在本次发布内。

## 2026-09-08(dsh-ecosystem v0.8.2 发布 —— vscode 侧边栏 webview 空白修复)

- **修复(vscode 侧边栏不可用,用户真机反馈)**:v0.8.1 卡片化侧边栏打开后仅显示静态标题 "dsh" 与原生按钮,
  主内容空白、按钮无反应。根因 = `dsh-vscode/src/sidebarViewHtml.ts` 外层为反引号模板字符串,内层 JS 的
  `sv.logs.join('\n')` 中 `\n` 在 TS 编译时被**求值为真实换行符** → 渲染出的 HTML 内联 `<script>` 出现跨行
  字符串字面量 → `SyntaxError: Invalid or unexpected token` → 整个 `<script>` 块解析失败,前端 JS 完全不执行。
  修复:转义写成 `'\\n'`(模板求值后得到合法 `\n` 换行转义),一行改动(commit c054dfc)。
- 验证(Linux 无头 VSCode 真机):诊断探针确认 resolveWebviewView→html set→快照推送正常但 probe 无回传;
  修复后 probe 回传、首页卡片完整渲染(工作区/连接状态/功能列表/操作按钮)、点击会话列表导航消息正常回流;
  清理探针后回归:tsc 零错误、vitest 42 通过、esbuild 打包通过、伞仓 verify-release OK。
- **发布**:tag `v0.8.2`(main 基于 c054dfc),三组件 launcher/vscode/desktop 统一 bump 0.8.1→0.8.2。

## 2026-09-07(dsh-ecosystem v0.8.1 发布 —— launcher 一键更新插件 / 仪表盘 UI / vscode 提问修复与卡片侧边栏)

- **功能(launcher 一键更新插件 M9)**:新端点 `POST /api/ecosystem/update` —— git 同步最新生态源 HEAD →
  读伞仓自声明清单(锁定的**插件集提交**与仓库 HEAD 解耦:release 才重钉,main 前进不等于插件集变化)→
  检出对齐插件集 → runPull 安装/更新插件与技能 → 可选 `restartActive` 重启 dsh;新增
  `ecosystem.latestEcosystemCommit / syncPluginsSourceTo(增量 fetch 不破坏既有检出) / readManifestAt`;
  UI 生态区「一键更新插件」主按钮,与拉齐 busy 互斥,进度走 SSE 日志。无头冒烟验证全链路
  (Linux 无法执行 install.ps1,安装段需 Windows 真机)。
- **UI(launcher v0.9 仪表盘)**:顶部 5 状态磁贴(Node/npm/dsh/端口/更新)+ 运行控制条 + 安装/版本面板 +
  插件技能面板 + 日志控制台;标题栏内置连接切换 pill;仅消费 tokens.css 设计令牌。
- **修复(vscode 提问空答案)**:根因 = 应答走旧包裹 `{sessionId, answer:{answers}}`,而当前 DSH typert
  remote 瀑布流把 `$events/result` outcome.value 原样返回给 ask 工具(期望裸 `{answers}` / 审批裸字符串)
  → `result.answers` undefined → 空答案。改为裸领域值;提交成功本地翻转提问/审批卡片
  (questionRpcId 此前恒为空,卡片停留"已提交")。
- **功能(vscode 侧边栏卡片化 issue#3)**:原生 TreeView 改 WebviewView 卡片侧边栏
  (`sidebar.ts` → `sidebarView.ts` + `sidebarViewHtml.ts`),会话按工作区分组卡片,图标/色块区分层级不再靠缩进;
  服务/配置/插件/模式视图全卡片化;命令支持 sessionId 参数(无参 QuickPick 兜底)。
- 验证:launcher/vscode tsc 通过、vscode vitest 42 用例通过、esbuild 构建通过、无头 launcher 冒烟通过。
- **发布**:tag `v0.8.1`(main `a061637`),三组件 launcher/vscode/desktop 统一 bump 0.8.0→0.8.1。

## 2026-09-05(launcher 插件重启编排 seam —— 档 1 hook 落地)

- **问题**:`launcher_restart` 跑在 dsh 进程内,重启会杀掉本进程与进行中的回合/后台任务,自助重启后
  「无法持续工作」。查证:官方 harness 无进程级生命周期钩子(仅 tool-call 级 hooks 包);插件面支持
  listen Events/注册 Service,但 before-shutdown 事件是否存在未确认(档 2 可继续深挖);会话历史与
  goal 跨重启存活(resume 后 disarm)是恢复基础。用户拍板走**档 1:纯插件 seam**。
- **实现**(dsh-plugins launcher 插件,改动文件):
  - `plugins/launcher/index.js`:`launcher_restart` 新增 `reason` 参数,触发前原子写
    `%DSH_HOME%\.dsh-restart-intent.json`(`{version,requestedAt,reason,byPid}`,无 token,D2 合规);
    `launcher_status` 展示重启意图(本进程是否晚于意图 = 重启后待恢复,摘要带 ⚠️ 提示与恢复动作),
    新增可选 `clearRestartIntent=true` 确认清除;返回信息附恢复指引。
  - `skills/install-launcher/SKILL.md`:新增 §3a「重启编排 seam」恢复流程(先 `update_goal resume`
    再继续,完成后清除意图);§0 定位改伞仓 monorepo 路径(旧独立仓已归档)。
  - 插件 README 工具表 + seam 说明同步。
- 语法 `node --check` 通过;未改 install.ps1 → 清单 sha 不变。
- **下一步**:随下个全量发布(v0.8.1)真机验证「launcher_restart(reason)→ 重启 → launcher_status 见意图 →
  update_goal resume 继续 → 清除」闭环;可选档 2:查 core Cordis Event 面是否有 before-shutdown 可挂真钩子。

## 2026-09-05(dsh-ecosystem v0.8.0 全量发布成功 —— 首次 monorepo 真实发布)

- **发布**:tag `v0.8.0`(main `2a85ea6`)→ 伞仓根 release.yml 触发,CI **5/5 job 全绿**:
  init(release 重建 6s)/ launcher(3m6s,portable+NSIS+双 smoke)/ desktop(2m38s,NSIS+latest.yml)/
  vscode(22s,vsix+Open VSX)/ plugins(verify-release 7s)。
- **渠道核验**:GitHub Release v0.8.0 资产 6 项(launcher.exe/setup、desktop setup+blockmap+latest.yml、vsix);
  **Open VSX** `kuaizhongqiang.dsh-vscode` 0.8.0 上线;npm `@kuaizhongqiang/dsh-desktop` 0.8.0 上线。
- **排障记录**(同类幂等/一致性 bug 全量排查,已固化为 CI 行为):
  1. **plugins verify sha 漂移**:blob 存 LF、Windows autocrlf 检出 CRLF → 本地/历史 sha(CRLF)与 CI(LF)不一致。
     修复:根 `.gitattributes` `*.ps1 text eol=crlf`,全平台检出一致(供应链清单 sha 基于 CRLF,无需改哈希)。
  2. **Open VSX 重复发布**(首跑其实已发布 0.8.0,索引延迟造成误判重发失败):发布前查 open-vsx.org 版本,已存在即 skip(幂等)。
  3. **desktop npm 重复发布**:`npm view` 查版本,已存在即 skip(幂等)。
  - 技术备忘:step 级 `if: env.X` 读不到同步骤 env(首次 vsx 被静默跳过,后改 shell 守卫);release.yml init `--notes`
    多行未缩进会坏 YAML(块标量);gh release delete 保留 git tag,重跑同 tag = 删 tag+release 重打。
- **下一步**:真机冒烟(v0.8.0 安装/托盘/`pull` 插件从伞仓锁定 commit 拉取);旧 0.7.x(运行时源为归档仓)用户
  升级路径说明;组件内旧文档对归档仓引用清扫。

## 2026-09-05(发布流程重做 —— 全量 tag 自动化,待真实发版验证)

- **决策**:用户拍板「一个 tag 搞定所有包」全量发布 + 源仓(5 个)已完成 GitHub 归档(只读)。
  伞仓 = 唯一权威代码/发布仓;发布 = 打 `vX.Y.Z` → 伞仓根 CI 全量构建并发布。
- **已完成(提交 9a6427e + f69f29f,已推 main)**:
  - `dsh-remote` 组件**完全移除**(目录 + docs/modules/dsh-remote.md + 全部引用清理;内容在归档仓可查)。
  - `.github/workflows/release.yml`:push tag `v*` → init(幂等重建 release)→ launcher/desktop/vscode 并行
    构建上传资产到该 release + plugins 校验;vscode 有 `OVSX_PAT` secret 时发布 Open VSX;desktop 有
    `NPM_TOKEN` 时顺带发 npm。
  - **launcher 运行时源切伞仓**(源码改):插件源 repo/commit + dir/skills 前缀 `dsh-plugins/`、
    默认检出根 `dsh-ecosystem`(ecosystem.ts 内嵌 + ecosystem.json 同步,commit 指向 9a6427e);
    自更新 URL(update.ts)→ kuaizhongqiang/dsh-ecosystem/releases;desktop electron-builder
    publish.repo → dsh-ecosystem(updater feed);launcher 未找到提示 URL 同步改。
  - 版本统一 bump **0.8.0**(launcher/vscode/desktop package.json);`scripts/verify-release.mjs` 发布门
    (7 包 install.ps1 + skills sha、repo/commit 与内嵌同步);RELEASING/README/.AGENT/modules/release-notes 同步。
  - 归档后 clone 链路验证:`clonePinned` 等价操作(浅取伞仓 @9a6427e)文件/哈希全匹配;launcher `tsc` 零错误;
    release.yml 本地 YAML 校验通过(修掉 init `--notes` 换行缩进 bug)。
- **待办(等用户)**:①用户已去加伞仓 Actions secret `OVSX_PAT`(Open VSX);②加好后打 `v0.8.0` tag →
  `gh run` 盯 CI → 修到发布成功(资产上传 + vscode 上 Open VSX);③成功后补模块页版本快照与真机冒烟。
- 遗留清扫项(非阻塞):组件目录内旧文档对已归档仓/旧 submodule 的引用;desktop/npm 渠道观察。

## 2026-09-04(伞仓 monorepo 化 —— 阶段 A 代码收敛完成)

- **决策**:用户拍板「归档 = 收敛到伞仓 monorepo」——5 自有组件并入伞仓单一 git,源仓归档只读;
  设计定稿 `docs/MONOREPO-UMBRELLA.md`(D-M1 = squash 快照 / D-M2 = 手动发版 SOP / D-M4 = 组件内
  嵌套 submodule 清除 / D-M6 = 禁 force push);直接工程形态(RESTRUCTURE)被本形态演进取代。
- **执行(阶段 A)**:
  - 探针:5 源仓历史很小(55/33/44/23/2 commits);**launcher/vscode/desktop 挂 GitHub Actions**
    (release/ci,vscode 含 Open VSX 管线)——归档即停摆,D-M2 定手动 SOP;
    launcher 与 desktop 原仓各带嵌套 .gitmodules(空占位子模块)。
  - 提交 `cc0db2c`(monorepo 设计定稿)、`f24cfcb`(代码收敛:264 文件 48898 行,5 组件以快照并入,
    嵌套 .git/.gitmodules/空占位目录清除,`.gitignore` 撤销组件忽略)+ 文档第三轮同步。
  - 并入快照:launcher `979cec6`(v0.7.3)/ plugins `7a1b8a9` / vscode `1756889` / desktop `250abfb` /
    remote `4f755d2`;harness 子模块指针 `47f94385` 不变(唯一 submodule)。
- **技术备忘**:跨盘 `Move-Item`(G:→C:)在删除只读 `.git` 对象时失败并把源内容移空——因源仓
  (GitHub)= 真源,直接重新 clone 恢复,**无数据损失**;教训:处理含 .git 的目录用「清只读属性 →
  就地删 .git」而非跨盘移动。
- **形态演进速记**:①文档 + 6 gitlink → ②直接工程(5 独立 git 检出)→ ③monorepo(当前,源仓待归档)。
- **下一步(阶段 B,用户启动)**:逐仓在 GitHub UI 归档(remote → desktop → vscode → plugins → launcher);
  手动发版 SOP 落地(见 RELEASING.md);后续工作项:伞仓根重建 CI/Open VSX 管道(D-M2(b))、
  组件内部旧 submodule 文档清扫、组件目录版本推进后刷新 modules 快照。

## 2026-09-04(伞仓形态改造:直接工程 + harness 唯一 submodule)

- **背景/决策**:原「文档 + 6 gitlink 版本锁」仪式成本高(尤其伞仓顶层与 launcher 内层两处 dsh-plugins
  指针独立 bump);过时的本地开发根(F:\Project\dsh-dev 等)已不存在。用户拍板改造为
  **文档 + 5 自有仓直接工程 + dsh 本体(deepseek-harness)唯一官方 submodule**;设计定稿
  `docs/RESTRUCTURE-UMBRELLA.md`(决策 D-R1–R5、五阶段迁移、回滚 = revert 去 submodule commit)。
- **执行**:伞仓 `git rm --cached` 5 仓(去 gitlink)→ `.gitmodules` 只留 harness → 根 `.gitignore`
  忽略 5 直接工程目录 → 逐仓完整 clone 落位(各自 main HEAD)→ 文档全量同步
  (README / .AGENT.md / docs/modules×7 / RELEASING / 本日志)→ 推 main。
  伞仓本地提交:`f4e8275`(设计)、`400cc0e`(去 submodule)。
- **改造后各仓 HEAD(快照,权威值见仓内 `git log -1`)**:
  - launcher `979cec6`(v0.7.3,含 ue-mcp 默认 OFF 同步 dsh-plugins 7a1b8a9)
  - plugins `7a1b8a9`(fix(ue-mcp):default OFF opt-in)
  - vscode `1756889`(feat:launch-token 增量整合)
  - desktop `250abfb`(fix(tray):close-to-tray 保活)
  - remote `4f755d2`(远程部署记录)
  - harness 子模块指针 `47f94385`(未检出,按需 `git submodule update --init`)
- **顺带补记**(此前未写日志的两笔 bump):plugins `79edc23`(stock v0.2.0 交易层入库 + 日周期时间模型)、
  launcher `1dd0acb`(dsh-stock v0.2.0 运行时源连锁)——现均已被上述更新 HEAD 取代,快照以工作树为准。
- **新工作流**:自有仓改动 → 目录内 git add/commit/push(各自 origin);伞仓只提交 docs/ 与元数据;
  **禁止对 5 直接工程目录 `git add`**;版本发布仍在各仓;伞仓 release 语义简化(见 RELEASING.md)。
- **遗留/下一步**:launcher 内层 dsh-plugins 子模块(runtime source)仍存在,属 launcher 仓内部结构,
  单列后续工作项(本次不触碰);docs/modules HEAD 快照随各仓推进手动刷新;Open VSX 发布待 OVSX_PAT、
  真机验证清单沿用上轮(离线 setup / 托盘重启 seam / remote 跟随 / PM3 插件全链 / profile pack 双机回传)。

## 2026-09-03(三仓发版 + vscode 协议对齐)

- **dsh-launcher [v0.7.0](https://github.com/kuaizhongqiang/dsh-launcher/releases/tag/v0.7.0)**:main 版本 0.6.4→0.7.0(`8aa28c4`)、构建 portable+NSIS(electron dist 就绪后 dist:all 成功)、GitHub Release 双产物(85.2/85.4 MB)已上传
- **dsh-plugins [v0.7.0](https://github.com/kuaizhongqiang/dsh-plugins/releases/tag/v0.7.0)**:tag 于 main `02b61f9`(PM1–PM4 新集合)
- **dsh-ecosystem [ecosystem-2026.09](https://github.com/kuaizhongqiang/dsh-ecosystem/releases/tag/ecosystem-2026.09)**:首个生态快照 Release(指针表 + 使用说明,tag 于 main a400ee2)
- **dsh-vscode**:M0 协议对齐 —— `clearLaunchToken(source, pid?)` source+pid 双匹配+复读确认(对称 P0-4)、`managedBy` 兼容字段、launchToken 测试 12 用例(vitest 40 全过)、版本 0.2.9→**0.3.0**;分支 `feat/launch-token-source-pid` 已推并合 main([PR #17](https://github.com/kuaizhongqiang/dsh-vscode/pull/17),5c0a388);**Open VSX 发布待用户 OVSX_PAT**
- 发版技术备忘:gh release create 的文件参数在 Windows 反斜杠/相对路径下 glob 失败 → 先建 Release 再用 uploads.github.com REST 传资产(绝对路径);PS 5.1 读无 BOM UTF-8 = ANSI 的坑再次确认(package.json 版本替换必须 [IO.File]+UTF8)

## 2026-09-03(全部推送落地,伞仓指针 bump —— 路线图实施收官)

- **dsh-plugins**:`feat/pm1-pm2-media-deepseek` 推送并经 [PR #7](https://github.com/kuaizhongqiang/dsh-plugins/pull/7) 合入 main(main=02b61f9,含 PM1–PM4,新集合 11→7)
- **dsh-launcher**:9 段分支逐一推送 + PR + 合入 main —— [PR #11 M0](https://github.com/kuaizhongqiang/dsh-launcher/pull/11)(b4f9b0a)、#12 M1、#13 M2、#14 M3、#15 M4、#16 M5、#17 M6、#18 M7+M8、[#19 PM4 联动](https://github.com/kuaizhongqiang/dsh-launcher/pull/19)(main=2e3ae87,含 M0–M8 全量 + 内层 dsh-plugins gitlink 9f47279)
- **伞仓 bump**(commit `b43af95`,已推 main):`dsh-launcher → 2e3ae87`、`dsh-plugins → 02b61f9`(update-index --cacheinfo,子模块目录保持未初始化惯例)
- **里程碑状态:M0–M8 + PM1–PM4 全部实现、验证(172 用例)、留痕、推送、指针落地** ✅
- 待办(交给用户/后续):
  - 生态快照 release(`ecosystem-2026.09`):按 docs/RELEASING.md 流程即可,是否切 tag 留给用户(此前决议:先定流程不实际切)
  - 真机验证点汇总:离线包新机 `setup --offline`、托盘/重启 seam(打包 exe)、remote 连接跟随、PM3 插件会话内全链、profile pack 双机回传
  - 技术备忘:launcher 内 npm allow-scripts 门禁会拦 electron/koffi postinstall,打包前需批准;pnpm 勿用于该仓

## 2026-09-03(PM3+PM4 编码完成 —— 全部里程碑编码收官)

- **PM3(dsh-plugins 仓,同分支,commit `9f47279`)**:`plugins/dsh-launcher-dsh-plugin` —— 5 工具(launcher_restart/status/connections/open/check_update),ESM defineTool;发现链(D6/M6):`DSH_LAUNCHER_EXE` → 注册文件(心跳+pid 复核)REST bridge 优先、其次 `<launcherExe> restart` → 手动指引;connections 切换写 D8 标记;输出全脱敏(token=***);无新凭证;`skills/install-launcher/SKILL.md`
- **PM4(双仓联动)**:
  - dsh-plugins:skills **11→7**(新增 install-media/install-deepseek/install-launcher,删旧 7 技能;install-skills.ps1 自动发现无需改);README 切新集合
  - dsh-launcher(分支 `feat/pm4-manifest-flip`,commit `abbc2a4`):默认清单(内嵌 + 根 ecosystem.json)切 **7 包**(dsh-media/dsh-deepseek/dsh-credentials/dsh-github/dsh-stock/dsh-unity/dsh-launcher,逐包 install.ps1 sha256 重算,锁 dsh-plugins `9f47279`);**内层 dsh-plugins 子模块 gitlink bump → 9f47279**(经 local remote fetch 本地分支;推送顺序:dsh-plugins 先推,launcher 后推)
- 验证:pm3 **13/13**(安装/幂等/卸载/patch/结构/发现链断言)、pm4 **8/8**(7 技能发现/安装落位/一致性);launcher 回归 m1 15 + m2 13 + m7 8 + m8 8 全绿
- **里程碑编码状态:M0–M8(launcher)+ PM1–PM4(plugins)全部完成**;验证用例合计 **172**
- 剩余(下轮「最终」):dsh-plugins 推 feat 分支 → launcher 逐分支 rebase/推送 + PR → 伞仓 bump 顶层 dsh-plugins 子模块指针 → 可选生态快照 release
- 真机验证点:PM3 插件真实 dsh 会话安装后 `launcher_status/restart` 全链(需 launcher M6 版)

## 2026-09-03(PM1+PM2 编码完成,本地提交)

- **PM1+PM2(dsh-plugins 仓,分支 `feat/pm1-pm2-media-deepseek`,commit `40ebb0e`,未推送)**——Phase §8 前两步落地:
  - **PM1 分层规范+模板**:`docs/PLUGIN-SPEC.md`(五层/准入三问/包结构/install.ps1 七条规范:幂等、-Only、-Uninstall、节头 `# --- dsh-<pkg>: <svc> ---`、cordis.patch 合并剥 `[]`、凭证红线、额外步骤可重跑)+ `_templates/install.ps1.tmpl`、`_templates/SKILL.md.tmpl`
  - **PM2 合并包**:`plugins/dsh-media-dsh-plugin`(感知五合一,6 工具,payload 平铺复制,-Only/-Uninstall,describe-image 的 apiproxy 补丁与 document-read 的 python 探测保留为可重跑步骤)+ `plugins/dsh-deepseek-dsh-plugin`(账户二合一);仓库根 `uninstall-old.ps1`(旧 7 包载荷删除 + patch 节按旧节头精确剥离,-Skills 可连旧技能清);旧 7 包各加 `DEPRECATED.md`(保留一个 deprecated 周期);README 增 PM1/PM2 段
  - 验证:新增 `scripts/verify-pm2.mjs`——**23 用例全过**(真 PowerShell:全量安装+幂等 7、-Only 子集 4、-Uninstall 3、dsh-deepseek 3、uninstall-old 迁移闭环 6)
  - 技术备忘:PowerShell 5.1 对无 BOM UTF-8 按 ANSI 解析,中文注释会破坏字符串——**新写 .ps1 必须带 UTF-8 BOM**(已修)
  - 真机验证点:本机 `dsh-media install.ps1` 全量 + `-Only` 子集装进真实 profile,重启后工具可用
- 下一步:PM3(dsh-launcher 插件:launcher_restart/status/connections/open/check_update + install-launcher 技能,消费 M5/M6 seam)→ PM4(skills 11→7、launcher 默认清单切 7 包 + 子模块联动)

## 2026-09-03(M7+M8 编码完成,本地提交)

- **M7+M8(dsh-launcher 仓,分支 `feat/m7-m8-setup-lock`,commit `5cdc85c`,未推送)**——Phase 7/8 落地:
  - **M7 setup 一条龙**(`src/setup.ts` 新增):`setup [--manifest] [--offline] [--connection] [--profile-dir|--profile-in --password] [--plugins] [--no-start] [--update-lock]` —— core(缺口/离线)→ pull(插件+skills,lock 优先;离线时信任 `<offline>/plugins` 目录)→ 个人层(可选)→ 连接 → start;GUI「一键部署」按钮(confirm 后走 `POST /api/setup`,202 异步 + SSE 进度)
  - **M8 版本 lock**(`ecosystem.ts`):`ecosystem-lock.json`(launcher 旁)——首次默认 pull 自动写;**无显式清单时 pull 一律收敛到 lock**(多机一致);显式 `--manifest` 不触碰 lock;`--update-lock` = 确认升级(写新 lock);`check-update` 有更新时提示「pull --update-lock 确认升级」;回传 = profile push/pull(M4 通道,LWW)
  - 验证:`verify-m7.mjs` **8/8**(离线 core + pull + 个人层 + lock 无头 e2e);`verify-m8.mjs` **8/8**(lock roundtrip/默认收敛/显式不动 lock/确认升级/回传提示);`tsc --noEmit` 与 `npm run build` 零错误
  - 真机验证点:U 盘离线包新机 `setup --offline …` 全自动;两台机器 lock 收敛;B 机 `profile push` 回传 pack
- **dsh-launcher M0–M8 全部编码完成**;分支链 main(M0)→ m1 → m2 → m3 → m4 → m5 → m6 → m7-m8(`5cdc85c`),待 M0 PR #11 合并后统一 rebase 推送
- 下一步:PM1–PM4(dsh-plugins:分层规范/模板重构、dsh-media+dsh-deepseek 合并、dsh-launcher 插件、默认清单 11→7)

## 2026-09-03(M6 编码完成,本地提交)

- **M6(dsh-launcher 仓,分支 `feat/m6-tray-restart`,commit `b7cdf31`,未推送)**——Phase 6 落地:
  - **托盘常驻**(`electron-main.ts` + `trayIcon.ts`):Tray 菜单(显示窗口/启动/停止/**重启**/打开浏览器(按激活连接)/连接切换 submenu(点击即 use+restart)/检查更新/退出(停止 dsh));图标状态色**运行时生成 16×16 纯色 PNG**(灰=未运行/绿=运行中/黄=有更新/红=异常,免资源文件,15s 轮询刷新);启停/重启/连接切换气泡通知
  - **关窗行为**:`closeAction` 默认 `'tray'`(标题栏 ×=隐藏到托盘,dsh 继续跑);`'exit'` 保留旧「关窗即停」;UI「退出」按钮/托盘退出=真退出(preload 新增 hide 通道,x 与退出分流)
  - **重启 seam**(`registration.ts` + `launch.ts` + `server.ts` + `cli.ts`):
    - `%DSH_HOME%\launcher-registration.json`(0600 原子写):`{version, launcherExe, launcherVersion, dshInstallDir, pid?, api?, bridgeKey?, running, registeredAt, updatedAt}`;便携版经 `PORTABLE_EXECUTABLE_DIR` 解析原始 exe 路径(dev 跳过注册);**spawn 成功注册、stop/退出注销(owned 保护防误删他人注册)**;心跳 ≤30s(server 就绪 `setBridge` 补写 api/bridgeKey)
    - spawn 注入发现链环境变量 `DSH_LAUNCHER_EXE` / `DSH_LAUNCHER_PID` / `DSH_LAUNCHER_CONNECTION`;`launch-token.json` 增可选 `managedBy`(读取方忽略未知字段)
    - `restartActive()`:优雅 stop → 等端口释放 → start(重抓 token 照写,30 天 cookie 免重登);remote=重连/重开浏览器
    - REST bridge `POST /api/dsh/restart?key=<bridgeKey>`(127.0.0.1+随机密钥,403/409/202);CLI `restart` 单实例转交(注册新鲜+pid 存活+api 健康 → 转交,否则本机执行);GUI 重启按钮
  - 验证:新增 `scripts/verify-m6.mjs`(`npm run verify:m6`,先 build)——**21 用例全过**:trayIcon PNG 4 + registration 7 + managedBy 1 + restart seam e2e 5(错 key 403/对 key 202/注册获得 bridgeKey)+ CLI 兜底 1 + 源码断言 3;`tsc --noEmit` 与 `npm run build` 零错误
  - 技术备忘:`version.ts` 的 package.json 导入补 `with { type: 'json' }`(Node 直载 TS 需要,esbuild 兼容)
  - 真机验证点:打包 exe 后托盘图标四态/关窗到托盘/气泡;真实 dsh 重启免重登;dsh 侧经 DSH_LAUNCHER_EXE/注册文件委托重启(跨仓,落 PM3 插件)
- 分支链:…→ feat/m5(M5 `2862da4`)→ feat/m6(M6 `b7cdf31`);待 M0 PR#11 合并后统一 rebase 推 M1–M6
- 下一步:M7(setup 向导整合:GUI 首启向导 + `setup --all` 无头)/ M8(版本 lock + 回传)

## 2026-09-03(M5 编码完成,本地提交)

- **M5(dsh-launcher 仓,分支 `feat/m5-connections`,commit `2862da4`,未推送)**——Phase 5 落地:
  - `src/connections.ts`(新增):connections.json v1(local/remote 组,remote token 可空=交由 Cloudflare Access;extraHeaders 字段对齐 vscode);**无文件时按 launcher.json 合成默认连接(不落盘,向后兼容)**;原子写(D8 ④:tmp+rename)、`.dsh-connection-changed` 变更标记(D8 ③)、**D8 ② 端口锁** `.dsh-port-<port>.lock`(他组活跃 PID 拒绝/自身放行/陈旧锁覆盖,spawn 前检查+退出清理);`buildRemoteTarget` 纯函数(token 追加 ?/&);损坏文件降级(告警+合成默认,不阻断启动)
  - `src/launch.ts`:start 跟随激活连接——**remote=不 spawn,健康检查(token 自检 401 提示更新、no-auth 提示外部认证)后带 token 开浏览器,并照写 v1 launch-token.json(兼容层:desktop 完全跟随/vscode token 跟随)**;local=连接端口覆盖 launcher.json 端口 + 端口锁闭环;stop 跟随语义(remote no-op)+ 锁清理;stopChildSilently 清锁
  - `src/cli.ts`:`connections list|add|use|remove`;`start [--connection <id>]`;`stop/status` 跟随激活连接(remote=HTTP ping);usage 更新
  - GUI(`server.ts`+`ui/`):连接切换器下拉(首行状态卡上方);`GET /api/connections`(token 不出后端,只回 hasToken)、`POST use/add/remove`;`/api/status` 带 `connection` 字段,remote 时端口行显示 remote 语义
  - 验证:新增 `scripts/verify-m5.mjs`(`npm run verify:m5`,先 build)——**29 用例全过**:单元 9(合成/增删改查/校验拒/原子写/标记)+ 端口锁 4 + remote target 3 + CLI e2e 6 + UI e2e 7(token 不泄漏/切换/状态带连接/切换器注入);`tsc --noEmit` 与 `npm run build` 零错误
  - 真机验证点:真实 remote 组(Cloudflare Access)健康检查+开浏览器+desktop/vscode 跟随;本机双端口双实例 + 端口锁拒绝第二监督者
- 分支链:…→ feat/m4(M4 `7de57b1`)→ feat/m5(M5 `2862da4`);待 M0 PR#11 合并后统一 rebase 推 M1–M5
- 下一步:M6(托盘常驻 + 重启 seam:DSH_LAUNCHER_EXE 注入、launcher-registration.json、restart 委托)/ 先推 M1–M5 PR

## 2026-09-03(M4 编码完成,本地提交)

- **M4(dsh-launcher 仓,分支 `feat/m4-profile-pack`,commit `7de57b1`,未推送)**——Phase 4 落地:
  - `src/profile.ts`(新增):白名单同步(settings.yaml / profiles/web/cordis.patch.yml / profiles/web/plugins/ / skills/ / stock/watchlist.json / stock/reports/)+ 显式排除(sessions、attachments、storages、llm-deepseek、node_modules、.git、.dsh-module-fallback、stock/daily、.dsh-memory-autostore-state*、kline-cache*)+ **红线 D2**(.credentials.yaml / launch-token.json / connections.json / .anonymous-user-id 永不进同步);`profile push`(镜像 + replace 语义 + profile-pack.json 清单含 sha256)/`profile pull`(按清单恢复,sha 校验不符即中止,红线永不恢复);`profile export/import` 加密容器(魔数 DSHPP1 + scrypt 派生 + AES-256-GCM,口令走 DSH_LAUNCHER_PROFILE_PASSWORD 或 --password——免外部 age 依赖的内置实现)
  - `src/cli.ts`:`profile push|pull|export|import` 子命令 + usage
  - 验证:新增 `scripts/verify-m4.mjs`(`npm run verify:m4`)——**13 用例全过**:push 白名单/噪音剔除 4 + pull 恢复 4 + 加密容器 roundtrip/错口令拒绝 4 + exclude 1;`tsc --noEmit` 与 `npm run build` 零错误
  - 真机验证点:本机 `profile push --dir <U盘pack>` → 新机 `profile pull` / `profile import`(口令三选一之 a 手填凭证 / b 加密包 / c 私有仓仍由用户选)
- 分支链:…→ feat/m3(M3 `3fa5866`)→ feat/m4(M4 `7de57b1`);M0 PR #11 合并后依次 rebase 推 M1–M4 PR
- 下一步:M5(connections.json 多连接 + launch-token v1 兼容层 + D8 端口锁/active 标记/原子写)/ 先推 M1–M4 PR

## 2026-09-03(M3 编码完成,本地提交)

- **M3(dsh-launcher 仓,分支 `feat/m3-runtime-offline`,commit `3fa5866`,未推送)**——Phase 3 落地:
  - `src/node.ts` 运行时自持段:runtime 根 `%LOCALAPPDATA%\dsh\runtime`(`DSH_LAUNCHER_RUNTIME_DIR` 可覆盖);`ensureRuntimeNode`(node.exe 就绪校验/下载 node-v<ver>-win-x64.zip/系统 tar→PowerShell 解压/提升到 runtime 根;mirror 缺省 nodejs.org,支持本地路径镜像与 `DSH_LAUNCHER_RUNTIME_FAKE` 测试缝);`resolveNodeExe` 优先级 **DSH_LAUNCHER_NODE_EXE > 便携 runtime > 系统 node > 下载**;`childEnvForNode` PATH 注入(仅便携时,不污染系统)
  - `src/launch.ts`:启动 dsh 改用解析出的 node 可执行 + 注入 env
  - `src/install.ts`:`runOfflineInstall`——`install --offline <目录>`:offline/dsh(npm/github 布局自动识别)直装、offline/runtime 便携 node 落位、写 launcher.json;不触发网络/git/pnpm
  - `src/cli.ts`:install 支持 `--offline` + usage
  - 验证:新增 `scripts/verify-m3.mjs`(`npm run verify:m3`,先 build)——**14 用例全过**:离线 CLI 安装 5(直装/布局/配置/runtime 落位)+ 解析优先级 3 + PATH 注入 2 + 本地镜像 zip 解压提升 4;`tsc --noEmit` 与 `npm run build` 零错误
  - 真机验证点:无 Node 新机 `install --offline <U盘包>` 直装并启动;有网机器删除系统 node 后 `install`(github 源)走便携 runtime
- 分支链:…→ feat/m2(M2 `cb58055`)→ feat/m3(M3 `3fa5866`);M0 PR #11 合并后依次 rebase 推 M1/M2/M3 PR
- 待用户决策项(Phase 3 安装源降依赖):默认 source 仍为 github(git+pnpm 路径),npm 源保持一等支持;是否翻转默认留待 PM4/收敛时确认
- 下一步:M4(profile pack push/pull + 加密)/ 先推 M1–M3 PR

## 2026-09-03(M2 编码完成,本地提交)

- **M2(dsh-launcher 仓,分支 `feat/m2-eco-gui`,commit `cb58055`,未推送;基于含 M0/M1 的本地链)**——Phase 2 落地:
  - 后端 `src/server.ts`:`GET /api/ecosystem`(默认清单 label/dsh/锁 commit/11 包 + `ecosystem-state.json` + busy + pluginsDir);`POST /api/ecosystem/pull`(异步 fire-and-forget,body: plugins/core/skills/dryRun;busy 期间 409;进度走既有 SSE `/api/events`);桥接注入 `getEcosystem/pullEcosystem`
  - 前端 `ui/index.html` + `ui/app.js` + `ui/launcher.css`:**「生态」卡片**——清单元信息行、状态摘要(core/插件 ok 数/上次拉齐时间)、插件勾选网格(带 已装/未装 chip,默认全选)、core/技能开关、「拉齐勾选项」/「仅校验(dry-run)」/刷新 按钮;mock 预览同步补齐
  - 验证:新增 `scripts/verify-m2.mjs`(`npm run verify:m2`,先 build)——**13 用例全过**:真实拉起 `dist/launcher.cjs ui` 打端点(无状态 6 + 有状态 2 + 异步 pull/busy 回落 2 + UI 资源注入 2);`tsc --noEmit` 与 `npm run build` 零错误
  - 真机验证点:双击 exe / `ui` 开浏览器看生态卡片,勾选后「拉齐勾选项」跑真实 pull(需 dsh 已装、profile 启动过)
- 分支链:main(M0 `0850b27`)→ feat/m1(M1 `7dcddf8`)→ feat/m2(M2 `cb58055`);M0 PR #11 合并后依次 rebase 推 M1/M2 PR
- 下一步:M3(Node 运行时自持 + 离线包)/ 先推 M1、M2 PR

## 2026-09-03(M1 编码完成,本地提交)

- **M1(dsh-launcher 仓,分支 `feat/m1-ecosystem-pull`,commit `7dcddf8`,未推送)**——Phase 1 落地:
  - `src/ecosystem.ts`(新增):ecosystem.json v1 类型与校验;**默认清单内嵌**随启动器走(锁 dsh-plugins `15ffcfd`、11 包 install.ps1 sha256、skills sha256,与仓库根 `ecosystem.json` 快照一致);`loadManifest`(默认/`--manifest` https 强制 HTTPS/本地文件);`ensurePluginsSource` 锁 commit(HEAD 漂移拒绝;缺失时按锁定 sha 克隆);`verifyHashes` 供应链逐文件 sha256(不符即拒,不执行);`runPull` = core 缺口(复用 install)→ 插件 install.ps1(逐个,失败记录不中断)→ skills install-skills.ps1 → 结果写 `ecosystem-state.json`(launcher 旁)
  - `src/node.ts`:新增 `runPowerShellFile`(install.ps1 执行器,powershell -NoProfile -Bypass -File 隐藏窗口)+ 导出带 cwd 的 `runGit`
  - `src/cli.ts`:`pull [--manifest <url|file>] [--plugins a,b] [--all] [--no-core] [--no-skills] [--dry-run]`
  - 验证:新增 `scripts/verify-m1.mjs`(`npm run verify:m1`)——**15 用例全过**:默认清单 4 + HTTPS 强制 1 + 锁 commit 1 + 篡改拒绝执行 2 + dry-run 2 + 真实 pull(真实 powershell 执行插件/技能 + 状态落盘)5;`tsc --noEmit` 与 `npm run build` 零错误
- 分支关系:M1 分支基于含 M0(`0850b27`)的本地 main;M0 PR #11 合并后需 rebase 再推 M1 PR(避免堆叠 diff)
- 真机验证点:新机 `install && pull`(默认清单走 github 源 clone+pnpm 构建 + 11 插件 + skills;插件真装需 dsh web profile 已启动过)
- 下一步:合 M0 PR#11 → 推 M1 PR → M2(GUI 生态页)

## 2026-09-03(M0 编码完成,本地提交)

- **M0(dsh-launcher 仓,本地 commit `0850b27`,尚未推送 origin)**——P0-4/P1-6 三项落地:
  - `src/tokenFile.ts`:`clearLaunchToken(source, pid?)` **原子化**——source+pid 双匹配 + 删除前复读确认(读→判归属→复读→内容一致才 rm,至多 3 次;宁残留不误删他人 token,修 P0-4);新增 `redactTokenUrl()` 脱敏工具
  - `src/log.ts`:`emit()` **中央出口统一 token 掩码**(控制台/文件/UI 订阅者同源生效,修 P1-6)
  - `src/launch.ts`:`launch.ts:184` 显式脱敏;child log 自 `%TEMP%` 迁至 `%DSH_HOME%\logs`(新增 `ensureChildLogDir()`;启动前建目录)
  - 验证:新增 `scripts/verify-m0.mjs`(`npm run verify:m0`)——**19 用例全过**:单进程归属 6 + 多进程并发压力 2 场景(非属主不得误删/属主收敛删除)+ 脱敏 5 + 迁址断言 3;`tsc --noEmit` 与 `npm run build` 零错误
- 技术备忘(dsh-launcher 开发环境):node_modules 原为 **npm** 管理,勿用 pnpm 触发 install(pnpm 11 会把 npm 包挪 `.ignored` 且因 allow-scripts 门禁失败,已恢复 `npm ci`);本机 npm allow-scripts 拦了 electron/esbuild/koffi 的 postinstall,后续打包/运行 GUI 前需批准或手动补跑
- 下一步:M0 推送确认 → M1(ecosystem.json + `pull` CLI,含 sha256 供应链校验)

## 2026-09-03(github 治理与模块文档就位)

- 新增 `.AGENT.md`(仓根,commit `57ad68b` 已推 main):代理工作手册——子模块纪律、文档索引、术语速查、提交规约
- GitHub 工具链就位:确认 `GITHUB_TOKEN`(fine-grained)可用;`github_sync` 以显式 path 直管本目录,commit/push 全链路验证通过
- 发布侧(**只建模板与流程,未切 tag**):
  - `.github/release-notes-template.md` —— 生态快照 notes 模板(指针表 旧→新 + 里程碑)
  - `docs/RELEASING.md` —— 伞仓发布流程(何时发 / checklist / 步骤 / notes / 不做什么);tag 命名 `ecosystem-YYYY.MM[.N]`
- 模板侧(`.github/`):`ISSUE_TEMPLATE/`(config.yml + bug / feature / 里程碑任务三套 yml)+ `PULL_REQUEST_TEMPLATE.md`
- 模块文档侧(`docs/modules/`):索引 + 6 组件页(launcher L0 / plugins L3 / vscode L4 / desktop L4 / remote L6 / deepseek-harness L2 官方只读),每页含角色、仓、当前锁指针、bump 注意点
- 索引同步:README(文档表 + 模板行)、.AGENT.md(§3 表 + §5 提交范围加 `.github/`)
- 技术备忘:伞仓零代码零测试,治理产出全部为文档/模板;commit 一律显式 pathspec,子模块 `deleted:` 预期脏状态不入提交

## 2026-09-02(issue 集中到伞仓,完成)

- 13 个里程碑 issue 全部归位 **dsh-ecosystem**:M0=#3(dsh-launcher#1 的 UI transfer 原档)、M1–M8=#5–#12、PM1–PM4=#13–#16
- dsh-launcher #2–#9、dsh-plugins #3–#6 已关闭并留跳转注释;原仓不再维护里程碑 issue
- 伞仓 #1/#2 为权限探测残留(closed);#4 为重建副本(closed,规范源 #3)
- 技术备忘:GitHub transfer REST API(`POST /issues/{n}/transfer`)对 fine-grained token 返回 404——即使 token 对源/目标仓均有 Issues:write(建 issue 201 正常),transfer 端点仍被拒;故采用「UI transfer #1 + 其余重建」混合方案

## 2026-09-02(伞仓建立)

- 新建 **kuaizhongqiang/dsh-ecosystem**(伞仓):6 个子模块平铺(dsh-launcher / dsh-plugins / dsh-vscode / dsh-desktop / dsh-remote / deepseek-harness 官方),commit 指针即版本锁
- 文档迁址:本目录(`dsh-ecosystem/docs/`)成为计划/审查/工作日志的**单一事实源**;dsh-launcher/docs 已删除(commit da99759)
- 里程碑 Issues:dsh-launcher #1–#9(M0–M8)、dsh-plugins #3–#6(PM1–PM4);待网页 Transfer 至本仓
- 本地说明:伞仓工作树仅元数据(docs + gitlink),子模块目录未初始化(dev 仍在 `F:\Project\dsh-dev\*`);需要内容时 `git submodule update --init`

## 2026-09-02(当天收尾更新)

### 已完成(全部落盘)
1. **《生态化路线图》三版演进** `ECOSYSTEM-PLAN.md`
   - v1:分层模型 L0–L6、八个缺口、决策 D1–D7、Phase 1–8、里程碑 M1–M8、风险表、§8 插件体系优化(11 → 7)
   - **v2**:初轮审查(18 条)修订全部应用
   - **v3(本次)**:深度审查有效发现(8 条)修订全部应用——新增 **D8 监督者协调协议**(clearLaunchToken source+pid 双匹配原子化、端口锁 `.dsh-port-<port>.lock`、active 变更标记 `.dsh-connection-changed`、共享文件原子写)、里程碑表加 **M0 前置修复**、Phase 1 供应链强制校验(sha256/HTTPS/锁 commit)、Phase 4 白名单按实测精确化(`profiles/web/cordis.patch.yml`+`plugins/`,显式排除清单,合计 ~0.21 MB)、Phase 5 收窄「零改动跟随」(desktop 完全跟随,vscode 仅 token 跟随/serverUrl 不自动切换)、Phase 6 注册文件补实现落点、风险表补竞态/中文路径行;深度报告的 P3-6/P3-7 经核验为过时项未采纳
2. **两轮审查报告**(mimo-v2.5-pro,provider=xiaomi)
   - `ECOSYSTEM-PLAN-REVIEW.md`(初轮,18 条,已消化)
   - `ECOSYSTEM-PLAN-REVIEW-DEEP.md`(深度,430 行;有效 8 条已全部进 v3;初轮 8 处代码引用复核全部属实)
3. 审查跑法沉淀:workflow 单 agent + `{provider:'xiaomi', model:'mimo-v2.5-pro'}`;凭据 XIAOMI_API_KEY 在位

### 下一步(按序)
1. 可选:让 mimo-v2.5-pro 对 v3 做一轮增量复核(验证修订无回归)
2. **开工编码 M0**:`src/tokenFile.ts` clearLaunchToken 原子化(source+pid 双匹配 + 复读确认);`src/launch.ts:184` 日志脱敏;child log 迁出 %TEMP%
3. **M1**:`src/ecosystem.ts`(EcosystemManifest + loadManifest + pull)+ `cli.ts` 加 `pull` 子命令;sha256 校验;`ecosystem-state.json`
4. 后续:M5 connections.json(可提前)/ M6 托盘+重启 seam / §8 PM1–PM4(dsh-plugins 独立仓)

### 文件清单(dsh-launcher\docs\)
- `ECOSYSTEM-PLAN.md` —— **当前 v3 生效**(D1–D8、M0–M8)
- `ECOSYSTEM-PLAN-REVIEW.md` —— 初轮审查(已消化)
- `ECOSYSTEM-PLAN-REVIEW-DEEP.md` —— 深度审查(已消化)
- `WORKLOG.md` —— 本日志
