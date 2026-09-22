/**
 * Model-facing `generate_image` tool for the native dsh web profile.
 *
 * Generates images with Doubao Seedream 5.0 on Volcengine Ark
 * (`POST {baseURL}/images/generations`) and writes every result to disk, so the
 * text-only conversation model can hand the user real files (and feed them to
 * later tools) instead of a link that expires after 24h.
 *
 * One endpoint covers three modes — the `image` field alone decides which:
 *   text2image          no reference image
 *   image2image         exactly 1 reference image
 *   multi_image_fusion  2..14 reference images
 * Group generation (组图) is `sequential_image_generation: auto` plus
 * `sequential_image_generation_options.max_images`.
 *
 * Reference images may be local paths (read here and inlined as data URIs —
 * the API has no file upload), public http(s) URLs, or data URIs. Ark answers
 * with either a URL or base64 JSON and both shapes are accepted, so an
 * OpenAI-compatible gateway can be used by pointing `baseURL` / `apiKeyEnv` /
 * `imageField` at it.
 *
 * This plugin is self-contained for the npm dsh install: it depends only on
 * packages the installed CLI already provides (dsh-tools, dsh-credentials,
 * schemastery). Credentials resolve through the credentials seam, falling back
 * to the process environment (ARK_API_KEY by default).
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

/** package.json is the single source of truth for the version. */
const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))

export const name = 'tool-image-gen'
export const inject = ['tools']
export const version = PKG.version

/** Ark endpoint root; image generation lives at `{baseURL}/images/generations`. */
export const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
/** Seedream 5.0 (Lite): text2image + image2image + multi-image fusion + 组图. */
export const DEFAULT_MODEL = 'doubao-seedream-5-0-260128'
/** Flagship single-image model (best quality, no 组图) — set `model` to switch. */
export const PRO_MODEL = 'doubao-seedream-5-0-pro-260628'
/** Default credential reference resolved through the credentials seam. */
export const DEFAULT_API_KEY_ENV = 'ARK_API_KEY'
/** Per-request timeout: 2K/4K plus 组图 generation is slow. */
export const DEFAULT_TIMEOUT_MS = 180_000
/** Default output directory when the caller passes neither path nor directory. */
export const DEFAULT_OUTPUT_DIR = join(homedir(), 'Downloads')
/** Request-body key holding the reference images on Ark's native API. */
export const DEFAULT_IMAGE_FIELD = 'image'
/** Ark's cap on reference images per request. */
export const MAX_REFERENCE_IMAGES = 14
/** Ark's cap on 组图 images per request. */
export const MAX_GROUP_IMAGES = 15
/** Formats the Seedream 5.0 line can emit. */
export const OUTPUT_FORMATS = ['jpeg', 'png']
/** Resolution tiers Ark accepts verbatim. */
export const SIZE_TIERS = ['1K', '2K', '3K', '4K']
/** Aspect-ratio presets -> the pixel sizes the platform recommends. */
export const SIZE_PRESETS = {
  square: '2048x2048',
  landscape: '2304x1728',
  portrait: '1728x2304',
  wide: '2560x1440',
  tall: '1440x2560',
}
/** Extension -> media type, for inlining local reference images. */
export const MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
}

/** Configuration for the image backend the tool calls. */
export const Config = z.object({
  baseURL: z.string(),
  model: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  timeoutMs: z.natural(),
  defaultOutputDir: z.string(),
  /** 'image' (Ark native) or 'images' (OpenAI-compatible gateways). */
  imageField: z.string(),
})

/**
 * Tool output must be lossless JSON: dsh rejects a result carrying an
 * `undefined`-valued own property (PLUGIN-SPEC §7). This strips such keys
 * recursively and narrows array holes / non-finite numbers to `null`.
 */
function jsonSafe(value) {
  if (value === null) return null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => {
    const safe = jsonSafe(item)
    return safe === undefined ? null : safe
  })
  if (typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      const safe = jsonSafe(value[key])
      if (safe !== undefined) out[key] = safe
    }
    return out
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined
  return value
}

/** Collision-safe file-name stem for one request. */
function defaultBaseName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const random = Math.random().toString(36).slice(2, 6)
  return `seedream-${stamp}-${random}`
}

/**
 * The file extension for the requested format, or the caller's own extension
 * when it matches that format.
 * @param format - 'jpeg' or 'png'.
 * @param requested - extension parsed from output_path, if any.
 * @returns one of '.jpg' | '.jpeg' | '.png'.
 */
