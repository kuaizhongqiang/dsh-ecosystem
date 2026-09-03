# Release Notes 模板 — dsh-ecosystem 伞仓生态快照

> 用法:切新 tag 时复制本模板,按实际填充;与 docs/RELEASING.md 流程配合。
> 伞仓 release = **生态版本快照**(tag 锁定 6 子模块指针),不是组件发布。

## 概要

- **Tag**:`ecosystem-YYYY.MM[.N]`
- **日期**:YYYY-MM-DD
- **性质**:生态快照 / 文档与治理里程碑 / 修复性快照(择一)

## 生态变更摘要

> 3–5 行人话:这轮生态发生了什么(新能力、路线图进度、治理基建)。

- …

## 子模块指针表

| 组件 | 旧指针(上一 release) | 新指针(本 release) | 关键变更 | 所属里程碑 |
|---|---|---|---|---|
| dsh-launcher | `<old-8>` | `<new-8>` | … | M? |
| dsh-plugins | `<old-8>` | `<new-8>` | … | PM? |
| dsh-vscode | `<old-8>` | `<new-8>` | … | — |
| dsh-desktop | `<old-8>` | `<new-8>` | … | — |
| dsh-remote | `<old-8>` | `<new-8>` | … | — |
| deepseek-harness | `<old-8>` | `<new-8>` | 官方上游(只读跟随) | — |

> 上一 release 的指针从 git 历史或旧 tag 获取;当前指针见 `git submodule status` 与 docs/modules/。

## 文档 / 治理更新

- docs/…(新增/修订内容一句话)
- .github/…(模板或流程变化)
- README / .AGENT.md / WORKLOG 同步情况

## 里程碑进度

- 已完成:M? / PM?
- 进行中:M? / PM?(关联 issue #N)
- 下一步:…

## 使用说明(对消费者)

- 拉取本快照:`git clone --recurse-submodules -b <tag> https://github.com/kuaizhongqiang/dsh-ecosystem.git`
- 已有检出:`git fetch && git checkout <tag> && git submodule update --init --recursive`
