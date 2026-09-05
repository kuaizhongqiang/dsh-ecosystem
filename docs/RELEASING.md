# RELEASING — 伞仓发布流程(全量 tag,自动化)

> **总则(2026-09-04 起)**:dsh-ecosystem 是 monorepo 唯一权威仓,发布 = **一个 tag 全量发布所有包**。
> tag `vX.Y.Z`(semver)→ 伞仓根 CI(`.github/workflows/release.yml`)并行构建并发布:
> dsh-launcher(portable+NSIS)、dsh-desktop(NSIS+latest.yml)、dsh-vscode(VSIX + Open VSX)、
> dsh-plugins(清单校验)。原 5 源仓已并入并**归档只读**,不再逐仓发布。

## 版本策略

- 伞仓统一 semver,组件内部版本号与 tag 一致(CI 逐组件断言,不一致即失败)。
- 语义:生态大功能/破坏 → minor;修复 → patch。**只有单组件变更也整体 bump**(全量发布)。
- 现状基线:launcher `0.8.0`(运行时源切伞仓)/ vscode `0.8.0` / desktop `0.8.0`;plugins 随伞仓提交,无独立号。
- 历史 tag(ecosystem-YYYY.MM、组件仓旧 tag)保留只读,不再使用。

## 发布前置

- [ ] 组件改动已按各自质量门验证(launcher:`npm run check`/`verify:m*`;vscode:`pnpm typecheck`/`pnpm test`;
      desktop:`npm run build` + smoke),并 `node scripts/verify-release.mjs`(伞仓根)通过
- [ ] **版本 bump**:`dsh-launcher/package.json`、`dsh-vscode/package.json`、`dsh-desktop/desktop/package.json`
      → 目标版本(与将打的 tag 一致)
- [ ] **插件集更新**(若有):dsh-plugins/ 内容变更后,重算 7 包 `install.ps1` + `skills/install-skills.ps1`
      的 sha256,同步 `dsh-launcher/ecosystem.json` 与 `dsh-launcher/src/ecosystem.ts`(PACKAGES / DEFAULT_ECOSYSTEM);
      manifest `commit` 指向**包含该插件内容的伞仓提交**(两步提交:先提交内容取 sha,再提交把 commit 字段指过去)
- [ ] harness 指针 = 已验证官方 commit(`git submodule status`,未变则不动)
- [ ] 工作树干净;凭证/运行时文件未入仓(红线 D2)

## 发布步骤

```powershell
# 1. 提交发布准备(含版本 bump 与清单同步)
git add -u . && git add .github scripts && git commit -m "release: prepare v0.8.0 (全量)"
git push origin main

# 2. 打 tag 并推送 → CI 自动触发
git tag -a v0.8.0 -m "dsh-ecosystem v0.8.0 — 全量发布"
git push origin v0.8.0

# 3. 盯 CI(本地 gh)
gh run watch --repo kuaizhongqiang/dsh-ecosystem
gh run list --repo kuaizhongqiang/dsh-ecosystem   # 失败 job 看日志:gh run view <id> --log
```

CI 行为:init job 重建该 tag 的 Release(幂等,先删同名 release 不动 tag)→
launcher/desktop/vscode 并行构建并上传资产到该 Release;vscode 在 `secrets.OVSX_PAT` 存在时同步发布 Open VSX;
desktop 在 `secrets.NPM_TOKEN` 存在时顺带发布 npm `@kuaizhongqiang/dsh-desktop`;plugins job 跑清单一致性校验。

## 发布后

- [ ] Releases 页可见全部资产(launcher exe/setup、desktop setup+latest.yml+blockmap、vscode vsix)
- [ ] Open VSX 页面出现新版本(若配了 OVSX_PAT)
- [ ] 在 docs/WORKLOG.md 记「已发 vX.Y.Z」

## 失败重跑

- 单 job 失败修复后:**先删 release 再整跑**(资产/版本唯一性):`gh release delete vX.Y.Z --yes`
  → 修复提交 push → 若 tag 需指向新 commit:删旧 tag 重打
  (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z` → 重打 → push)→ CI 全量重跑(init 幂等重建)。
- 不改版本小修重发同 tag 需谨慎:Open VSX 不接受重复版本(需 bump)。

## 组件发布矩阵

| 组件 | 产物 | 渠道 | 触发 |
|---|---|---|---|
| dsh-launcher | portable exe + NSIS setup | 伞仓 Release 资产 | tag v* |
| dsh-desktop | NSIS setup + latest.yml + blockmap(updater feed = 伞仓) | 伞仓 Release 资产;(可选 npm) | tag v* |
| dsh-vscode | VSIX | 伞仓 Release 资产 + **Open VSX**(OVSX_PAT) | tag v* |
| dsh-plugins | 无独立产物(校验 + release notes) | 随 launcher 清单发布 | tag v* |
| deepseek-harness | 官方上游,不发布 | 子模块 bump(见 .AGENT.md) | 手动 |

## 不做什么

- 不向已归档源仓发布/推送(只读);不逐仓发版;
- 不在伞仓建 PR 门禁(直接推 main 既定工作流);
- 不把凭证内容带进 tag / notes / 产物。
