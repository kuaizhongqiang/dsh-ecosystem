# Stock 插件（tool-stock）

A 股「行情 → 舆情 → 建议 → 模拟盘」闭环插件（v0.3.0，**24 个工具**）。数据仅来自腾讯
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

### 四块信号模型（2）

板块只分四块、不存在第五个主题：**电力设备**（含 运营/防御、设备/基建、锂电新能源 三个子层）与
**航天卫星** 为可交易块；**券商**、**石油** 只做信号、**不建头寸**。

| 工具 | 作用 |
|---|---|
| `sector_panel` | 四块面板：1/5/20 日收益、相对沪深300 超额（RS20）、成交额占比及其量能倍数、上涨家数、β、四象限（主升/抱团/出逃/冷落）；大盘状态机（牛/震荡/熊）；券商牛市启动信号（默认判假，需连续 2 日 + 大盘站上 MA20 才确认）；石油牛市收尾信号（仅牛市监听）；并给出每块/子层的挂单深度规则 |
| `order_calibration` | 挂单成交率标定：买单挂 `收盘−k×ATR`、卖单挂 `收盘+u×ATR` 的次日成交率与成交后 5 日表现，按趋势分层。先定目标成交率再反查 k 值（建仓 60~70% → k≈0.3；了结 85%+ → u≤0.2） |

> 动机：挂单规则是「T 日挂单 → T+1 只用最高/最低价判定一次 → 未触及即作废」，每个标的每天只有
> 一次机会，**价格是唯一可控变量**，所以挂单本质是给成交概率定价，而不是预测价格。
> 方法与实测见 `%DSH_HOME%\stock\playbook.md`。

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

## 更新代码后建议重启 dsh web

本部署**未启用 `cordis-plugin-hmr`**；实测 profile 条目/文件的改动**有时**会被运行中的实例拾取
（有延迟、不确定），所以**最稳的做法仍是重启**：

1. 同步文件到运行时副本：
   `cp dsh-plugins/plugins/stock-dsh-plugin/plugins/stock/index.js %DSH_HOME%\profiles\web\plugins\stock\index.js`
2. **重启** `dsh web`（`systemctl --user restart dsh` 或停掉旧进程重跑），新代码才会生效。

> ⚠️ 不要把 `cordis.patch.yml` 里的 `name` 写成 `./plugins/stock/index.js?v=N`。本项目 loader 会把
> 查询串当字面路径去 `import()`，实测报 `ERR_MODULE_NOT_FOUND` 并导致**整棵插件树加载失败**
> （2026-09-13 在 agent-memory 原生插件上实测复现）。需要绕过 Node ESM 缓存时，正确做法是重启进程，
> 或启用 `@deepseek-ai/cordis-plugin-hmr`（当前 profile 未挂载）。

## 卸载

1. 编辑 `%DSH_HOME%\profiles\web\cordis.patch.yml`，删除 `tool-stock` 条目
2. 删除 `%DSH_HOME%\profiles\web\plugins\stock\`
3. 重启 `dsh web`（不删除 `%DSH_HOME%\stock\` 用户数据）

## 版本

见 [plugins/stock/package.json](plugins/stock/package.json)（当前 `0.3.0`）；升级 = 重跑
`install.ps1`。安装/使用/排查细节见伞仓 `dsh-plugins/skills/install-stock/SKILL.md`。
