/**
 * Model-facing `read_video` tool for the native dsh web profile.
 *
 * Understands one video by calling the Xiaomi MiMo full-modal model
 * (`mimo-v2.5`) through the OpenAI-compatible chat/completions endpoint.
 * The main conversation model stays text-only — it calls this tool with a
 * local file path (`path`) or a public URL (`url`) and consumes the returned
 * description.
 *
 * Video input follows the official MiMo "Video Understanding" contract: the
 * user content carries a `video_url` block whose `url` is either a public
 * https URL or a base64 data URI (`data:{MIME_TYPE};base64,...`) for local
 * files. `fps` and `media_resolution` control the frame-extraction fineness.
 *
 * This plugin is self-contained for the npm dsh install: it depends only on
 * packages the installed CLI already provides (dsh-tools, dsh-credentials,
 * schemastery). Credentials resolve through the credentials seam, falling
 * back to the process environment.
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'tool-video-read'
export const inject = ['tools']

/** MiMo OpenAI-compatible endpoint root. */
export const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
/** Full-modal model that accepts video (also image + audio) input. */
export const DEFAULT_MODEL = 'mimo-v2.5'
/** Default credential reference resolved through the credentials seam. */
export const DEFAULT_API_KEY_ENV = 'MIMO_API_KEY'
/** Per-request endpoint timeout in milliseconds (video reasoning can be slow). */
export const DEFAULT_TIMEOUT_MS = 180_000
/** Default vision response token budget. */
export const DEFAULT_MAX_TOKENS = 4096
/**
 * Default per-file byte cap: the platform limits the base64 data URI to 50 MB,
 * which is 37.5 MB of binary data. URL input is capped by the platform at
 * 300 MB and is not locally enforced.
 */
export const DEFAULT_MAX_BYTES = 37_500_000
/** Default frame-extraction rate (frames per second), platform range [0.1, 10]. */
export const DEFAULT_FPS = 2
/** Default per-frame resolution tier: 'default' | 'max'. */
export const DEFAULT_MEDIA_RESOLUTION = 'default'

/** Extension-to-media-type map for local video files (the tool cannot sniff bytes). */
const VIDEO_MEDIA_TYPES = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
}

/** Media type for one disk path, or undefined for an unsupported extension. */
function mediaTypeForPath(path) {
  return VIDEO_MEDIA_TYPES[extname(path).toLowerCase().replace('.', '')]
}

/** Configuration for the video-understanding backend the tool calls. */
export const Config = z.object({
  baseURL: z.string(),
  model: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  timeoutMs: z.natural(),
  maxTokens: z.natural(),
  maxBytes: z.natural(),
})

/**
 * Resolve the video source from the tool arguments: either a local file that
 * is read and base64-encoded into a data URI, or a public URL passed through.
 * @returns `{ url, label }` — `url` is what the `video_url` block receives.
 */
async function resolveVideoSource(args, maxBytes) {
  if (args.url !== undefined) {
    if (!/^https?:\/\//i.test(args.url)) {
      throw new Error('read_video: url must be a public http(s) URL')
    }
    return { url: args.url, label: args.url }
  }
  const path = args.path
  if (path === undefined) throw new Error('read_video: specify path or url')
  const mediaType = mediaTypeForPath(path)
  if (mediaType === undefined) {
    throw new Error(`read_video: unsupported video format for ${JSON.stringify(path)} (supported: mp4/mov/avi/wmv)`)
  }
  const data = new Uint8Array(await readFile(path))
  if (data.byteLength > maxBytes) {
    throw new Error(`read_video: ${JSON.stringify(path)} is ${data.byteLength} bytes, over the ${maxBytes}-byte limit for base64 input (use a public URL for larger files)`)
  }
  const url = `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`
  return { url, label: path }
}

