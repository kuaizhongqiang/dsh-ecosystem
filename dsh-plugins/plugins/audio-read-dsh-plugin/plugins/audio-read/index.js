/**
 * Model-facing audio tools for the native dsh web profile:
 * `transcribe_audio` and `understand_audio`.
 *
 * - `transcribe_audio` turns speech into text with the dedicated ASR model
 *   (`mimo-v2.5-asr`, mp3/wav only, language auto/zh/en).
 * - `understand_audio` answers questions about any audio with the full-modal
 *   model (`mimo-v2.5`, mp3/wav/flac/m4a/ogg).
 *
 * The main conversation model stays text-only — it calls these tools with a
 * local file path (`path`) or a public URL (`url`) and consumes the returned
 * text. Audio input follows the official MiMo "Audio Understanding" /
 * "Speech Recognition" contracts: a user content block of type `input_audio`
 * whose `data` is a public URL or a base64 data URI
 * (`data:{MIME_TYPE};base64,...`).
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

export const name = 'tool-audio-read'
export const inject = ['tools']

/** MiMo OpenAI-compatible endpoint root. */
export const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
/** Dedicated automatic-speech-recognition model. */
export const DEFAULT_ASR_MODEL = 'mimo-v2.5-asr'
/** Full-modal model that accepts audio (also image + video) input. */
export const DEFAULT_UNDERSTAND_MODEL = 'mimo-v2.5'
/** Default credential reference resolved through the credentials seam. */
export const DEFAULT_API_KEY_ENV = 'MIMO_API_KEY'
/** Per-request endpoint timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 120_000
/** Default response token budget for audio understanding. */
export const DEFAULT_MAX_TOKENS = 2048
/**
 * Default per-file byte cap: the platform limits the base64 data URI to 50 MB,
 * which is 37.5 MB of binary data. URL input is capped by the platform at
 * 100 MB and is not locally enforced.
 */
export const DEFAULT_MAX_BYTES = 37_500_000

/** Extension-to-media-type map for local audio files (the tool cannot sniff bytes). */
const AUDIO_MEDIA_TYPES = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
}

/** Media type for one disk path, or undefined for an unsupported extension. */
function mediaTypeForPath(path) {
  return AUDIO_MEDIA_TYPES[extname(path).toLowerCase().replace('.', '')]
}

/**
 * Fetch a public audio URL and return it as a base64 data URI. The dedicated
 * ASR endpoint only accepts base64 data (unlike the full-modal model, which
 * also accepts URLs directly), so URL input must be downloaded and encoded
 * locally. Enforces the same byte cap as local-file input.
 * @returns `{ data, label }` — `data` is the data URI for `input_audio`.
 */
async function fetchAudioToDataUri(url, maxBytes) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`audio tools: failed to fetch ${JSON.stringify(url)}: ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maxBytes) {
    throw new Error(`audio tools: ${JSON.stringify(url)} is ${declared} bytes, over the ${maxBytes}-byte limit for base64 input`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) {
    throw new Error(`audio tools: ${JSON.stringify(url)} is ${bytes.byteLength} bytes, over the ${maxBytes}-byte limit for base64 input`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  const mediaType = (
    ['audio/mpeg', 'audio/mp3', 'audio/wav'].find((candidate) => contentType.toLowerCase().includes(candidate))
    ?? mediaTypeForPath(new URL(url).pathname)
    ?? 'audio/mpeg'
  )
  return { data: `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`, label: url }
}

/** Configuration for the audio backends the tools call. */
export const Config = z.object({
  baseURL: z.string(),
  asrModel: z.string(),
  understandModel: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  timeoutMs: z.natural(),
  maxTokens: z.natural(),
  maxBytes: z.natural(),
})

/**
 * Resolve the audio source from the tool arguments: either a local file that
 * is read and base64-encoded into a data URI, or a public URL passed through.
 * @returns `{ data, label }` — `data` is what the `input_audio` block receives.
 */
async function resolveAudioSource(args, maxBytes, allowedMediaTypes) {
  if (args.url !== undefined) {
    if (!/^https?:\/\//i.test(args.url)) {
      throw new Error('audio tools: url must be a public http(s) URL')
    }
    return { data: args.url, label: args.url }
  }
  const path = args.path
  if (path === undefined) throw new Error('audio tools: specify path or url')
  const mediaType = mediaTypeForPath(path)
  if (mediaType === undefined) {
    throw new Error(`audio tools: unsupported audio format for ${JSON.stringify(path)} (supported: ${Object.keys(allowedMediaTypes).join('/')})`)
  }
  const data = new Uint8Array(await readFile(path))
  if (data.byteLength > maxBytes) {
    throw new Error(`audio tools: ${JSON.stringify(path)} is ${data.byteLength} bytes, over the ${maxBytes}-byte limit for base64 input (use a public URL for larger files)`)
  }
  return { data: `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`, label: path }
}

/** One OpenAI-compatible chat/completions call against the configured endpoint. */
async function callChat(body, options) {
  const response = await fetch(`${options.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`audio tools: endpoint answered ${response.status}${text.length === 0 ? '' : `: ${text.slice(0, 400)}`}`)
  }
  return response.json()
}

/**
 * Register `transcribe_audio` and `understand_audio`. Credentials resolve
 * through the optional credentials seam, falling back to the process env.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the audio backend facts.
 */
