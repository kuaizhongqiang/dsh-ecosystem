# 伞仓 monorepo 化设计:文档 + 组件代码 + harness 子模块

> 状态:**阶段 A 已执行完成(2026-09-04;D-M1 = squash 快照,D-M2 = 手动 SOP);阶段 B(源仓归档 + 手动发版 SOP 落地)由用户启动**
> · 阶段 A 提交:设计 `cc0db2c`、代码收敛 `f24cfcb`(264 文件,5 组件并入)+ 文档第三轮同步
> · 前序:[RESTRUCTURE-UMBRELLA.md](RESTRUCTURE-UMBRELLA.md)(直接工程形态,2026-09-04 已执行,
> 本设计将其**演进取代**) · 决策来源:用户拍板「归档 = 收敛到伞仓 monorepo」

## 1. 背景与动机

2026-09-04 先完成「直接工程」改造(5 自有仓以独立 git 检出在伞仓根,各自 remote 推送/发版)。
用户进一步决定:**伞仓成为唯一权威代码仓**,5 个源仓(`kuaizhongqiang/dsh-launcher|plugins|vscode|desktop|remote`)
在收敛完成后**归档只读**(仅留历史);`deepseek-harness` 官方上游继续以唯一子模块存在。
动机:单一工作区 + 单一权威 + 不再维护 6 个 GitHub 仓库的活跃状态。

> 事实探针(2026-09-04):各源仓历史很小——launcher 55 commits / plugins 33 / vscode 44 /
> desktop 23 / remote 2;**launcher / vscode / desktop 三仓有 GitHub Actions**(release/ci,
> vscode 的 release 含 Open VSX 发布管线)——归档会使这些自动化停摆,须在 §5 显式处理。

## 2. 目标形态

```
dsh-ecosystem/                      # 伞仓 = 唯一权威代码仓(单一 git,全部代码 + 历史)
├── docs/                           # 单一事实源(含本设计)
├── .github/                        # 治理模板 + (后续可重建的 CI,见 §5)
├── README.md / .AGENT.md / .gitmodules / .gitignore / LICENSE
├── dsh-launcher/                   # ← 组件代码(launcher v0.7.3 线)
├── dsh-plugins/                    # ← 组件代码(7 包插件 + skills)
├── dsh-vscode/                     # ← 组件代码(扩展 0.3.0 线)
├── dsh-desktop/                    # ← 组件代码(桌面壳)
├── dsh-remote/                     # ← 部署记录
└── deepseek-harness/               # ← 唯一 git 子模块(官方只读,gitlink,按需 --init)
```

- 5 组件目录成为伞仓 git 的**普通目录**(不再有嵌套 .git、不再被 .gitignore 忽略、不再各自 remote)。
- 各组件历史按选定的深度并入伞仓(决策 D-M1);源仓归档只读,历史仍可浏览。
- 伞仓根**不建统一构建/测试**:各组件质量门(pnpm check、npm run verify 等)在各自目录内执行。

## 3. 决策草案

| # | 决策 | 内容 |
|---|---|---|
| D-M1 | 历史并入深度 | **已定:(a) squash 快照**——每组件内容 vendor 为一个快照提交(commit message 注明来源仓 + 源 HEAD);源仓归档只读仍可浏览全部历史 |
| D-M2 | 源仓 CI/release 自动化 | **已定:(a) 本次不迁移**——归档即停摆;组件发版改本地脚本 + 手动上传 SOP(写入 RELEASING);伞仓重建 Actions / Open VSX 管道列为后续工作项 |
| D-M3 | harness | 保持唯一官方子模块(gitlink + .gitmodules 单条,未检出,按需 `--init`) |
| D-M4 | 组件内嵌套 submodule | 事实探针:**launcher 带 `dsh-plugins`、desktop 带 `deepseek-harness`+`dsh-plugins` 的 .gitmodules(均空占位)**;并入时删除各组件内所有 `.gitmodules` 文件与空占位目录(launcher 的 `dsh-plugins/`、desktop 的 `deepseek-harness/`+`dsh-plugins/`)。运行时插件源逻辑(M1 `ensurePluginsSource` 锁 sha 从 GitHub 拉取)不受影响;组件内部遗留的 submodule 说明文字 = 后续文档清扫项(§6) |
| D-M5 | 发版语义 | 组件版本推进 = 伞仓内目录改版 + 版本号 bump;伞仓 release 同时承载组件产物或维持汇总快照——随手动 SOP 定稿(阶段 B 落 RELEASING) |
| D-M6 | 回滚 | 迁移提交为普通 commit 可 revert;**禁止 force push**(工具不支持,工作流无 PR 门);归档动作由用户在 GitHub UI 执行(无 API),可 unarchive 恢复 |

