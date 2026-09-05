# dsh-deepseek —— DeepSeek 账户运维合并插件(余额查询 · 充值辅助)

> PM2 合并(路线图 §8 11→7):由 deepseek-balance / deepseek-recharge 合并而来。
> 共享凭证 DEEPSEEK_API_KEY,「账户运维」层。

## 工具(2)

| 服务目录 | 工具 | 说明 |
|---|---|---|
| `plugins/deepseek-balance` | `deepseek_balance` | 查询 DeepSeek API 账户余额(官方 /user/balance;key 走 credentials seam,输出不暴露 key) |
| `plugins/deepseek-recharge` | `deepseek_recharge` | 充值辅助(查余额 + 打开平台充值页;DeepSeek 无公开充值 API) |

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Only deepseek-balance
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

## 凭证

见 `.env.example`(DEEPSEEK_API_KEY;推荐 credentials 服务)。

## 从旧包迁移

旧 2 个单工具包已标记 **deprecated**:运行仓库根 `uninstall-old.ps1` 清理后安装本包。
