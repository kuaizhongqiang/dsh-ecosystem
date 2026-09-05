# Stock 插件（tool-stock）

A 股行情分析与自选股管理插件：9 个工具覆盖实时行情、日 K、技术指标、大盘
概览、自选股管理、每日行情收集与个股报告。数据仅来自腾讯公开行情接口
（无需 API key），技术指标（MA/MACD/RSI/KDJ/ATR）插件内零依赖计算。

## 工具

| 工具 | 作用 |
|---|---|
| `stock_quote` | 实时行情（价格/涨跌/换手/PE/PB/市值/五档） |
| `stock_kline` | 日 K（前复权，本地缓存） |
| `stock_indicators` | MA / 量均线 / MACD / RSI / KDJ / ATR |
| `stock_market_overview` | 上证/深成/创业板/沪深300 快照 |
| `watchlist_add` / `watchlist_remove` / `watchlist_list` | 自选股管理 |
| `stock_daily_collect` | 收集当日自选股+指数快照（每日幂等） |
| `stock_report` | 生成个股 Markdown 报告骨架 |

用户数据在 `%DSH_HOME%\stock\`（watchlist.json / kline-cache.json /
daily/YYYY-MM-DD.json / reports/*.md）。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本幂等：复制插件（打印版本）→ `cordis.patch.yml` 追加 `tool-stock` 条目。
重启 `dsh web` 后即可在对话里使用。

## 配置（可选，cordis.patch.yml）

```yaml
- insert:
    - id: tool-stock
      name: './plugins/stock/index.js'
      config:
        klineDays: 150
        dataRoot: C:/path/to/stock
        timeoutMs: 15000
```

## 卸载

1. 编辑 `%DSH_HOME%\profiles\web\cordis.patch.yml`，删除 `tool-stock` 条目
2. 删除 `%DSH_HOME%\profiles\web\plugins\stock\`
3. 重启 `dsh web`（不删除 `%DSH_HOME%\stock\` 用户数据）

## 版本

见 [plugins/stock/package.json](plugins/stock/package.json)；升级 = 重跑
`install.ps1`。安装/使用/排查细节见仓库 `skills/install-stock/SKILL.md`。
