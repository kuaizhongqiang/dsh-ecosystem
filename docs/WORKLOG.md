# dsh-launcher 生态计划 —— 工作日志

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