export function resolveExtension(format, requested) {
  const expected = format === 'png' ? ['.png'] : ['.jpg', '.jpeg']
  if (requested === undefined) return expected[0]
  const lower = requested.toLowerCase()
  if (expected.includes(lower)) return lower
  throw new Error(`generate_image: output_path extension ${requested} does not match output_format ${format} (expected ${expected.join(' or ')})`)
}

/**
 * Resolve the absolute path of every image this request may produce.
 * `output_path` names one file — with several images a `-N` suffix is inserted
 * before the extension, so 组图 never overwrites itself.
 * @returns one absolute path per expected image.
 */
export function resolveOutputPaths({ outputPath, outputDir, extension, total, defaultOutputDir }) {
  if (outputPath !== undefined && String(outputPath).trim() !== '') {
    const target = String(outputPath).trim()
    const own = extname(target)
    const resolved = resolveExtension(extension === '.png' ? 'png' : 'jpeg', own === '' ? undefined : own)
    const stem = own === '' ? target : target.slice(0, -own.length)
    return Array.from({ length: total }, (_unused, index) => `${stem}${total === 1 ? '' : `-${index + 1}`}${resolved}`)
  }
  const directory = outputDir !== undefined && String(outputDir).trim() !== ''
    ? String(outputDir).trim()
    : defaultOutputDir
  const base = defaultBaseName()
  return Array.from({ length: total }, (_unused, index) => join(directory, `${base}${total === 1 ? '' : `-${index + 1}`}${extension}`))
}

/**
 * Normalize the `size` argument: preset name, resolution tier, or `WxH`.
 * Bounds stay loose on purpose — the platform is the authority and reports a
 * precise error, while this only catches the obvious typos early.
 * @returns the value to send, or undefined to let the platform default apply.
 */
export function normalizeSize(size) {
  if (size === undefined || String(size).trim() === '') return undefined
  const raw = String(size).trim()
  const preset = SIZE_PRESETS[raw.toLowerCase()]
  if (preset !== undefined) return preset
  const tier = raw.toUpperCase()
  if (SIZE_TIERS.includes(tier)) return tier
  const match = /^(\d{2,5})\s*[xX*×]\s*(\d{2,5})$/.exec(raw)
  if (match === null) {
    throw new Error(`generate_image: size must be ${SIZE_TIERS.join('/')}, a preset (${Object.keys(SIZE_PRESETS).join('/')}) or WxH such as 2048x2048`)
  }
  const width = Number(match[1])
  const height = Number(match[2])
  if (width < 256 || height < 256 || width > 8192 || height > 8192) {
    throw new Error(`generate_image: size ${raw} is outside the plausible range (256..8192 per side; Ark expects about 1024x1024..4096x4096)`)
  }
  return `${width}x${height}`
}

/** Normalize `output_format` ('jpg' is accepted as an alias of 'jpeg'). */
export function normalizeOutputFormat(format) {
  if (format === undefined || String(format).trim() === '') return 'jpeg'
  const raw = String(format).trim().toLowerCase()
  const value = raw === 'jpg' ? 'jpeg' : raw
  if (!OUTPUT_FORMATS.includes(value)) {
    throw new Error(`generate_image: output_format must be one of ${OUTPUT_FORMATS.join('/')} (jpg is accepted as jpeg)`)
  }
  return value
}

/**
 * Resolve the effective mode. 'auto' infers it from the reference images, which
 * is exactly how the endpoint decides; an explicit mode is checked for
 * consistency so a mismatched call fails here instead of upstream.
 */
export function resolveMode(requested, referenceCount) {
  const inferred = referenceCount === 0 ? 'text2image' : referenceCount === 1 ? 'image2image' : 'multi_image_fusion'
  if (requested === undefined || String(requested).trim() === '' || requested === 'auto') return inferred
  const mode = String(requested).trim()
  if (mode !== 'text2image' && mode !== 'image2image' && mode !== 'multi_image_fusion') {
    throw new Error("generate_image: mode must be 'auto' | 'text2image' | 'image2image' | 'multi_image_fusion'")
  }
  if (mode !== inferred) {
    throw new Error(`generate_image: mode ${mode} does not match the ${referenceCount} reference image(s) given (that is ${inferred})`)
  }
  return mode
}

