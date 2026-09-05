# speak_text tool for native dsh

把 `speak_text` 语音合成（TTS）工具装进任何一台装有 dsh（npm 版）的电脑。
主对话模型保持 text-only，模型调用 `speak_text`，由小米 MiMo TTS 模型
（`mimo-v2.5-tts`）合成语音并写入本地文件，返回文件路径。

## 包里有什么

```
audio-speak-dsh-plugin/
├── install.ps1                    一键安装脚本（幂等，可重复执行）
├── .env.example                   MIMO_API_KEY 配置模板（不含真实 key）
├── README.md                      本说明
└── plugins/
    └── audio-speak/
        ├── index.js               speak_text 工具插件（自包含，仅依赖
        │                          npm 版已有的 dsh-tools / dsh-credentials /
        │                          schemastery）
        └── package.json           ESM 声明（消除 MODULE_TYPELESS 警告）
```

## 前置要求（目标电脑）

- Node.js（dsh 要求 `^22.19 || >=24`）
- dsh npm 版已安装：`npm install -g @deepseek-ai/dsh`
  （或每次用 `npx @deepseek-ai/dsh`）
- 至少启动过一次 `dsh web`，让 `profiles/web` 目录初始化

## 安装（目标电脑上）

```powershell
cd audio-speak-dsh-plugin
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：
1. 把 `plugins/audio-speak` 复制到 `%DSH_HOME%\profiles\web\plugins\audio-speak`
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

工具参数（模型调用时自动填充）：

| 参数 | 必填 | 说明 |
|------|------|------|
| `text` | 是 | 要朗读的准确文本（≤ 2000 字符） |
| `voice` | 否 | 音色 ID，默认 `mimo_default`；内置音色见下表 |
| `format` | 否 | 输出格式：`wav`（默认）或 `mp3` |
| `style` | 否 | 语气/风格说明（如“轻快上扬、语速略快”），留空忽略 |
| `output_path` | 否 | 输出文件路径或目录；默认写入下载文件夹（自动生成文件名） |

### 内置音色

| voice | 语言 | 性别 |
|-------|------|------|
| `mimo_default` | 视集群 | 默认（中国区默认 冰糖） |
| `冰糖` | 中文 | 女 |
| `茉莉` | 中文 | 女 |
| `苏打` | 中文 | 男 |
| `白桦` | 中文 | 男 |
| `Mia` | 英文 | 女 |
| `Chloe` | 英文 | 女 |
| `Milo` | 英文 | 男 |
| `Dean` | 英文 | 男 |

对话里直接说“用冰糖音色把这句话读出来：……”，模型会调用 `speak_text`
并把生成的音频文件路径告诉你。

## 自定义端点（可选）

`index.js` 顶部有默认值，也可在 profile 的 `cordis.patch.yml` 条目里覆盖：

```yaml
- insert:
    - id: tool-audio-speak
      name: './plugins/audio-speak/index.js'
      config:
        baseURL: https://你的端点/v1
        model: mimo-v2.5-tts
        apiKeyEnv: YOUR_KEY_ENV
        timeoutMs: 60000
        defaultOutputDir: C:\path\to\output
```

> `defaultOutputDir` 为字符串，注意 YAML 里反斜杠需转义或使用正斜杠。

## 重启并验证

1. 重启 web 实例：停掉旧进程后运行 `dsh web`（或 `npx @deepseek-ai/dsh web`）
2. 在对话里让模型朗读一段文字，检查下载文件夹里出现 `mimo-speech-*.wav/mp3`

## 已知边界

- 平台 TTS 支持 wav/mp3/pcm/pcm16；本工具只落盘 wav/mp3（带文件头可直接播放），
  pcm16 裸流不适合直接保存为可播放文件，故未开放
- 语音克隆（`mimo-v2.5-tts-voiceclone`）与音色设计（`mimo-v2.5-tts-voicedesign`）
  模型未包含在本工具内；如需可基于同一 `audio` 参数扩展
- 参考官方文档：
  [Speech Synthesis](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)
