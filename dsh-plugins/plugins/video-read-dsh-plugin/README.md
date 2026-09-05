# read_video tool for native dsh

把 `read_video` 视频理解工具装进任何一台装有 dsh（npm 版）的电脑。
主对话模型保持 text-only，模型调用 `read_video` 读视频，由小米 MiMo
全模态模型（`mimo-v2.5`）返回文字描述。

## 包里有什么

```
video-read-dsh-plugin/
├── install.ps1                    一键安装脚本（幂等，可重复执行）
├── .env.example                   MIMO_API_KEY 配置模板（不含真实 key）
├── README.md                      本说明
└── plugins/
    └── video-read/
        ├── index.js               read_video 工具插件（自包含，仅依赖
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
cd video-read-dsh-plugin
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：
1. 把 `plugins/video-read` 复制到 `%DSH_HOME%\profiles\web\plugins\video-read`
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
| `path` | 二选一 | 本地视频文件绝对路径（mp4/mov/avi/wmv，≤ 37.5 MB，base64 上限 50 MB） |
| `url` | 二选一 | 公网 http(s) 视频地址（≤ 300 MB，平台限制） |
| `prompt` | 否 | 想从视频里了解什么；默认详细描述视频内容 |
| `fps` | 否 | 每秒抽帧数，范围 [0.1, 10]，默认 2（越大越精细、越费 token） |
| `media_resolution` | 否 | `default`（平衡）或 `max`（小物体/细节更强），默认 `default` |
| `max_tokens` | 否 | 回复 token 预算，默认 4096 |

对话里给模型一个本地路径或视频链接，例如：
“分析一下 `D:\clips\demo.mp4` 里发生了什么”，模型会调用 `read_video`
并把描述返回给你。

> 视频输入同时含画面与音轨（平台按 `video_tokens` + `audio_tokens` 计费）。
> 本地路径输入受 50 MB base64 上限约束（≈37.5 MB 文件）；更大的视频请用
> 公网 URL。

## 自定义端点（可选）

`index.js` 顶部有默认值，也可在 profile 的 `cordis.patch.yml` 条目里覆盖：

```yaml
- insert:
    - id: tool-video-read
      name: './plugins/video-read/index.js'
      config:
        baseURL: https://你的端点/v1
        model: 你的模型
        apiKeyEnv: YOUR_KEY_ENV
        maxTokens: 4096
        timeoutMs: 180000
```

## 重启并验证

1. 重启 web 实例：停掉旧进程后运行 `dsh web`（或 `npx @deepseek-ai/dsh web`）
2. 在对话里给一个视频路径或链接，模型会调用 `read_video` 并返回描述

## 已知边界

- 平台仅支持 mp4/mov/avi/wmv 且不保证所有变体可识别（官方说明）
- 本地文件走 base64 输入，上限 50 MB 编码串（≈37.5 MB 文件）；超大视频用 URL
- 参考官方文档：
  [Video Understanding](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/video-understanding)