/**
 * Turn one reference image into something the API accepts. A public URL or an
 * existing data URI passes through; a local path is read and inlined.
 * @returns the URL or data URI to send.
 */
export async function materializeReference(source) {
  const value = String(source ?? '').trim()
  if (value === '') throw new Error('generate_image: reference image entries must be non-empty strings (local path, http(s) URL or data URI)')
  if (value.startsWith('data:')) return value
  if (/^https?:\/\//i.test(value)) return value
  const mediaType = MIME_BY_EXTENSION[extname(value).toLowerCase()]
  if (mediaType === undefined) {
    throw new Error(`generate_image: local reference image ${JSON.stringify(value)} has an unsupported extension (${Object.keys(MIME_BY_EXTENSION).join('/')}); pass a public http(s) URL instead`)
  }
  if (!existsSync(value)) throw new Error(`generate_image: local reference image not found: ${value}`)
  const bytes = await readFile(value)
  return `data:${mediaType};base64,${bytes.toString('base64')}`
}

/**
 * Build the Ark request body. Pure and exported so the regression gate can
 * assert the three modes' wire shape without a network call.
 * @param options - every resolved argument plus the backend facts.
 * @returns the JSON body to POST.
 */
export function buildRequestBody(options) {
  const {
    model, prompt, references, mode, size, count, watermark, seed,
    outputFormat, webSearch, optimizePrompt, extra, imageField,
  } = options

  if (extra !== undefined && (extra === null || typeof extra !== 'object' || Array.isArray(extra))) {
    throw new Error('generate_image: extra must be a JSON object; its keys are merged into the Ark request body')
  }
  if (mode === 'text2image' && references.length > 0) throw new Error('generate_image: text2image takes no reference image')
  if (mode === 'image2image' && references.length !== 1) throw new Error('generate_image: image2image takes exactly 1 reference image')
  if (mode === 'multi_image_fusion' && references.length < 2) throw new Error('generate_image: multi_image_fusion takes 2 or more reference images')

  const body = {
    ...(extra ?? {}),
    model,
    prompt,
    stream: false,
    response_format: 'url',
    watermark: watermark === true,
  }
  if (size !== undefined) body.size = size
  if (references.length > 0) {
    // Ark's native key takes a single string for one image and an array for
    // several; OpenAI-compatible gateways always take the array form.
    body[imageField] = imageField === DEFAULT_IMAGE_FIELD && references.length === 1 ? references[0] : references
  }
  if (count > 1) {
    body.sequential_image_generation = 'auto'
    body.sequential_image_generation_options = { max_images: count }
  } else {
    body.sequential_image_generation = 'disabled'
  }
  if (seed !== undefined) body.seed = seed
  if (outputFormat !== undefined) body.output_format = outputFormat
  if (webSearch === true) body.tools = [{ type: 'web_search' }]
  if (optimizePrompt === true) body.optimize_prompt_options = { mode: 'standard' }
  return body
}

/**
 * Turn a failed response into an actionable message: the two cases that need
 * the operator rather than a prompt tweak are credentials and moderation.
 */
export function describeFailure(status, payload) {
  const code = payload?.error?.code ?? payload?.code ?? ''
  const message = payload?.error?.message ?? payload?.message ?? ''
  const detail = [code, message].filter((part) => typeof part === 'string' && part !== '').join(': ')
  const hints = []
  if (status === 401 || status === 403) hints.push('check the API key (credentials seam or environment) and that it can access this image model')
  if (status === 429) hints.push('rate limited or out of quota — retry later, or check the Ark console')
  if (/sensitive|risk|moderat|审核|敏感/i.test(`${code} ${message}`)) hints.push('the prompt or a reference image was refused by content moderation — rephrase')
  return `${detail === '' ? '' : ` — ${detail}`}${hints.length === 0 ? '' : ` (${hints.join('; ')})`}`
}

/** Download one generated image; the platform URL expires after 24h. */
async function downloadImage(url, signal) {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`download answered HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Register `generate_image`. Credentials resolve through the optional
 * credentials seam, falling back to the process environment.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the image backend facts.
 */
export function apply(ctx, config) {
  const baseURL = config?.baseURL ?? DEFAULT_BASE_URL
  const model = config?.model ?? DEFAULT_MODEL
  const apiKeyEnv = config?.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const defaultOutputDir = config?.defaultOutputDir ?? DEFAULT_OUTPUT_DIR
  const imageField = config?.imageField ?? DEFAULT_IMAGE_FIELD

  console.info(`[tool-image-gen] v${version} registered (model=${model}, apiKeyEnv=${apiKeyEnv})`)

  async function resolveApiKey() {
    const ref = credentialRef(apiKeyEnv)
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      : process.env[apiKeyEnv]
    if (hit === undefined || hit.length === 0) {
      throw new Error(`generate_image: no credential for ${apiKeyEnv}; set it through the credentials service (\`credentials_set ${apiKeyEnv}\`) or export it in the environment`)
    }
    return hit
  }

  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: 'Generate images with Doubao Seedream 5.0 (Volcengine Ark) and write them to disk. '
      + 'Text-to-image: pass only a prompt. Image-to-image: add 1 reference image. Multi-image fusion: add 2-14 reference '
      + 'images. References may be local file paths, public http(s) URLs or data URIs. Set count above 1 for 组图 (a '
      + 'coherent set of images) and web_search for prompts needing current facts. Returns the paths of the written '
      + 'files; tell the user where they were saved.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What to draw, in Chinese or English (about 300 Chinese characters / 600 English words is the sweet spot).' },
      image: {
        type: 'array',
        items: { type: 'string' },
        description: 'Reference images: local file paths, public http(s) URLs or data URIs. Omit for text-to-image, '
          + 'pass 1 for image-to-image, 2-14 for multi-image fusion.',
      },
      mode: {
        type: 'string',
        description: "Optional: 'auto' (default, inferred from image) | 'text2image' | 'image2image' | 'multi_image_fusion'.",
      },
      size: {
        type: 'string',
        description: `Output size: preset (${Object.keys(SIZE_PRESETS).join('/')}), resolution tier (${SIZE_TIERS.join('/')}) or pixels like 2048x2048 (default 2048x2048; Ark accepts roughly 1024x1024..4096x4096).`,
      },
      count: {
        type: 'integer',
        description: `Number of images for 组图, 1-${MAX_GROUP_IMAGES} (default 1). Above 1 the model decides how many to actually return.`,
      },
      watermark: { type: 'boolean', description: "Add the platform's \"AI生成\" watermark (default false)." },
      seed: { type: 'integer', description: 'Optional seed: reuse it to reproduce the same image.' },
      output_format: { type: 'string', description: "Image file format: 'jpeg' (default) or 'png'." },
      web_search: { type: 'boolean', description: 'Let the model search the web first (5.0 only); useful for prompts about current facts, adds latency.' },
      optimize_prompt: { type: 'boolean', description: 'Let the model rewrite the prompt before drawing (default false).' },
      output_path: {
        type: 'string',
        description: 'File path for the image; with count above 1 a -1/-2 suffix is inserted. Defaults to output_dir with a generated name.',
      },
      output_dir: { type: 'string', description: 'Directory for generated names (default: the Downloads folder).' },
      extra: {
        type: 'json',
        description: 'Optional JSON object merged into the Ark request body, for platform parameters not modelled here. Explicit arguments win on conflict.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paths: { type: 'array', required: true, description: 'Absolute paths of the written image files, one per generated image.', items: { type: 'string' } },
          urls: { type: 'array', required: true, description: 'Platform URLs of the generated images (empty string when the platform answered with base64 instead).', items: { type: 'string' } },
          sizes: { type: 'array', required: true, description: 'Pixel size reported per image, e.g. 2048x2048 (empty string when unreported).', items: { type: 'string' } },
          mode: { type: 'string', required: true, description: 'text2image | image2image | multi_image_fusion.' },
          model: { type: 'string', required: true, description: 'Model id that produced the images.' },
          outputFormat: { type: 'string', required: true, description: 'jpeg | png.' },
          grouped: { type: 'boolean', required: true, description: 'Whether 组图 (sequential generation) was requested.' },
          references: { type: 'integer', required: true, description: 'Number of reference images sent.' },
          seed: { type: 'integer', description: 'Seed used (present only when the caller asked for one).' },
          usage: { type: 'object', additionalProperties: true, description: 'Platform usage counters (generated_images / output_tokens / total_tokens).' },
          failures: {
            type: 'array',
            description: 'Per-image failures reported by the platform (present only when at least one image failed).',
            items: { type: 'object', additionalProperties: true },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Generated ${value.paths.length} image(s) [${value.mode}] -> ${value.paths.join(', ')}`,
      }],
    },
    async execute(args, exec) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt === '') throw new Error('generate_image: prompt must be a non-empty string')

      const rawReferences = args.image ?? []
      if (!Array.isArray(rawReferences)) throw new Error('generate_image: image must be an array of reference images')
      if (rawReferences.length > MAX_REFERENCE_IMAGES) {
        throw new Error(`generate_image: ${rawReferences.length} reference images, over the ${MAX_REFERENCE_IMAGES} limit`)
      }
      const count = args.count ?? 1
      if (!Number.isInteger(count) || count < 1 || count > MAX_GROUP_IMAGES) {
        throw new Error(`generate_image: count must be an integer between 1 and ${MAX_GROUP_IMAGES}`)
      }
      if (args.seed !== undefined && !Number.isInteger(args.seed)) throw new Error('generate_image: seed must be an integer')

      const mode = resolveMode(args.mode, rawReferences.length)
      const size = normalizeSize(args.size)
      const outputFormat = normalizeOutputFormat(args.output_format)
      const extension = outputFormat === 'png' ? '.png' : '.jpg'
      const paths = resolveOutputPaths({
        outputPath: args.output_path,
        outputDir: args.output_dir,
        extension,
        total: count,
        defaultOutputDir,
      })

      const references = []
      for (const source of rawReferences) references.push(await materializeReference(source))

      const body = buildRequestBody({
        model,
        prompt,
        references,
        mode,
        size,
        count,
        watermark: args.watermark,
        seed: args.seed,
        outputFormat,
        webSearch: args.web_search,
        optimizePrompt: args.optimize_prompt,
        extra: args.extra,
        imageField,
      })

      const apiKey = await resolveApiKey()
      const timeoutController = new AbortController()
      const timeout = setTimeout(() => {
        timeoutController.abort(new Error(`generate_image: Ark timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      try {
        const signal = AbortSignal.any([exec.signal, timeoutController.signal])
        const response = await fetch(`${String(baseURL).replace(/\/+$/, '')}/images/generations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal,
        })
        const payload = await response.json().catch(() => undefined)
        if (!response.ok) throw new Error(`generate_image: Ark answered ${response.status}${describeFailure(response.status, payload)}`)
        const items = payload?.data
        if (!Array.isArray(items)) throw new Error('generate_image: Ark returned no image list')

        const written = []
        const urls = []
        const sizes = []
        const failures = []
        for (const [index, item] of items.entries()) {
          if (item === null || typeof item !== 'object') {
            failures.push({ index, code: 'malformed', message: 'entry is not an object' })
            continue
          }
          if (item.error !== undefined) {
            failures.push({ index, code: String(item.error?.code ?? 'error'), message: String(item.error?.message ?? '') })
            continue
          }
          const target = paths[written.length]
          if (target === undefined) break
          try {
            let bytes
            if (typeof item.b64_json === 'string' && item.b64_json !== '') {
              bytes = Buffer.from(item.b64_json, 'base64')
            } else if (typeof item.url === 'string' && item.url !== '') {
              bytes = await downloadImage(item.url, signal)
            } else {
              failures.push({ index, code: 'no_payload', message: 'entry carries neither url nor b64_json' })
              continue
            }
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, bytes)
            written.push(target)
            urls.push(typeof item.url === 'string' ? item.url : '')
            sizes.push(typeof item.size === 'string' ? item.size : '')
          } catch (error) {
            failures.push({ index, code: 'write_failed', message: `${target}: ${String(error?.message ?? error)}` })
          }
        }
        if (written.length === 0) {
          const first = failures[0]
          throw new Error(`generate_image: no image was produced${first === undefined ? '' : ` (${first.code}: ${first.message})`}`)
        }

        // jsonSafe drops the undefined-valued keys, so failed entries simply do
        // not appear in the output (PLUGIN-SPEC §7).
        return jsonSafe({
          paths: written,
          urls,
          sizes,
          mode,
          model,
          outputFormat,
          grouped: count > 1,
          references: references.length,
          seed: args.seed,
          usage: typeof payload.usage === 'object' && payload.usage !== null ? payload.usage : undefined,
          failures: failures.length > 0 ? failures : undefined,
        })
      } finally {
        clearTimeout(timeout)
        timeoutController.abort()
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Generate image', kind: 'other', rawInput: args }),
  }))
}
