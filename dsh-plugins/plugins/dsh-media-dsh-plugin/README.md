# dsh-media —— 感知类合并插件(音频转写/理解 · 语音合成 · 图片理解 · 视频理解 · 文档读取)

> PM2 合并(路线图 §8 11→7):由 audio-read / audio-speak / describe-image / video-read /
> document-read 五个单工具包合并而来。同一把凭证(MIMO_API_KEY + vision 端点)、
> 同一种「主模型保持 text-only + 外挂感知」模式,包内 `--only` 支持子集安装。

## 工具(6)

| 服务目录 | 工具 | 说明 |
|---|---|---|
| `plugins/audio-read` | `transcribe_audio` / `understand_audio` | 语音转写(mimo-v2.5-asr)/ 音频理解(mimo-v2.5),mp3/wav,本地路径或公网 URL |
| `plugins/audio-speak` | `speak_text` | 语音合成(mimo-v2.5-tts),wav/mp3,9 种内置音色 |
| `plugins/describe-image` | `describe_image` | 图片理解(可配置 OpenAI 兼容 vision 端点,默认小米 MiMo) |
| `plugins/video-read` | `read_video` | 视频理解(mimo-v2.5 全模态),mp4/mov/avi/wmv 或公网 URL |
| `plugins/document-read` | `read_document` | Word/Excel/PDF 读取(内置 parse_document.py,可选 Python 依赖) |

## 安装

```powershell
# 全部 5 个服务
powershell -ExecutionPolicy Bypass -File .\install.ps1
# 子集
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Only audio-read,video-read
# 卸载(支持 -Only)
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

安装逻辑:载荷复制到 `%DSH_HOME%\profiles\web\plugins\<svc>\` + 在 `cordis.patch.yml`
追加幂等 patch 条目(`tool-<svc>`)。describe-image 会额外运行 `patch-apiproxy.mjs`
(可重跑,失败仅告警)。

## 凭证

见 `.env.example`(MIMO_API_KEY;推荐走 credentials 服务写入 `%DSH_HOME%\.credentials.yaml`)。

## 从旧包迁移

旧 5 个单工具包已标记 **deprecated**(保留一个版本周期):运行仓库根
`uninstall-old.ps1` 清理旧载荷与 patch 条目,再安装本包。
