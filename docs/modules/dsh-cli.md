# dsh-cli — L1.5 入口层(伞仓内目录)

| 项 | 值 |
|---|---|
| 形态 | **伞仓内目录 `dsh-cli/`**(monorepo,随伞仓统一提交) |
| 生态位 | L1.5 入口层(与 L0 的 launcher 并列;不实现 agent loop) |
| 产物 | `dshcli.exe`(自包含,目标机不需要装 Node) + npm 包 `@kuaizhongqiang/dsh-cli`(bin `dshcli` / 别名 `dshc`) |
| 命令名 | **`dshcli`** —— 不占用上游的 `dsh`(冲突时 CLI 让路) |
| 依赖 | dsh 本体(子模块 L2)的可执行 + 会话事件日志;无第三方运行时依赖 |

## 角色

把 dsh 接成**可被别的 agent(openclaw 等)调度的执行体**:dsh 只管执行与查询,定时/调度归调用方。

- **cmd 面**:`dshcli run / report / status / doctor / tools / call / serve`(人可直接用,非重点);
- **对外调用面**:本机回环 HTTP + token,工具路由 `/call/<工具>`(清单见 `dshcli tools`);
- **数据源**:直接读会话事件日志(`%DSH_HOME%/sessions/**/session.jsonl.zstd`,多帧 zstd),
  **不用** `headless --json`(它的投影会裁到 8KiB/32KiB)。

## 关键契约(设计与施工文档)

- [dsh-cli-design.md](../dsh-cli-design.md) —— 设计定稿(归属模型 / `out` 契约 / 分段契约 / 工具清单 / 兼容检测);
- [dsh-cli-execution.md](../dsh-cli-execution.md) —— 施工计划(里程碑 + issue 拆分 / 阶段验收 / 分支与发布规则)。

三条硬规则:① 外来会话运行中只读、越界硬失败;② `out` 是主事件是辅、同步异步同形;
③ 分段契约「一步一条」:不裁、不塞二进制、不丢事件。

## 与伞仓的关系

- **开发在伞仓内进行**,随伞仓 git 提交;
- 发布跟随伞仓全量 tag(`vX.Y.Z`):版本与 launcher / vscode **三方一致**(desktop 已归上游,不参与伞仓版本号),
  由 `.github/workflows/release.yml` 的 `build-dsh-cli` job 出 exe + 发 npm;
- launcher 侧提供 **安装入口与更新入口**(检测/下载/升级/拉起,见施工计划 §3 P5)。

## 质量门

- `node dsh-cli/scripts/verify-cli.mjs` —— **85 项**:多帧 zstd / 会话发现 / 分段契约 / 归属写权限 / `out` 无损 /
  **桩 dsh 端到端**(可执行+会话日志+out+report,不触网) / HTTP 鉴权与工具路由 / 契约快照 /
  **命令面两层**(短开关≡子命令、生成子命令、`--help`、未实现报错、78 个参数声明) /
  **技能**(正文关键词、落盘、与内嵌一致性、提示);
- 构建:`npm run build:exe`(esbuild 打包 → Node SEA blob → postject 注入 → `dist/dshcli.exe` +
  `dist/dshcli-<ver>.exe`;`dist/` 不入库,只进 Release 资产);
- 发布门:`scripts/verify-release.mjs` 现在同时校验**三方组件版本一致**(launcher / vscode / dsh-cli;
  desktop 已归上游,另由镜像 pin 校验),
  给了 `TAG`/`GITHUB_REF_NAME` 还要与 tag 一致。
- **本机构建坑**:npm 开了 allow-scripts → esbuild 的 postinstall 会被拦,需手动
  `node node_modules/esbuild/install.js` 再构建;CI(GitHub runner)无此策略。

## 运行时关键文件(dsh-cli 侧)

| 文件 | 作用 |
|---|---|
| `%DSH_HOME%\bin\dshcli.exe` | 自包含产物(launcher 经插件工具 `launcher_cli` 安装/升级) |
| `%DSH_HOME%\bin\dshcli.install.json` | 安装状态:版本 / 大小 / sha256 / 来源 |
| `%DSH_HOME%\dsh-cli\endpoint.json` | **本机工具服务的 token**(不进仓库/日志) |
| `%DSH_HOME%\dsh-cli\*.json` | 任务运行记录(会话归属判定用) |

## 给改这个组件的代理(要点)

- **参数元数据是单一事实来源**(`src/tools.js` 的 `positional`/`params`):同时驱动子命令、`--help`、
  `GET /tools` 自描述与参数校验 —— **加工具要连参数一起声明**,别另写一份。
- 主要消费者是 agent,所以 `--json` 无损、退出码稳定、未实现工具报 `not_implemented`。
- 改技能正文 = 改仓里 `skills/dshcli.SKILL.md` 那一份(构建期内嵌进 exe),别在别处另抄。
