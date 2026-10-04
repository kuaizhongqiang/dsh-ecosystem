---
name: install-continuity
description: 把任务连续性插件 dsh-continuity(handoff 服务:/handoff 命令 + handoff_start 工具)安装到 dsh web,让「上下文不够用就换新会话继续」变成一次命令——自动写交接文档、同 workspace 新开会话、克隆 goal(轮次归零)、播种首条消息并自动开跑。当用户要求安装、卸载或排查 dsh-continuity / handoff、或抱怨「换会话要先让 agent 总结再复制粘贴」时使用。
whenToUse: 用户说「装 continuity/handoff 插件」「新开会话接着跑」「上下文满了怎么续」，或 /handoff 命令与 handoff_start 工具缺失需要排查时使用。无凭证依赖。
---

# 安装 dsh-continuity 插件（任务连续性域）

第 8 个插件包。域定义：**任务不因载体（会话 / 上下文窗口 / 进程）更替而中断**。
v1 只交付一个服务 `handoff`，**无凭证、无外部系统**，只用 dsh 自身的
session / goal / plan / sessionProjections seam。

## 0. 定位插件包

伞仓 monorepo 目录：`<dsh-ecosystem>/dsh-plugins/plugins/dsh-continuity-dsh-plugin/`
（`install.ps1` 同目录）。旧独立仓 kuaizhongqiang/dsh-plugins 已归档，勿再 clone。

## 1. 前置

1. dsh 已装且 web profile 启动过（`%DSH_HOME%\profiles\web`）；
2. 无需任何 key。交接文档落在 `%DSH_HOME%\handoff\<workspace>\`，不需要额外权限。

## 2. 安装

```powershell
powershell -ExecutionPolicy Bypass -File "<dsh-plugins>/plugins/dsh-continuity-dsh-plugin/install.ps1"
# 多 profile 机器显式指定目标：-ProfileName desktop
# 只装单服务：-Only handoff      卸载：-Uninstall [-Only handoff]
```

**目标 profile 自动解析**：`-ProfileName` → `$env:DSH_PROFILE` / `$env:DSH_PROFILE_DIR`（会话内
由 dsh-shell-env 注入）→ 进程祖先链 → 唯一候选 → 兜底 web。**不要写死 `profiles\web`**：
桌面宿主跑的是 `profiles\desktop`，写死会让插件装进没人加载的 profile。

幂等：载荷覆盖复制；patch 条目（`tool-handoff`）判重跳过；卸载按节头
`# --- dsh-continuity: handoff (native dsh) ---` 按缩进整段剥离（含最后一行 `name:`）。

## 3. 重启并验证

1. 重启：**必须重启进程**——载荷 JS 换代不会自动换模块
   （`dsh-plugin-manager`：「Package replacements require restarting the process to load a
   fresh JavaScript module generation」）；config 改动才可热应用。优先 `launcher_restart`
   （带 `reason`），但注意桌面部署下 launcher 可能早已停摆（注册心跳陈旧 → 静默空操作），
   此时请用户手动退出并重开 DeepSeek Harness；
2. 验证：
   - 命令面：`/handoff --dry-run` —— 应只写交接文档、**不**建会话，并回显文档路径；
   - 工具面：`handoff_start` 应出现在工具列表里（`dryRun=true` 可安全试跑）；
   - 文件面：`%DSH_HOME%\handoff\<workspace>\latest.md` 出现；
3. 真机端到端：`/handoff 备注` —— 应在左侧会话列表出现一条新会话，且它**已经在自己跑**
   （首条消息是「读交接文档并继续」）。

## 4. 语义边界（排查时先看这里）

- **计划模式会被拒绝**：源会话处于 plan mode（计划未批准）时 `/handoff` 返回 error。
  这是刻意设计——否则新会话会去执行一份没人批准的计划。先 `exit_plan_mode` 或退出计划模式。
- **goal 轮次归零**：新会话重新 `goals.create` 同一 objective，`roundsStarted` 从 0 起算，
  `maxGoalRounds` 继承源 goal；源 goal 若是 `paused`，新会话以 `active` 启动（不保持 paused）。
- **todo 不继承**：`todos` 投影遇 `turn/start` 会重置，预置会被抹掉。交接文档里有 todo 段，
  接手会话需用 `todo_write` 重建。
- **插件不能替 UI 切会话**：新会话建好并已在跑，但活动会话的选择归客户端；
  需要在左侧会话列表点一下。

## 5. 故障排查

- `/handoff` 不在命令菜单：确认 `cordis.patch.yml` 含 `tool-handoff` 条目并已重启；
- 工具报「需要 X 服务」：profile 组合缺 `sessionProjections` / `goals` / `agents` /
  `sessionController`——web profile 默认都有，缺失说明 patch 层把宿主行禁用了；
- 新会话没自动跑：看返回文本里是否带「首条消息发送失败」，或新会话的 preset 与源会话不同；
- 交接文档是乱码：检查安装器是否用了 `Get-Content -Raw -Encoding UTF8`
  （2026-10-04 之前的 14 个旧安装器缺这个参数，会把 patch 文件写坏）。

## 红线

- 插件内不含任何凭证；不要把 key 写进仓库或交接文档。
- 交接文档只写任务状态，不写 token / cookie / 私密内容。
