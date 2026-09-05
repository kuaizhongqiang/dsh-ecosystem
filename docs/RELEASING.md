# RELEASING — 伞仓发布流程(手动 SOP)

> 适用范围:**dsh-ecosystem(monorepo)是唯一权威代码仓**(2026-09-04 收敛,见
> [MONOREPO-UMBRELLA.md](MONOREPO-UMBRELLA.md));组件发版在伞仓进行。
> 原 5 个源仓已并入本仓并**归档只读**,其 GitHub Actions(CI/release)已停摆——
> 当前发布为**本地构建 + 手动上传**;伞仓根重建 CI / Open VSX 管道列为后续工作项。

## 组件发布概览

| 组件 | 版本位置 | 产物与渠道(手动) |
|---|---|---|
| dsh-launcher | `dsh-launcher/package.json` | 本地 `npm run build` + `dist:all`(portable+NSIS)→ 上传伞仓 Releases |
| dsh-plugins | `dsh-plugins/README.md` 版本约定 | 插件集改版随伞仓 tag;无独立产物 |
| dsh-vscode | `dsh-vscode/package.json` | 本地打包 vsix → 手动发布 Open VSX(需 OVSX_PAT)/ 上传伞仓 Releases |
| dsh-desktop | `dsh-desktop/desktop/package.json` | 本地 electron-builder → 上传伞仓 Releases |
| dsh-remote | — | 部署记录,随伞仓提交 |
| deepseek-harness | 子模块指针 | **不发布**,跟随官方 bump(见 .AGENT.md §2) |

## 何时发伞仓 release

- 任一组件进入新版本 / 修复已验证,或伞仓文档/治理达里程碑;建议低频(跟随组件里程碑或月末)。
- tag 命名:`ecosystem-YYYY.MM`(汇总快照);组件级产物可另加组件前缀 tag
  (如 `dsh-launcher-v0.8.0`)上传对应 release。

## 发布前检查清单

- [ ] 组件改动已按各自质量门验证(目录内:`npm run build` / `verify:m*` / `pnpm test` 等)
- [ ] `deepseek-harness` 指针 = 已验证官方 commit(`git submodule status`)
- [ ] `docs/modules/*.md` 快照与组件版本一致;`docs/WORKLOG.md` 已记录本轮
- [ ] 工作树干净;凭证 / 运行时文件未入仓(红线 D2)

## 发布步骤(手动)

```powershell
# 1. 确认版本状态
git status                              # 干净
git submodule status                    # harness 指针
git -C dsh-launcher log -1 --oneline    # 各组件最近提交(逐目录)

# 2. 组件产物本地构建(示例 launcher;详见各组件 README/scripts)
cd dsh-launcher; npm run build; npm run dist:all; cd ..

# 3. 打伞仓 tag(汇总快照)或组件 tag
git tag -a ecosystem-2026.09 -m "ecosystem snapshot YYYY-MM"
git tag -a dsh-launcher-v0.8.0 -m "dsh-launcher v0.8.0"   # 组件级产物用
git push origin --tags

# 4. 建 GitHub Release(网页 Releases → Draft,或 gh CLI)并上传产物
gh release create ecosystem-2026.09 --title "dsh-ecosystem YYYY-MM — <摘要>" --notes-file RELEASE_NOTES.md
# 组件产物:gh release upload <tag> <dist 路径>(绝对路径;Windows glob 有坑,用显式文件列表)

# 5. vscode:本地打包 + 手动发 Open VSX
cd dsh-vscode; <打包 vsix>; npx ovsx publish <file> -p $env:OVSX_PAT; cd ..
```

> `gh` 未安装时用网页。Windows 上传 assets 的 glob 反斜杠坑:用显式文件路径而非通配符。

## Release Notes

- 模板:`.github/release-notes-template.md`;必填:生态变更摘要、**组件版本表**(各组件版本 + harness 锁,
  含所属里程碑)、文档/治理更新、里程碑进度。
- 旧快照取上一 release tag 时的组件版本记录。

## 发布后

- [ ] 验证拉取:`git clone https://github.com/kuaizhongqiang/dsh-ecosystem.git` + `git submodule update --init deepseek-harness`
- [ ] 在 docs/WORKLOG.md 记一笔「已发 <tag>」

## 不做什么

- 不向已归档的源仓发布或推送(只读);
- 不在伞仓建 PR 门禁(直接推 main 既定工作流);
- 不把任何凭证内容带进 tag / notes / 产物。
