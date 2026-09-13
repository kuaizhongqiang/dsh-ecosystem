# Stock 插件（tool-stock）

A 股「行情 → 舆情 → 建议 → 模拟盘」闭环插件（v0.2.0，**22 个工具**）。数据仅来自腾讯
公开行情接口（无需 API key），技术指标（MA/MACD/RSI/KDJ/ATR）插件内零依赖计算；舆情
只采信白名单权威来源；交易建议以**挂单**形式登记，次日按实际最高/最低价区间验单成交
（建议即挂单）。

## 工具

### 行情数据（9）

| 工具 | 作用 |
|---|---|
| `stock_quote` | 实时行情（价格/涨跌/换手/PE/PB/市值/五档） |
| `stock_kline` | 日 K（前复权，本地缓存） |
| `stock_indicators` | MA / 量均线 / MACD / RSI / KDJ / ATR |
| `stock_market_overview` | 上证/深成/创业板/沪深300 快照 |
| `watchlist_add` / `watchlist_remove` / `watchlist_list` | 自选股管理 |
| `stock_daily_collect` | 收集当日自选股+指数快照（每日幂等） |
| `stock_report` | 生成个股 Markdown 报告骨架 |

### 舆情（4）

| 工具 | 作用 |
|---|---|
| `sentiment_sources` | 权威信息源白名单（官方部委/交易所/公告 + 主流财经媒体） |
| `sentiment_pick` | 从自选股客观数据挑当日最需调查的股票（≤5 只/日） |
| `sentiment_record` | 记录舆情结论（消息摘要/来源/受众定位/矛盾检验/反身性/倾向） |
| `sentiment_list` | 回顾历史舆情结论，避免重复调查 |

### 建议与持仓（4）

| 工具 | 作用 |
|---|---|
| `advice_calc` | 按技术位算触发价/目标价/止损价/建议股数（多因子信号分 + ATR 定档） |
| `position_record` | 登记挂单（**股数为准**，A 股一手 100 股；自动标注 `phase` / `dataDate`） |
| `position_list` | 列出挂单（pending / executed / cancelled / all） |
| `position_update` | 更新执行状态（已执行 / 已取消） |

### 模拟盘（5）

| 工具 | 作用 |
|---|---|
| `paper_init` | 初始化模拟盘账户（默认本金 10 万元，幂等） |
| `paper_account` | 账户快照（现金/持仓/市值/浮盈亏/流水摘要） |
| `paper_trade` | 手工成交一笔（不依赖建议记录，用于调仓/止损） |
| `paper_execute_advice` | 把一条 pending 建议按建议价执行到模拟盘（"建议即操作"） |
| `paper_settle` | **T+1 验单**：挂单价落在建议日之后第一个交易日 `[最低, 最高]` 区间即按挂单价成交记账，否则作废并记偏离原因 |

## 运行模型（日周期）

- 每条建议/挂单标注产生时段 `phase`（pre_market / intraday / after_hours）与
  数据基准日 `dataDate`：盘中/盘前记录只用 T-1 及以前已收盘数据，盘后与非交易日
  （周末/节假日）取最近已收盘交易日——**避免马后炮**。
- 挂单统一按「建议日期之后第一个交易日」的**实际最高/最低价区间**验单，与记录时刻的
  `phase` 无关；成交按挂单价记账，未触价自动作废。
- 数量口径：一律用**具体股数**（100 股整数倍），不用仓位百分比。

## 建议价与信号分（advice_calc）

- 触发价/目标价/止损价由 ATR 波动率 + 均线 + 近期支撑压力 + 风险偏好（默认 6.5）自动定档；
  建议股数 = 模拟盘总资产 × 仓位档位 ÷ 触发价，取整到 100 股。
- `auto` 动作基于多因子信号分（趋势/动量/量能，约 -7..+7）：信号分 ≥2 判买入、≤-2 判卖出；
  深度超卖但趋势/量能走弱时不再机械给买入，而是给出卖出/回避方向。返回 `signalScore`
  （信号分）、`confidence`（强/中/弱）与 `factors`（因子说明）供整合进最终建议，模型可酌情微调。

## 用户数据

`%DSH_HOME%\stock\`：`watchlist.json`、`kline-cache.json`、`daily/YYYY-MM-DD.json`、
`reports/*.md`、`sentiment.json`、`positions.json`、`paper.json`。

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

## 热重载（改代码免重启）

web bundle 禁用了模块级 HMR，但 loader 会在插件 `name` 变化时重新 import
（绕过 Node ESM 缓存）。因此**修改插件 JS 后无需重启**，只需：

1. 同步文件到运行时副本：
   `cp dsh-plugins/plugins/stock-dsh-plugin/plugins/stock/index.js %DSH_HOME%\profiles\web\plugins\stock\index.js`
2. 在 `%DSH_HOME%\profiles\web\cordis.patch.yml` 中把 `tool-stock` 的
   `name` 版本号 +1（如 `./plugins/stock/index.js?v=2` → `?v=3`），保存即可触发重载。
3. 注意：**不要把 name 改回无版本号的原始路径**，否则会命中旧的 ESM 缓存回退到旧代码。

> 依赖新增/变更（如新增第三方包）时，热重载不适用，仍需重启 `dsh web`。

## 卸载

1. 编辑 `%DSH_HOME%\profiles\web\cordis.patch.yml`，删除 `tool-stock` 条目
2. 删除 `%DSH_HOME%\profiles\web\plugins\stock\`
3. 重启 `dsh web`（不删除 `%DSH_HOME%\stock\` 用户数据）

## 版本

见 [plugins/stock/package.json](plugins/stock/package.json)（当前 `0.2.0`）；升级 = 重跑
`install.ps1`。安装/使用/排查细节见伞仓 `dsh-plugins/skills/install-stock/SKILL.md`。
