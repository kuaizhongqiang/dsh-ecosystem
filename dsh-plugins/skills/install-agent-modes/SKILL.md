---
name: install-agent-modes
description: 把 7 个开发阶段模式（需求/文档·写/文档·审/设计·美化/实现/测试反馈/交付·仓库）的 preset 声明装进 dsh web profile，让会话可按阶段切换工具面与权限
whenToUse: 用户要求安装/升级/卸载/排查 agent-modes（阶段模式、按阶段切工具面、防止 agent 越过阶段自动继续）时使用
---

# 安装 agent-modes（开发阶段模式）

## 目的

装完后，dsh 的模式选择器里会多出 7 个模式，每个模式挂不同的工具面：

| 模式 | 装完能做什么 |
|---|---|
| 需求 | 只读分析 + 提问；物理上不能写文件、不能跑 shell |
| 文档·写 | 写文档；计划类文档会附「执行分工」区块 |
| 文档·审 | 只读审阅，产出带出处的问题清单 |
| 设计·美化 | 写设计文档与视觉规范，不写产品代码 |
| 实现 | 唯一能写代码、跑命令、派活的模式 |
| 测试反馈 | 能跑测试，不能改文件 |
| 交付·仓库 | 版本控制与记录 |

7 个模式**都不挂** `tool-goal` / `tool-ralph`，所以做完就停，不会自动进入下一阶段；
阶段推进只能由人换模式。

## 前置

1. dsh 已安装且 web profile 存在（`%DSH_HOME%\profiles\web`；没启动过先 `dsh web` 一次）；
2. **不要同时用 bundle 路径安装同一批 preset** —— 两条路径声明同一批 preset id，会撞重复 id；
   安装器会自动检测并拒绝；
3. 无凭证需求。

## 步骤

1. 运行安装器：

   ```powershell
   powershell -ExecutionPolicy Bypass -File "<dsh-plugins>/plugins/agent-modes-dsh-plugin/install.ps1"
   powershell -ExecutionPolicy Bypass -File "<dsh-plugins>/plugins/agent-modes-dsh-plugin/install.ps1" -Profile desktop
   ```

   - `-Profile`：目标 profile，默认 `web`；桌面版用 `desktop`。**两者独立，必须分别安装**；
   - 卸载：`-Uninstall [-Profile desktop]`；
   - 幂等：以 `preset-clarify` 判重，可重复执行；
   - 写入前会跑 `scripts/validate-patch.mjs` 结构门，不通过**不落盘**。

2. **重启并验证**：
   - 优先走 launcher 重启 seam：`launcher_restart` 工具，或
     `%DSH_HOME%\launcher-registration.json` 中 api 的 `POST /api/dsh/restart?key=<bridgeKey>`；
   - 无 launcher 时手动重启：停掉 web → `dsh web`；
   - 验证：**新建会话** → 模式选择器应出现 7 个中文模式名。

3. **验收硬边界**（建议至少做一次，这是本包的核心价值）：
   - 在「需求」模式里要求它改一段代码 → 它应该**物理上做不到**（没有 write/edit，也没有 shell），
     并停下说明；
   - 在「测试反馈」模式里要求它改文件 → 同样应被拒，但它应该能跑测试命令。

## 故障排查

- **模式选择器里没有新模式**：确认 `cordis.patch.yml` 含 `preset-clarify` 条目，且**已重启** dsh web。
  已存在的会话保留启动时的插件版本，必须**新建会话**才能看到新模式。
- **报重复 preset id**：bundle 路径与 patch 路径同时在用，二选一。
- **桌面版看不到新模式**：`web` 与 `desktop` 是两个独立 profile，需要单独跑
  `install.ps1 -Profile desktop` 并**重启桌面版**。
- **改了 `install.ps1` 后脚本报 `Missing closing`**：多办是编辑过程把 UTF-8 BOM 吃掉了。
  Windows PowerShell 5.1 读无 BOM 文件会按 GBK 解码而无法解析——**BOM 必须保留**；
  同时脚本内读文件一律走 `Read-TextUtf8`，不要用 `Get-Content -Raw`。
- **结构门报 `not a comment, list item, or "key: value"` 且指向中文散文行**：校验器版本过旧
  （块标量识别缺失），更新 `scripts/validate-patch.mjs`。
- **某模式看不到任何技能**：这是 `includeDefaultRoots: false` 的预期行为。需要共享技能就把该模式的
  这一行改成 `true`，或把该模式专属技能放进 `<DSH_HOME>\skills-modes\<mode>\`。

## 红线

- 不要把真实凭证写进仓库或分享文件；
- 不要改动 `deepseek-harness/` 子模块；
- 阶段模式的价值来自**边界**。不要为了「方便」给只读模式补写能力或 shell ——
  那等于把机制退回成提示词，本包就白做了。
