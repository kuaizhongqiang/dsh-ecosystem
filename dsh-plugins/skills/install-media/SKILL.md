---
name: install-media
description: 把 dsh-media 感知合并包(transcribe_audio/understand_audio 语音、speak_text 语音合成、describe_image 图片、read_video 视频、read_document 文档,共 6 工具)安装到 dsh web,支持 -Only 子集安装与卸载。当用户要求安装/卸载/排查 audio-read、audio-speak、describe-image、video-read、document-read 或合并后的 media 插件,或要配置 MIMO_API_KEY / vision 端点时使用。
whenToUse: 用户想给 dsh 加语音转写/音频理解/朗读/图片理解/视频理解/文档读取能力,或要求安装上述任一旧单包名(自动落到本合并包)时使用;配置 MIMO_API_KEY 时使用。
---

# 安装 dsh-media 插件(感知合并包)

PM2 合并(路线图 §8 11→7):五个单工具包并入一个包,同一把凭证(MIMO_API_KEY +
vision 端点),`-Only` 支持子集安装。主对话模型保持 text-only。

## 0. 定位插件包

仓库 `plugins/dsh-media-dsh-plugin/`(本地克隆或 GitHub)。

## 1. 前置

1. Node.js 满足 dsh 要求;`npm install -g @deepseek-ai/dsh`;
2. web profile 已启动过一次(`dsh web`);
3. 凭证:`MIMO_API_KEY`(credentials seam 推荐写入 `%DSH_HOME%\.credentials.yaml`)。

## 2. 安装(幂等,可重跑)

```powershell
# 全部 5 个服务(6 工具)
powershell -ExecutionPolicy Bypass -File "<dsh-plugins>/plugins/dsh-media-dsh-plugin/install.ps1"
# 子集:例如只要语音转写与视频理解
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Only audio-read,video-read
# 卸载(支持 -Only)
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall [-Only <svc>]
```

describe-image 会额外运行 apiproxy 补丁(可重跑,失败仅告警);document-read 会探测
python 解析依赖(缺则提示 `python -m pip install python-docx openpyxl PyMuPDF`)。

## 3. 凭证

按包内 `.env.example`:推荐把 `MIMO_API_KEY: <key>` 合并进 `%DSH_HOME%\.credentials.yaml`。
**红线:key 不入库、不进日志。**

## 4. 重启并验证

重启 web(优先 `launcher_restart`;否则手动停掉再 `dsh web`),然后逐工具试一次:
给一段本地 mp3 → `transcribe_audio`;给一张图 → `describe_image`。

## 5. 从旧单包迁移

旧 5 包已 DEPRECATED:先装本包,再跑仓库根 `uninstall-old.ps1` 清理旧载荷与 patch 节。
