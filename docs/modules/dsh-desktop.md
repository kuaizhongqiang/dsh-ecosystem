# dsh-desktop — L4 周边(Electron 桌面壳)

| 项 | 值 |
|---|---|
| 上游仓 | [kuaizhongqiang/dsh-desktop](https://github.com/kuaizhongqiang/dsh-desktop) |
| 生态位 | L4 周边(独立桌面客户端) |
| 伞仓锁指针 | `250abfbd`(`250abfbd1184d81cc49ed2cd58ed3f8aef94ffac`) |
| 本地开发 | 子仓克隆(本地开发根 `F:\Project\dsh-dev\*`,见 WORKLOG 2026-09-02) |

## 角色

Electron 桌面壳客户端:连**共享的 dsh server**(本机或远端),提供独立于浏览器的 dsh 使用面。

## 自带文档 / 入口

- 仓内 README(连接方式、构建/打包说明)。

## 与伞仓的关系 / 跟随语义(Phase 5)

- 按 `launch-token.json` 的 `url` 连接,**完全跟随**激活连接(launcher 解析激活连接后照写
  v1 `launch-token.json`,规范不变);见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) Phase 5。

## bump / 发布注意点

- 发布走自身仓 Releases;伞仓 bump 指针锁版本。
- 路线图 Phase 5「零改动跟随」对 desktop 是**完全跟随**(vscode 仅 token 跟随),相关改动时保持此语义。
