---
name: install-media
description: 把 dsh-media 感知合并包(transcribe_audio/understand_audio 语音、speak_text 语音合成、read_video 视频、read_document 文档,共 5 工具)安装到 dsh web,支持 -Only 子集安装与卸载。当用户要求安装/卸载/排查 audio-read、audio-speak、video-read、document-read 或合并后的 media 插件,或要配置 MIMO_API_KEY 时使用。
whenToUse: 用户想给 dsh 加语音转写/音频理解/朗读/视频理解/文档读取能力,或要求安装上述任一旧单包名(自动落到本合并包)时使用;配置 MIMO_API_KEY 时使用。图片读取不需要本包——主模型已原生支持图片输入。
---

# 安装 dsh-media 插件(感知合并包)

PM2 合并(路线图 §8 11→7):四个单工具包并入一个包,同一把凭证(MIMO_API_KEY),
`-Only` 支持子集安装。主对话模型保持 text-only。
**图片读取不在本包内**:DeepSeek 主模型已支持图片输入(多模态),会话直接读图即可;
原 `describe-image` 服务与 apiproxy 补丁已下线,不要再按旧文档安装。

## 0. 定位插件包

仓库 `plugins/dsh-media-dsh-plugin/`(本地克隆或 GitHub)。

## 1. 前置

1. Node.js 满足 dsh 要求;`npm install -g @deepseek-ai/dsh`;
2. web profile 已启动过一次(`dsh web`);
3. 凭证:`MIMO_API_KEY`(credentials seam 推荐写入 `%DSH_HOME%\.credentials.yaml`)。

## 2. 安装(幂等,可重跑)

```powershell
# 全部 4 个服务(5 工具)
powershell -ExecutionPolicy Bypass -File "<dsh-plugins>/plugins/dsh-media-dsh-plugin/install.ps1"
# 子集:例如只要语音转写与视频理解
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Only audio-read,video-read
# 卸载(支持 -Only)
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall [-Only <svc>]
```

document-read 会探测 python 解析依赖(缺则提示
`python -m pip install python-docx openpyxl PyMuPDF`);每次写 patch 后脚本会用
`scripts/validate-patch.mjs` 校验整份 `cordis.patch.yml`。

## 3. 凭证

按包内 `.env.example`:推荐把 `MIMO_API_KEY: <key>` 合并进 `%DSH_HOME%\.credentials.yaml`。
**红线:key 不入库、不进日志。**

## 4. 重启并验证

重启 web(优先 `launcher_restart`;否则手动停掉再 `dsh web`),然后逐工具试一次:
给一段本地 mp3 → `transcribe_audio`;给一个本地 mp4 → `read_video`。

## 5. 从旧单包迁移

旧单工具包已 DEPRECATED:先装本包,再跑仓库根 `uninstall-old.ps1` 清理旧载荷、patch 节**与旧技能**
(技能清理已**默认执行**,要保留旧技能加 `-KeepSkills`)。迁移后应重启 web。

**这一步必须做**:技能是「给 Agent 看的安装说明书」,本机若还留着 `install-describe-image` 之类旧技能,
会话里说一句「装 xxx」就可能把**已下线**的服务装回去(旧包已不在仓库,会装到来路不明的载荷,见 issue #31)。
图片读取本身不需要任何工具 —— 主模型原生多模态直读。

