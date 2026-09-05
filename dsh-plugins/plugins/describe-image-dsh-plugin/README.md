# describe_image tool for native dsh

把 `describe_image` 图片理解工具装进任何一台装有 dsh（npm 版）的电脑。
主对话模型保持 text-only，模型调用 `describe_image` 读图，由可配置的
OpenAI 兼容 vision 端点（默认 Xiaomi MiMo `mimo-v2.5`）返回文字描述。

## 包里有什么

```
describe-image-dsh-plugin/
├── install.ps1                    一键安装脚本（幂等，可重复执行）
├── patch-apiproxy.mjs             apiproxy 补丁：text-only 主模型收到图片时
│                                  转为 hint 文本而非拒绝（幂等）
├── .env.example                   MIMO_API_KEY 配置模板（不含真实 key）
├── README.md                      本说明
└── plugins/
    └── describe-image/
        ├── index.js               describe_image 工具插件（自包含，仅依赖
        │                          npm 版已有的 dsh-tools / dsh-attachment /
        │                          dsh-credentials / dsh-session / cordis）
        └── package.json           ESM 声明（消除 MODULE_TYPELESS 警告）
```

## 前置要求（目标电脑）

- Node.js（dsh 要求 `^22.19 || >=24`）
- dsh npm 版已安装：`npm install -g @deepseek-ai/dsh`
  （或每次用 `npx @deepseek-ai/dsh`，与当前本机用法一致）
- 至少启动过一次 `dsh web`，让 `profiles/web` 目录初始化

## 安装（目标电脑上）

```powershell
# 进入解压后的目录
cd describe-image-dsh-plugin
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：
1. 把 `plugins/describe-image` 复制到 `%DSH_HOME%\profiles\web\plugins\describe-image`
2. 幂等地在 `cordis.patch.yml` 追加 `- insert:` 挂载条目（已存在则跳过）
3. 复制并运行 `patch-apiproxy.mjs`（幂等，可重跑）

## 配置 MIMO_API_KEY

任选其一（工具按 credentials seam → 环境变量顺序解析），`.env.example` 里有完整指引：

- credentials 服务：在 `%DSH_HOME%\.credentials.yaml` 加入
  ```yaml
  MIMO_API_KEY: <你的 key>
  ```
- 或设置环境变量 `MIMO_API_KEY`

> 本包不包含你的 key。迁移到新电脑时请单独配置，不要把 key 写进
> 会拷贝/分享的文件里。

## 自定义 vision 端点（可选）

`index.js` 顶部有默认值，也可在 profile 的 `cordis.patch.yml` 条目里覆盖：

```yaml
- insert:
    - id: tool-describe-image
      name: './plugins/describe-image/index.js'
      config:
        baseURL: https://你的端点/v1
        model: 你的模型
        apiKeyEnv: YOUR_KEY_ENV
        maxTokens: 4096
```

`mimo-v2.5` 是 reasoning 模型，`maxTokens` 建议 ≥ 2048，否则推理过程可能
耗尽预算导致 `content` 为空（本包默认 4096）。

## 重启并验证

1. 重启 web 实例：停掉旧进程后运行 `dsh web`（或 `npx @deepseek-ai/dsh web`）
2. 在对话里附一张图（或给本地路径），模型会调用 `describe_image` 并返回描述
3. 观察 hint 文本 `[图片附件 <id> ...]` 出现 = apiproxy 补丁生效

## 已知边界

- 补丁按 npm 版 `dsh-host-apiproxy` 的文本锚点定位；若 dsh 大版本升级后
  锚点失效，`patch-apiproxy.mjs` 会报 "admission block not found"，需按新
  版本的 `lib/index.js` 结构更新锚点。
- `attachmentId` 需要图片以会话附件形式存在（GUI 粘贴/上传）。磁盘路径
  `path` 参数不受此限制。
