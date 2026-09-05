# PLUGIN-SPEC —— dsh 插件分层规范与模板(PM1 / 路线图 §8)

> 适用:dsh-plugins 仓内全部插件包。新包准入与既有包重构都按本规范执行。
> 决策依据:ECOSYSTEM-PLAN §3 D7(插件按「凭证与模式」聚合,不按工具拆分)+ §8(11→7)。

## 1. 分层(D7)

| 层 | 包 | 说明 |
|---|---|---|
| 基础设施 | dsh-credentials | 最底层凭证 seam(`.credentials.yaml`),不与任何包耦合 |
| 感知 | **dsh-media** | 音频/语音/图片/视频/文档;MIMO_API_KEY(+vision 端点);「text-only 主模型 + 外挂感知」 |
| 账户 | **dsh-deepseek** | DEEPSEEK_API_KEY;账户运维(balance/recharge) |
| 域工具 | dsh-github / dsh-stock | 工具数 ≥8,自成一体 |
| 桥接 | dsh-unity / **dsh-launcher** | 外部系统桥(unity-mcp / launcher seam) |

## 2. 准入三问(D7/§8)

新插件入集合前先答:**独立凭证?独立外部系统(MCP)?工具数 ≥8?**
三者皆否 → 并入既有层(包内多服务,`--only` 子集安装)。阈值随实践校准,非硬常数。

## 3. 包结构规范

```
plugins/<pkg>-dsh-plugin/
  install.ps1          # 安装器(规范见 §4);支持 -Only 子集与 -Uninstall
  README.md            # 工具表 / 安装 / 凭证 / 迁移说明
  .env.example         # 凭证模板(只有 key 名,绝无真实值)
  plugins/<svc>/       # 每服务一个载荷目录:index.js + package.json(+附属文件)
  DEPRECATED.md        # (弃用时)迁移指引
```

- 服务命名:`<svc>` 与载荷目录、patch 工具 id(`tool-<svc>`)严格一致。
- 多服务包:包名 = `dsh-<域>`(如 dsh-media),服务仍按单目录平铺,patch 条目逐服务幂等。

## 4. install.ps1 规范

1. **幂等**:载荷覆盖复制;patch 条目以 `tool-<svc>` 判重,已存在则 SKIP。
2. **-Only 子集**:`param([string]$Only='')`,逗号分隔服务 id;未知 id 报错并列出可用项。
3. **-Uninstall**:删除载荷目录 + 从 `cordis.patch.yml` 剥离对应节(按节头精确匹配)。
4. **节头规范**:新增条目一律 `# --- dsh-<pkg>: <svc> (native dsh) ---`;旧单包节头
   (如 `# --- audio reading tools (native dsh) ---`)由 `uninstall-old.ps1` 精确剥离。
5. **cordis.patch.yml 合并**:剥离裸 `[]` 占位行后按序列合并;UTF-8 无 BOM 写回。
6. **凭证**:只提示(credentials seam → 环境变量),绝不写入/打印真实 key(D2 红线)。
7. **额外步骤**(如 apiproxy 补丁、python 依赖探测)必须可重跑、失败降级为 WARN,不中断安装。

## 5. SKILL.md 模板要素(install-* 技能)

模板见 `_templates/SKILL.md.tmpl`,必备段:目的 / 前置(dsh 已装且 web profile 启动过)/
步骤(install.ps1 → 凭证 → 重启验证)/ 重启验证(经 launcher restart seam 或手动)/ 红线
(凭证不入库)。

## 6. 弃用流程

1. 合并包落地后,旧包根加 `DEPRECATED.md`(指明并入目标与迁移步骤),保留一个版本周期;
2. 仓库根 `uninstall-old.ps1` 负责旧载荷/patch 节(可选 -Skills 连技能一起清);
3. 下一个大版本删除旧包目录。
