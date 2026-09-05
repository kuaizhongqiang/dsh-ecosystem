# dsh-remote — L6 广域网(远程部署)

| 项 | 值 |
|---|---|
| 上游仓 | [kuaizhongqiang/dsh-remote](https://github.com/kuaizhongqiang/dsh-remote) |
| 形态 | **直接工程**(伞仓根 `dsh-remote/`,独立 git,改动在仓内提交推送) |
| 生态位 | L6 广域网连接(Cloudflare Access 部署) |
| HEAD 快照 | `4f755d2`(docs:远程部署记录与运维脚本;权威值 `git -C dsh-remote log -1`) |

## 角色

dsh 的**远程部署记录仓**:记录把 dsh 暴露到广域网的方式(Cloudflare Access 等),供
launcher / desktop / vscode 作为 **remote 连接组**接入。

## 自带文档 / 入口

- 仓内 README 与部署记录(域名、Access 策略、认证头配置)。

## 与伞仓的关系

- 伞仓根的 `dsh-remote/` 就是本仓检出,更新 = 目录内 `git pull` / 提交推送,**无伞仓 bump 仪式**。
- remote 连接在路线图中统一收进 `%DSH_HOME%\connections.json` 的连接组(Phase 5 / 决策 D5):
  kind=remote 的连接**不 spawn**,launcher 只做健康检查并带 token 打开浏览器;token 可留空,
  认证交给 Cloudflare Access(`extraHeaders` 对齐 vscode 配置)。

## 发布注意点

- 部署文档性质,随实际部署变更提交推送;remote 组 token 生命周期见 PLAN Phase 5(失效 401 提示更新)。
