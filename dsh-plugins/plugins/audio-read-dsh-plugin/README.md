# audio reading tools for native dsh

把 `transcribe_audio` / `understand_audio` 两个音频读取工具装进任何一台
装有 dsh（npm 版）的电脑。主对话模型保持 text-only，由小米 MiMo 模型
返回文字：

- `transcribe_audio`：语音转文字，专用 ASR 模型 `mimo-v2.5-asr`（仅 mp3/wav，中英）
- `understand_audio`：听音频回答问题，全模态模型 `mimo-v2.5`（mp3/wav/flac/m4a/ogg）

## 包里有什么

```
audio-read-dsh-plugin/
├── install.ps1                    一键安装脚本（幂等，可重复执行）
├── .env.example                   MIMO_API_KEY 配置模板（不含真实 key）
├── README.md                      本说明
└── plugins/
    └── audio-read/
        ├── index.js               音频工具插件（自包含，仅依赖 npm 版已有的
        │                          dsh-tools / dsh-credentials / schemastery）
        └── package.json           ESM 声明（消除 MODULE_TYPELESS 警告）
```

## 前置要求（目标电脑）

- Node.js（dsh 要求 `^22.19 || >=24`）
- dsh npm 版已安装：`npm install -g @deepseek-ai/dsh`
  （或每次用 `npx @deepseek-ai/dsh`）
- 至少启动过一次 `dsh web`，让 `profiles/web` 目录初始化

## 安装（目标电脑上）

```powershell
cd audio-read-dsh-plugin
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：
1. 把 `plugins/audio-read` 复制到 `%DSH_HOME%\profiles\web\plugins\audio-read`
2. 幂等地在 `cordis.patch.yml` 追加 `- insert:` 挂载条目（已存在则跳过）

## 配置 MIMO_API_KEY

任选其一（工具按 credentials seam → 环境变量顺序解析），`.env.example` 里有完整指引：

- credentials 服务：在 `%DSH_HOME%\.credentials.yaml` 加入
  ```yaml
  MIMO_API_KEY: <你的 key>
  ```
- 或设置环境变量 `MIMO_API_KEY`

> 本包不包含你的 key。迁移到新电脑时请单独配置，不要把 key 写进
> 会拷贝/分享的文件里。

## 用法

### transcribe_audio（语音转写）

| 参数 | 必填 | 说明 |
|------|------|------|
| `path` | 二选一 | 本地音频绝对路径（仅 mp3/wav，≤ 37.5 MB） |
| `url` | 二选一 | 公网 http(s) 音频地址（ASR 端点只收 base64，工具会抓取后本地编码，≤ 37.5 MB） |
| `language` | 否 | `auto`（默认）/ `zh` / `en` |

返回 `transcript`（识别文本）与可选 `durationSeconds`（音频时长）。

### understand_audio（音频理解）

| 参数 | 必填 | 说明 |
|------|------|------|
| `path` | 二选一 | 本地音频绝对路径（mp3/wav/flac/m4a/ogg，≤ 37.5 MB） |
| `url` | 二选一 | 公网 http(s) 音频地址（≤ 100 MB，平台限制） |
| `prompt` | 否 | 想从音频里了解什么；默认详细描述音频内容 |
| `max_tokens` | 否 | 回复 token 预算，默认 2048 |

对话里给模型一个本地路径或音频链接，例如：
“把 `D:\recordings\meeting.wav` 转成文字” → `transcribe_audio`；
“这段音乐是什么情绪？” → `understand_audio`。

## 自定义端点（可选）

`index.js` 顶部有默认值，也可在 profile 的 `cordis.patch.yml` 条目里覆盖：

```yaml
- insert:
    - id: tool-audio-read
      name: './plugins/audio-read/index.js'
      config:
        baseURL: https://你的端点/v1
        asrModel: mimo-v2.5-asr
        understandModel: mimo-v2.5
        apiKeyEnv: YOUR_KEY_ENV
        maxTokens: 2048
        timeoutMs: 120000
```

## 重启并验证

1. 重启 web 实例：停掉旧进程后运行 `dsh web`（或 `npx @deepseek-ai/dsh web`）
2. 在对话里给一个音频路径或链接，模型会调用对应工具并返回文字

## 已知边界

- `transcribe_audio` 平台限制仅 mp3/wav；`understand_audio` 支持 mp3/wav/flac/m4a/ogg
- base64 输入上限 50 MB 编码串（≈37.5 MB 文件）；`transcribe_audio` 的 URL 会抓取
  后本地编码，同样受 37.5 MB 限制；`understand_audio` 的 URL 直传（平台 ≤ 100 MB）
- 参考官方文档：
  [Speech Recognition](https://mimo.mi.com/docs/en-US/api/audio/Speech-Recognition) ·
  [Audio Understanding](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/audio-understanding)
