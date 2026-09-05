# dsh-ecosystem — dsh 生态伞仓(monorepo)

以 [dsh-launcher](dsh-launcher/) 为核心的 DeepSeek Harness(dsh)个人生态,2026-09-04 起收敛为
**monorepo 单仓**:5 个自有组件以**普通目录**形式与 `docs/` 同仓,伞仓即**唯一权威代码仓**;
[deepseek-harness](deepseek-harness/)(官方上游)保持**唯一 git 子模块**,锁定 dsh 本体构建基线。
原 5 个源仓(`kuaizhongqiang/dsh-launcher|plugins|vscode|desktop|remote`)已并入本仓并**归档只读**(阶段 B)。

> 形态演进:直接工程(RESTRUCTURE,2026-09-04 已执行)→ **monorepo**(本形态,阶段 A 已执行),
> 设计见 [docs/MONOREPO-UMBRELLA.md](docs/MONOREPO-UMBRELLA.md)。

## 仓库结构

```
dsh-ecosystem/                  # 单一权威 git(全部代码 + 历史)
├── docs/                       # 单一事实源
├── .github/                    # 治理模板(组件各自的 .github/workflows 为归档文件,不生效,见 .AGENT.md)
├── README.md / .AGENT.md / .gitmodules / LICENSE
├── dsh-launcher/               # L0 载体(安装 + 启动引导器)
├── dsh-plugins/                # L3 插件合集(7 包 + install-* 技能)
├── dsh-vscode/                 # L4 VSCode 扩展
├── dsh-desktop/                # L4 Electron 桌面壳(应用代码在 desktop/ 子目录)
├── dsh-remote/                 # L6 远程部署记录
└── deepseek-harness/           # ← 唯一 git 子模块(官方只读,按需 --init)
```

## 组件清单(并入来源)

| 目录 | 角色 | 来源仓(已归档只读) | 并入 HEAD(快照) |
|---|---|---|---|
| [dsh-launcher](dsh-launcher/) | L0 载体(伞仓核心) | kuaizhongqiang/dsh-launcher | `979cec6`(v0.7.3) |
| [dsh-plugins](dsh-plugins/) | L3 插件(7 包 + 技能) | kuaizhongqiang/dsh-plugins | `7a1b8a9` |
| [dsh-vscode](dsh-vscode/) | L4 扩展(Open VSX) | kuaizhongqiang/dsh-vscode | `1756889` |
| [dsh-desktop](dsh-desktop/) | L4 桌面壳 | kuaizhongqiang/dsh-desktop | `250abfb` |
| [dsh-remote](dsh-remote/) | L6 远程部署记录 | kuaizhongqiang/dsh-remote | `4f755d2` |

> 组件目录为伞仓 git 的普通目录(嵌套 .git / .gitmodules 已清除),随伞仓统一提交推进;
> 各组件自带文档与质量门脚本仍在各自目录内。

## 拉取工作区

```powershell
git clone https://github.com/kuaizhongqiang/dsh-ecosystem.git
cd dsh-ecosystem
git submodule update --init deepseek-harness   # 可选:需要 dsh 本体源码时
```

增量更新:`git pull`;harness 跟随官方 tag 人工验证后 bump(不做 `update --remote` 自动推进)。

## 版本状态与发布

- 组件版本 = 伞仓内目录(随伞仓提交推进;版本号见各目录 package.json / README)
- dsh 本体基线 = `deepseek-harness` 子模块指针(`git submodule status`)
- **发布 = 手动 SOP**:组件产物本地构建后手动上传伞仓 Releases / Open VSX(源仓归档,原 Actions 已停摆;
  伞仓重建 CI 为后续项)——见 [docs/RELEASING.md](docs/RELEASING.md)

## 生态路线图与审查

| 文档 | 说明 |
|---|---|
| [docs/ECOSYSTEM-PLAN.md](docs/ECOSYSTEM-PLAN.md) | 生态化路线图 **v3**(决策 D1–D8、Phase 1–8、里程碑 M0–M8 / PM1–PM4) |
| [docs/MONOREPO-UMBRELLA.md](docs/MONOREPO-UMBRELLA.md) | **伞仓 monorepo 化设计**(阶段 A 已执行;阶段 B = 归档与手动发版 SOP) |
| [docs/RESTRUCTURE-UMBRELLA.md](docs/RESTRUCTURE-UMBRELLA.md) | 直接工程形态设计(已执行,**被 MONOREPO 取代**) |
| [docs/ECOSYSTEM-PLAN-REVIEW.md](docs/ECOSYSTEM-PLAN-REVIEW.md) | 初轮审查(mimo-v2.5-pro,18 条,已消化) |
| [docs/ECOSYSTEM-PLAN-REVIEW-DEEP.md](docs/ECOSYSTEM-PLAN-REVIEW-DEEP.md) | 深度审查(代码级 + 实测,10 条,有效 8 条已进 v3) |
| [docs/WORKLOG.md](docs/WORKLOG.md) | 工作日志 / 交接 |
| [docs/modules/](docs/modules/README.md) | 各组件生态位说明书(索引 + 6 页) |
| [docs/RELEASING.md](docs/RELEASING.md) | 伞仓发布流程(手动 SOP) |

工作项跟踪:

- **dsh-ecosystem Issues** — 里程碑 M0–M8 + 插件优化 PM1–PM4:https://github.com/kuaizhongqiang/dsh-ecosystem/issues
- 编号映射:M0=#3、M1=#5、M2=#6、M3=#7、M4=#8、M5=#9、M6=#10、M7=#11、M8=#12;PM1=#13、PM2=#14、PM3=#15、PM4=#16
- (原 dsh-launcher / dsh-plugins 里程碑 issue 已关闭并留跳转注释;dsh-launcher#1 经 UI transfer 原档迁入,即本仓 #3)

Issue / PR 模板与发布说明模板在 [`.github/`](.github/)。

## License

MIT(各组件目录各自持有 LICENSE;deepseek-harness 归 deepseek-ai)
