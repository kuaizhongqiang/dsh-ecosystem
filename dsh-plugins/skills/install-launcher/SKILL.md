---
name: install-launcher
description: 把 launcher 桥接插件(launcher_restart/launcher_status/launcher_connections/launcher_open/launcher_check_update 五个工具)安装到 dsh web,让会话内可以直接「重启 dsh / 切连接 / 查状态 / 开浏览器 / 查升级」。当用户要求安装、卸载或排查 dsh-launcher 插件,或想让 dsh 获得重启与多连接能力时使用。
whenToUse: 用户说「装 dsh-launcher 插件」「让 dsh 能重启自己/切换连接」,或 launcher_status 显示未注册需要接入 seam 时使用;依赖 launcher M5(connections.json)与 M6(重启 seam)。
---

# 安装 dsh-launcher 插件

把 launcher 宿主能力升级为 dsh 一等工具面(PLAN §8 / D6)。**无新凭证**:工具只读写
`%DSH_HOME%` seam 文件(launcher-registration.json / connections.json / launch-token.json),
token 不出本机、输出一律脱敏。

## 0. 定位插件包

伞仓 monorepo 目录:`<dsh-ecosystem>/dsh-plugins/plugins/dsh-launcher-dsh-plugin/`(`install.ps1` 同目录;
本地 `git clone https://github.com/kuaizhongqiang/dsh-ecosystem.git` 后即含)。旧独立仓 kuaizhongqiang/dsh-plugins 已归档,勿再 clone。

## 1. 前置

1. dsh 已装且 web profile 启动过(`%DSH_HOME%\profiles\web`);
2. (可选但推荐)本机装有 dsh-launcher ≥ M5/M6 版本:重启 seam 与 connections.json 才可用;
   没有 launcher 时工具仍可安装,但 launcher_restart 会返回手动重启指引。

## 2. 安装

```powershell
powershell -ExecutionPolicy Bypass -File "<dsh-plugins>/plugins/dsh-launcher-dsh-plugin/install.ps1"
# 卸载:-Uninstall
```

幂等:载荷覆盖复制,patch 条目(tool-launcher)判重跳过。

## 3. 重启并验证

1. 重启:若已有可用 launcher 注册,直接调用 `launcher_restart`(建议带 `reason` 说明原因/
   要恢复的工作摘要,工具会写入重启意图文件);否则请用户手动重启
   (停掉 web → `dsh web`,或重启 launcher);
2. 验证:重启后调用 `launcher_status` —— 应返回注册信息(或明确的「未注册」说明)、
   激活连接与 launch-token 状态;再试 `launcher_connections`(list)确认连接组。

## 3a. 重启编排 seam(自助重启后恢复工作)

`launcher_restart` 运行在 dsh 进程内,**重启会杀掉本进程与进行中的回合/后台任务**。为能持续工作:

1. 触发重启前:若在做长任务/目标轮次,先调用 `launcher_restart` 且 `reason` 写明
   「重启原因 + 下一步待办摘要」(工具已自动写入 `%DSH_HOME%\.dsh-restart-intent.json`);
2. 重启生效后(通常数秒,launcher 自动重抓 token):恢复会话,先调用 `launcher_status`
   ——若摘要含「⚠️ 上次重启意图」,说明本进程是重启后的实例;
3. **恢复动作**:对被打断的目标执行 `update_goal resume`(目标跨重启存活但会 disarm),
   再按意图文件里的待办继续;确认无后续事项后用 `launcher_status(clearRestartIntent=true)`
   清除意图,避免下次状态提示残留。

> 意图文件只含时间/原因/pid,无任何 token(D2 合规);失败落盘不阻断重启。

## 4. 故障排查

- `launcher_restart` 报「未发现可用的 launcher」:launcher 未安装/过旧(无 M6 seam)→
  指引升级 launcher 后重试;
- REST bridge 403:注册文件与运行中的 launcher 不匹配 → 重启 launcher 重新注册;
- 工具不出现:确认 cordis.patch.yml 含 `tool-launcher` 条目并已重启。
