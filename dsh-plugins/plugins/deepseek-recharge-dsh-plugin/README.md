# deepseek_recharge tool for native dsh

把 `deepseek_recharge` 充值辅助工具装进任何一台装有 dsh（npm 版）的电脑。

**背景**：DeepSeek **没有公开充值 API**——充值只能在平台网页端完成（实名认证
后支付宝/微信支付）。所以本工具做的是「**把充值路径缩到最短**」：先查当前
余额作为上下文，再打开平台充值页，付完回来再查余额验证。

## 包里有什么

```
deepseek-recharge-dsh-plugin/
├── install.ps1                    一键安装脚本（幂等，可重复执行）
├── .env.example                   DEEPSEEK_API_KEY 配置模板（不含真实 key）
├── README.md                      本说明
└── plugins/
    └── deepseek-recharge/
        ├── index.js               deepseek_recharge 工具插件（自包含，仅依赖
        │                          npm 版已有的 dsh-tools / dsh-credentials /
        │                          schemastery）
        └── package.json           ESM 声明（消除 MODULE_TYPELESS 警告）
```

## 前置要求（目标电脑）

- Node.js（dsh 要求 `^22.19 || >=24`）
- dsh npm 版已安装：`npm install -g @deepseek-ai/dsh`
- 至少启动过一次 `dsh web`，让 `profiles/web` 目录初始化
- DeepSeek 平台账号（已实名认证才能充值）与 API key

## 安装（目标电脑上）

```powershell
cd deepseek-recharge-dsh-plugin
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：
1. 把 `plugins/deepseek-recharge` 复制到 `%DSH_HOME%\profiles\web\plugins\deepseek-recharge`
2. 幂等地在 `cordis.patch.yml` 追加 `- insert:` 挂载条目（已存在则跳过）

## 配置 DEEPSEEK_API_KEY

任选其一（工具按 credentials seam → 环境变量顺序解析），`.env.example` 里有完整指引：

- credentials 服务：在 `%DSH_HOME%\.credentials.yaml` 加入
  ```yaml
  DEEPSEEK_API_KEY: <你的 key>
  ```
- 或设置环境变量 `DEEPSEEK_API_KEY`

> 本包不包含你的 key。迁移到新电脑时请单独配置，不要把 key 写进
> 会拷贝/分享的文件里。

## 用法

对话里说“DeepSeek 余额不多了，帮我打开充值页”→ 模型调用
`deepseek_recharge`，工具会：

1. 查当前余额（作为上下文，显示给你）
2. 用**系统默认浏览器打开充值页**（默认 `https://platform.deepseek.com/usage`）
3. 返回充值页 URL + 当前余额 + 是否已打开浏览器

支付完成后，再说“再查一下余额”确认到账（用配套的
[deepseek-balance](../deepseek-balance-dsh-plugin/README.md) 插件）。

## 可选配置

`cordis.patch.yml` 条目里可覆盖：

```yaml
- insert:
    - id: tool-deepseek-recharge
      name: './plugins/deepseek-recharge/index.js'
      config:
        rechargeUrl: https://platform.deepseek.com/usage   # 充值页
        autoOpen: true       # false = 只返回 URL 不自动开浏览器
        apiKeyEnv: DEEPSEEK_API_KEY
        timeoutMs: 15000
```

## 重启并验证

1. 重启 web 实例：停掉旧进程后运行 `dsh web`（或 `npx @deepseek-ai/dsh web`）
2. 在对话里让模型打开充值页，确认默认浏览器弹出平台页面
3. 充值完成后用 `deepseek_balance` 验证余额变化

## 已知边界

- 无法程序化充值（官方无 API）；本工具只负责「余额上下文 + 跳转」
- 自动打开浏览器依赖系统默认浏览器；`autoOpen: false` 时仅返回 URL
- 平台页面若改版，`rechargeUrl` 可在配置里调整

## 卸载

1. 编辑 `%DSH_HOME%\profiles\web\cordis.patch.yml`，删除
   `tool-deepseek-recharge` 条目
2. 删除 `%DSH_HOME%\profiles\web\plugins\deepseek-recharge\`
3. （可选）移除 credentials / 环境变量中的 `DEEPSEEK_API_KEY`
4. 重启 `dsh web`
