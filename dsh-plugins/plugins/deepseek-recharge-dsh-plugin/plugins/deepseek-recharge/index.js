/**
 * Model-facing `deepseek_recharge` tool for the native dsh web profile.
 *
 * DeepSeek has no public top-up API — recharging happens on the platform
 * website (支付宝/微信 after 实名认证). This tool makes that path as short as
 * possible: it queries the current balance for context, then opens the
 * recharge/billing page in the system default browser. The user pays there,
 * and can re-run `deepseek_balance` afterwards to verify the top-up landed.
 *
 * The balance context resolves `DEEPSEEK_API_KEY` through the credentials
 * seam (never exposed in output). Opening the browser is a configurable
 * behavior (`autoOpen`, default true) so headless/CI usage can disable it.
 *
 * This plugin is self-contained for the npm dsh install: it depends only on
 * packages the installed CLI already provides (dsh-tools, dsh-credentials,
 * schemastery).
 */

import { spawn } from 'node:child_process'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'tool-deepseek-recharge'
export const inject = ['tools']

/** DeepSeek Open Platform API root (for the balance context query). */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'
/** Default credential reference resolved through the credentials seam. */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
/** Per-request endpoint timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 15_000
/** The billing / recharge page on the DeepSeek platform. */
export const DEFAULT_RECHARGE_URL = 'https://platform.deepseek.com/usage'

/** Configuration for the recharge tool. */
export const Config = z.object({
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  timeoutMs: z.natural(),
  /** The recharge/billing page to open. */
  rechargeUrl: z.string(),
  /** Whether to open the page in the system default browser (default true). */
  autoOpen: z.boolean(),
})

/** Fetch the current account balance (for the context shown to the user). */
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
    throw new Error(`deepseek_recharge: balance endpoint answered ${response.status}${body.length === 0 ? '' : `: ${body.slice(0, 300)}`}`)
  }
  const parsed = await response.json()
  const info = Array.isArray(parsed?.balance_infos) && parsed.balance_infos.length > 0 ? parsed.balance_infos[0] : null
  return {
    isAvailable: parsed?.is_available === true,
    currency: info?.currency ?? 'CNY',
    totalBalance: Number(info?.total_balance) || 0,
  }
}

/** Open a URL in the system default browser (Windows `start`, else xdg-open/open). */
function openBrowser(url) {
  const command = process.platform === 'win32'
    ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
    : process.platform === 'darwin'
      ? { cmd: 'open', args: [url] }
      : { cmd: 'xdg-open', args: [url] }
  const child = spawn(command.cmd, command.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

/**
 * Register the `deepseek_recharge` tool. Credentials resolve through the
 * optional credentials seam, falling back to the process environment.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the recharge backend facts.
 */
export function apply(ctx, config) {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const rechargeUrl = config.rechargeUrl ?? DEFAULT_RECHARGE_URL
  const autoOpen = config.autoOpen ?? true

  const resolveApiKey = async () => {
    const ref = credentialRef(apiKeyEnv)
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      : process.env[apiKeyEnv]
    if (hit === undefined || hit.length === 0) {
      throw new Error(`deepseek_recharge: no credential for ${apiKeyEnv}; set it through the credentials service or export it in the environment`)
    }
    return hit
  }

  ctx.tools.register(defineTool({
    name: 'deepseek_recharge',
    description: 'Help the user top up the DeepSeek API account. DeepSeek has no recharge API, so this tool queries the '
      + 'current balance for context and opens the platform recharge/billing page in the default browser for the user '
      + 'to pay (支付宝/微信 after 实名认证). Returns the recharge URL and the current balance; the user can re-run '
      + 'deepseek_balance afterwards to verify the top-up.',
    parameters: {
      auto_open: { type: 'boolean', description: 'Override whether to open the browser (defaults to the configured value).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rechargeUrl: { type: 'string', required: true },
          opened: { type: 'boolean', required: true },
          currency: { type: 'string', required: true },
          totalBalance: { type: 'number', required: true },
          isAvailable: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `DeepSeek 充值页: ${value.rechargeUrl}`,
          `当前余额: ${value.totalBalance} ${value.currency}${value.isAvailable ? '' : '（余额不足，建议尽快充值）'}`,
          value.opened ? '已在默认浏览器打开充值页，请在页面完成支付（支付宝/微信）。' : '未自动打开浏览器，请手动访问上面的链接。',
          '支付完成后，可让我再查一次余额确认到账。',
        ].join('\n'),
      }],
    },
    async execute(args, exec) {
      const apiKey = await resolveApiKey()
      const timeoutController = new AbortController()
      const timeout = setTimeout(() => {
        timeoutController.abort(new Error(`deepseek_recharge: balance endpoint timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      let balance
      try {
        balance = await fetchBalance(baseURL, apiKey, AbortSignal.any([exec.signal, timeoutController.signal]))
      } finally {
        clearTimeout(timeout)
        timeoutController.abort()
      }
      const open = args.auto_open ?? autoOpen
      if (open) openBrowser(rechargeUrl)
      return {
        rechargeUrl,
        opened: open,
        currency: balance.currency,
        totalBalance: balance.totalBalance,
        isAvailable: balance.isAvailable,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'DeepSeek recharge', kind: 'other', rawInput: args }),
  }))
}