export function apply(ctx, config) {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  const asrModel = config.asrModel ?? DEFAULT_ASR_MODEL
  const understandModel = config.understandModel ?? DEFAULT_UNDERSTAND_MODEL
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
      throw new Error(`audio tools: no credential for ${apiKeyEnv}; set it through the credentials service or export it in the environment`)
    }
    return hit
  }

  /** Shared timeout plumbing for one tool call. */
  const withTimeout = async (work) => {
    const timeoutController = new AbortController()
    const timeout = setTimeout(() => {
      timeoutController.abort(new Error(`audio tools: endpoint timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    try {
      return await work(AbortSignal.any([timeoutController.signal]))
    } finally {
      clearTimeout(timeout)
      timeoutController.abort()
    }
  }

  // --- transcribe_audio: mimo-v2.5-asr (mp3/wav) --------------------------
  ctx.tools.register(defineTool({
    name: 'transcribe_audio',
    description: 'Transcribe speech from one audio file to text. Pass either path (a local mp3/wav file) or url '
      + '(a public http(s) audio URL). Uses the dedicated MiMo ASR model (Chinese and English); use it when the user '
      + 'asks what was said in an audio recording.',
    parameters: {
      path: { type: 'string', description: 'Absolute path of a local audio file (mp3/wav). Exactly one of path and url is required.' },
      url: { type: 'string', description: 'Public http(s) URL of an mp3/wav file (fetched locally, max ~37.5 MB). Exactly one of path and url is required.' },
      language: { type: 'string', description: "Recognition language: 'auto' (detect), 'zh' (Chinese), or 'en' (English). Defaults to 'auto'." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          transcript: { type: 'string', required: true, description: 'The recognized speech text.' },
          durationSeconds: {
            required: true,
            oneOf: [{ type: 'integer' }, { type: 'null' }],
            description: 'Audio duration in seconds, or null when not reported by the API.',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.transcript }],
    },
    async execute(args, exec) {
      if ((args.path === undefined) === (args.url === undefined)) {
        throw new Error('transcribe_audio: exactly one of path and url is required')
      }
      if (args.language !== undefined && !['auto', 'zh', 'en'].includes(args.language)) {
        throw new Error("transcribe_audio: language must be 'auto', 'zh', or 'en'")
      }
      if (!/^https?:\/\//i.test(args.url ?? '')) {
        throw new Error('transcribe_audio: url must be a public http(s) URL')
      }
      // The ASR endpoint only accepts base64 data (mp3/wav), so a public URL
      // is fetched and encoded locally; a local file is read and encoded.
      const source = args.url !== undefined
        ? await fetchAudioToDataUri(args.url, maxBytes)
        : await resolveAudioSource(args, maxBytes, { mp3: true, wav: true })
      const apiKey = await resolveApiKey()
      return withTimeout(async (signal) => {
        const parsed = await callChat({
          model: asrModel,
          messages: [{
            role: 'user',
            content: [{ type: 'input_audio', input_audio: { data: source.data } }],
          }],
          asr_options: { language: args.language ?? 'auto' },
        }, { baseURL, apiKey, signal })
        const transcript = parsed.choices?.[0]?.message?.content
        if (typeof transcript !== 'string' || transcript.length === 0) {
          throw new Error('transcribe_audio: endpoint returned no transcript')
        }
        const result = { transcript }
        const seconds = parsed.usage?.seconds
        result.durationSeconds = typeof seconds === 'number' ? seconds : null
        return result
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Transcribe audio', kind: 'read', rawInput: args }),
  }))

  // --- understand_audio: mimo-v2.5 full-modal (mp3/wav/flac/m4a/ogg) ------
  ctx.tools.register(defineTool({
    name: 'understand_audio',
    description: 'Answer a question about one audio file. Pass either path (a local mp3/wav/flac/m4a/ogg file) or url '
      + '(a public http(s) audio URL). The MiMo full-modal model listens to the audio and returns a text answer; use it '
      + 'when the user asks about the content, tone, or meaning of an audio (not just a transcript).',
    parameters: {
      path: { type: 'string', description: 'Absolute path of a local audio file (mp3/wav/flac/m4a/ogg). Exactly one of path and url is required.' },
      url: { type: 'string', description: 'Public http(s) URL of an audio file (max 100 MB, platform-enforced). Exactly one of path and url is required.' },
      prompt: { type: 'string', description: 'What to look for in the audio; defaults to describing its content.' },
      max_tokens: { type: 'integer', description: 'Response token budget; defaults to the configured value.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string', required: true, description: "The model's answer about the audio." },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.answer }],
    },
    async execute(args, exec) {
      if ((args.path === undefined) === (args.url === undefined)) {
        throw new Error('understand_audio: exactly one of path and url is required')
      }
      const source = await resolveAudioSource(args, maxBytes, AUDIO_MEDIA_TYPES)
      const apiKey = await resolveApiKey()
      return withTimeout(async (signal) => {
        const parsed = await callChat({
          model: understandModel,
          messages: [{
            role: 'user',
            content: [
              { type: 'input_audio', input_audio: { data: source.data } },
              { type: 'text', text: args.prompt ?? 'Describe the content of this audio in detail.' },
            ],
          }],
          max_completion_tokens: args.max_tokens ?? maxTokens,
        }, { baseURL, apiKey, signal })
        const answer = parsed.choices?.[0]?.message?.content
        if (typeof answer !== 'string' || answer.length === 0) {
          throw new Error('understand_audio: endpoint returned no answer')
        }
        return { answer }
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Understand audio', kind: 'read', rawInput: args }),
  }))
}
