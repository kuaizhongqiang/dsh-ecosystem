/**
 * GitHub repository management tools for the native dsh web profile:
 * `github_repo`, `github_files`, `github_file_write`, `github_issue`,
 * `github_pr`, `github_commit`, `github_search`, and `github_sync`.
 *
 * The optional GITHUB_TOKEN resolves through the credentials seam (env
 * fallback); without it the plugin runs in anonymous read-only mode on public
 * repositories. Local clone/pull/commit/push (`github_sync`) shells out to git
 * with the token injected per invocation so it never lands on disk.
 *
 * Layout: `lib/core.js` (HTTP layer), `lib/git.js` (git layer), and the tool
 * modules `lib/tools-repo.js`, `lib/tools-social.js`, `lib/tools-history.js`,
 * `lib/tools-sync.js`. This entry wires config + credentials and registers
 * everything. See ../../DESIGN.md for the full design.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import { createCore } from './lib/core.js'
import { createGitKit } from './lib/git.js'
import { register as registerRepoTools } from './lib/tools-repo.js'
import { register as registerSocialTools } from './lib/tools-social.js'
import { register as registerHistoryTools } from './lib/tools-history.js'
import { register as registerSyncTool } from './lib/tools-sync.js'

/** package.json is the single source of truth for the version. */
const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))
export const version = PKG.version

export const name = 'tool-github'
export const inject = ['tools']

export const Config = z.object({
  tokenRef: z.string().role('credential-ref'),
  apiBase: z.string(),
  defaultRepo: z.string(),
  perPage: z.natural(),
  timeoutMs: z.natural(),
  workspaceRoot: z.string(),
  projectRoot: z.string(),
  gitUserName: z.string(),
  gitUserEmail: z.string(),
  gitCoworkerName: z.string(),
  gitCoworkerEmail: z.string(),
  allowWrite: z.boolean(),
  maxFileBytes: z.natural(),
  maxDiffLines: z.natural(),
})

/**
 * Register the nine GitHub tools.
 * @param {object} ctx - registrant context carrying the tool registry and the
 *   optional credentials seam (ctx.get('credentials')).
 * @param {object} config - validated Config values (all optional).
 */
export function apply(ctx, config) {
  const cfg = {
    tokenRef: config.tokenRef || 'GITHUB_TOKEN',
    apiBase: (config.apiBase || 'https://api.github.com').replace(/\/+$/, ''),
    defaultRepo: config.defaultRepo || '',
    perPageDef: config.perPage > 0 ? config.perPage : 25,
    timeoutMs: config.timeoutMs > 0 ? config.timeoutMs : 20_000,
    workspaceRoot: config.workspaceRoot || '',
    projectRoot: config.projectRoot || '',
    gitUserName: config.gitUserName || '',
    gitUserEmail: config.gitUserEmail || '',
    coworkerName: config.gitCoworkerName || 'coworker (DeepSeek Harness GLM)',
    coworkerEmail: config.gitCoworkerEmail || 'coworker@deepseek-harness.invalid',
    allowWrite: config.allowWrite !== false,
    maxFileBytes: config.maxFileBytes > 0 ? config.maxFileBytes : 65_536,
    maxDiffLines: config.maxDiffLines > 0 ? config.maxDiffLines : 400,
  }

  // The credentials service may start AFTER this plugin registers — fetch it
  // lazily per operation (see tool-credentials / deepseek-balance), never once
  // at apply time, or the captured value is undefined forever.
  const resolveToken = async () => {
    const ref = credentialRef(cfg.tokenRef)
    const credentials = ctx.get ? ctx.get('credentials') : undefined
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      : process.env[cfg.tokenRef]
    return typeof hit === 'string' && hit.length > 0 ? hit : null
  }

  const core = createCore({ apiBase: cfg.apiBase, timeoutMs: cfg.timeoutMs, getToken: resolveToken })
  const git = createGitKit(core, {
    getToken: resolveToken,
    gitUserName: cfg.gitUserName,
    gitUserEmail: cfg.gitUserEmail,
    coworkerName: cfg.coworkerName,
    coworkerEmail: cfg.coworkerEmail,
    workspaceRoot: cfg.workspaceRoot,
    projectRoot: cfg.projectRoot,
  })

  const env = { cfg, resolveToken, ...core, git }

  registerRepoTools(ctx, env)
  registerSocialTools(ctx, env)
  registerHistoryTools(ctx, env)
  registerSyncTool(ctx, env)

  console.info(`[tool-github] v${version} — 8 tools registered (tokenRef=${cfg.tokenRef}, apiBase=${cfg.apiBase})`)
}
