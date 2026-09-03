# dsh-ecosystem — dsh 生态伞仓

以 [dsh-launcher](https://github.com/kuaizhongqiang/dsh-launcher) 为核心的 DeepSeek Harness(dsh)个人生态,全部组件以 **git 子模块**平铺于此。子模块的 commit 指针即**生态版本锁**——各组件更新后在此 bump 一笔,全生态版本一目了然。

## 一条命令拉全生态

```powershell
git clone --recurse-submodules https://github.com/kuaizhongqiang/dsh-ecosystem.git
```

已有本地检出时增量补齐:

```powershell
git submodule update --init --recursive
```

## 组件清单

| 子模块 | 说明 | 生态位 |
|---|---|---|
| [dsh-launcher](dsh-launcher/) | Windows 单文件安装 + 启动引导器(伞仓的核心) | 载体 L0 / 生命周期 |
| [dsh-plugins](dsh-plugins/) | 社区插件合集(11 包 + install-* 技能,路线图 §8 计划合并为 7) | 插件 L3 |
| [dsh-vscode](dsh-vscode/) | VSCode 扩展(会话/聊天/工具卡片,已发布 Open VSX) | 周边 L4 |
| [dsh-desktop](dsh-desktop/) | Electron 桌面壳客户端(连共享 dsh server) | 周边 L4 |
| [dsh-remote](dsh-remote/) | 远程部署记录(Cloudflare Access) | 广域网 L6 |
| [deepseek-harness](deepseek-harness/) | dsh 本体(官方上游 `deepseek-ai/deepseek-harness`,只读消费,非自有仓) | 核心 L2 |

> 注意:`dsh-launcher` 内部另有自己的 `dsh-plugins` 子模块(launcher 安装/拉取时的**运行时源**),伞仓顶层 `dsh-plugins` 是**开发集合视角**——两处指针独立 bump,更新插件时两处都要推进。

## 生态路线图与审查

| 文档 | 说明 |
|---|---|
| [docs/ECOSYSTEM-PLAN.md](docs/ECOSYSTEM-PLAN.md) | 生态化路线图 **v3**(决策 D1–D8、Phase 1–8、里程碑 M0–M8 / PM1–PM4) |
| [docs/ECOSYSTEM-PLAN-REVIEW.md](docs/ECOSYSTEM-PLAN-REVIEW.md) | 初轮审查(mimo-v2.5-pro,18 条,已消化) |
| [docs/ECOSYSTEM-PLAN-REVIEW-DEEP.md](docs/ECOSYSTEM-PLAN-REVIEW-DEEP.md) | 深度审查(代码级 + 实测,10 条,有效 8 条已进 v3) |
| [docs/WORKLOG.md](docs/WORKLOG.md) | 工作日志 / 交接 |

工作项跟踪:

- **dsh-launcher Issues** — 里程碑 M0–M8(#1–#9):https://github.com/kuaizhongqiang/dsh-launcher/issues
- **dsh-plugins Issues** — 插件优化 PM1–PM4(#3–#6):https://github.com/kuaizhongqiang/dsh-plugins/issues
- (迁移后)本仓 Issues — 生态统一工作项

## 指针更新

```powershell
git submodule update --remote   # 各子模块推到各自远端 HEAD(谨慎:自动)
git add -A && git commit -m "chore: bump submodules" && git push
```

个人生态建议**手动逐仓推进**(先在各仓验证,再 bump 指针提交),保持伞仓指针 = 已验证版本。

## License

MIT(各子模块仓各自持有 LICENSE;deepseek-harness 归 deepseek-ai)
