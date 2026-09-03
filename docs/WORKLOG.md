# dsh-launcher 生态计划 —— 工作日志

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
