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

仓库 `plugins/dsh-launcher-dsh-plugin/`(本地克隆或 `git clone https://github.com/kuaizhongqiang/dsh-plugins`)。

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

1. 重启:若已有可用 launcher 注册,直接调用 `launcher_restart`;否则请用户手动重启
   (停掉 web → `dsh web`,或重启 launcher);
2. 验证:重启后调用 `launcher_status` —— 应返回注册信息(或明确的「未注册」说明)、
   激活连接与 launch-token 状态;再试 `launcher_connections`(list)确认连接组。

## 4. 故障排查

- `launcher_restart` 报「未发现可用的 launcher」:launcher 未安装/过旧(无 M6 seam)→
  指引升级 launcher 后重试;
- REST bridge 403:注册文件与运行中的 launcher 不匹配 → 重启 launcher 重新注册;
- 工具不出现:确认 cordis.patch.yml 含 `tool-launcher` 条目并已重启。