## 4. 迁移步骤(阶段 A 代码收敛 / 阶段 B 发布与归档)

### 阶段 A — 代码收敛(本次执行)
- [ ] A1 备份伞仓当前指针(7cc7af0)与 5 组件 HEAD(已记 WORKLOG 2026-09-04)
- [ ] A2 将 5 个直接工程目录(源仓 clone)整体移到临时区(内容保真,含 .git 备用;伞仓忽略它们,移动无副作用)
- [ ] A3 快照落位:自临时区把各组件内容复制回伞仓同名目录,**排除** `.git` / `.gitmodules` /
  空占位子模块目录(见 D-M4);`git add` 5 目录(显式 pathspec)
- [ ] A4 删除 `.gitignore` 中 5 目录行(现在要被伞仓跟踪);校验无嵌套 .git 被捕获
- [ ] A5 校验门 1:伞仓 `git status` 干净;`git ls-files` 含各组件源码;index 中 160000 仅 harness;
  `git submodule status` 仅 harness;各组件目录内无嵌套 .git / .gitmodules
- [ ] A6 文档第三轮同步:README(树结构/拉取=单仓 clone + harness init/版本状态)、.AGENT.md(伞仓 = 代码仓纪律:
  组件目录是伞仓一部分,提交在伞仓统一进行;harness 仍子模块)、docs/modules/(形态改「伞仓内目录」)、
  RESTRUCTURE-UMBRELLA.md 标注被本设计取代、RELEASING.md(手动 SOP,D-M5/D-M2 定稿)、WORKLOG 补记
- [ ] A7 推 main

### 阶段 B — 发布与归档(用户启动,不在本次自动执行)
- [ ] B1 按 D-M2 定稿发布通道(本地 SOP 或伞仓 Actions)
- [ ] B2 用户逐仓在 GitHub UI **Archive repository**(顺序建议 remote → desktop → vscode → plugins → launcher,
      每归档一个后验证伞仓工作流无依赖)
- [ ] B3 归档后把 README/各组件目录头部说明收敛(指向伞仓为唯一开发/发版位)

## 5. 影响与风险

| 影响 | 说明与处理 |
|---|---|
| CI/release 停摆 | launcher/vscode/desktop 的 Actions 归档即停;vscode Open VSX 自动发布断 → 按 D-M2 定发布通道,OVSX_PAT 若要续用需迁伞仓 secrets |
| Release 资产承载 | launcher exe(85MB)/desktop 安装包等产物改传伞仓 Releases(单仓可承载)或改本地分发——D-M5 |
| 文档轮次 | RESTRUCTURE 直接工程形态被取代,文档同步到新形态(第三轮),grep 校验无旧表述 |
| 历史可追溯 | squash 时以 commit message 记录「来源仓 + 源 HEAD」;源仓归档后仍可 clone 浏览 |
| 无 force push | 迁移全程普通提交;出错 revert 或新分支,不重写已推历史 |
| 嵌套仓库残留 | 并入前必须删净目录内 .git / .gitmodules,防 git 将其当 embedded repo 只加 gitlink(A4 校验门兜底) |

## 6. 不做的事 / 后续项

- 不把 `deepseek-harness` 并入(官方只读,保持子模块锁基线)
- 不在伞仓根做统一构建/测试编排(各目录自持质量门)
- 伞仓重建 CI、发布自动化、Open VSX 管道迁移 = 后续工作项(D-M2(b) 或另开会话)
- 本次不在 GitHub 侧归档任何仓库(UI 动作归用户,阶段 B)
