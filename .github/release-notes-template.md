# Release Notes 模板 — dsh-ecosystem 全量发布

> 用法:CI(init job)按此结构生成 release notes;打 tag 前复制本模板人工核对/补充。
> 伞仓 release = **全量发布**(2026-09-04 起):一个 `vX.Y.Z` tag 发布所有组件,资产同仓。

## 概要

- **Tag**:`vX.Y.Z`
- **日期**:YYYY-MM-DD
- **性质**:全量发布(launcher / desktop / vscode / plugins 同一版本)

## 生态变更摘要

> 3–5 行人话:这轮生态发生了什么(新能力、运行时源切换、发布流程等)。

- …

## 组件版本表

| 组件 | 本 release 版本 | 产物 | 渠道 | 关键变更 |
|---|---|---|---|---|
| dsh-launcher | `vX.Y.Z` | portable exe + NSIS setup | 本 release 资产 | … |
| dsh-desktop | `vX.Y.Z` | NSIS setup + latest.yml + blockmap | 本 release 资产 | … |
| dsh-vscode | `vX.Y.Z` | VSIX | 本 release 资产 + Open VSX | … |
| dsh-plugins | 随伞仓 commit | 无独立产物 | launcher 清单 | … |
| deepseek-harness | 子模块 `47f94385`(锁定) | — | 官方上游(只读跟随) | … |

## 文档 / 治理更新

- docs/…(新增/修订内容一句话)
- .github/…(workflow / 模板变化)
- README / .AGENT.md / WORKLOG 同步情况

## 里程碑进度

- 已完成:M? / PM?
- 进行中:M? / PM?(关联 issue #N)
- 下一步:…

## 使用说明(对消费者)

- 安装 launcher/desktop:本 release 资产下载 exe/setup;扩展:vscode 市场(Open VSX)或 vsix 手动安装
- 拉取源码:README「拉取工作区」+ `git submodule update --init deepseek-harness`
