# 伞仓形态改造:submodule 锁仓 → 直接工程 + dsh 本体 submodule

> 状态:**已批准并执行(2026-09-04)** · 执行:伞仓提交 `f4e8275`(设计)+ `400cc0e`(去 submodule)+ 文档同步提交 · 关联:README / .AGENT.md / docs/modules/ · 里程碑:非路线图增量,属仓结构重构

## 1. 背景与目标

现状伞仓是「文档 + gitlink 版本锁」:docs/ 为单一事实源,6 个自有/官方仓以 git 子模块指针平铺,
代码在各子仓独立推进,伞仓只做 bump 指针。痛点:

- 跨仓改动需要**两处 dsh-plugins 指针**(伞仓顶层 + launcher 内层)独立 bump,仪式成本高;
- 开发副本与伞仓分离(F:\Project\dsh-dev 等,现已不存在),上下文割裂;
- 「版本锁 = gitlink」对自有仓收益低(自有仓 HEAD 即最新,锁只增仪式)。

**目标形态**:伞仓 = `docs/` 文档 + **5 个自有仓以直接工程(独立 git 仓库)检出** + `deepseek-harness`
保持**唯一官方 submodule**。改造后卸掉自有仓的 submodule 机制(.gitmodules / gitlink),
开发直接在伞仓目录内进行,改动逐仓推送各自 origin。

## 2. 目标形态(改造后)

```
dsh-ecosystem/                      # 伞仓 git(只含文档与元数据)
├── .gitignore                      # 忽略 5 个直接工程目录
├── .gitmodules                     # 仅剩 [submodule "deepseek-harness"]
├── README.md / .AGENT.md / LICENSE
├── .github/                        # 治理模板(不动)
├── docs/                           # 单一事实源(含本设计)
├── dsh-launcher/                   # ← 直接工程(独立 .git,remote=自有仓,不再被伞仓 git 跟踪)
├── dsh-plugins/                    # ← 直接工程
├── dsh-vscode/                     # ← 直接工程
├── dsh-desktop/                    # ← 直接工程
├── dsh-remote/                     # ← 直接工程
└── deepseek-harness/               # ← 唯一官方 submodule(保持空目录 + gitlink,按需 --init)
```

## 3. 决策

| # | 决策 | 内容 |
|---|---|---|
| D-R1 | 直接工程形态 | 各自有仓以**独立 git 仓库**检出(含 .git,保留历史与 remote);伞仓根 `.gitignore` 忽略 5 目录,**杜绝 `git add -A` 误纳入**(纪律延续,见 §5 风险) |
| D-R2 | 版本锁职责转移 | 废除自有仓 gitlink 锁;新锁 = 各仓远端 main HEAD(工作树)。`docs/modules/*.md` 的指针快照表**保留但语义降级**为「说明性快照」,权威值以各仓 `git log -1` 为准,不再承诺 bump 仪式 |
| D-R3 | 拉取方式 | README「一条命令拉全生态」改为**逐仓 clone 清单**(单段可整段粘贴);不再依赖 `--recurse-submodules` |
| D-R4 | harness 保留 | `deepseek-harness` 维持官方只读 submodule:.gitmodules 保留单条 + gitlink 保留,目录维持未检出,使用时 `git submodule update --init deepseek-harness` |
| D-R5 | 发布职责 | 各仓发版/tag 流程不变(逐仓 GitHub Release);伞仓 tag(ecosystem-*)语义从「指针表快照」简化为「各仓 release 汇总 + harness 锁」,RELEASING.md 同步改写 |

**单列后续工作项(本次不触碰)**:dsh-launcher 仓内自己的 `dsh-plugins` 子模块(安装/拉取时的运行时源)属
launcher 仓内部结构,不在伞仓 git 控制内;若目标是把插件源统一指向伞仓直接工程目录,需在 launcher 仓单独设计
(本地路径/环境变量指定插件源,现 `--manifest <本地文件>` 已具备雏形),另开会话处理。

## 4. 迁移步骤(分阶段,每阶段有校验门)

> 现状事实:6 子模块目录**全为空**(未初始化),git config 无 submodule 注册 → 迁移**无工作树数据风险**。

