/**
 * History & search tools for tool-github: `github_commit`, `github_search`.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

const FILE_PATCH_LINES = 60
const PATCH_TOTAL_LINES = 400
const PATCH_TOTAL_CHARS = 50_000

/** Loose schema nodes (the harness demands explicit additionalProperties). */
const OBJ = { type: 'object', additionalProperties: true }
const ARR = { type: 'array', items: { type: 'object', additionalProperties: true } }

/**
 * Register the commit/search tools.
 * @param {object} ctx - registrant context carrying the tool registry.
 * @param {object} env - shared plugin environment (cfg, core helpers, git kit).
 */
export function register(ctx, env) {
  const { gh, errFromGh, invalidErr, noTokenErr, withQuery, clipLines, sha7, repoParam, rateNote, resolveToken } = env
  const cfg = env.cfg

  const fmtErr = (e) => [`❌ [${e.status}] ${e.message}`, ...(e.hint ? [`💡 ${e.hint}`] : [])]
  const headline = (message) => String(message ?? '').split('\n')[0] ?? ''

  // --- github_commit -----------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'github_commit',
    description: 'Inspect commit history and individual changes in a GitHub repository. action:"list" (default) '
      + 'returns recent commits (optionally filtered by branch via `sha` and by `path`); action:"get" returns one '
      + 'commit with stats and per-file patches (clipped). Repo as owner/repo or URL.',
    parameters: {
      action: { type: 'string', description: 'list (default) | get.' },
      repo: { type: 'string', required: true, description: 'owner/repo or GitHub URL.' },
      sha: { type: 'string', description: 'list: start ref/branch; defaults to the default branch.' },
      path: { type: 'string', description: 'list: only commits touching this path.' },
      ref: { type: 'string', description: 'get: commit sha or ref; defaults to the default branch tip.' },
      perPage: { type: 'number', description: 'list page size, default 25, max 100.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          commits: ARR,
          commit: OBJ,
          count: { type: 'number' },
          error: OBJ,
        },
      },
      render: (_args, value) => {
        const lines = []
        if (value.error) lines.push(...fmtErr(value.error))
        else if (value.commits) {
          lines.push(`最近提交 ${value.count} 条：`)
          for (const c of value.commits) lines.push(`- ${c.sha7} ${c.author} ${c.date.slice(0, 10)} ${c.message}`)
        } else if (value.commit) {
          const c = value.commit
          lines.push(`${c.sha7} ${c.author} ${c.date}`)
          lines.push(c.message)
          lines.push(`共 ${c.files.length} 个文件，+${c.additions}/-${c.deletions}`)
          for (const f of c.files) {
            lines.push(`- ${f.filename} (${f.status} +${f.additions}/-${f.deletions})`)
            if (f.patch) {
              lines.push('```')
              lines.push(f.patchTruncated ? `${f.patch}\n…` : f.patch)
              lines.push('```')
            }
          }
        }
        const note = rateNote()
        if (note) lines.push(note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const token = await resolveToken()
      const signal = exec?.signal
      const r = repoParam(args, cfg.defaultRepo)
      if (r.error) return r
      const base = `/repos/${r.owner}/${r.repo}`
      const action = args.action || 'list'
      if (action === 'get') {
        const res = await gh(`${base}/commits/${encodeURIComponent(args.ref || 'HEAD')}`, { token, signal })
        if (res.kind !== 'ok') return errFromGh(res)
        const j = res.json
        let budget = PATCH_TOTAL_LINES
        const files = (Array.isArray(j.files) ? j.files : []).map((f) => {
          if (f.patch && budget > 0) {
            const clipped = clipLines(f.patch, Math.min(FILE_PATCH_LINES, budget))
            budget -= clipped.text.split('\n').length
            return { filename: f.filename, status: f.status, additions: f.additions ?? 0, deletions: f.deletions ?? 0, patch: clipped.text, patchTruncated: clipped.truncated }
          }
          return { filename: f.filename, status: f.status, additions: f.additions ?? 0, deletions: f.deletions ?? 0, patch: null }
        })
        return {
          commit: {
            sha7: sha7(j.sha),
            author: j.commit?.author?.name ?? j.author?.login ?? '',
            date: j.commit?.author?.date ?? '',
            message: String(j.commit?.message ?? '').slice(0, PATCH_TOTAL_CHARS),
            additions: j.stats?.additions ?? 0,
            deletions: j.stats?.deletions ?? 0,
            files,
          },
        }
      }
      const perPage = Math.min(Number(args.perPage) > 0 ? Number(args.perPage) : cfg.perPageDef, 100)
      const res = await gh(withQuery(`${base}/commits`, {
        sha: args.sha || undefined,
        path: args.path || undefined,
        per_page: perPage,
      }), { token, signal })
      if (res.kind !== 'ok') return errFromGh(res)
      const items = Array.isArray(res.json) ? res.json : []
      return {
        count: items.length,
        commits: items.map((c) => ({
          sha7: sha7(c.sha),
          author: c.commit?.author?.name ?? c.author?.login ?? '',
          date: c.commit?.author?.date ?? '',
          message: headline(c.commit?.message),
        })),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `GitHub commits ${args.action || 'list'}`, kind: 'read', rawInput: args }),
  }))

  // --- github_search --------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'github_search',
    description: 'Search GitHub with the query syntax. scope "repos" finds repositories, "code" finds file matches '
      + '(requires GITHUB_TOKEN; only the default branch, files <384KB), "issues" finds issues and PRs. Provide q in '
      + 'GitHub search syntax, e.g. `defineTool repo:kuaizhongqiang/dsh-plugins` or `todo: language:python stars:>100`.',
    parameters: {
      scope: { type: 'string', required: true, description: 'repos | code | issues.' },
      q: { type: 'string', required: true, description: 'GitHub search query.' },
      perPage: { type: 'number', description: 'page size, default 25, max 50.' },
      page: { type: 'number', description: 'page number, default 1.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number' },
          results: ARR,
          scope: { type: 'string' },
          error: OBJ,
        },
      },
      render: (_args, value) => {
        const lines = []
        if (value.error) lines.push(...fmtErr(value.error))
        else {
          lines.push(`搜索 "${value.scope}" 共 ${value.total} 条结果（本页 ${value.results.length}）：`)
          for (const x of value.results) lines.push(`- ${x.primary}${x.secondary ? ` — ${x.secondary}` : ''}`)
        }
        const note = rateNote()
        if (note) lines.push(note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const token = await resolveToken()
      const signal = exec?.signal
      const scope = ['repos', 'code', 'issues'].includes(args.scope) ? args.scope : null
      if (!scope) return invalidErr('scope 必须是 repos / code / issues')
      if (!args.q) return invalidErr('需要 q 参数（GitHub 搜索语法）')
      if (scope === 'code' && !token) return noTokenErr('代码搜索（code search）')
      const perPage = Math.min(Number(args.perPage) > 0 ? Number(args.perPage) : cfg.perPageDef, 50)
      const endpoint = { repos: 'repositories', code: 'code', issues: 'issues' }[scope]
      const res = await gh(withQuery(`/search/${endpoint}`, {
        q: args.q,
        per_page: perPage,
        page: Number(args.page) > 1 ? Number(args.page) : undefined,
      }), { token, signal })
      if (res.kind !== 'ok') return errFromGh(res)
      const j = res.json ?? {}
      const items = Array.isArray(j.items) ? j.items : []
      const results = items.map((x) => {
        if (scope === 'repos') {
          return {
            primary: `${x.full_name}${x.private ? ' 🔒' : ''}`,
            secondary: `★${x.stargazers_count ?? 0} ${x.language ?? ''} ${x.description ?? ''}`.trim(),
            htmlUrl: x.html_url,
          }
        }
        if (scope === 'code') {
          return {
            primary: `${x.repository?.full_name ?? ''}:${x.path ?? ''}`,
            secondary: x.html_url ?? '',
            htmlUrl: x.html_url,
          }
        }
        const repoFull = String(x.repository_url ?? '').replace(/^.*\/repos\//, '')
        return {
          primary: `${repoFull}#${x.number} [${x.state}]${x.pull_request ? ' (PR)' : ''} ${x.title}`,
          secondary: x.html_url ?? '',
          htmlUrl: x.html_url,
        }
      })
      return { scope, total: j.total_count ?? results.length, results }
    },
    presentCall: (args) => ({ card: 'generic', title: `GitHub search ${args.scope ?? ''}`.trim(), kind: 'read', rawInput: args }),
  }))
}
