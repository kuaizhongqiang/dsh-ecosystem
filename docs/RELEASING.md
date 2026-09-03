# RELEASING — 伞仓发布流程

> 适用范围:**dsh-ecosystem(伞仓)的 release = 生态版本快照**。
> 它锁定 6 个子模块指针 + 当时文档,给消费者一个「已验证的版本组合」锚点。
> **组件自身的发布**(launcher Releases、plugins 版本化、vscode Open VSX 等)在各组件仓进行,不在此列。

## 何时发布

- 子模块指针有**实质推进**(某个组件进入新版本 / 修复),且已在各仓验证;
- 或伞仓文档/治理达到里程碑(如本套模板、module docs 上线、路线图改版);
- 建议低频:跟随功能里程碑(M0–M8 / PM1–PM4)或月末快照,不必每笔 bump 都发。
- tag 命名:`ecosystem-YYYY.MM`;同月多次追加 `.1`、`.2`(如 `ecosystem-2026.09.1`)。

## 发布前检查清单

- [ ] 各子模块指针 = **已验证版本**(手动逐仓推进,参考 .AGENT.md §2)
- [ ] `docs/modules/*.md` 的指针列与 `git submodule status` 一致
- [ ] `docs/WORKLOG.md` 已记录本轮工作
- [ ] README / .AGENT.md 索引与新增文档一致
- [ ] 工作树除预期的 6 子模块 `deleted:` 外无其他脏改动
- [ ] 凭证 / 运行时文件未入仓(红线 D2)

## 发布步骤

```powershell
# 1. 提交指针 bump(逐组件,显式 pathspec,勿 add -A)
git add dsh-launcher && git commit -m "chore: bump dsh-launcher → <sha-8>"

# 2. 确认状态
git status                       # 应只有预期的子模块 deleted:
git submodule status             # 记下 6 个指针,填入 notes

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
- 必填段落:生态变更摘要、**子模块指针表**(旧→新,含所属里程碑)、文档/治理更新、里程碑进度
- 旧指针取上一 release tag 对应的 `git ls-tree <old-tag> <submodule>` 或 git 历史

## 发布后

- [ ] 验证拉取:`git clone --recurse-submodules -b <tag> …`(或已有检出 checkout + submodule update)
- [ ] 在 docs/WORKLOG.md 记一笔「已发 <tag>」
- [ ] 需要时更新 README 顶部或指针说明

## 不做什么

- 不替组件仓发布(各组件 release 责任在各自仓库);
- 不在伞仓建 PR 门禁(直接推 main 是本仓既定工作流);
- 不把 `.credentials.yaml` / `launch-token.json` / `connections.json` 等任何凭证内容带进 tag 或 notes。
