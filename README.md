# dsh-ecosystem — dsh 生态伞仓(monorepo)

以 [dsh-launcher](dsh-launcher/) 为核心的 DeepSeek Harness(dsh)个人生态,2026-09-04 起收敛为
**monorepo 单仓**:自有组件以**普通目录**形式与 `docs/` 同仓,伞仓即**唯一权威代码仓与发布仓**;
[deepseek-harness](deepseek-harness/)(官方上游)保持**唯一 git 子模块**,锁定 dsh 本体构建基线。
发布 = **一个 `vX.Y.Z` tag 全量发布所有包**(自动化,见 [docs/RELEASING.md](docs/RELEASING.md))。

> 形态演进:直接工程(RESTRUCTURE)→ **monorepo**(本形态);dsh-remote 组件已移除(2026-09-04,
> 内容归档于已归档的 kuaizhongqiang/dsh-remote)。

## 仓库结构

```
dsh-ecosystem/                  # 单一权威 git(全部代码 + 历史)
├── docs/                       # 单一事实源
├── scripts/                    # 伞仓级脚本(verify-release.mjs 发布校验门;mirror-desktop.mjs 上游桌面版镜像)
├── .github/workflows/          # release.yml = 全量发布 CI(tag v* 触发)
├── README.md / .AGENT.md / .gitmodules / LICENSE
├── dsh-launcher/               # L0 载体(安装 + 启动引导器;含插件源清单 ecosystem.json)
├── dsh-cli/                    # L1.5 入口层(终端 CLI + 本机工具服务:给别的 agent 调 dsh;见 docs/dsh-cli-*.md)
├── dsh-plugins/                # L3 插件合集(默认清单 9 包 + install-* 技能)
├── dsh-vscode/                 # L4 VSCode 扩展
├── agent-memory/               # L5 记忆层(我们的协议桥源码;记忆引擎为第三方上游)
└── deepseek-harness/           # ← 唯一 git 子模块(官方只读,按需 --init;桌面版 apps/desktop 在此)
```

## 组件清单(并入来源,均已归档只读)

| 目录 | 角色 | 来源仓(归档) | 并入 HEAD | 当前版本 |
|---|---|---|---|---|
| [dsh-launcher](dsh-launcher/) | L0 载体(伞仓核心) | kuaizhongqiang/dsh-launcher | `979cec6` | 0.11.5 |
| [dsh-cli](docs/dsh-cli-design.md) | **L1.5 入口层**(终端 CLI + 本机工具服务:让别的 agent 能调 dsh 执行任务) | 伞仓内目录 `dsh-cli/` | `0.11.0` | 0.11.5 |
| [dsh-plugins](dsh-plugins/) | L3 插件(默认清单 9 包 + 技能) | kuaizhongqiang/dsh-plugins | `7a1b8a9` | 随伞仓 |
| [agent-memory](agent-memory/) | L5 记忆层(协议桥: MCP 桥/HTTP 桥/autostore) | kuaizhongqiang/TencentAgentMemoryBridge | `4080826` | 0.3.0 |
| [dsh-vscode](dsh-vscode/) | L4 扩展(Open VSX + 优雅升级) | kuaizhongqiang/dsh-vscode | 随伞仓 | 0.11.5 |
| [desktop](docs/modules/dsh-desktop.md) | L4 桌面客户端(**已归上游**;伞仓只镜像 win-x64 安装包) | deepseek-ai/deepseek-harness `apps/desktop` | 随子模块 | 0.1.7-rc.2 |
| deepseek-harness | L2 本体(官方只读) | deepseek-ai/deepseek-harness | 子模块 `477b4f42` | — |

> 组件目录为伞仓 git 的普通目录(嵌套 .git/.gitmodules 已清除),随伞仓统一提交;插件集即
> `dsh-plugins/` 目录,launcher 安装/拉取按 `dsh-launcher/ecosystem.json` 锁定的伞仓 commit + sha256 获取。

## 拉取工作区

```powershell
git clone https://github.com/kuaizhongqiang/dsh-ecosystem.git
cd dsh-ecosystem
git submodule update --init deepseek-harness   # 可选:需要 dsh 本体源码时
```

增量更新:`git pull`;harness 跟随官方 tag 人工验证后 bump(不做 `update --remote` 自动推进)。

## 发布(全量,自动化)

