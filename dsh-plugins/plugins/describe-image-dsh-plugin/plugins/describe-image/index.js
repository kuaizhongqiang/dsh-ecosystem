/**
 * Model-facing `describe_image` tool for the native dsh web profile.
 *
 * Describes one image by calling a configurable OpenAI-compatible vision
 * endpoint (Xiaomi MiMo by default), reading the image from a session
 * attachment (`attachmentId`) or a disk path (`path`). The main conversation
 * model stays text-only — it calls this tool and consumes the returned
 * description.
 *
 * The endpoint protocol is the OpenAI standard (`image_url` with a base64 data
 * URI), so any OpenAI-compatible vision gateway is a configuration change.
 *
 * This plugin is self-contained for the npm dsh install: it depends only on
 * packages the installed CLI already provides (dsh-tools, dsh-attachment,
 * dsh-credentials, dsh-session, cordis, schemastery). The image-ref hint
 * format it parses is the same format the profile's apiproxy patch writes
 * (see the patch-apiproxy script).
 */

import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'tool-describe-image'
export const inject = ['tools']

/** package.json is the single source of truth for the version. */
const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))
export const version = PKG.version

/** Default vision endpoint: Xiaomi MiMo, OpenAI chat-completions standard. */
export const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
/** Default vision model. */
export const DEFAULT_MODEL = 'mimo-v2.5'
/** Default credential reference resolved through the credentials seam. */
export const DEFAULT_API_KEY_ENV = 'MIMO_API_KEY'
/** Default per-request endpoint timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 60_000
/** Default vision response token budget. */
export const DEFAULT_MAX_TOKENS = 4096
/** Default per-image byte cap, matching the attachment store's default. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
/** Default accepted raster media types (the OpenAI-standard set plus BMP). */
export const DEFAULT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']

/** Configuration for the vision backend the tool calls. */
export const Config = z.object({
  baseURL: z.string(),
  model: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  timeoutMs: z.natural(),
  maxTokens: z.natural(),
  maxBytes: z.natural(),
  allowedMediaTypes: z.array(z.string()),
})

/** Extension-to-media-type map for disk paths (the tool cannot sniff bytes). */
const EXTENSION_MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

/** Media type for one disk path, or undefined for an unknown extension. */
function mediaTypeForPath(path) {
  return EXTENSION_MEDIA_TYPES[extname(path).toLowerCase().replace('.', '')]
}

/**
 * Render a text hint that carries one durable image reference. The leading
 * bracket section is machine-parseable by {@link parseImageRefHint}; the
 * trailing instruction is free text the model reads. Must stay byte-identical
 * to the writer in the apiproxy patch so the two sides never drift.
 * @param ref - the durable reference to embed.
 * @returns the hint text.
 */
export function imageRefHint(ref) {
  const name = ref.name === undefined ? '' : `, ${JSON.stringify(ref.name)}`
  const bracket = `[图片附件 ${String(ref.attachmentId)} (${ref.mediaType}, ${ref.width}×${ref.height}, ${ref.bytes}B${name})]`
  return `${bracket} — 使用 describe_image 工具（参数 attachmentId=${String(ref.attachmentId)}）查看此图片`
}

/**
 * Parse the leading reference section of an image-attachment hint.
 * @param text - text possibly carrying an image-ref hint.
 * @returns the embedded reference, or undefined when the text is not a hint.
 */