### 阶段 0 — 前置校验
- [ ] 伞仓本地干净:`git status` 无未提交改动(除预期空目录)
- [ ] 记录当前 5 gitlink 锁 + harness 锁(WORKLOG 备份,供追溯):launcher `1dd0acb` / plugins `79edc23` / vscode `65c25bab` / desktop `250abfbd` / remote `4f755d23` / harness `47f94385`
- [ ] 确认 5 个自有仓远端可达(https clone 通)

### 阶段 1 — 伞仓去 submodule 化(仅文档 + git 元数据,无代码)
- [ ] `git rm --cached dsh-launcher dsh-plugins dsh-vscode dsh-desktop dsh-remote`(去 gitlink,空目录保留)
- [ ] `.gitmodules` 仅留 `[submodule "deepseek-harness"]` 单条
- [ ] 新增/更新根 `.gitignore`(忽略 5 目录,harness 不忽略)
- [ ] 校验门 1:`git ls-files -s` 中 160000 仅剩 `deepseek-harness`;`.gitmodules` 单条

### 阶段 2 — 直接工程落位(逐仓 clone)
- [ ] 逐仓 `git clone https://github.com/kuaizhongqiang/<name>.git <name>`(默认 main,**不浅克隆**,保全历史)
- [ ] 校验门 2:每仓 `git remote -v` 指向自有仓、`git log -1` 正常、`git status` 干净;伞仓 `git status` 干净(5 目录被 ignore)

### 阶段 3 — harness 保持
- [ ] 维持空目录 + gitlink(现状惯例),不 init(按需时 `git submodule update --init deepseek-harness`)
- [ ] 校验门 3:`git submodule status` 仅剩 harness 一条(`-` 前缀 = 未初始化,预期)

### 阶段 4 — 文档与工作流同步(单一事实源)
- [ ] `README.md`:组件清单加「直接工程」标注、指针更新节改写(逐仓 git pull / 逐仓 commit+push)、拉全生态命令改写、移除 dsh-plugins 双指针说明(harness 保留说明)
- [ ] `.AGENT.md`:子模块纪律改写为「直接工程纪律」——目录内开发、逐仓独立提交推送、伞仓只提交 docs/ 与元数据、**严禁对 5 目录 `git add`**;文档索引与术语表更新;F:\ 路径引用校准为实际工作区
- [ ] `docs/modules/README.md` + 6 页:自有仓 5 页角色表改「直接工程目录」、指针改「当前 HEAD 快照(说明性)」;harness 页维持 submodule 语义
- [ ] `docs/RELEASING.md`:伞仓 release 流程按 D-R5 简化改写
- [ ] `docs/WORKLOG.md`:补本次改造条目(含阶段 0 锁备份)
- [ ] 校验门 4:全仓 grep 无旧表述残留(`submodule update --remote`、双指针 bump、`git add -A` 提法)

### 阶段 5 — 收尾验证(整体)
- [ ] `git status` 干净且 5 目录被忽略(untracked 不出现)
- [ ] 各仓能正常独立提交(抽 1 仓空 commit 试推可跳过,改为 dry 验证)
- [ ] 文档内相对链接可点(README → docs、docs/modules 索引)
- [ ] commit 策略全程**显式 pathspec**(禁用 add -A)

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 误将直接工程目录 `git add` 进伞仓 | `.gitignore` 兜底 + 纪律条款改版(双重防护) |
| gitlink 移除后旧结构不可恢复 | git 历史保留 gitlink;回滚 = revert 阶段 1 commit 即可还原 |
| clone HEAD ≠ 伞仓旧锁(远端有新提交) | 直接工程语义下以远端最新为准;旧锁已备份于 WORKLOG 阶段 0 |
| 文档与现状脱节 | 阶段 4 全量同步 + 校验门 4 grep 残留 |
| 伞仓 release 流程悬空 | 阶段 4 同步 RELEASING.md(D-R5) |

## 6. 不做的事(边界)

- 不合并各仓历史/代码进伞仓 git(保留逐仓独立版本与发布)
- 不触碰 dsh-launcher 内层 dsh-plugins 子模块(单列后续项,见 §3)
- 不改 .github/ 治理模板、不改各仓内部结构
- 本次不 init harness 子模块内容(按需再取)
