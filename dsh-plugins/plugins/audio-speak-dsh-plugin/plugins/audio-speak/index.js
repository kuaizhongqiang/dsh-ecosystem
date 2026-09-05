/**
 * Model-facing `speak_text` tool for the native dsh web profile.
 *
 * Synthesizes speech for a piece of text with the Xiaomi MiMo TTS model
 * (`mimo-v2.5-tts`) through the OpenAI-compatible chat/completions endpoint,
 * writes the resulting audio file to disk, and returns its path. The main
 * conversation model stays text-only — it calls this tool and tells the user
 * where the audio file was written.
 *
 * The request follows the official MiMo "Speech Synthesis" contract: a user
 * message may carry tone/style instructions, an assistant message carries the
 * exact target text, and the `audio` object selects the output format and
 * voice (`mimo_default`, or one of the built-in voices). The response's
 * `choices[0].message.audio.data` is the base64 audio payload.
 *
 * This plugin is self-contained for the npm dsh install: it depends only on
 * packages the installed CLI already provides (dsh-tools, dsh-credentials,
 * schemastery). Credentials resolve through the credentials seam, falling
 * back to the process environment.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'tool-audio-speak'
export const inject = ['tools']

/** MiMo OpenAI-compatible endpoint root. */
export const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
/** Speech-synthesis model with the built-in preset voices. */
export const DEFAULT_MODEL = 'mimo-v2.5-tts'
/** Default credential reference resolved through the credentials seam. */
export const DEFAULT_API_KEY_ENV = 'MIMO_API_KEY'
/** Per-request endpoint timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 60_000
/** Default output directory when the caller passes no output_path. */
export const DEFAULT_OUTPUT_DIR = join(homedir(), 'Downloads')
/** Default voice. */
export const DEFAULT_VOICE = 'mimo_default'
/** Output formats this plugin writes to disk (wav/mp3 carry headers; pcm16 does not). */
export const OUTPUT_FORMATS = ['wav', 'mp3']
/** Built-in voices documented by the platform (voice IDs equal their names). */
export const BUILTIN_VOICES = [
  'mimo_default', '冰糖', '茉莉', '苏打', '白桦',
  'Mia', 'Chloe', 'Milo', 'Dean',
]

/** Configuration for the speech backend the tool calls. */
export const Config = z.object({
  baseURL: z.string(),
  model: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  timeoutMs: z.natural(),
  defaultOutputDir: z.string(),
  maxTextLength: z.natural(),
})

/** Generate a collision-safe default filename for one synthesis. */
function defaultFileName(format) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const random = Math.random().toString(36).slice(2, 6)
  return `mimo-speech-${stamp}-${random}.${format}`
}

/**
 * Resolve the final output path: a full path is kept (extension enforced to
 * match the format), a directory gets a generated filename, and no path uses
 * the configured default directory.
 * @returns the resolved absolute path.
 */
function resolveOutputPath(outputPath, format, defaultOutputDir) {
  let target = outputPath ?? join(defaultOutputDir, defaultFileName(format))
  const extension = extname(target).toLowerCase()
  if (extension === '') {
    target = `${target}.${format}`
  } else if (extension !== `.${format}`) {
    throw new Error(`speak_text: output file extension ${extension} does not match format ${format}`)
  }
  return target
}

/**
 * Synthesize speech through the configured endpoint and return the raw audio
 * bytes in the requested format.
 * @param text - the exact text to speak.
 * @param style - optional tone/style instructions (becomes the user message).
 * @param format - 'wav' or 'mp3'.
 * @param voice - the voice ID.
 * @param options - endpoint facts and the resolved credential.
 * @returns the audio bytes.
 */