export function parseImageRefHint(text) {
  const match = /^\[图片附件 ([^ (]+) \(([^,]+), (\d+)×(\d+), (\d+)B(?:, ("(?:[^"\\]|\\.)*"))?\)\]/.exec(text)
  if (match === null) return undefined
  const id = match[1]
  const mediaType = match[2]
  const width = match[3]
  const height = match[4]
  const bytes = match[5]
  const nameJson = match[6]
  const ref = {
    attachmentId: id,
    mediaType,
    width: Number(width),
    height: Number(height),
    bytes: Number(bytes),
  }
  if (nameJson !== undefined) {
    try {
      const parsed = JSON.parse(nameJson)
      if (typeof parsed === 'string') ref.name = parsed
    } catch {
      // An unparsable name leaves the reference unnamed; the other fields stand.
    }
  }
  return ref
}

/** Scan one content array for an image reference matching an id. */
function imageRefInContent(content, attachmentId) {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (typeof value !== 'object' || value === null) continue
    const block = value
    if (block.type === 'image') {
      const ref = block.attachment
      if (typeof ref === 'object' && ref !== null && String(ref.attachmentId) === attachmentId) return ref
    }
    if (block.type === 'text') {
      if (typeof block.text !== 'string') continue
      const hint = parseImageRefHint(block.text)
      if (hint !== undefined && String(hint.attachmentId) === attachmentId) return hint
    }
    if (block.type === 'tool-result') {
      const nested = imageRefInContent(block.content, attachmentId)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Search one event's carriers for an image reference matching an id. */
function imageRefInEvent(event, attachmentId) {
  const data = event.data
  const direct = imageRefInContent(data?.content, attachmentId)
  if (direct !== undefined) return direct
  if (data?.message !== undefined) {
    const wrapped = imageRefInContent(data.message.content, attachmentId)
    if (wrapped !== undefined) return wrapped
  }
  if (data?.inserted !== undefined) {
    for (const message of data.inserted) {
      const inserted = imageRefInContent(message.content, attachmentId)
      if (inserted !== undefined) return inserted
    }
  }
  return undefined
}

/** Resolve the durable reference for one session attachment id, or undefined. */
function findAttachmentRef(events, attachmentId) {
  for (const event of events) {
    const found = imageRefInEvent(event, attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}

/** Read and media-type one image source (attachment or path). */
async function resolveImageSource(attachments, events, args) {
  if (args.attachmentId !== undefined) {
    if (attachments === undefined) throw new Error('describe_image: no attachment service is mounted')
    const ref = findAttachmentRef(events, args.attachmentId)
    if (ref === undefined) {
      throw new Error(`describe_image: attachment ${JSON.stringify(args.attachmentId)} is not referenced by this session`)
    }
    const stored = await attachments.readImage(ref)
    return { data: stored.data, mediaType: stored.ref.mediaType, label: ref.name ?? String(ref.attachmentId) }
  }
  const path = args.path
  if (path === undefined) throw new Error('describe_image: specify attachmentId or path')
  const mediaType = mediaTypeForPath(path)
  if (mediaType === undefined) {
    throw new Error(`describe_image: cannot determine the image type of ${JSON.stringify(path)} (supported: png/jpg/jpeg/webp/gif/bmp)`)
  }
  const data = new Uint8Array(await readFile(path))
  return { data, mediaType, label: path }
}

/**
 * Describe one image through the configured OpenAI-compatible endpoint.
 * @param source - the image bytes and media type.
 * @param prompt - the vision task text.
 * @param options - endpoint facts and the resolved credential.
 * @returns the model's description text.
 */
async function describeImage(source, prompt, options) {
  const dataUri = `data:${source.mediaType};base64,${Buffer.from(source.data).toString('base64')}`
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
    throw new Error(`describe_image: vision endpoint answered ${response.status}${body.length === 0 ? '' : `: ${body.slice(0, 400)}`}`)
  }
  const parsed = await response.json()
  const description = parsed.choices?.[0]?.message?.content
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error('describe_image: vision endpoint returned no description')
  }
  return description
}

/**
 * Register the `describe_image` tool. Credentials resolve through the optional
 * credentials seam, falling back to the process environment.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the vision backend facts.
 */
export function apply(ctx, config) {
  console.info(`[tool-describe-image] v${version} registered`)
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  const model = config.model ?? DEFAULT_MODEL
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES
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
      throw new Error(`describe_image: no credential for ${apiKeyEnv}; set it through the credentials service or export it in the environment`)
    }
    return hit
  }

  ctx.tools.register(defineTool({
    name: 'describe_image',
    description: 'Describe the content of one image. Pass either attachmentId (an image the user attached to this '
      + 'conversation, e.g. pasted or dropped) or path (a file on disk). The vision model reads the image and returns '
      + 'a text description; use it when the user asks about an attached image or an image file.',
    parameters: {
      attachmentId: { type: 'string', description: 'The id of an image the user attached to this conversation (pasted or dropped). Exactly one of attachmentId and path is required.' },
      path: { type: 'string', description: 'Absolute path of an image file on disk (png/jpg/jpeg/webp/gif/bmp). Exactly one of attachmentId and path is required.' },
      prompt: { type: 'string', description: 'What to look for; defaults to describing the image.' },
      maxTokens: { type: 'integer', description: 'Vision response token budget; defaults to the configured value.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string', required: true, description: "The vision model's description of the image." },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.description }],
    },
    async execute(args, exec) {
      if ((args.attachmentId === undefined) === (args.path === undefined)) {
        throw new Error('describe_image: exactly one of attachmentId and path is required')
      }
      if (args.attachmentId !== undefined && exec.agent === undefined) {
        throw new Error('describe_image: attachmentId requires an owning agent session')
      }
      const source = await resolveImageSource(
        ctx.get('attachments'),
        exec.agent?.session.events ?? [],
        {
          ...args.attachmentId === undefined ? {} : { attachmentId: args.attachmentId },
          ...args.path === undefined ? {} : { path: args.path },
        },
      )
      if (!allowedMediaTypes.has(source.mediaType)) {
        throw new Error(`describe_image: unsupported image type ${JSON.stringify(source.mediaType)} (allowed: ${[...allowedMediaTypes].join(', ')})`)
      }
      if (source.data.byteLength > maxBytes) {
        throw new Error(`describe_image: image ${JSON.stringify(source.label)} is ${source.data.byteLength} bytes, over the ${maxBytes}-byte limit`)
      }
      const apiKey = await resolveApiKey()
      const timeoutController = new AbortController()
      const timeout = setTimeout(() => {
        timeoutController.abort(new Error(`describe_image: vision endpoint timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      try {
        const description = await describeImage(source, args.prompt ?? 'Describe the content of this image in detail.', {
          baseURL,
          model,
          apiKey,
          maxTokens: args.maxTokens ?? maxTokens,
          signal: AbortSignal.any([exec.signal, timeoutController.signal]),
        })
        return { description }
      } finally {
        clearTimeout(timeout)
        timeoutController.abort()
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Read image', kind: 'read', rawInput: args }),
  }))
}
