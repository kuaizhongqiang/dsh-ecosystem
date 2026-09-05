# dsh-desktop — L4 周边(Electron 桌面壳)

| 项 | 值 |
|---|---|
| 上游仓 | [kuaizhongqiang/dsh-desktop](https://github.com/kuaizhongqiang/dsh-desktop) |
| 形态 | **直接工程**(伞仓根 `dsh-desktop/`,独立 git,改动在仓内提交推送) |
| 生态位 | L4 周边(独立桌面客户端) |
| HEAD 快照 | `250abfb`(fix(tray):close-to-tray 保活;权威值 `git -C dsh-desktop log -1`) |

## 角色

Electron 桌面壳客户端:连**共享的 dsh server**(本机或远端),提供独立于浏览器的 dsh 使用面。

## 自带文档 / 入口

- 仓内 README(连接方式、构建/打包说明)。

## 与伞仓的关系 / 跟随语义(Phase 5)

- 伞仓根的 `dsh-desktop/` 就是本仓检出,更新 = 目录内 `git pull` / 提交推送,**无伞仓 bump 仪式**。
- 按 `launch-token.json` 的 `url` 连接,**完全跟随**激活连接(launcher 解析激活连接后照写
  v1 `launch-token.json`,规范不变);见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) Phase 5。

## 发布注意点

- 发布走自身仓 Releases;版本推进后刷新伞仓模块页 HEAD 快照。
- 路线图 Phase 5「零改动跟随」对 desktop 是**完全跟随**(vscode 仅 token 跟随),相关改动时保持此语义。
