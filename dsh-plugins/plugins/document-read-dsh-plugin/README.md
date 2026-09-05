# read_document tool for native dsh

综合理解 **Word / Excel / PDF** 文档的工具：把 `read_document` 装进任意一台
（npm 版）dsh 的电脑。主对话模型保持 text-only，模型调用 `read_document`
读取文档：**提取文字** + **提取内嵌图片并逐张用 vision 模型描述**
（默认 Xiaomi MiMo `mimo-v2.5`，OpenAI 兼容端点，可配置）。

## 包里有什么

```
document-read-dsh-plugin/
├── install.ps1                    一键安装脚本（幂等，可重复执行）
├── README.md                      本说明
├── .env.example                   MIMO_API_KEY 配置模板
└── plugins/
    └── document-read/
        ├── index.js               read_document 工具插件（自包含，仅依赖
        │                          npm 版已有的 dsh-tools / dsh-credentials /
        │                          schemastery）
        ├── parse_document.py      Python 解析脚本（docx/xlsx/pdf → JSON：
        │                          文字 + 图片提取）
        └── package.json           ESM 声明（消除 MODULE_TYPELESS 警告）
```

## 前置要求（目标电脑）

- Node.js（dsh 要求 `^22.19 || >=24`）
- dsh npm 版已安装：`npm install -g @deepseek-ai/dsh`
- 至少启动过一次 `dsh web`，让 `profiles/web` 目录初始化
- **Python 3.9+** 与三个解析库（解析由 Python 完成）：

  ```powershell
  python -m pip install python-docx openpyxl PyMuPDF
  ```

- **MIMO_API_KEY**（vision 端点用；用于描述内嵌图片，仅提取文字时不需要）
  配置方式见 `.env.example`（credentials 服务或环境变量）

## 安装（目标电脑上）

```powershell
cd document-read-dsh-plugin
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：
1. 把 `plugins/document-read` 复制到 `%DSH_HOME%\profiles\web\plugins\document-read`
2. 幂等地在 `cordis.patch.yml` 追加 `- insert:` 挂载条目（已存在则跳过）
3. 探测 Python 解析库是否齐备（缺失时提示安装命令）

## 工具

| 工具 | 作用 |
|------|------|
| `read_document(path?/url?, prompt?, maxImages?)` | 读 docx/docm/xlsx/pdf：返回提取文字（含表格/工作表/分页标记）+ 内嵌图片清单（每张附 vision 描述与本地提取路径） |

参数：
- `path`：本地绝对路径；`url`：http(s) 链接（下载到临时文件再解析），二选一必填
- `prompt`：可选，自定义图片理解要求（默认逐张详细描述）
- `maxImages`：可选，最多描述的图片数（默认 10，0 = 只提取不描述）

返回结构：`{ format, meta, text, truncated, images: [{name, path, description}] }`

## 数据与存储

- 解析由随包分发的 `parse_document.py` 完成（python-docx / openpyxl / PyMuPDF）
- URL 下载到系统临时目录，解析后自动清理
- 提取出的图片写入 `%TEMP%\dsh_doc_img_*\`，工具返回每张图的本地路径，
  模型可再用 `describe_image` 复查；如需长期保存请告知模型复制路径

## 可选配置

`cordis.patch.yml` 条目里可覆盖：

```yaml
- insert:
    - id: tool-document-read
      name: './plugins/document-read/index.js'
      config:
        baseURL: https://你的端点/v1
        model: 你的模型
        apiKeyEnv: YOUR_KEY_ENV
        maxImages: 10        # 默认描述图片数上限
        maxTextChars: 30000  # 返回文本长度上限（超出截断）
        maxBytes: 52428800   # URL 下载大小上限（字节）
        pythonPath: python   # Python 可执行文件（Windows 默认 python，其它 python3）
```

`mimo-v2.5` 是 reasoning 模型，`maxTokens` 建议 ≥ 1024（本包默认 2048/图）。

## 重启并验证

1. 重启 web 实例：停掉旧进程后运行 `dsh web`（或 `npx @deepseek-ai/dsh web`）
2. 对话里试：
   - “读一下 `C:\temp\拖拉机维修手册.docx`” → `read_document`
   - “把 https://example.com/table.xlsx 的内容总结给我” → `read_document(url)`
   - “这个 PDF 里有什么图？`D:\docs\拆解图.pdf`” → `read_document` + 图片描述

## 已知边界

- 解析依赖 Python 及三个库；缺失时工具返回清晰的错误信息（含安装命令）
- `.doc` / `.xls`（老二进制格式）不支持，仅 `.docx/.docm/.xlsx/.pdf`
- PDF 图片提取基于 PyMuPDF 渲染；扫描版 PDF 无文本层时 `text` 为空，
  但内嵌位图仍会提取并描述
- xlsx 只读 `data_only=True` 的单元格值（公式取缓存结果，不重算）
- 免费/限速的 vision 端点可能超时；单图失败会在 `description` 里标注
  `[图片理解失败: ...]`，不影响其余图片与文字

## 卸载

1. 编辑 `%DSH_HOME%\profiles\web\cordis.patch.yml`，删除 `tool-document-read` 条目
2. 删除 `%DSH_HOME%\profiles\web\plugins\document-read\`
3. （可选）移除 credentials / 环境变量中的 `MIMO_API_KEY`
4. 重启 `dsh web`

（卸载不删除 Python 库；不装库时 `read_document` 调用会报错，属预期。）
