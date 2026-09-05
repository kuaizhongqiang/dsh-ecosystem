/**
 * Credential-management tools for the native dsh web profile:
 * `credentials_list`, `credentials_set`, `credentials_unset`, and
 * `credentials_verify`.
 *
 * All four operate exclusively through the official credentials seam
 * (`@deepseek-ai/dsh-credentials`): configuration surfaces hold only
 * references (environment-variable-style names), the values live in the
 * provider-managed store (`$DSH_HOME/.credentials.yaml`), and every write
 * inherits the seam's cross-process file lock, atomic replacement, 0600
 * permissions, hot reload, and shadow-write protection.
 *
 * Security posture:
 * - `credentials_list` / `credentials_verify` never reveal stored values —
 *   they report `configured` / `source` / `writable` only.
 * - `credentials_set` stores a value supplied by the caller. When the
 *   deployment composes an approval service and the call runs under an agent,
 *   the write is gated behind an approval request (`'allowed-once'` is the
 *   only grant). The tool description orders the model never to echo the
 *   value. Note: the value does pass through the conversation once.
 * - `credentials_unset` removes a key through the seam.
 *
 * This plugin is self-contained for the npm dsh install: it depends only on
 * packages the installed CLI already provides (dsh-tools, dsh-credentials,
 * schemastery).
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'tool-credentials'
export const inject = ['tools']

/** Plugin configuration. All optional — see apply(). */
export const Config = z.object({
  /** Gate credentials_set behind the approval seam (default true). */
  requireApproval: z.boolean(),
})

/** POSIX shell identifier — the only shape a credential reference may take. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Validate one credential reference name and return it branded. */
function validatedRef(ref) {
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) {
    throw new Error(`credentials tools: ${JSON.stringify(ref)} is not a valid reference (expected a POSIX identifier like MIMO_API_KEY)`)
  }
  return credentialRef(ref)
}

/** Describe many references through the seam; values never cross this boundary. */
async function describeMany(credentials, refs) {
  const rows = []
  for (const ref of refs) {
    const info = await credentials.describe(validatedRef(ref))
    rows.push({
      ref,
      configured: info.configured,
      source: info.source ?? null,
      writable: info.writable,
    })
  }
  return rows
}

/** Render one list row for the model-facing text block. */
function renderRow(row) {
  const parts = [
    row.ref,
    row.configured ? 'configured' : 'unconfigured',
  ]
  if (row.configured && row.source !== null) parts.push(`source=${row.source}`)
  parts.push(row.writable ? 'writable' : 'read-only')
  return parts.join('  ')
}

/**
 * Register the four credential tools.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - plugin config.
 */
