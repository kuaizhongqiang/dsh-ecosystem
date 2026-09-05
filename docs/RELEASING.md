# RELEASING — 伞仓发布流程

> 适用范围:**dsh-ecosystem(伞仓)的 release = 生态汇总快照**(2026-09-04 形态改造后语义简化,
> 见 [RESTRUCTURE-UMBRELLA.md](RESTRUCTURE-UMBRELLA.md) D-R5):汇总各组件当前版本 +
> harness 锁定 commit + 当时文档,给消费者一个「已验证版本组合」锚点。
> **组件自身的发布**(launcher Releases、plugins 版本化、vscode Open VSX 等)在各组件仓进行,不在此列。

## 何时发布

- 某组件发布新版本 / 修复且已在各仓验证,或伞仓文档/治理达到里程碑;
- 建议低频:跟随组件功能里程碑或月末快照,不必每笔推进都发。
- tag 命名:`ecosystem-YYYY.MM`;同月多次追加 `.1`、`.2`(如 `ecosystem-2026.09.1`)。

## 发布前检查清单

- [ ] 5 个直接工程目录工作树 = **已验证版本**(逐仓 `git log -1` 确认,参考 .AGENT.md §2)
- [ ] `deepseek-harness` 子模块指针 = 已验证官方 commit(`git submodule status`)
- [ ] `docs/modules/*.md` 快照与各仓 HEAD 基本一致(说明性;重大发布后应顺手刷新)
- [ ] `docs/WORKLOG.md` 已记录本轮工作
- [ ] 工作树干净(5 直接工程目录被忽略,不构成脏改动)
- [ ] 凭证 / 运行时文件未入仓(红线 D2)

## 发布步骤

```powershell
# 1. 汇总各组件 HEAD 与 harness 指针(逐个直接工程目录)
git -C dsh-launcher log -1 --format='%h %s'    # launcher / plugins / vscode / desktop / remote 同式
git submodule status                            # deepseek-harness 指针

# 2. 确认状态
git status        # 应干净(5 直接工程目录被 .gitignore 忽略)

# 3. 打 tag(轻量或附注皆可;建议附注,内容 = release notes 摘要)
git tag -a ecosystem-2026.09 -m "ecosystem snapshot YYYY-MM"
git push origin ecosystem-2026.09

# 4. 建 GitHub Release(网页 Releases → Draft,或 gh CLI)
gh release create ecosystem-2026.09 \
  --title "dsh-ecosystem YYYY-MM — <一句话摘要>" \
  --notes-file RELEASE_NOTES.md
```

> `gh` 未安装时用网页:GitHub 仓库 → Releases → **Draft a new release** →
> 选 tag → 把 notes 粘贴进正文。

## Release Notes

- 模板:`.github/release-notes-template.md`(仓库根相对路径)
- 必填段落:生态变更摘要、**组件 HEAD 表**(各仓当前版本/提交 + harness 锁,含所属里程碑)、
  文档/治理更新、里程碑进度
- 旧快照取上一 release tag 时的各仓 HEAD 记录(本次发布前 `git log -1` 的输出)

## 发布后

- [ ] 验证拉取:按 [README](../README.md)「拉取整个工作区」清单逐仓 clone + `git submodule update --init deepseek-harness`
- [ ] 在 docs/WORKLOG.md 记一笔「已发 <tag>」
- [ ] 需要时更新 README 顶部或快照说明

## 不做什么

- 不替组件仓发布(各组件 release 责任在各自仓库);
- 不在伞仓建 PR 门禁(直接推 main 是本仓既定工作流);
- 不把 `.credentials.yaml` / `launch-token.json` / `connections.json` 等任何凭证内容带进 tag 或 notes。
