# deepseek_balance tool for native dsh

把 `deepseek_balance` 余额查询工具装进任何一台装有 dsh（npm 版）的电脑。
主对话模型调用该工具，通过 **DeepSeek 官方公开接口**
（`GET https://api.deepseek.com/user/balance`）查询账户余额，key 走
credentials seam（`DEEPSEEK_API_KEY`），输出中**永不暴露 key**。

## 包里有什么

```
deepseek-balance-dsh-plugin/
├── install.ps1                    一键安装脚本（幂等，可重复执行）
├── .env.example                   DEEPSEEK_API_KEY 配置模板（不含真实 key）
├── README.md                      本说明
└── plugins/
    └── deepseek-balance/
        ├── index.js               deepseek_balance 工具插件（自包含，仅依赖
        │                          npm 版已有的 dsh-tools / dsh-credentials /
        │                          schemastery）
        └── package.json           ESM 声明（消除 MODULE_TYPELESS 警告）
```

## 前置要求（目标电脑）

- Node.js（dsh 要求 `^22.19 || >=24`）
- dsh npm 版已安装：`npm install -g @deepseek-ai/dsh`
- 至少启动过一次 `dsh web`，让 `profiles/web` 目录初始化
- DeepSeek 平台账号与 API key

## 安装（目标电脑上）

```powershell
cd deepseek-balance-dsh-plugin
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：
1. 把 `plugins/deepseek-balance` 复制到 `%DSH_HOME%\profiles\web\plugins\deepseek-balance`
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

对话里说“DeepSeek 还剩多少余额？”→ 模型调用 `deepseek_balance`，返回：

- 可用状态（`is_available`）
- 币种、**总余额**、**充值余额**、**赠送余额**
- 查询时间

## 自定义端点（可选）

`index.js` 顶部有默认值，也可在 profile 的 `cordis.patch.yml` 条目里覆盖：

```yaml
- insert:
    - id: tool-deepseek-balance
      name: './plugins/deepseek-balance/index.js'
      config:
        baseURL: https://api.deepseek.com
        apiKeyEnv: DEEPSEEK_API_KEY
        timeoutMs: 15000
```

## 重启并验证

1. 重启 web 实例：停掉旧进程后运行 `dsh web`（或 `npx @deepseek-ai/dsh web`）
2. 在对话里问“DeepSeek 余额多少？”，模型应调用 `deepseek_balance` 并返回余额

## 已知边界

- 官方余额接口返回的是**余额快照**，不含消费明细/用量统计（那些是平台私有
  dashboard 接口，需登录 token）；如需消费统计可另行扩展
- 余额不足时 `is_available` 为 false；充值请用配套的
  [deepseek-recharge](../deepseek-recharge-dsh-plugin/README.md) 插件跳转
  平台充值页
- 参考官方文档：[Get User Balance](https://api-docs.deepseek.com/api/get-user-balance/)

## 卸载

1. 编辑 `%DSH_HOME%\profiles\web\cordis.patch.yml`，删除
   `tool-deepseek-balance` 条目
2. 删除 `%DSH_HOME%\profiles\web\plugins\deepseek-balance\`
3. （可选）移除 credentials / 环境变量中的 `DEEPSEEK_API_KEY`
4. 重启 `dsh web`