export function apply(ctx, config) {
  const requireApproval = config.requireApproval ?? true

  const credentials = () => ctx.get('credentials')
  const requireCredentials = () => {
    const service = credentials()
    if (service === undefined) throw new Error('credentials tools: no credentials service is mounted')
    return service
  }

  /** Enumerate the managed store's keys (guarded access to the provider snapshot). */
  const storeRefs = () => {
    const service = credentials()
    if (service === undefined) return []
    const values = service.values
    if (values instanceof Map) {
      return [...values.keys()].filter((key) => typeof key === 'string' && REF_PATTERN.test(key))
    }
    return []
  }

  /** Ask the approval seam before a write; absent service or agent degrades open. */
  const askApproval = async (exec, toolName, reason) => {
    if (!requireApproval) return
    const approval = ctx.get('approval')
    if (approval === undefined || exec.agent === undefined) return
    const outcome = await approval.request({
      agent: exec.agent,
      toolName,
      reason,
      signal: exec.signal,
    })
    if (outcome !== 'allowed-once') {
      throw new Error(`${toolName}: the write was not approved (${outcome}); nothing was changed`)
    }
  }

  // --- credentials_list ----------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'credentials_list',
    description: 'List which credential references are configured on this machine without revealing any values. Pass refs '
      + '(environment-variable-style names) to inspect specific keys, or omit refs to enumerate every key stored in the '
      + 'managed credentials file. Use it to check whether a plugin key (e.g. MIMO_API_KEY) is configured before installing '
      + 'or troubleshooting a plugin.',
    parameters: {
      refs: {
        type: 'array',
        description: 'Optional credential reference names to inspect (e.g. ["MIMO_API_KEY", "DEEPSEEK_API_KEY"]). When omitted, all keys in the managed credentials store are enumerated.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ref: { type: 'string', required: true },
                configured: { type: 'boolean', required: true },
                source: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                writable: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.rows.length === 0
          ? 'No credentials are stored.'
          : value.rows.map(renderRow).join('\n'),
      }],
    },
    async execute(args) {
      const service = requireCredentials()
      const refs = args.refs !== undefined && args.refs.length > 0 ? args.refs : storeRefs()
      return { rows: await describeMany(service, refs) }
    },
    presentCall: args => ({ card: 'generic', title: 'List credentials', kind: 'read', rawInput: args }),
  }))

  // --- credentials_verify --------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'credentials_verify',
    description: 'Verify that one credential reference resolves to a configured value on this machine, without revealing the '
      + 'value itself. Reports configured state and the source layer (env/file/.env). Use it to confirm a plugin key is in '
      + 'place after installation (e.g. credentials_verify on MIMO_API_KEY).',
    parameters: {
      ref: { type: 'string', required: true, description: 'The credential reference name to verify (e.g. MIMO_API_KEY).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'string', required: true },
          configured: { type: 'boolean', required: true },
          source: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.configured
          ? `${value.ref} is configured (source=${value.source ?? 'unknown'})`
          : `${value.ref} is NOT configured`,
      }],
    },
    async execute(args) {
      const service = requireCredentials()
      const ref = validatedRef(args.ref)
      const resolved = await service.resolve(ref)
      return {
        ref: args.ref,
        configured: resolved !== undefined,
        source: resolved?.source ?? null,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Verify credential', kind: 'read', rawInput: args }),
  }))

  // --- credentials_set -----------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'credentials_set',
    description: 'Store a credential value under a reference in the managed credentials file (hot-reloaded, no restart '
      + 'needed). The value must come from the user in this conversation; NEVER echo, quote, repeat, or otherwise restate '
      + 'the value in any later message, and never include it in summaries. In deployments with an approval service the '
      + 'write is gated behind an approval prompt. Use it when a newly installed plugin needs its API key configured.',
    parameters: {
      ref: { type: 'string', required: true, description: 'The credential reference name to store (a POSIX identifier like MIMO_API_KEY).' },
      value: { type: 'string', required: true, description: 'The secret value to store. Never restate this value afterwards.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'string', required: true },
          stored: { type: 'boolean', required: true },
          source: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.ref} stored in the managed credentials file (${value.source}).`,
      }],
    },
    async execute(args, exec) {
      const service = requireCredentials()
      const ref = validatedRef(args.ref)
      if (typeof args.value !== 'string' || args.value.length === 0) {
        throw new Error('credentials_set: value must be a non-empty string')
      }
      await askApproval(exec, 'credentials_set', `Store a new credential value under the reference ${args.ref}? The value persists in the managed credentials file.`)
      await service.set(ref, args.value)
      return { ref: args.ref, stored: true, source: 'file' }
    },
    presentCall: args => ({ card: 'generic', title: 'Set credential', kind: 'other', rawInput: args }),
  }))

  // --- credentials_unset ---------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'credentials_unset',
    description: 'Remove one credential reference from the managed credentials file (a no-op when it is absent). Use it to '
      + 'clean up a key that is no longer needed. The value is never read or revealed.',
    parameters: {
      ref: { type: 'string', required: true, description: 'The credential reference name to remove (e.g. MIMO_API_KEY).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'string', required: true },
          removed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.removed ? 'Removed' : 'Did not remove'} ${value.ref}`,
      }],
    },
    async execute(args, exec) {
      const service = requireCredentials()
      const ref = validatedRef(args.ref)
      await askApproval(exec, 'credentials_unset', `Remove the credential ${args.ref} from the managed credentials file?`)
      await service.unset(ref)
      return { ref: args.ref, removed: true }
    },
    presentCall: args => ({ card: 'generic', title: 'Unset credential', kind: 'other', rawInput: args }),
  }))
}
