# dsh-ecosystem — dsh 生态伞仓

以 [dsh-launcher](https://github.com/kuaizhongqiang/dsh-launcher) 为核心的 DeepSeek Harness(dsh)个人生态的
**总工作区与文档仓**。**5 个自有组件以直接工程(独立 git 仓库)检出在伞仓根目录**,开发直接在本工作区进行、
改动逐仓推送各自 origin;[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)(官方上游)是
**唯一 git 子模块**,锁定 dsh 本体构建基线。伞仓自身 git 树只承载 `docs/` 与根级元数据
(提交纪律见 [.AGENT.md](.AGENT.md))。

> 形态改造(2026-09-04):由「文档 + 6 gitlink 版本锁」改为「文档 + 直接工程 + harness 唯一 submodule」,
> 设计与迁移步骤见 [docs/RESTRUCTURE-UMBRELLA.md](docs/RESTRUCTURE-UMBRELLA.md)。

## 工作区形态

| 组件 | 形态 | 说明 |
|---|---|---|
| [dsh-launcher](dsh-launcher/) | 直接工程(独立 git) | Windows 单文件安装 + 启动引导器(伞仓核心,L0 载体) |
| [dsh-plugins](dsh-plugins/) | 直接工程(独立 git) | 社区插件合集(7 包 + install-* 技能,L3) |
| [dsh-vscode](dsh-vscode/) | 直接工程(独立 git) | VSCode 扩展(会话/聊天/工具卡片,L4) |
| [dsh-desktop](dsh-desktop/) | 直接工程(独立 git) | Electron 桌面壳客户端(连共享 dsh server,L4) |
| [dsh-remote](dsh-remote/) | 直接工程(独立 git) | 远程部署记录(Cloudflare Access,L6) |
| [deepseek-harness](deepseek-harness/) | **git 子模块(官方只读)** | dsh 本体(L2 核心,`deepseek-ai/deepseek-harness`) |

> 5 个直接工程目录各自是独立 git 仓库(.git / remote / 历史俱全),伞仓不跟踪其内容
> (根 `.gitignore` 忽略,严禁对这些目录 `git add`)。
> `dsh-launcher` 仓内另有自己的 `dsh-plugins` 子模块(安装/拉取时的**运行时源**)——属 launcher
> 内部结构,与本工作区根部的 `dsh-plugins` 直接工程目录相互独立,按各自仓纪律维护。

## 拉取整个工作区

```powershell
git clone https://github.com/kuaizhongqiang/dsh-ecosystem.git
cd dsh-ecosystem
git clone https://github.com/kuaizhongqiang/dsh-launcher.git
git clone https://github.com/kuaizhongqiang/dsh-plugins.git
git clone https://github.com/kuaizhongqiang/dsh-vscode.git
git clone https://github.com/kuaizhongqiang/dsh-desktop.git
git clone https://github.com/kuaizhongqiang/dsh-remote.git
git submodule update --init deepseek-harness   # 可选:需要 dsh 本体源码时
```

已有检出时增量更新:5 个直接工程目录内逐仓 `git pull`;`deepseek-harness` 跟随官方 tag 人工验证后
`git add deepseek-harness` bump 指针(**不做** `update --remote` 的自动推进)。

## 版本状态

- 自有组件:版本 = 各仓远端/工作树 HEAD(权威值 `git -C <dir> log -1`;
  [docs/modules](docs/modules/README.md) 保留**说明性快照**)
- dsh 本体:构建基线 = `deepseek-harness` 子模块指针(`git submodule status`)
- 组件自身发布在各仓 Releases / Open VSX 进行;伞仓 release = 生态汇总快照,
  流程见 [docs/RELEASING.md](docs/RELEASING.md)

## 生态路线图与审查

| 文档 | 说明 |
|---|---|
| [docs/ECOSYSTEM-PLAN.md](docs/ECOSYSTEM-PLAN.md) | 生态化路线图 **v3**(决策 D1–D8、Phase 1–8、里程碑 M0–M8 / PM1–PM4) |
| [docs/RESTRUCTURE-UMBRELLA.md](docs/RESTRUCTURE-UMBRELLA.md) | **伞仓形态改造设计**(直接工程 + harness 唯一 submodule,2026-09-04 已执行) |
| [docs/ECOSYSTEM-PLAN-REVIEW.md](docs/ECOSYSTEM-PLAN-REVIEW.md) | 初轮审查(mimo-v2.5-pro,18 条,已消化) |
| [docs/ECOSYSTEM-PLAN-REVIEW-DEEP.md](docs/ECOSYSTEM-PLAN-REVIEW-DEEP.md) | 深度审查(代码级 + 实测,10 条,有效 8 条已进 v3) |
| [docs/WORKLOG.md](docs/WORKLOG.md) | 工作日志 / 交接 |
| [docs/modules/](docs/modules/README.md) | 各组件生态位说明书(索引 + 6 组件页,含 HEAD 快照 / 子模块指针) |
| [docs/RELEASING.md](docs/RELEASING.md) | 伞仓发布流程(tag 即生态汇总快照) |

工作项跟踪:

- **dsh-ecosystem Issues** — 里程碑 M0–M8 + 插件优化 PM1–PM4:https://github.com/kuaizhongqiang/dsh-ecosystem/issues
- 编号映射:M0=#3、M1=#5、M2=#6、M3=#7、M4=#8、M5=#9、M6=#10、M7=#11、M8=#12;PM1=#13、PM2=#14、PM3=#15、PM4=#16
- (原 dsh-launcher / dsh-plugins 里程碑 issue 已关闭并留跳转注释;dsh-launcher#1 经 UI transfer 原档迁入,即本仓 #3)

Issue / PR 模板与发布说明模板在 [`.github/`](.github/):bug / feature / 里程碑任务三套 issue 模板 + PR 模板 + release notes 模板。

## License

MIT(各子模块/组件仓各自持有 LICENSE;deepseek-harness 归 deepseek-ai)
