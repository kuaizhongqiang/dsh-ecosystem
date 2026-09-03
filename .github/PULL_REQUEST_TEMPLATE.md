<!-- 伞仓只收 docs/ 与根级元数据(README / .AGENT.md / .gitmodules / LICENSE)及 .github/ 治理文件;
     实现代码改动请提交到对应子模块仓。 -->

## 目的 / 关联

- 关联 issue:#N(如为里程碑任务,注明 M? / PM? 映射,见 README)

## 改动类型

- [ ] 文档(docs/)
- [ ] 治理模板 / 配置(.github/)
- [ ] 子模块指针 bump
- [ ] 其他:____

## 指针 bump(仅当改动类型含指针时)

- 组件:`<old-sha-8>` → `<new-sha-8>`
- 验证方式:____(该组件仓内实测 / release 说明)

## 验证

- [ ] 工作树除预期的 6 个子模块 `deleted:` 脏状态外无其他改动
- [ ] 提交用显式 pathspec,未用 `add -A` / all(防误提交子模块删除)
- [ ] docs/WORKLOG.md 已按日期段追加本次工作
- [ ] README / .AGENT.md / docs 索引与本次改动一致

## Checklist

- [ ] 凭证 / 运行时文件(credentials、launch-token、connections、sessions)未入仓
- [ ] 语言风格与现仓一致(中文为主,术语保留英文)
