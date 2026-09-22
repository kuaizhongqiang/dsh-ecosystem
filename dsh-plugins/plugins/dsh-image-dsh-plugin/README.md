# dsh-image —— 图片生成插件(Doubao Seedream 5.0 / 火山方舟)

> 给 dsh 增加**出图**能力:一个 `generate_image` 工具覆盖文生图 / 图生图 / 多图融合 / 组图,
> 结果**一律落盘**成文件(不是给个 24h 失效的链接)。
>
> 独立成包的理由(PLUGIN-SPEC §2 准入三问):**独立凭证** —— 方舟 `ARK_API_KEY`,
> 与 dsh-media 的 `MIMO_API_KEY` 不同源;按 D7「按凭证聚合」不与感知包混装。

## 工具(1)

| 工具 | 说明 |
|---|---|
| `generate_image` | 调火山方舟 `POST /api/v3/images/generations`(`doubao-seedream-5-0-260128`),三种模式由 `image` 字段自动决定,**接口没有单独的开关** |

| 模式 | 入参 |
|---|---|
| `text2image` | 只给 `prompt` |
| `image2image` | `prompt` + **1** 张参考图 |
| `multi_image_fusion` | `prompt` + **2~14** 张参考图 |

参考图支持三类来源:**本地文件路径**(插件读文件转 data URI 上传,接口不支持文件上传)、
**公网 http(s) URL**、**`data:image/...;base64,...`**。

### 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `prompt` | — | 必填,中英文均可(建议 ≤300 汉字 / 600 英文词) |
| `image` | — | 参考图数组;不给=文生图,1 张=图生图,2~14 张=多图融合 |
| `mode` | `auto` | 显式声明 `text2image`/`image2image`/`multi_image_fusion`;与 `image` 不一致时**当场报错**,不浪费一次调用 |
| `size` | 平台默认 | 档位 `1K`/`2K`/`3K`/`4K`、像素 `2048x2048`,或预设 `square`/`landscape`/`portrait`/`wide`/`tall` |
| `count` | `1` | `>1` 走组图(`sequential_image_generation: auto` + `max_images`),**实际张数由模型决定,可能少于** |
| `watermark` | `false` | 是否加平台「AI生成」水印 |
| `seed` | — | 复现同一张图 |
| `output_format` | `jpeg` | `jpeg`(\*.jpg)/`png` |
| `web_search` | `false` | 5.0 支持 `tools:[{type:'web_search'}]`,用于「画一张今天的天气图」这类时效提示词 |
| `optimize_prompt` | `false` | 让模型先改写提示词(`optimize_prompt_options`) |
| `output_path` / `output_dir` | `~/Downloads` | 落盘位置;组图自动加 `-1`/`-2` 后缀,不互相覆盖 |
| `extra` | — | JSON 对象直通方舟请求体(平台新增参数无需等插件升级);与显式参数冲突时以显式参数为准 |

### 返回

`paths[]`(落盘绝对路径,交给用户/后续工具)、`urls[]`、`sizes[]`、
`mode` / `model` / `outputFormat` / `grouped` / `references` / `seed` / `usage`,
以及 `failures[]`(单张失败时才有:平台支持部分成功)。输出遵守 PLUGIN-SPEC §7(**无损 JSON**)。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Only image-gen      # 子集(本包只有一个服务)
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall           # 卸载
```

安装逻辑:载荷复制到 `%DSH_HOME%\profiles\web\plugins\image-gen\` + 在 `cordis.patch.yml`
追加幂等 patch 条目(`tool-image-gen`),写完立刻用 `scripts/validate-patch.mjs` 校验整份 patch。

## 凭证

见 `.env.example`:**`ARK_API_KEY`**(火山方舟控制台 → API Key)。推荐走 credentials 服务写入
`%DSH_HOME%\.credentials.yaml`,或设同名环境变量。缺失时工具返回可执行报错,不会静默失败。

**不改代码换端点/换 key 名**:在 `cordis.patch.yml` 的 `tool-image-gen` 条目加 config ——

```yaml
- insert:
    - id: tool-image-gen
      name: './plugins/image-gen/index.js'
      config:
        # 走 OpenAI 兼容中转网关时:
        baseURL: https://<网关>/v1
        imageField: images          # 方舟原生是 image,网关多为 images
        apiKeyEnv: TOKENHUB_API_KEY # 复用已有那把 key,不用新申请
        model: doubao-seedream-5-0-260128
        timeoutMs: 180000
```

**红线:凭证值绝不入库/入日志**(D2)。

## 重启并验证

优先 `launcher_restart`,否则手动停掉再 `dsh web`。然后逐条试:

1. 文生图:「画一张蒸汽朋克机械鸟,黄铜齿轮外露」→ 落盘 1 张;
2. 图生图:「把 `D:\pic\a.jpg` 改成铅笔素描」→ 走本地路径 → data URI;
3. 组图:「生成 3 张连续场景:小女孩在游乐园坐过山车」→ `count: 3`;
4. 时效:「画一张今天上海的天气图」+ `web_search: true`。

## 排查

| 现象 | 处置 |
|---|---|
| 工具不出现 | 查 `cordis.patch.yml` 是否有 `tool-image-gen`;是否重启过 web |
| `no credential for ARK_API_KEY` | `credentials_set ARK_API_KEY`,或设环境变量后重启 |
| 401/403 | Key 无效,或该 Key 未开通 Seedream 图片模型 |
| 429 | 限流/余额;稍后重试或去方舟控制台看用量 |
| 内容审核拒绝 | 提示词或参考图被拒,改写提示词 |
| 落盘失败 | 目标目录不可写;换 `output_dir` |
| 网关报未知字段 | 该网关非方舟原生,配 `imageField: images` 并用 `extra` 传专有参数 |

## 不作为 / 已知边界

- 不做视频(Seedance)与 3D —— 有需要另开包,复用同一把方舟凭证;
- 不做「描述图片」:**主模型原生多模态直读**,不需要外挂 vision(原 describe-image 已下线);
- `optimize_prompt` / `seed` / `extra` 等字段以平台实际接受为准,平台报错会原样透出。
