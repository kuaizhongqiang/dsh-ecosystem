# dsh-launcher 生态计划 —— 工作日志

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
