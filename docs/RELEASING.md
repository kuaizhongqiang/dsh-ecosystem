# RELEASING — 伞仓发布流程(全量 tag,自动化)

> **总则(2026-09-04 起)**:dsh-ecosystem 是 monorepo 唯一权威仓,发布 = **一个 tag 全量发布所有包**。
> tag `vX.Y.Z`(semver)→ 伞仓根 CI(`.github/workflows/release.yml`)并行构建并发布:
> dsh-launcher(portable+NSIS)、dsh-cli(Windows exe + Linux 单文件 + npm)、dsh-vscode(VSIX + Open VSX)、
> dsh-plugins(清单校验)、**desktop-mirror(镜像上游桌面版安装包)**。
> 原 5 源仓已并入并**归档只读**,不再逐仓发布。
>
> **2026-09-28 变更**:桌面版**归上游** —— 上游 `deepseek-harness/apps/desktop`(包名
> `@deepseek-ai/dsh-desktop`,与 dsh 本体严格同号)自带桌面客户端;伞仓自建的 `dsh-desktop/` 已移除,
> 伞仓不再构建/签名/自发布桌面版,只把上游 win-x64 安装包**镜像**到本仓 Release(见下文
> 「桌面版:归上游 + 镜像」)。

## 版本策略

- 伞仓统一 semver:**launcher / vscode / dsh-cli 三方**内部版本号与 tag 一致(CI 逐组件断言,不一致即失败)。
- 语义:生态大功能/破坏 → minor;修复 → patch。**只有单组件变更也整体 bump**(全量发布)。
- desktop **不参与**伞仓版本号:它的版本号就是**上游桌面版号**(资产名自带),与 tag 无关。
- 现状基线(2026-09-24 已发 v0.11.5):launcher / vscode / dsh-cli 同为 `0.11.5`;plugins 随伞仓提交,无独立号。
- 历史 tag(ecosystem-YYYY.MM、组件仓旧 tag)保留只读,不再使用。

## 发布前置

- [ ] 组件改动已按各自质量门验证(launcher:`npm run check`/`verify:m*`;vscode:`pnpm typecheck`/`pnpm test`;
      dsh-cli:`node dsh-cli/scripts/verify-cli.mjs`),并 `node scripts/verify-release.mjs`(伞仓根)通过
- [ ] **版本 bump**:`dsh-launcher/package.json`、`dsh-vscode/package.json`、`dsh-cli/package.json`
      → 目标版本(与将打的 tag 一致)
- [ ] **插件集更新**(若有):dsh-plugins/ 内容变更后,重算 7 包 `install.ps1` + `skills/install-skills.ps1`
      的 sha256,同步 `dsh-launcher/ecosystem.json` 与 `dsh-launcher/src/ecosystem.ts`(PACKAGES / DEFAULT_ECOSYSTEM);
      manifest `commit` 指向**包含该插件内容的伞仓提交**(两步提交:先提交内容取 sha,再提交把 commit 字段指过去)
- [ ] **harness 指针 = 已验证官方 commit**(`git submodule status`,未变则不动);
      **若 bump 了子模块,同批把 `scripts/desktop-mirror.json` 的 `version` 改成对应上游桌面版号**
      (= `deepseek-harness/apps/desktop/package.json` 的 version;`verify-release.mjs` 会交叉校验,
      不一致直接拦在本机),并跑一次 `node scripts/mirror-desktop.mjs --check`
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
launcher / dsh-cli(Windows + Linux)/ vscode / **desktop-mirror** 并行产出并上传资产到该 Release;
vscode 在 `secrets.OVSX_PAT` 存在时同步发布 Open VSX;dsh-cli 在 `secrets.NPM_TOKEN` 存在时发布 npm;
plugins job 跑清单一致性校验(`node scripts/verify-release.mjs`)。

## 桌面版:归上游 + 镜像

**结论**:桌面版不再自建。上游 `deepseek-harness/apps/desktop`(`@deepseek-ai/dsh-desktop`)与 dsh 本体
严格同号,自带签名、安装器与 electron-updater 通道;伞仓只做 **win-x64 安装包的镜像/托管**。

