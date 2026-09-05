/**
 * Model-facing `read_document` tool for the native dsh web profile.
 *
 * Reads one Word (.docx/.docm), Excel (.xlsx) or PDF (.pdf) document and
 * returns:
 *   - the extracted text (paragraphs / sheet cells / per-page text)
 *   - a list of embedded images, each described through a configurable
 *     OpenAI-compatible vision endpoint (Xiaomi MiMo by default)
 *
 * The main conversation model stays text-only: it calls this tool and
 * consumes the returned text + image descriptions.
 *
 * Parsing is delegated to the bundled `parse_document.py` script, which uses
 * python-docx / openpyxl / PyMuPDF on the target machine. The document may be
 * a local disk path or an http(s) URL (downloaded to a temp file first).
 *
 * This plugin is self-contained for the npm dsh install: it depends only on
 * packages the installed CLI already provides (dsh-tools, dsh-credentials,
 * schemastery) plus the bundled Python script.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'tool-document-read'
export const inject = ['tools']

const execFileAsync = promisify(execFile)

/** Default vision endpoint: Xiaomi MiMo, OpenAI chat-completions standard. */
export const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
/** Default vision model. */
export const DEFAULT_MODEL = 'mimo-v2.5'
/** Default credential reference resolved through the credentials seam. */
export const DEFAULT_API_KEY_ENV = 'MIMO_API_KEY'
/** Default per-request endpoint timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 60_000
/** Default vision response token budget per image. */
export const DEFAULT_MAX_TOKENS = 2048
/** Default cap on the number of embedded images described via vision. */
export const DEFAULT_MAX_IMAGES = 10
/** Default cap on characters of extracted text returned to the model. */
export const DEFAULT_MAX_TEXT_CHARS = 30_000
/** Default cap on downloaded document size in bytes. */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
/** Default Python executable used to run parse_document.py. */
export const DEFAULT_PYTHON = process.platform === 'win32' ? 'python' : 'python3'
/** Default per-image byte cap for the vision endpoint. */
export const DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** Default accepted raster media types for the vision endpoint. */
export const DEFAULT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']

/** Configuration for the document backend. */
export const Config = z.object({
  baseURL: z.string(),
  model: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  timeoutMs: z.natural(),
  maxTokens: z.natural(),
  maxImages: z.natural(),
  maxTextChars: z.natural(),
  maxBytes: z.natural(),
  imageMaxBytes: z.natural(),
  allowedMediaTypes: z.array(z.string()),
  pythonPath: z.string(),
})

/** Path to the bundled Python parser next to this module. */
function parserScriptPath() {
  return fileURLToPath(new URL('./parse_document.py', import.meta.url))
}

/** Supported document extensions (lowercased, with dot). */
const SUPPORTED_EXTENSIONS = new Set(['.docx', '.docm', '.xlsx', '.pdf'])

/** Whether the argument names a local file path (vs a URL). */
function looksLikePath(value) {
  return !/^https?:\/\//i.test(value)
}

/** Download a URL to a temp file and return its path. */
async function downloadToTemp(url, maxBytes, signal) {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`read_document: download answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`)
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > maxBytes) {
    throw new Error(`read_document: ${url} is ${contentLength} bytes, over the ${maxBytes}-byte limit`)
  }
  const data = Buffer.from(await response.arrayBuffer())
  if (data.byteLength > maxBytes) {
    throw new Error(`read_document: ${url} downloaded ${data.byteLength} bytes, over the ${maxBytes}-byte limit`)
  }
  // derive a safe local file name: url path segment, else a generic name
  let name = ''
  try {
    name = decodeURIComponent(basename(new URL(url).pathname))
  } catch {
    name = ''
  }
  if (!name || !SUPPORTED_EXTENSIONS.has(extname(name).toLowerCase())) {
    name = `document_${Date.now()}${extname(name).toLowerCase() || ''}`
  }
  const dir = await mkdtemp(join(tmpdir(), 'dsh_doc_'))
  const filePath = join(dir, name)
  await writeFile(filePath, data)
  return { filePath, dir }
}

/**
 * Run parse_document.py and parse its JSON report.
 * @returns {{format: string, meta: object, text: string, images: Array<{path:string, mediaType:string, name:string}>}}
 */
