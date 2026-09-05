---
name: install-stock
description: 把 A 股行情分析与自选股插件安装到 dsh web（9 个工具：stock_quote / stock_kline / stock_indicators / stock_market_overview / watchlist_add|remove|list / stock_daily_collect / stock_report，数据源腾讯公开接口，无密钥，指标零依赖计算，数据存 %DSH_HOME%\stock）。当用户要求安装、卸载或排查 stock 插件，或想让 dsh 具备查行情、技术分析、自选股管理、每日行情收集、个股报告能力时使用。
whenToUse: 用户想给 dsh 加股票行情查询/技术分析/自选股/每日收集/分析报告能力、要求安装或卸载 stock 插件、或查询股票相关功能不可用需要排查时。
---

# 安装 stock 插件

把 A 股行情分析与自选股管理插件装进目标电脑的 dsh web。数据**仅来自腾讯
公开行情接口**（无需 API key），技术指标（MA/MACD/RSI/KDJ/ATR）在插件内
零依赖计算，主模型负责解读与报告撰写。

## 0. 定位插件包

插件包在本仓库 `plugins/stock-dsh-plugin/`，二选一获取：

- 本地已有仓库克隆：直接用 `<仓库根>/plugins/stock-dsh-plugin`
- 没有克隆：`git clone https://github.com/kuaizhongqiang/dsh-plugins`，
  或让用户下载 Release 压缩包并解压

以下步骤均在插件包目录内执行。

## 1. 检查前置（目标电脑）

1. Node.js 满足 dsh 要求：`node -v` 应输出 `^22.19 || >=24`
2. dsh 已安装：`npm install -g @deepseek-ai/dsh`（或确认 `npx @deepseek-ai/dsh` 可用）
3. `%DSH_HOME%\profiles\web` 已初始化（`$env:DSH_HOME` 缺省 `~/.dsh`）。
   至少启动过一次 `dsh web`；没有就先用 `dsh web` 启动一次再继续

## 2. 执行安装脚本

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会（幂等，可重复执行）：
1. 复制 `plugins/stock` 到 `%DSH_HOME%\profiles\web\plugins\stock`
2. 幂等地在 `cordis.patch.yml` 追加 `- insert:` 的 `tool-stock` 挂载条目
   （已存在则跳过；一个条目注册九个工具）

确认输出出现 `OK  plugin copied`、`OK  profile patch entry added`（或
`SKIP ... already present`）。若报 `no dsh profiles found` 或 `web profile
not found`，回到步骤 1 检查 dsh 是否装好、`dsh web` 是否初始化过。

> 本插件不需要任何 API key（腾讯公开接口）。

## 3. 可选配置

`cordis.patch.yml` 条目里可覆盖：

```yaml
- insert:
    - id: tool-stock
      name: './plugins/stock/index.js'
      config:
        klineDays: 150                  # 日K缓存深度（默认 150）
        dataRoot: C:/path/to/stock      # 数据目录（默认 %DSH_HOME%\stock）
        timeoutMs: 15000                # 请求超时（毫秒）
```

## 4. 重启并验证

1. 重启 web 实例：停掉旧进程后运行 `dsh web`（或 `npx @deepseek-ai/dsh web`）
2. 对话里试：
   - “茅台现在什么价？” → `stock_quote`
   - “把 600519、000001 加进自选股” → `watchlist_add` ×2
   - “收集今日行情” → `stock_daily_collect`（收盘后调用最有意义）
   - “出一份 600519 的分析报告” → `stock_report` + 模型补充分析
   - “今天大盘怎么样？” → `stock_market_overview`

## 5. 排查

- 报 `invalid code`：支持 `600519` / `sh600519` / `600519.SH`；推断规则
  `60/68/9x→沪`、`00/30/20→深`；指数需显式代码（`sh000001` 上证 vs
  `000001` 平安银行）
- 报 `empty quote response` / `kline endpoint ...`：腾讯公开接口偶发不稳，
  稍后重试；连续失败检查网络
- 指标返回 null：K 线不足（如 MA60 需 60 根以上），新股数据少属正常
- `stock_daily_collect` 报 `watchlist is empty`：先用 `watchlist_add` 加自选股
- 提示“今日快照已存在”：当日幂等设计，重采加 `force: true`

## 6. 卸载

1. 编辑 `%DSH_HOME%\profiles\web\cordis.patch.yml`，删除 `tool-stock` 条目
2. 删除 `%DSH_HOME%\profiles\web\plugins\stock\`
3. 重启 `dsh web`

（卸载不会删除 `%DSH_HOME%\stock\` 下的自选股/快照/报告数据。）
