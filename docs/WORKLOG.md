# dsh-launcher 生态计划 —— 工作日志

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
