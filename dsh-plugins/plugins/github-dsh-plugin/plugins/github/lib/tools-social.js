/**
 * Social tools for tool-github: `github_issue`, `github_pr`.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

const BODY_CLIP = 2_000
const COMMENT_CLIP = 1_000

/** Loose schema nodes (the harness demands explicit additionalProperties). */
const OBJ = { type: 'object', additionalProperties: true }
const ARR = { type: 'array', items: { type: 'object', additionalProperties: true } }

/**
 * Register the issue/PR/notification tools.
 * @param {object} ctx - registrant context carrying the tool registry.
 * @param {object} env - shared plugin environment (cfg, core helpers, git kit).
 */
export function register(ctx, env) {
  const { gh, ghRaw, errOf, errFromGh, invalidErr, noTokenErr, withQuery, clipText, clipLines, sha7, csv, repoParam, rateNote, resolveToken } = env
  const cfg = env.cfg

  const fmtErr = (e) => [`❌ [${e.status}] ${e.message}`, ...(e.hint ? [`💡 ${e.hint}`] : [])]
  const confirmErr = (what) => errOf('confirm-required', `${what}属于破坏性操作，必须显式传 confirm: true`)
  const writeGate = () => (cfg.allowWrite ? null : errOf('forbidden', '插件处于只读模式（config.allowWrite: false）'))
  const labelNames = (j) => (j?.labels ?? []).map((l) => l.name ?? l)

  // --- github_issue -----------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'github_issue',
    description: 'Manage GitHub issues: list (PRs filtered out), get one with optional latest comments, create, '
      + 'comment, close/reopen (optional parting comment), and relabel. Repo as owner/repo or URL. Write actions '
      + 'are blocked when the plugin runs read-only (allowWrite: false).',
    parameters: {
      action: { type: 'string', description: 'list (default) | get | create | comment | close | reopen | label.' },
      repo: { type: 'string', required: true, description: 'owner/repo or GitHub URL.' },
      number: { type: 'number', description: 'issue number (get and all write actions).' },
      state: { type: 'string', description: 'list: open (default) | closed | all.' },
      labels: { type: 'string', description: 'list: comma-separated label filter; create: comma-separated labels to set.' },
      title: { type: 'string', description: 'create: issue title.' },
      body: { type: 'string', description: 'create/comment: text body.' },
      comment: { type: 'string', description: 'close/reopen: optional parting comment.' },
      add: { type: 'string', description: 'label: comma-separated labels to add.' },
      remove: { type: 'string', description: 'label: comma-separated labels to remove.' },
      includeComments: { type: 'boolean', description: 'get: include the latest 10 comments.' },
      perPage: { type: 'number', description: 'list page size, default 25, max 100.' },
      page: { type: 'number', description: 'list page number, default 1.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          issues: ARR,
          issue: OBJ,
          comment: OBJ,
          count: { type: 'number' },
          error: OBJ,
        },
      },
      render: (_args, value) => {
        const lines = []
        if (value.error) lines.push(...fmtErr(value.error))
        else if (value.issues) {
          lines.push(`issues ${value.count} 个（PR 已过滤）：`)
          for (const i of value.issues) {
            lines.push(`- #${i.number} [${i.state}] ${i.title}（${i.author}${i.labels.length ? ` · ${i.labels.join('/')}` : ''}）${i.updatedAt}`)
          }
        } else if (value.issue) {
          const i = value.issue
          lines.push(`#${i.number} [${i.state}] ${i.title}（${i.author}）`)
          if (i.body) lines.push(`正文: ${i.bodyTruncated ? `${i.body.slice(0, 120)}…` : i.body.slice(0, 200)}`)
          if (i.labels?.length) lines.push(`标签: ${i.labels.join(', ')}`)
          if (i.commentsList) {
            lines.push(`最近评论 ${i.commentsList.length} 条：`)
            for (const c of i.commentsList) lines.push(`- ${c.author}: ${c.body.slice(0, 100)}${c.truncated ? '…' : ''}`)
          }
          lines.push(i.htmlUrl)
        } else if (value.comment) lines.push(`✅ 评论成功: ${value.comment.htmlUrl}`)
        const note = rateNote()
        if (note) lines.push(note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const action = args.action || 'list'
      const token = await resolveToken()
      const signal = exec?.signal
      const r = repoParam(args, cfg.defaultRepo)
      if (r.error) return r
      const base = `/repos/${r.owner}/${r.repo}`
      const perPage = Math.min(Number(args.perPage) > 0 ? Number(args.perPage) : cfg.perPageDef, 100)
      if (action === 'list') {
        const res = await gh(withQuery(`${base}/issues`, {
          state: args.state || 'open',
          labels: args.labels || undefined,
          per_page: perPage,
          page: Number(args.page) > 1 ? Number(args.page) : undefined,
        }), { token, signal })
        if (res.kind !== 'ok') return errFromGh(res)
        const items = (Array.isArray(res.json) ? res.json : []).filter((x) => !x.pull_request)
        return {
          count: items.length,
          issues: items.map((x) => ({
            number: x.number,
            title: x.title,
            state: x.state,
            author: x.user?.login ?? '',
            labels: labelNames(x),
            comments: x.comments ?? 0,
            updatedAt: x.updated_at,
            htmlUrl: x.html_url,
          })),
        }
      }
      const needsNumber = ['get', 'comment', 'close', 'reopen', 'label'].includes(action)
      const n = Number(args.number)
      if (needsNumber && (!Number.isInteger(n) || n <= 0)) return invalidErr(`${action} 需要 number 参数（issue 编号）`)
      if (action === 'get') {
        const res = await gh(`${base}/issues/${n}`, { token, signal })
        if (res.kind !== 'ok') return errFromGh(res)
        const j = res.json
        const body = clipText(j.body ?? '', BODY_CLIP)
        let commentsList
        if (args.includeComments) {
          const c = await gh(withQuery(`${base}/issues/${n}/comments`, { per_page: 10, sort: 'created', direction: 'desc' }), { token, signal })
          if (c.kind === 'ok') {
            commentsList = (Array.isArray(c.json) ? c.json : []).reverse().map((x) => {
              const b = clipText(x.body ?? '', COMMENT_CLIP)
              return { author: x.user?.login ?? '', body: b.text, truncated: b.truncated, createdAt: x.created_at }
            })
          }
        }
        return {
          issue: {
            number: j.number,
            title: j.title,
            state: j.state,
            author: j.user?.login ?? '',
            body: body.text,
            bodyTruncated: body.truncated,
            labels: labelNames(j),
            comments: j.comments ?? 0,
            createdAt: j.created_at,
            updatedAt: j.updated_at,
            htmlUrl: j.html_url,
            ...(commentsList ? { commentsList } : {}),
          },
        }
      }
      const gate = writeGate()
      if (gate) return gate
      if (action === 'create') {
        if (!args.title) return invalidErr('create 需要 title 参数')
        const labels = csv(args.labels)
        const res = await gh(`${base}/issues`, {
          method: 'POST',
          token,
          signal,
          body: { title: args.title, ...(args.body ? { body: args.body } : {}), ...(labels.length ? { labels } : {}) },
        })
        if (res.kind !== 'ok') return errFromGh(res)
        return { issue: { number: res.json.number, title: res.json.title, state: res.json.state, htmlUrl: res.json.html_url } }
      }
      if (action === 'comment') {
        if (!args.body) return invalidErr('comment 需要 body 参数')
        const res = await gh(`${base}/issues/${n}/comments`, { method: 'POST', token, signal, body: { body: args.body } })
        if (res.kind !== 'ok') return errFromGh(res)
        return { comment: { id: res.json.id, htmlUrl: res.json.html_url } }
      }
      if (action === 'close' || action === 'reopen') {
        if (args.comment) {
          const c = await gh(`${base}/issues/${n}/comments`, { method: 'POST', token, signal, body: { body: args.comment } })
          if (c.kind !== 'ok') return errFromGh(c)
        }
        const res = await gh(`${base}/issues/${n}`, { method: 'PATCH', token, signal, body: { state: action === 'close' ? 'closed' : 'open' } })
        if (res.kind !== 'ok') return errFromGh(res)
        return { issue: { number: res.json.number, state: res.json.state, htmlUrl: res.json.html_url } }
      }
      if (action === 'label') {
        if (!args.add && !args.remove) return invalidErr('label 需要 add 或 remove 参数（逗号分隔）')
        const cur = await gh(`${base}/issues/${n}`, { token, signal })
        if (cur.kind !== 'ok') return errFromGh(cur)
        const remove = csv(args.remove)
        const set = labelNames(cur.json).filter((x) => !remove.includes(x))
        for (const a of csv(args.add)) if (!set.includes(a)) set.push(a)
        const res = await gh(`${base}/issues/${n}`, { method: 'PATCH', token, signal, body: { labels: set } })
        if (res.kind !== 'ok') return errFromGh(res)
        return { issue: { number: res.json.number, labels: labelNames(res.json), htmlUrl: res.json.html_url } }
      }
      return invalidErr(`未知 action: ${action}`)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `GitHub issue ${args.action || 'list'}${args.number ? ` #${args.number}` : ''}`,
      kind: ['list', 'get'].includes(args.action || 'list') ? 'read' : 'write',
      rawInput: args,
    }),
  }))

  // --- github_pr ----------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'github_pr',
    description: 'Manage GitHub pull requests: list, get (with diff and changed-file summary), create from a pushed '
      + 'branch, comment, merge (requires confirm:true), and close. Repo as owner/repo or URL. After github_sync push '
      + 'the tool output already contains the PR-creation link.',
    parameters: {
      action: { type: 'string', description: 'list (default) | get | create | comment | merge | close.' },
      repo: { type: 'string', required: true, description: 'owner/repo or GitHub URL.' },
      number: { type: 'number', description: 'PR number (get and all write actions).' },
      state: { type: 'string', description: 'list: open (default) | closed | all.' },
      base: { type: 'string', description: 'list: filter by base branch; create: target branch (required).' },
      head: { type: 'string', description: 'create: source branch (required).' },
      title: { type: 'string', description: 'create: PR title (required).' },
      body: { type: 'string', description: 'create/comment: text body.' },
      draft: { type: 'boolean', description: 'create: open as draft.' },
      diff: { type: 'boolean', description: 'get: include the diff (default true, capped).' },
      method: { type: 'string', description: 'merge: merge (default) | squash | rebase.' },
      confirm: { type: 'boolean', description: 'merge: must be true.' },
      perPage: { type: 'number', description: 'list page size, default 25, max 100.' },
      page: { type: 'number', description: 'list page number, default 1.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pulls: ARR,
          pull: OBJ,
          merge: OBJ,
          comment: OBJ,
          count: { type: 'number' },
          error: OBJ,
        },
      },
      render: (_args, value) => {
        const lines = []
        if (value.error) lines.push(...fmtErr(value.error))
        else if (value.pulls) {
          lines.push(`PR ${value.count} 个：`)
          for (const p of value.pulls) {
            lines.push(`- #${p.number} [${p.draft ? 'draft ' : ''}${p.state}] ${p.title}（${p.head} → ${p.base}）${p.updatedAt}`)
          }
        } else if (value.pull) {
          const p = value.pull
          lines.push(`#${p.number} [${p.draft ? 'draft ' : ''}${p.state}] ${p.title}（${p.author}）`)
          lines.push(`${p.head} → ${p.base} · mergeable: ${p.mergeable ?? 'computing'} · 作者 ${p.author}`)
          if (p.files?.length) {
            lines.push(`改动文件 ${p.files.length}${p.filesTruncated ? '+' : ''} 个：`)
            for (const f of p.files) lines.push(`- ${f.filename} (${f.status} +${f.additions}/-${f.deletions})`)
          }
          if (p.diff) {
            lines.push('--- diff ---')
            lines.push(p.diffTruncated ? `${p.diff}\n…（已截断）` : p.diff)
          }
          lines.push(p.htmlUrl)
        } else if (value.merge) lines.push(`✅ merged: ${value.merge.merged ? sha7(value.merge.sha) : '失败'} — ${value.merge.message ?? ''}`)
        else if (value.comment) lines.push(`✅ 评论成功: ${value.comment.htmlUrl}`)
        const note = rateNote()
        if (note) lines.push(note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const action = args.action || 'list'
      const token = await resolveToken()
      const signal = exec?.signal
      const r = repoParam(args, cfg.defaultRepo)
      if (r.error) return r
      const base = `/repos/${r.owner}/${r.repo}`
      const perPage = Math.min(Number(args.perPage) > 0 ? Number(args.perPage) : cfg.perPageDef, 100)
      if (action === 'list') {
        const res = await gh(withQuery(`${base}/pulls`, {
          state: args.state || 'open',
          base: args.base || undefined,
          per_page: perPage,
          page: Number(args.page) > 1 ? Number(args.page) : undefined,
        }), { token, signal })
        if (res.kind !== 'ok') return errFromGh(res)
        const items = Array.isArray(res.json) ? res.json : []
        return {
          count: items.length,
          pulls: items.map((x) => ({
            number: x.number,
            title: x.title,
            state: x.state,
            draft: !!x.draft,
            author: x.user?.login ?? '',
            head: x.head?.ref ?? '',
            base: x.base?.ref ?? '',
            updatedAt: x.updated_at,
            htmlUrl: x.html_url,
          })),
        }
      }
      const needsNumber = ['get', 'comment', 'merge', 'close'].includes(action)
      const n = Number(args.number)
      if (needsNumber && (!Number.isInteger(n) || n <= 0)) return invalidErr(`${action} 需要 number 参数（PR 编号）`)
      if (action === 'get') {
        const res = await gh(`${base}/pulls/${n}`, { token, signal })
        if (res.kind !== 'ok') return errFromGh(res)
        const j = res.json
        const out = {
          pull: {
            number: j.number,
            title: j.title,
            state: j.state,
            draft: !!j.draft,
            author: j.user?.login ?? '',
            head: j.head?.ref ?? '',
            base: j.base?.ref ?? '',
            mergeable: j.mergeable ?? null,
            createdAt: j.created_at,
            htmlUrl: j.html_url,
          },
        }
        if (args.diff !== false) {
          const d = await ghRaw(`${base}/pulls/${n}`, 'application/vnd.github.diff', { token, signal })
          if (d.kind === 'ok') {
            const clipped = clipLines(d.buffer.toString('utf8'), cfg.maxDiffLines)
            out.pull.diff = clipped.text
            out.pull.diffTruncated = clipped.truncated
          }
        }
        const f = await gh(withQuery(`${base}/pulls/${n}/files`, { per_page: 20 }), { token, signal })
        if (f.kind === 'ok' && Array.isArray(f.json)) {
          out.pull.files = f.json.map((x) => ({ filename: x.filename, status: x.status, additions: x.additions ?? 0, deletions: x.deletions ?? 0 }))
          out.pull.filesTruncated = f.json.length === 20
        }
        return out
      }
      const gate = writeGate()
      if (gate) return gate
      if (action === 'create') {
        if (!args.title || !args.head || !args.base) {
          return invalidErr('create 需要 title、head（源分支）、base（目标分支）参数')
        }
        const res = await gh(`${base}/pulls`, {
          method: 'POST',
          token,
          signal,
          body: { title: args.title, head: args.head, base: args.base, ...(args.body ? { body: args.body } : {}), draft: !!args.draft },
        })
        if (res.kind !== 'ok') return errFromGh(res)
        return { pull: { number: res.json.number, title: res.json.title, state: res.json.state, htmlUrl: res.json.html_url } }
      }
      if (action === 'comment') {
        if (!args.body) return invalidErr('comment 需要 body 参数')
        const res = await gh(`${base}/issues/${n}/comments`, { method: 'POST', token, signal, body: { body: args.body } })
        if (res.kind !== 'ok') return errFromGh(res)
        return { comment: { id: res.json.id, htmlUrl: res.json.html_url } }
      }
      if (action === 'merge') {
        if (args.confirm !== true) return confirmErr('合并 PR')
        const res = await gh(`${base}/pulls/${n}/merge`, { method: 'PUT', token, signal, body: { merge_method: args.method || 'merge' } })
        if (res.kind !== 'ok') return errFromGh(res)
        return { merge: { merged: !!res.json.merged, sha: sha7(res.json.sha), message: res.json.message ?? '' } }
      }
      if (action === 'close') {
        const res = await gh(`${base}/pulls/${n}`, { method: 'PATCH', token, signal, body: { state: 'closed' } })
        if (res.kind !== 'ok') return errFromGh(res)
        return { pull: { number: res.json.number, state: res.json.state, htmlUrl: res.json.html_url } }
      }
      return invalidErr(`未知 action: ${action}`)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `GitHub PR ${args.action || 'list'}${args.number ? ` #${args.number}` : ''}`,
      kind: ['list', 'get'].includes(args.action || 'list') ? 'read' : 'write',
      rawInput: args,
    }),
  }))
}
