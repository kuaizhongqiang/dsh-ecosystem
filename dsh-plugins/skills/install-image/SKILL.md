---
name: install-image
description: 把 dsh-image 图片生成插件(generate_image,豆包 Seedream 5.0 / 火山方舟)安装到 dsh web,支持卸载,并完成 ARK_API_KEY 凭证与重启验证。当用户要求安装/卸载/排查出图(generate_image、文生图、图生图、组图)或配置 ARK_API_KEY 时使用。
whenToUse: 用户想给 dsh 加出图能力(说"画一张…"、"生成图片"、"把这张图改成…"、"生成组图"),或要安装/排查 dsh-image 插件、配置火山方舟 ARK_API_KEY 时使用。单纯"看图/描述图片"不需要本插件——主模型原生多模态直读。
---

# 安装 dsh-image 插件(图片生成)

## 目的

装完用户能让 dsh **生成图片**:`generate_image` 一个工具覆盖
文生图 / 图生图(1 张参考图)/ 多图融合(2~14 张),支持组图(`count>1`)与
`web_search` 时效提示词;结果**一律落盘**成文件路径返回。

## 前置

1. dsh 已安装且 web profile 存在(`%DSH_HOME%\profiles\web`,没启动过先 `dsh web` 一次);
2. 凭证:`ARK_API_KEY`(火山方舟控制台 → API Key,需开通 Doubao Seedream 图片模型);
3. 出网可达 `ark.cn-beijing.volces.com`(走代理时在插件 config 覆盖 `baseURL`)。

## 步骤

1. 运行安装器:

   ```powershell
   powershell -ExecutionPolicy Bypass -File "<dsh-plugins>/plugins/dsh-image-dsh-plugin/install.ps1"
   ```

   - 卸载:`-Uninstall`;子集:`-Only image-gen`(本包只有一个服务);
   - 幂等:可重复执行(载荷覆盖复制,patch 条目判重跳过)。

2. 凭证:按 `.env.example` 把 `ARK_API_KEY` 写入 `%DSH_HOME%\.credentials.yaml`
   (推荐,credentials 服务,`credentials_set ARK_API_KEY`)或设环境变量。
   **红线:凭证值绝不入库/入日志。**
   走 OpenAI 兼容中转网关时不必新申请 key:在 `cordis.patch.yml` 的 `tool-image-gen` 条目里
   覆盖 `baseURL` + `imageField: images` + `apiKeyEnv: <已有 key 名>`。

3. **重启并验证**:
   - 优先走 launcher 重启 seam:`launcher_restart` 工具(dsh-launcher 插件),或
     `%DSH_HOME%\launcher-registration.json` 中 api 的 `POST /api/dsh/restart?key=<bridgeKey>`;
   - 无 launcher 时提示用户手动重启:`停掉 web → dsh web`;
   - 验证(逐条真机跑,不要只看工具是否出现):
     ① 文生图:「画一张蒸汽朋克机械鸟」→ 返回 `paths[]` 且文件存在;
     ② 图生图:给一个本地图片路径 +「改成铅笔素描」;
     ③ 组图:`count: 3` 的连续场景提示词。

## 故障排查

- 工具不出现:检查 `cordis.patch.yml` 是否含 `tool-image-gen` 条目;重启是否执行;
- `no credential for ARK_API_KEY`:走第 2 步写入,然后重启;
- 401/403:Key 无效或未开通 Seedream 图片模型;429:限流/余额;
- 内容审核拒绝:改写提示词或换参考图;
- 参考图不生效:本地路径需**存在**且扩展名在支持列表内(`.png/.jpg/.jpeg/.webp/.bmp/.gif`),
  否则改用公网 URL;
- 平台报未知字段:该端点非方舟原生,配 `imageField: images`,专有参数走 `extra`。
