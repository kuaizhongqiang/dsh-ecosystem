# Release Notes 模板 — dsh-ecosystem 全量发布

> 用法:CI(init job)按此结构生成 release notes;打 tag 前复制本模板人工核对/补充。
> 伞仓 release = **全量发布**(2026-09-04 起):一个 `vX.Y.Z` tag 发布所有组件,资产同仓。

## 概要

- **Tag**:`vX.Y.Z`
- **日期**:YYYY-MM-DD
- **性质**:全量发布(launcher / vscode / dsh-cli 同一版本;desktop 为**上游**产物的镜像,版本号与 tag 无关)

## 生态变更摘要

> 3–5 行人话:这轮生态发生了什么(新能力、运行时源切换、发布流程等)。

- …

## 组件版本表

| 组件 | 本 release 版本 | 产物 | 渠道 | 关键变更 |
|---|---|---|---|---|
| dsh-launcher | `vX.Y.Z` | portable exe + NSIS setup | 本 release 资产 | … |
| dsh-cli | `vX.Y.Z` | `dshcli.exe` + `dshcli-linux-x64` | 本 release 资产 + npm | … |
| desktop(**镜像**) | 上游版号(如 `0.1.7-rc.2`) | 上游 `deepseek-harness-<上游版>-win-x64.exe` + `.sha512` | 本 release 资产(上游自有 COS 通道不变) | … |
| dsh-vscode | `vX.Y.Z` | VSIX | 本 release 资产 + Open VSX | … |
| dsh-plugins | 随伞仓 commit | 无独立产物 | launcher 清单 | … |
| deepseek-harness | 子模块 `477b4f42`(锁定,`dsh-v0.1.7-rc.2`) | — | 官方上游(只读跟随;桌面版亦在此) | … |

## 文档 / 治理更新

- docs/…(新增/修订内容一句话)
- .github/…(workflow / 模板变化)
- README / .AGENT.md / WORKLOG 同步情况

## 里程碑进度

- 已完成:M? / PM?
- 进行中:M? / PM?(关联 issue #N)
- 下一步:…

## 使用说明(对消费者)

- 安装 launcher / dsh-cli / 桌面版:本 release 资产下载 exe/setup(**桌面版是上游产物镜像,其版本号与 tag 不同**);
  扩展:vscode 市场(Open VSX)或 vsix 手动安装;mac 桌面版走上游官方通道(伞仓不镜像 mac)
- 拉取源码:README「拉取工作区」+ `git submodule update --init deepseek-harness`