/**
 * Understand one video through the configured endpoint.
 * @param source - the resolved `video_url` value.
 * @param prompt - the video task text.
 * @param options - endpoint facts and the resolved credential.
 * @returns the model's description text.
 */
async function readVideo(source, prompt, options) {
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
          {
            type: 'video_url',
            video_url: { url: source.url },
            fps: options.fps,
            media_resolution: options.mediaResolution,
          },
          { type: 'text', text: prompt },
        ],
      }],
      max_completion_tokens: options.maxTokens,
    }),
    signal: options.signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`read_video: endpoint answered ${response.status}${body.length === 0 ? '' : `: ${body.slice(0, 400)}`}`)
  }
  const parsed = await response.json()
  const description = parsed.choices?.[0]?.message?.content
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error('read_video: endpoint returned no description')
  }
  return description
}

/**
 * Register the `read_video` tool. Credentials resolve through the optional
 * credentials seam, falling back to the process environment.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the video backend facts.
 */
export function apply(ctx, config) {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  const model = config.model ?? DEFAULT_MODEL
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES

  const resolveApiKey = async () => {
    const ref = credentialRef(apiKeyEnv)
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      : process.env[apiKeyEnv]
    if (hit === undefined || hit.length === 0) {
      throw new Error(`read_video: no credential for ${apiKeyEnv}; set it through the credentials service or export it in the environment`)
    }
    return hit
  }

  ctx.tools.register(defineTool({
    name: 'read_video',
    description: 'Understand the content of one video. Pass either path (a local video file: mp4/mov/avi/wmv) or url '
      + '(a public http(s) video URL). The MiMo full-modal model reads the video and returns a text description; use it '
      + 'when the user asks about a video file, a video URL, or asks you to analyze video content.',
    parameters: {
      path: { type: 'string', description: 'Absolute path of a local video file (mp4/mov/avi/wmv). Exactly one of path and url is required.' },
      url: { type: 'string', description: 'Public http(s) URL of a video (max 300 MB, platform-enforced). Exactly one of path and url is required.' },
      prompt: { type: 'string', description: 'What to look for in the video; defaults to a detailed description.' },
      fps: { type: 'number', description: 'Frames extracted per second, range [0.1, 10]; higher = finer temporal detail, more tokens. Defaults to 2.' },
      media_resolution: { type: 'string', description: "Per-frame resolution tier: 'default' (balanced) or 'max' (better small-object detail, more tokens). Defaults to 'default'." },
      max_tokens: { type: 'integer', description: 'Response token budget; defaults to the configured value.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string', required: true, description: "The model's description of the video." },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.description }],
    },
    async execute(args, exec) {
      if ((args.path === undefined) === (args.url === undefined)) {
        throw new Error('read_video: exactly one of path and url is required')
      }
      if (args.fps !== undefined && (args.fps < 0.1 || args.fps > 10)) {
        throw new Error('read_video: fps must be within [0.1, 10]')
      }
      if (args.media_resolution !== undefined && args.media_resolution !== 'default' && args.media_resolution !== 'max') {
        throw new Error("read_video: media_resolution must be 'default' or 'max'")
      }
      const source = await resolveVideoSource(args, maxBytes)
      const apiKey = await resolveApiKey()
      const timeoutController = new AbortController()
      const timeout = setTimeout(() => {
        timeoutController.abort(new Error(`read_video: endpoint timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      try {
        const description = await readVideo(source, args.prompt ?? 'Describe the content of this video in detail.', {
          baseURL,
          model,
          apiKey,
          fps: args.fps ?? DEFAULT_FPS,
          mediaResolution: args.media_resolution ?? DEFAULT_MEDIA_RESOLUTION,
          maxTokens: args.max_tokens ?? maxTokens,
          signal: AbortSignal.any([exec.signal, timeoutController.signal]),
        })
        return { description }
      } finally {
        clearTimeout(timeout)
        timeoutController.abort()
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Read video', kind: 'read', rawInput: args }),
  }))
}
