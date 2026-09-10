# agent-memory-codegraph-dsh-plugin

dsh-ecosystem **milestone #3** 的本地增强层：把 MemoryKnowledge 的 code-graph 查询面暴露为 MCP 工具
（`mcp__agent-memory-codegraph__code_*`）。源码在 [`plugins/agent-memory-codegraph/`](plugins/agent-memory-codegraph/)，
含零依赖 MCP server（`index.mjs`）、mock 单元 + 真实集成测试（`mcp-tests.mjs`）与部署 README。

## 安装到 web profile

- **Linux/macOS**：把 `plugins/agent-memory-codegraph` 复制到 `~/.dsh/profiles/web/plugins/`，
  再按该包 README 的样例在 `cordis.patch.yml` 增加 `mcp-agent-memory-codegraph` 实例。
- **Windows**：运行 [`install.ps1`](install.ps1)。
- 样例配置：[`cordis-patch.example.yml`](plugins/agent-memory-codegraph/cordis-patch.example.yml)。

## 测试

```bash
cd plugins/agent-memory-codegraph
node mcp-tests.mjs                  # mock 单测 23 项
TEAM_ID=<你的 team> REAL=1 node mcp-tests.mjs   # 打真实本机 :8421
```
