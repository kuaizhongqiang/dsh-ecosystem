---
name: install-deepseek
description: 把 dsh-deepseek 账户运维合并包(deepseek_balance 余额查询 + deepseek_recharge 充值辅助)安装到 dsh web,支持 -Only 子集与卸载。当用户要求安装/卸载/排查 deepseek-balance、deepseek-recharge 或合并后的 deepseek 插件,或要查 DeepSeek API 余额/是否需要充值、配置 DEEPSEEK_API_KEY 时使用。
whenToUse: 用户想给 dsh 加 DeepSeek 账户运维能力(查余额/充值跳转),或要求安装上述任一旧单包名(自动落到本合并包),或配置 DEEPSEEK_API_KEY 时使用。
---

# 安装 dsh-deepseek 插件(账户运维合并包)

PM2 合并(路线图 §8 11→7):deepseek-balance + deepseek-recharge 两包合一,
共享 `DEEPSEEK_API_KEY`。

## 0. 定位插件包

仓库 `plugins/dsh-deepseek-dsh-plugin/`。

## 1. 前置

1. dsh 已装且 web profile 启动过;
2. 凭证:`DEEPSEEK_API_KEY`(credentials seam 或环境变量)。

## 2. 安装(幂等)

```powershell
powershell -ExecutionPolicy Bypass -File "<dsh-plugins>/plugins/dsh-deepseek-dsh-plugin/install.ps1"
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Only deepseek-balance
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

## 3. 凭证

按 `.env.example`:推荐把 `DEEPSEEK_API_KEY: <key>` 合并进 `%DSH_HOME%\.credentials.yaml`。
余额查询输出不暴露 key;**红线:key 不入库、不进日志。**

## 4. 重启并验证

重启 web(优先 `launcher_restart`),调用 `deepseek_balance` 应返回币种/总余额/
赠送余额/充值余额;`deepseek_recharge` 会打开平台充值页(无公开充值 API)。

## 5. 从旧单包迁移

旧 2 包已 DEPRECATED:先装本包,再跑仓库根 `uninstall-old.ps1`。
