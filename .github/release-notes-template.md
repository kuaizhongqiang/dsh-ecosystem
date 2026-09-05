# Release Notes 模板 — dsh-ecosystem 伞仓生态汇总快照

> 用法:切新 tag 时复制本模板,按实际填充;与 docs/RELEASING.md 流程配合。
> 伞仓 release = **生态汇总快照**(2026-09-04 形态改造后:harness 子模块指针锁定,各组件记录 HEAD),
> 不是组件发布——组件发布在各仓 Releases / Open VSX 进行。

## 概要

- **Tag**:`ecosystem-YYYY.MM[.N]`
- **日期**:YYYY-MM-DD
- **性质**:生态快照 / 文档与治理里程碑 / 修复性快照(择一)

## 生态变更摘要

> 3–5 行人话:这轮生态发生了什么(新能力、路线图进度、治理基建)。

- …

## 组件版本表

| 组件 | 形态 | 本 release 版本/HEAD | 关键变更 | 所属里程碑 |
|---|---|---|---|---|
| dsh-launcher | 直接工程 | `<版本或 8 位 HEAD>` | … | M? |
| dsh-plugins | 直接工程 | `<…>` | … | PM? |
| dsh-vscode | 直接工程 | `<…>` | … | — |
| dsh-desktop | 直接工程 | `<…>` | … | — |
| dsh-remote | 直接工程 | `<…>` | … | — |
| deepseek-harness | **子模块(锁定)** | `<8 位指针>` | 官方上游(只读跟随) | — |

> 上一 release 的 HEAD 记录见旧 tag 时的工作日志;当前值:`git -C <dir> log -1 --format='%h'`(直接工程)+
> `git submodule status`(harness)。

## 文档 / 治理更新

- docs/…(新增/修订内容一句话)
- .github/…(模板或流程变化)
- README / .AGENT.md / WORKLOG 同步情况

## 里程碑进度

- 已完成:M? / PM?
- 进行中:M? / PM?(关联 issue #N)
- 下一步:…

## 使用说明(对消费者)

- 拉取本快照:见 README「拉取整个工作区」——逐仓 clone + `git submodule update --init deepseek-harness`
- 已有检出:`git fetch && git checkout <tag>`,直接工程目录内逐仓 `git pull`