- 单一事实源:`scripts/desktop-mirror.json`(target `win-x64` / channel `nightly` / `version` / 上游
  origin 与目录)。取件脚本:`scripts/mirror-desktop.mjs`。
- 上游通道(公开,无需凭证):清单 `https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml`,
  产物 `.../dsh-desk/bin/win-x64/deepseek-harness-<version>-win-x64.exe`(即上游 electron-builder 的
  `artifactName` 模板 `deepseek-harness-${version}-${os}-${arch}.${ext}`)。上游版本目前全是 prerelease,
  故**只有 `nightly` 通道**,稳定别名 `latest.yml` 不出现。
- 门:CI `desktop-mirror` job 先 `node scripts/mirror-desktop.mjs --check`(校验
  **上游 feed.version == 镜像 pin == 子模块 `apps/desktop` 版本**),再 `--download <目录>`
  (验 sha512 与字节数后落盘,并写 `.sha512` 副档),最后上传为 Release 资产。
- 版本关系:镜像资产名里的版本 = **上游桌面版号**,与伞仓 tag 无关(伞仓 tag 只约束 launcher/vscode/dsh-cli)。
- **只镜像 Windows**:mac(`mac-arm64` / `mac-x64`)不镜像 —— 需要 mac 版的用户直接按上游清单
  `https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly.yml` 下载官方产物。
- npm `@kuaizhongqiang/dsh-desktop` **不再发布/不再维护**(历史版本留在 npm 上,不删不动);发布流程里
  自建 desktop 的 job(NSIS + `latest.yml` + npm 发布)已整体删除。
- **升级路径**:已装自建 desktop(0.11.x)的用户需手工卸载后装上游版;上游版与 dsh 同号、自带更新通道,
  装好后由它自己升级。

## 发布后

- [ ] Releases 页可见全部资产(launcher exe/setup、dshcli exe/Linux 单文件、vscode vsix、
      镜像的 `deepseek-harness-<上游版>-win-x64.exe` 与 `.sha512`)
- [ ] Open VSX 页面出现新版本(若配了 OVSX_PAT)
- [ ] 在 docs/WORKLOG.md 记「已发 vX.Y.Z」
- [ ] **长期观察**:Open VSX / npm 的发布历史(有无撤包、重发、dist-tag 漂移)

## 失败重跑

- 单 job 失败修复后:**先删 release 再整跑**(资产/版本唯一性):`gh release delete vX.Y.Z --yes`
  → 修复提交 push → 若 tag 需指向新 commit:删旧 tag 重打
  (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z` → 重打 → push)→ CI 全量重跑(init 幂等重建)。
- 不改版本小修重发同 tag 需谨慎:Open VSX 不接受重复版本(需 bump)。
- desktop-mirror 失败通常是**上游推进**(pin 落后):按提示 bump 子模块 + 改镜像 pin,或按上游 feed 修正 pin。

## 组件发布矩阵

| 组件 | 产物 | 渠道 | 触发 |
|---|---|---|---|
| dsh-launcher | portable exe + NSIS setup | 伞仓 Release 资产 | tag v* |
| dsh-cli | `dshcli.exe` + `dshcli-linux-x64`(各带版本化副本) | 伞仓 Release 资产 + npm `@kuaizhongqiang/dsh-cli`(NPM_TOKEN) | tag v* |
| desktop(**镜像**) | 上游 `deepseek-harness-<上游版>-win-x64.exe` + `.sha512` | 伞仓 Release 资产(镜像;上游自有 COS 通道不变) | tag v* |
| dsh-vscode | VSIX | 伞仓 Release 资产 + **Open VSX**(OVSX_PAT) | tag v* |
| dsh-plugins | 无独立产物(校验 + release notes) | 随 launcher 清单发布 | tag v* |
| deepseek-harness | 官方上游,不发布 | 子模块 bump(见 .AGENT.md) | 手动 |

## 不做什么

- 不向已归档源仓发布/推送(只读);不逐仓发版;
- **不自建/不签名/不自发布桌面版**:上游产物只镜像,不改包、不重打包;
- 不在伞仓建 PR 门禁(直接推 main 既定工作流);
- 不把凭证内容带进 tag / notes / 产物。
