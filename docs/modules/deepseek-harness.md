# deepseek-harness — L2 核心(dsh 本体,官方上游,伞仓唯一子模块)

| 项 | 值 |
|---|---|
| 上游仓 | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)(**非自有仓**) |
| 形态 | **git 子模块(伞仓唯一)**——默认未检出,需要时 `git submodule update --init deepseek-harness` |
| 生态位 | L2 核心(dsh 本体) |
| 子模块指针 | `47f94385`(`47f943859bef60e4160492346772ded9b24f765a`;权威值 `git submodule status`) |
| 消费方式 | **只读消费**:bump 只跟随官方 main/tag,永不改写、不 fork 推进 |

## 角色

DeepSeek Harness(dsh)本体——生态里被 launcher 安装/拉起、被各端(web / desktop / vscode /
插件)连接的核心服务。伞仓锁其官方 commit,即锁 dsh 的构建基线。

## 自带文档 / 入口

- 官方仓 README / docs;构建方式(GitHub tag / npm 双源,见 [ECOSYSTEM-PLAN.md](../ECOSYSTEM-PLAN.md) Phase 1)。

## 与伞仓的关系

- 伞仓只做**指针跟随**(官方推进后人工验证再 bump),不向官方仓发 PR、不开 issue 当自家工单。
- 供应链校验(M1 起强制):私有清单强制 HTTPS、插件包 sha256、子模块锁 commit——本子模块同样
  只认锁定的官方 commit(PLAN §4 Phase 1)。

## bump / 发布注意点

- 跟随官方 tag 而非任意远端 HEAD;bump 前在本机验证新构建可用;提交
  `chore: bump deepseek-harness → <sha 前 8>`(不做 `update --remote` 自动推进)。
- 与 launcher 的兼容面:Node 版本要求(^22.19 ‖ >=24)、端口/连接语义(Phase 5)变化时
  需联动检查 dsh-launcher、dsh-vscode、dsh-desktop。