打 `v0.8.0` 式 tag → 伞仓根 CI 发布全部:launcher(portable+NSIS)/ dsh-cli(exe + Linux 单文件 + npm)/
vscode(VSIX+Open VSX)/ plugins(清单校验)/ **desktop-mirror(镜像上游桌面版 win-x64 安装包)**。
详见 [docs/RELEASING.md](docs/RELEASING.md):
- 前置:三方组件版本 bump(launcher / vscode / dsh-cli)+ 插件清单同步(如有)+ desktop 镜像 pin 与子模块同号 +
  `node scripts/verify-release.mjs` 通过
- CI 需要 secrets:`OVSX_PAT`(vscode → Open VSX,可选)、`NPM_TOKEN`(dsh-cli → npm,可选)
- 产物与 Release 见 https://github.com/kuaizhongqiang/dsh-ecosystem/releases

## 生态路线图与审查

| 文档 | 说明 |
|---|---|
| [docs/ECOSYSTEM-PLAN.md](docs/ECOSYSTEM-PLAN.md) | 生态化路线图 **v3**(决策 D1–D8、Phase 1–8、里程碑 M0–M8 / PM1–PM4) |
| [docs/MONOREPO-UMBRELLA.md](docs/MONOREPO-UMBRELLA.md) | 伞仓 monorepo 化设计(阶段 A 已执行) |
| [docs/RESTRUCTURE-UMBRELLA.md](docs/RESTRUCTURE-UMBRELLA.md) | 直接工程形态设计(已执行,被取代) |
| [docs/ECOSYSTEM-PLAN-REVIEW.md](docs/ECOSYSTEM-PLAN-REVIEW.md) | 初轮审查(18 条,已消化) |
| [docs/ECOSYSTEM-PLAN-REVIEW-DEEP.md](docs/ECOSYSTEM-PLAN-REVIEW-DEEP.md) | 深度审查(有效 8 条已进 v3) |
| [docs/WORKLOG.md](docs/WORKLOG.md) | 工作日志 / 交接 |
| [docs/modules/](docs/modules/README.md) | 各组件生态位说明书 |
| [docs/RELEASING.md](docs/RELEASING.md) | 发布流程(全量 tag,自动化) |
| [docs/dsh-cli-design.md](docs/dsh-cli-design.md) | **dsh-cli 设计定稿**:会话归属模型 / 任务终结产出 out / 分段契约(一步一条) / 78 个工具候选 |
| [docs/dsh-cli-execution.md](docs/dsh-cli-execution.md) | **dsh-cli 施工计划**:里程碑 + issue 拆分 / 阶段验收 / 分支与 PR 规则 / 发布接入 |

工作项跟踪:

- **dsh-ecosystem Issues** — 里程碑 M0–M8 + 插件优化 PM1–PM4:https://github.com/kuaizhongqiang/dsh-ecosystem/issues
- 编号映射:M0=#3、M1=#5、M2=#6、M3=#7、M4=#8、M5=#9、M6=#10、M7=#11、M8=#12;PM1=#13、PM2=#14、PM3=#15、PM4=#16
- (原 dsh-launcher / dsh-plugins 里程碑 issue 已关闭并留跳转注释;dsh-launcher#1 经 UI transfer 原档迁入,即本仓 #3)

Issue / PR 模板与发布说明模板在 [`.github/`](.github/)。

## License

本仓(组件代码 + `docs/` + `scripts/` + 元数据)为 **MIT**,Copyright (c) 2026 kuaizhongqiang:
根 [`LICENSE`](LICENSE) 与各自有组件目录 —— [dsh-launcher](dsh-launcher/LICENSE) /
[dsh-plugins](dsh-plugins/LICENSE) / [dsh-vscode](dsh-vscode/LICENSE) / [dsh-cli](dsh-cli/LICENSE) /
[agent-memory](agent-memory/LICENSE) —— 为同一份文本。

第三方面(不在本仓 MIT 范围内,按各自条款):

- **[deepseek-harness](deepseek-harness)(唯一 git 子模块)**:官方上游,版权归 **deepseek-ai**;
  按其自身 `LICENSE` 与 `THIRD_PARTY_NOTICES.md` 使用 —— 本仓**只读跟随**(锁 commit),不改写、不重打包。
- **desktop(桌面版)**:同样归上游(`deepseek-harness/apps/desktop`);本仓自 2026-09-28 起不再自建,
  Release 里的桌面版安装包是**原样镜像**,权利与许可归上游。
- **agent-memory 的记忆引擎**:第三方上游(TencentDB Agent Memory,本地部署分支),按其自身许可;
  本仓只含协议桥 / 接入器。
- **dsh-plugins 内各插件**:插件代码本仓 MIT;它们调用的外部服务与第三方包 / 工具
  (MIMO、DeepSeek API、火山方舟 Seedream、Unity MCP、Unreal 等)归各自所有,按各自条款与凭证使用。