async function runParser(pythonPath, inputPath, outDir, maxImages, timeoutMs, signal) {
  const args = [parserScriptPath(), inputPath, '--out', outDir]
  if (maxImages >= 0) args.push('--max-images', String(maxImages))
  const { stdout } = await execFileAsync(pythonPath, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
    signal,
  })
  let report
  try {
    report = JSON.parse(stdout)
  } catch {
    throw new Error(`read_document: python parser produced invalid JSON; stderr not captured (first 300 chars of stdout: ${stdout.slice(0, 300)})`)
  }
  if (report.error !== undefined) {
    throw new Error(`read_document: parser error: ${report.error}`)
  }
  return report
}

/**
 * Describe one image through the configured OpenAI-compatible endpoint.
 * @returns the model's description text.
 */
async function describeImage(data, mediaType, prompt, options) {
  const dataUri = `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`
  const response = await fetch(`${options.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      }],
      max_tokens: options.maxTokens,
    }),
    signal: options.signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`read_document: vision endpoint answered ${response.status}${body.length === 0 ? '' : `: ${body.slice(0, 400)}`}`)
  }
  const parsed = await response.json()
  const description = parsed.choices?.[0]?.message?.content
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error('read_document: vision endpoint returned no description')
  }
  return description
}

/** Build the vision prompt for one embedded image. */
function imagePrompt(index, total, name, userPrompt) {
  const base = userPrompt || 'Describe the content of this image in detail.'
  return total > 1
    ? `${base} (Embedded image ${index + 1}/${total} of the document${name ? `, file ${JSON.stringify(name)}` : ''}.)`
    : `${base}${name ? ` (Embedded image file ${JSON.stringify(name)}.)` : ''}`
}

/**
 * Register the `read_document` tool. Credentials resolve through the optional
 * credentials seam, falling back to the process environment.
 */
export function apply(ctx, config) {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  const model = config.model ?? DEFAULT_MODEL
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  const maxImages = config.maxImages ?? DEFAULT_MAX_IMAGES
  const maxTextChars = config.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES
  const imageMaxBytes = config.imageMaxBytes ?? DEFAULT_IMAGE_MAX_BYTES
  const pythonPath = config.pythonPath ?? DEFAULT_PYTHON
  const configuredMediaTypes = config.allowedMediaTypes
  const allowedMediaTypes = new Set(
    configuredMediaTypes === undefined || configuredMediaTypes.length === 0 ? DEFAULT_MEDIA_TYPES : configuredMediaTypes,
  )

  const resolveApiKey = async () => {
    const ref = credentialRef(apiKeyEnv)
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      : process.env[apiKeyEnv]
    if (hit === undefined || hit.length === 0) {
      throw new Error(`read_document: no credential for ${apiKeyEnv}; set it through the credentials service or export it in the environment`)
    }
    return hit
  }

  ctx.tools.register(defineTool({
    name: 'read_document',
    description: 'Read and understand a Word (.docx), Excel (.xlsx) or PDF (.pdf) document. Pass either path (a local '
      + 'file on disk) or url (an http(s) link). Returns the extracted text plus descriptions of embedded images '
      + '(each image is read by a vision model). Use it when the user asks about a document file, wants its content, '
      + 'wants text or images extracted, or needs a summary of a docx/xlsx/pdf.',
    parameters: {
      path: { type: 'string', description: 'Absolute path of a local document file (.docx/.docm/.xlsx/.pdf). Exactly one of path and url is required.' },
      url: { type: 'string', description: 'http(s) URL of a document (.docx/.docm/.xlsx/.pdf). Exactly one of path and url is required.' },
      prompt: { type: 'string', description: 'What to look for in embedded images; defaults to describing each image.' },
      maxImages: { type: 'integer', description: `Max embedded images to describe via vision (default ${maxImages}); 0 disables image description.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          format: { type: 'string', required: true, description: 'Document format: docx | xlsx | pdf.' },
          meta: { type: 'object', additionalProperties: true, required: true, description: 'Per-format metadata (page/sheet counts, file name).' },
          text: { type: 'string', required: true, description: 'Extracted document text (possibly truncated).' },
          truncated: { type: 'boolean', required: true, description: 'Whether the text was truncated to the char cap.' },
          images: {
            type: 'array',
            required: true,
            description: 'Embedded images with their vision descriptions.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true, description: 'Original media file name inside the document.' },
                path: { type: 'string', required: true, description: 'Local path where the image was extracted to.' },
                description: { type: 'string', required: true, description: "Vision model's description of the image." },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          `文档格式: ${value.format}`,
          `元数据: ${JSON.stringify(value.meta)}`,
          '',
          '===== 提取文本 =====',
          value.text,
        ]
        if (value.truncated) lines.push('\n[文本已截断]')
        lines.push('', `===== 内嵌图片 (${value.images.length}) =====`)
        for (const image of value.images) {
          lines.push(`- ${image.name}: ${image.description}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      if ((args.path === undefined) === (args.url === undefined)) {
        throw new Error('read_document: exactly one of path and url is required')
      }
      const target = args.path ?? args.url
      if (looksLikePath(target)) {
        if (args.url !== undefined) {
          throw new Error('read_document: a URL must start with http:// or https://')
        }
      } else if (args.path !== undefined) {
        throw new Error('read_document: a path must be a local file, not a URL')
      }

      // --- resolve the local file (download URLs to a temp file) ----------
      let tempDir = undefined
      let inputPath = target
      try {
        if (!looksLikePath(target)) {
          const downloaded = await downloadToTemp(target, maxBytes, exec.signal)
          inputPath = downloaded.filePath
          tempDir = downloaded.dir
        }

        const extension = extname(inputPath).toLowerCase()
        if (!SUPPORTED_EXTENSIONS.has(extension)) {
          throw new Error(`read_document: unsupported document type ${JSON.stringify(extension)} (supported: .docx .docm .xlsx .pdf)`)
        }

        const apiKey = await resolveApiKey()
        const workDir = await mkdtemp(join(tmpdir(), 'dsh_doc_img_'))

        // --- parse text + extract images ----------------------------------
        const parseTimeout = Math.max(timeoutMs, 120_000)
        const report = await runParser(pythonPath, inputPath, workDir, maxImages, parseTimeout, exec.signal)

        // --- truncate text --------------------------------------------------
        let text = report.text ?? ''
        let truncated = false
        if (text.length > maxTextChars) {
          text = text.slice(0, maxTextChars)
          truncated = true
        }

        // --- describe each extracted image via vision -----------------------
        const images = []
        for (const image of report.images ?? []) {
          if (maxImages >= 0 && images.length >= maxImages) break
          try {
            const data = new Uint8Array(await readFile(image.path))
            if (data.byteLength > imageMaxBytes) {
              images.push({
                name: image.name ?? basename(image.path),
                path: image.path,
                description: `[跳过: 图片 ${data.byteLength} 字节超过 ${imageMaxBytes} 字节上限]`,
              })
              continue
            }
            if (!allowedMediaTypes.has(image.mediaType)) {
              images.push({
                name: image.name ?? basename(image.path),
                path: image.path,
                description: `[跳过: 不支持的图片类型 ${JSON.stringify(image.mediaType)}]`,
              })
              continue
            }
            const timeoutController = new AbortController()
            const timeout = setTimeout(() => {
              timeoutController.abort(new Error(`read_document: vision endpoint timed out after ${timeoutMs}ms`))
            }, timeoutMs)
            try {
              const description = await describeImage(data, image.mediaType, imagePrompt(images.length, report.images.length, image.name, args.prompt), {
                baseURL,
                model,
                apiKey,
                maxTokens,
                signal: AbortSignal.any([exec.signal, timeoutController.signal]),
              })
              images.push({
                name: image.name ?? basename(image.path),
                path: image.path,
                description,
              })
            } finally {
              clearTimeout(timeout)
              timeoutController.abort()
            }
          } catch (error) {
            images.push({
              name: image.name ?? basename(image.path),
              path: image.path,
              description: `[图片理解失败: ${error.message}]`,
            })
          }
        }

        return {
          format: report.format,
          meta: report.meta ?? {},
          text,
          truncated,
          images,
        }
      } finally {
        // clean up temp download dir, keep extracted images for the user
        if (tempDir !== undefined) {
          await rm(tempDir, { recursive: true, force: true }).catch(() => {})
        }
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Read document', kind: 'read', rawInput: args }),
  }))
}