async function synthesize(text, style, format, voice, options) {
  const response = await fetch(`${options.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      messages: [
        ...(style !== undefined && style.length > 0
          ? [{ role: 'user', content: style }]
          : []),
        { role: 'assistant', content: text },
      ],
      audio: { format, voice },
    }),
    signal: options.signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`speak_text: endpoint answered ${response.status}${body.length === 0 ? '' : `: ${body.slice(0, 400)}`}`)
  }
  const parsed = await response.json()
  const encoded = parsed.choices?.[0]?.message?.audio?.data
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error('speak_text: endpoint returned no audio data')
  }
  return Buffer.from(encoded, 'base64')
}

/**
 * Register the `speak_text` tool. Credentials resolve through the optional
 * credentials seam, falling back to the process environment.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the speech backend facts.
 */
export function apply(ctx, config) {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  const model = config.model ?? DEFAULT_MODEL
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const defaultOutputDir = config.defaultOutputDir ?? DEFAULT_OUTPUT_DIR
  const maxTextLength = config.maxTextLength ?? 2000

  const resolveApiKey = async () => {
    const ref = credentialRef(apiKeyEnv)
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      : process.env[apiKeyEnv]
    if (hit === undefined || hit.length === 0) {
      throw new Error(`speak_text: no credential for ${apiKeyEnv}; set it through the credentials service or export it in the environment`)
    }
    return hit
  }

  ctx.tools.register(defineTool({
    name: 'speak_text',
    description: 'Synthesize speech for a piece of text with the MiMo TTS model and write the audio to a file. '
      + 'Pass the text to speak, optionally a voice, an output format (wav or mp3), and an output file path or '
      + 'directory. Returns the path of the generated audio file; tell the user where it was saved.',
    parameters: {
      text: { type: 'string', description: 'The exact text to speak (the audio reads exactly this text).' },
      voice: {
        type: 'string',
        description: "Voice ID: 'mimo_default' (default), or a built-in voice: 冰糖 (female, zh), 茉莉 (female, zh), "
          + '苏打 (male, zh), 白桦 (male, zh), Mia (female, en), Chloe (female, en), Milo (male, en), Dean (male, en).',
      },
      format: { type: 'string', description: "Output audio format: 'wav' (default) or 'mp3'." },
      style: { type: 'string', description: 'Optional tone/style instructions for the delivery (e.g. "bright and upbeat, fast pace"); ignored when empty.' },
      output_path: { type: 'string', description: 'Where to write the audio: a full file path (extension must match the format) or a directory; defaults to the Downloads folder with a generated name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Absolute path of the written audio file.' },
          format: { type: 'string', required: true, description: 'The audio format written (wav or mp3).' },
          bytes: { type: 'integer', required: true, description: 'Size of the written audio file in bytes.' },
          voice: { type: 'string', required: true, description: 'The voice used.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Speech saved to ${value.path} (${value.format}, ${value.bytes} bytes, voice ${value.voice})`,
      }],
    },
    async execute(args, exec) {
      const text = args.text
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new Error('speak_text: text must be a non-empty string')
      }
      if (text.length > maxTextLength) {
        throw new Error(`speak_text: text is ${text.length} characters, over the ${maxTextLength}-character limit`)
      }
      const format = args.format ?? 'wav'
      if (!OUTPUT_FORMATS.includes(format)) {
        throw new Error(`speak_text: format must be one of ${OUTPUT_FORMATS.join('/')}`)
      }
      const voice = args.voice ?? DEFAULT_VOICE
      if (!BUILTIN_VOICES.includes(voice)) {
        throw new Error(`speak_text: unknown voice ${JSON.stringify(voice)} (built-in: ${BUILTIN_VOICES.join(', ')})`)
      }
      const outputPath = resolveOutputPath(args.output_path, format, defaultOutputDir)
      const apiKey = await resolveApiKey()

      const timeoutController = new AbortController()
      const timeout = setTimeout(() => {
        timeoutController.abort(new Error(`speak_text: endpoint timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      try {
        const bytes = await synthesize(text, args.style, format, voice, {
          baseURL,
          model,
          apiKey,
          signal: AbortSignal.any([exec.signal, timeoutController.signal]),
        })
        await mkdir(dirname(outputPath), { recursive: true })
        await writeFile(outputPath, bytes)
        return { path: outputPath, format, bytes: bytes.byteLength, voice }
      } finally {
        clearTimeout(timeout)
        timeoutController.abort()
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Speak text', kind: 'other', rawInput: args }),
  }))
}
