/**
 * Model-facing `deepseek_balance` tool for the native dsh web profile.
 *
 * Queries the current balance of the DeepSeek Open Platform account through
 * the official public endpoint `GET /user/balance` (Bearer auth with the API
 * key), returning the total / granted / topped-up balance per currency.
 *
 * The key is resolved through the credentials seam (`DEEPSEEK_API_KEY` by
 * default), never hardcoded and never exposed in tool output.
 *
 * This plugin is self-contained for the npm dsh install: it depends only on
 * packages the installed CLI already provides (dsh-tools, dsh-credentials,
 * schemastery).
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'tool-deepseek-balance'
export const inject = ['tools']

/** DeepSeek Open Platform API root. */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'
/** Default credential reference resolved through the credentials seam. */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
/** Per-request endpoint timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 15_000
/** Preferred currency entry when multiple balance_infos are returned. */
export const DEFAULT_CURRENCY = 'CNY'

/** Configuration for the balance backend the tool calls. */
export const Config = z.object({
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  timeoutMs: z.natural(),
})

/**
 * Fetch the account balance from the official endpoint.
 * @returns the parsed balance payload, or throws with a clear message.
 */
async function fetchBalance(baseURL, apiKey, signal) {
  const response = await fetch(`${baseURL.replace(/\/+$/, '')}/user/balance`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`deepseek_balance: endpoint answered ${response.status}${body.length === 0 ? '' : `: ${body.slice(0, 300)}`}`)
  }
  const parsed = await response.json()
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('deepseek_balance: unexpected response shape')
  }
  return parsed
}

/** Pick the preferred currency entry, falling back to the first one. */
function pickBalanceInfo(balanceInfos, currency) {
  if (!Array.isArray(balanceInfos) || balanceInfos.length === 0) return null
  const found = balanceInfos.find((entry) => entry?.currency === currency)
  return found ?? balanceInfos[0]
}

/**
 * Register the `deepseek_balance` tool. Credentials resolve through the
 * optional credentials seam, falling back to the process environment.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the balance backend facts.
 */
export function apply(ctx, config) {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const resolveApiKey = async () => {
    const ref = credentialRef(apiKeyEnv)
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      : process.env[apiKeyEnv]
    if (hit === undefined || hit.length === 0) {
      throw new Error(`deepseek_balance: no credential for ${apiKeyEnv}; set it through the credentials service or export it in the environment`)
    }
    return hit
  }

  ctx.tools.register(defineTool({
    name: 'deepseek_balance',
    description: 'Query the current DeepSeek API account balance through the official /user/balance endpoint (uses the '
      + 'DEEPSEEK_API_KEY credential). Returns availability, currency, total balance, granted (free) balance, and '
      + 'topped-up balance. Use it when the user asks about remaining credits, cost, or whether the account needs a '
      + 'top-up.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          isAvailable: { type: 'boolean', required: true },
          currency: { type: 'string', required: true },
          totalBalance: { type: 'number', required: true },
          grantedBalance: { type: 'number', required: true },
          toppedUpBalance: { type: 'number', required: true },
          checkedAt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `DeepSeek 余额（${value.currency}）: ${value.totalBalance}`,
          `充值余额: ${value.toppedUpBalance}  赠送余额: ${value.grantedBalance}`,
          value.isAvailable ? '账户可用' : '账户不可用（余额不足或受限）',
          `查询时间: ${value.checkedAt}`,
        ].join('\n'),
      }],
    },
    async execute(args, exec) {
      const apiKey = await resolveApiKey()
      const timeoutController = new AbortController()
      const timeout = setTimeout(() => {
        timeoutController.abort(new Error(`deepseek_balance: endpoint timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      try {
        const parsed = await fetchBalance(baseURL, apiKey, AbortSignal.any([exec.signal, timeoutController.signal]))
        const info = pickBalanceInfo(parsed.balance_infos, DEFAULT_CURRENCY)
        if (info === null) {
          throw new Error('deepseek_balance: endpoint returned no balance information')
        }
        return {
          isAvailable: parsed.is_available === true,
          currency: info.currency ?? DEFAULT_CURRENCY,
          totalBalance: Number(info.total_balance) || 0,
          grantedBalance: Number(info.granted_balance) || 0,
          toppedUpBalance: Number(info.topped_up_balance) || 0,
          checkedAt: new Date().toISOString(),
        }
      } finally {
        clearTimeout(timeout)
        timeoutController.abort()
      }
    },
    presentCall: () => ({ card: 'generic', title: 'DeepSeek balance', kind: 'read' }),
  }))
}
