/**
 * Repository, file-read, and single-file-write tools for tool-github:
 * `github_repo`, `github_files`, `github_file_write`.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

const TREE_ENTRY_CAP = 1_000

/** Loose schema nodes (the harness demands explicit additionalProperties). */
const OBJ = { type: 'object', additionalProperties: true }
const ARR = { type: 'array', items: { type: 'object', additionalProperties: true } }

const normalizePath = (p) => String(p ?? '')
  .replace(/^\.\//, '')
  .replace(/^\/+/, '')
  .replace(/\/+$/, '')

const encPath = (p) => encodeURIComponent(p === '' ? '/' : p)

/**
 * Register the repository/file tools.
 * @param {object} ctx - registrant context carrying the tool registry.
 * @param {object} env - shared plugin environment (cfg, core helpers, git kit).
 */
export function register(ctx, env) {
  const { gh, ghRaw, errOf, errFromGh, invalidErr, noTokenErr, withQuery, clipText, sha7, csv, repoParam, defaultBranchOf, rateNote, resolveToken } = env
  const cfg = env.cfg

  const fmtErr = (e) => [`❌ [${e.status}] ${e.message}`, ...(e.hint ? [`💡 ${e.hint}`] : [])]
  const confirmErr = (what) => errOf('confirm-required', `${what}属于破坏性操作，必须显式传 confirm: true`)
  const writeGate = () => (cfg.allowWrite ? null : errOf('forbidden', '插件处于只读模式（config.allowWrite: false）'))

  // --- github_repo ----------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'github_repo',
    description: 'GitHub repository info: get one repo (stars/branches/default branch), list accessible repos '
      + '(token mode lists the current account; anonymous mode needs `owner`), list branches, or `action:"me"` '
      + 'to check identity and rate limit (run this first to verify GITHUB_TOKEN). Pass repo as owner/repo or a '
      + 'full GitHub URL.',
    parameters: {
      action: { type: 'string', description: 'get (default) | list | branches | me.' },
      repo: { type: 'string', description: 'owner/repo or GitHub URL (get/branches).' },
      owner: { type: 'string', description: 'list + anonymous: list repos of this owner.' },
      type: { type: 'string', description: 'list (token): owner (default) | all | member.' },
      sort: { type: 'string', description: 'list: pushed (default) | updated | full_name.' },
      perPage: { type: 'number', description: 'list/branches page size, default 25, max 100.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: OBJ,
          repos: ARR,
          branches: ARR,
          me: OBJ,
          count: { type: 'number' },
          error: OBJ,
        },
      },
      render: (_args, value) => {
        const lines = []
        if (value.error) lines.push(...fmtErr(value.error))
        else if (value.me) {
          lines.push(`身份: ${value.me.login ?? '匿名'}（${value.me.tokenKind}，${value.me.tokenRef}）`)
          lines.push(`rate: ${value.me.rate.remaining ?? '?'}/${value.me.rate.limit ?? '?'}，重置于 ${value.me.rate.resetAt ?? '?'}`)
        } else if (value.repo) {
          const r = value.repo
          lines.push(`${r.fullName}${r.private ? ' 🔒' : ''} — ⭐ ${r.stars} · forks ${r.forks} · open issues ${r.openIssues}`)
          lines.push(`${r.description || '(无描述)'}`)
          lines.push(`默认分支 ${r.defaultBranch} · 语言 ${r.language || '?'} · license ${r.license || '?'} · 最近推送 ${r.pushedAt}`)
          lines.push(r.htmlUrl)
        } else if (value.repos) {
          lines.push(`共 ${value.count} 个仓库：`)
          for (const r of value.repos) {
            lines.push(`- ${r.fullName}${r.private ? ' 🔒' : ''} ★${r.stars} ${r.language ? `[${r.language}]` : ''} ${r.description || ''}`)
          }
        } else if (value.branches) {
          lines.push(`分支 ${value.branches.length} 个：`)
          for (const b of value.branches) lines.push(`- ${b.name}${b.protected ? ' 🛡' : ''} @${b.sha7}`)
        }
        const note = rateNote()
        if (note) lines.push(note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const token = await resolveToken()
      const perPage = Math.min(Number(args.perPage) > 0 ? Number(args.perPage) : cfg.perPageDef, 100)
      const action = args.action || 'get'
      const signal = exec?.signal
      if (action === 'me') {
        if (!token) {
          const res = await gh('/rate_limit', { signal })
          if (res.kind !== 'ok') return errFromGh(res)
          const c = res.json?.resources?.core ?? {}
          return { me: { login: null, tokenKind: 'anonymous', tokenRef: cfg.tokenRef, rate: { limit: c.limit ?? null, remaining: c.remaining ?? null, resetAt: c.reset ? new Date(c.reset * 1000).toISOString() : null } } }
        }
        const u = await gh('/user', { token, signal })
        if (u.kind !== 'ok') return errFromGh(u)
        const scopes = u.headers?.get('x-oauth-scopes')
        const rr = await gh('/rate_limit', { token, signal })
        const c = rr.kind === 'ok' ? (rr.json?.resources?.core ?? {}) : {}
        return {
          me: {
            login: u.json.login ?? null,
            tokenKind: scopes && scopes.trim() ? 'classic' : 'fine-grained',
            tokenRef: cfg.tokenRef,
            rate: { limit: c.limit ?? null, remaining: c.remaining ?? null, resetAt: c.reset ? new Date(c.reset * 1000).toISOString() : null },
          },
        }
      }
      if (action === 'list') {
        const q = { per_page: perPage, sort: args.sort || 'pushed' }
        let res
        if (token) {
          if (args.type) q.type = args.type
          res = await gh(withQuery('/user/repos', q), { token, signal })
        } else {
          if (!args.owner) {
            return invalidErr('匿名模式下列出仓库需要 owner 参数（如 owner: kuaizhongqiang）', '配置 GITHUB_TOKEN 后可直接列出当前账号的仓库')
          }
          res = await gh(withQuery(`/users/${encodeURIComponent(args.owner)}/repos`, q), { signal })
        }
        if (res.kind !== 'ok') return errFromGh(res)
        const items = Array.isArray(res.json) ? res.json : []
        return {
          count: items.length,
          repos: items.map((x) => ({
            fullName: x.full_name,
            description: x.description ?? '',
            private: !!x.private,
            language: x.language ?? '',
            stars: x.stargazers_count ?? 0,
            pushedAt: x.pushed_at,
            htmlUrl: x.html_url,
          })),
        }
      }
      const r = repoParam(args, cfg.defaultRepo)
      if (r.error) return r
      if (action === 'branches') {
        const res = await gh(withQuery(`/repos/${r.owner}/${r.repo}/branches`, { per_page: perPage }), { token, signal })
        if (res.kind !== 'ok') return errFromGh(res)
        const items = Array.isArray(res.json) ? res.json : []
        return { branches: items.map((b) => ({ name: b.name, protected: !!b.protected, sha7: sha7(b.commit?.sha) })) }
      }
      const res = await gh(`/repos/${r.owner}/${r.repo}`, { token, signal })
      if (res.kind !== 'ok') return errFromGh(res)
      const j = res.json
      return {
        repo: {
          fullName: j.full_name,
          description: j.description ?? '',
          private: !!j.private,
          fork: !!j.fork,
          defaultBranch: j.default_branch,
          stars: j.stargazers_count ?? 0,
          forks: j.forks_count ?? 0,
          openIssues: j.open_issues_count ?? 0,
          language: j.language ?? '',
          license: j.license?.spdx_id ?? '',
          createdAt: j.created_at,
          pushedAt: j.pushed_at,
          htmlUrl: j.html_url,
        },
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `GitHub repo ${args.action || 'get'}`, kind: 'read', rawInput: args }),
  }))

  // --- github_files ---------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'github_files',
    description: 'Read files or list directory trees from a GitHub repository. action:"read" (default) decodes a '
      + 'file to text (binary files return metadata only; large files are clipped at maxBytes, >1MB files fall back '
      + 'to the raw endpoint); action:"tree" lists a directory (recursive:true walks the whole tree, capped at 1000 '
      + 'entries). Pass repo as owner/repo or URL; ref defaults to the default branch.',
    parameters: {
      action: { type: 'string', description: 'read (default) | tree.' },
      repo: { type: 'string', required: true, description: 'owner/repo or GitHub URL.' },
      path: { type: 'string', description: 'file or directory path inside the repo; "/" is the root.' },
      ref: { type: 'string', description: 'branch / tag / sha; defaults to the default branch.' },
      recursive: { type: 'boolean', description: 'tree: walk the entire tree (cap 1000 entries).' },
      maxBytes: { type: 'number', description: 'read: text clip threshold in bytes, default 65536.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: OBJ,
          dir: OBJ,
          error: OBJ,
        },
      },
      render: (_args, value) => {
        const lines = []
        if (value.error) lines.push(...fmtErr(value.error))
        else if (value.file) {
          const f = value.file
          if (f.encoding === 'binary') {
            lines.push(`🔒 ${f.path}（二进制，${f.size} 字节，不返回内容）`)
            if (f.htmlUrl) lines.push(f.htmlUrl)
          } else {
            lines.push(`📄 ${f.path}（${f.encoding}${f.truncated ? `，已截断至 ${f.bytes} 字节` : ''}，原始 ${f.size} 字节）`)
            lines.push('---')
            lines.push(f.content ?? '')
          }
        } else if (value.dir) {
          lines.push(`📁 ${value.dir.path}${value.dir.ref ? ` @${value.dir.ref}` : ''}（${value.dir.count} 项${value.dir.truncated ? '，已截断' : ''}${value.dir.note ? `，${value.dir.note}` : ''}）`)
          for (const e of value.dir.entries ?? []) {
            lines.push(`- ${e.type === 'dir' ? '📂' : '📄'} ${e.path ?? e.name}${e.size != null ? ` (${e.size})` : ''}`)
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
      const action = args.action || 'read'
      if (action === 'tree') {
        if (args.recursive) {
          const ref = args.ref || await defaultBranchOf(r.owner, r.repo, token)
          const res = await gh(withQuery(`/repos/${r.owner}/${r.repo}/git/trees/${encodeURIComponent(ref)}`, { recursive: 1 }), { token, signal })
          if (res.kind !== 'ok') return errFromGh(res)
          const all = Array.isArray(res.json?.tree) ? res.json.tree : []
          const entries = all.slice(0, TREE_ENTRY_CAP).map((t) => ({
            path: t.path,
            type: t.type === 'tree' ? 'dir' : t.type === 'blob' ? 'file' : t.type,
            size: t.type === 'blob' ? (t.size ?? null) : null,
          }))
          return {
            dir: {
              path: '/',
              ref,
              entries,
              count: entries.length,
              truncated: !!res.json?.truncated || all.length > TREE_ENTRY_CAP,
            },
          }
        }
        const dirPath = normalizePath(args.path || '/')
        const res = await gh(withQuery(`/repos/${r.owner}/${r.repo}/contents/${encPath(dirPath)}`, { ref: args.ref }), { token, signal })
        if (res.kind !== 'ok') return errFromGh(res)
        if (!Array.isArray(res.json)) {
          return invalidErr(`${dirPath} 是文件不是目录`, '用 action:"read" 读取内容；或 recursive:true 查看整棵树')
        }
        return {
          dir: {
            path: dirPath || '/',
            ref: args.ref ?? null,
            entries: res.json.map((e) => ({ path: e.path, type: e.type, size: e.type === 'file' ? (e.size ?? null) : null })),
            count: res.json.length,
            truncated: false,
          },
        }
      }
      const p = normalizePath(args.path || '')
      if (!p) return invalidErr('read 需要 path 参数')
      const base = withQuery(`/repos/${r.owner}/${r.repo}/contents/${encPath(p)}`, { ref: args.ref })
      const res = await gh(base, { token, signal })
      let meta = null
      let buffer = null
      if (res.kind === 'ok') {
        if (Array.isArray(res.json)) {
          return {
            dir: {
              path: p,
              ref: args.ref ?? null,
              entries: res.json.map((e) => ({ path: e.path, type: e.type, size: e.type === 'file' ? (e.size ?? null) : null })),
              count: res.json.length,
              truncated: false,
              note: '该路径是目录，已按目录返回',
            },
          }
        }
        meta = res.json
        buffer = Buffer.from(meta.content ?? '', 'base64')
      } else if (res.kind === 'http' && res.status === 403 && /too_large|larger than 1 mb/i.test(res.message)) {
        const raw = await ghRaw(base, 'application/vnd.github.raw', { token, signal })
        if (raw.kind !== 'ok') return errFromGh(raw)
        buffer = raw.buffer
        meta = { path: p, size: buffer.length, html_url: `https://github.com/${r.owner}/${r.repo}/blob/${args.ref || 'HEAD'}/${p}` }
      } else {
        return errFromGh(res)
      }
      const size = buffer.length
      if (buffer.includes(0)) {
        return { file: { path: meta.path ?? p, size, encoding: 'binary', truncated: false, bytes: size, content: null, htmlUrl: meta.html_url ?? null } }
      }
      const maxBytes = Number(args.maxBytes) > 0 ? Number(args.maxBytes) : cfg.maxFileBytes
      const text = buffer.toString('utf8')
      const clipped = clipText(text, maxBytes)
      return {
        file: {
          path: meta.path ?? p,
          size,
          encoding: clipped.truncated ? 'utf-8-truncated' : 'utf-8',
          truncated: clipped.truncated,
          bytes: Math.min(maxBytes, size),
          content: clipped.text,
          htmlUrl: meta.html_url ?? null,
        },
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `GitHub files ${args.action || 'read'}`, kind: 'read', rawInput: args }),
  }))

  // --- github_file_write ------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'github_file_write',
    description: 'Create, update, or delete a single file in a GitHub repository as one commit. Use for small '
      + 'single-file changes; for multi-file or bulk changes use github_sync (local clone + commit + push). '
      + 'Deleting requires confirm:true. Update/delete fetch the current file sha automatically.',
    parameters: {
      action: { type: 'string', required: true, description: 'create | update | delete.' },
      repo: { type: 'string', required: true, description: 'owner/repo or GitHub URL.' },
      path: { type: 'string', required: true, description: 'file path inside the repo.' },
      message: { type: 'string', required: true, description: 'commit message.' },
      content: { type: 'string', description: 'create/update: full file content (utf-8 text).' },
      branch: { type: 'string', description: 'target branch; defaults to the default branch.' },
      confirm: { type: 'boolean', description: 'must be true for delete.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          write: OBJ,
          error: OBJ,
        },
      },
      render: (_args, value) => {
        const lines = []
        if (value.error) lines.push(...fmtErr(value.error))
        else {
          const w = value.write
          lines.push(`✅ ${w.action} ${w.path}（${w.branch}）→ commit ${w.commitSha}`)
          if (w.htmlUrl) lines.push(w.htmlUrl)
        }
        const note = rateNote()
        if (note) lines.push(note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const gate = writeGate()
      if (gate) return gate
      const action = args.action
      if (!['create', 'update', 'delete'].includes(action)) {
        return invalidErr(`未知 action: ${action}`, '支持 create / update / delete')
      }
      if (action === 'delete' && args.confirm !== true) return confirmErr('删除文件')
      if (action !== 'delete' && (args.content === undefined || args.content === null)) {
        return invalidErr(`${action} 需要 content 参数`)
      }
      const token = await resolveToken()
      const signal = exec?.signal
      const r = repoParam(args, cfg.defaultRepo)
      if (r.error) return r
      const p = normalizePath(args.path)
      if (!p) return invalidErr('需要 path 参数')
      const enc = encPath(p)
      const branch = args.branch || null
      let head = null
      if (action !== 'create') {
        const g = await gh(withQuery(`/repos/${r.owner}/${r.repo}/contents/${enc}`, { ref: branch }), { token, signal })
        if (g.kind !== 'ok') {
          if (g.kind === 'http' && g.status === 404) {
            return invalidErr(`${p} 不存在（分支 ${branch ?? '默认'}）`, action === 'update' ? '新建文件请用 action:"create"' : undefined)
          }
          return errFromGh(g)
        }
        head = { sha: g.json.sha, htmlUrl: g.json.html_url }
      }
      const commit = { message: args.message, ...(branch ? { branch } : {}) }
      let res
      if (action === 'delete') {
        res = await gh(`/repos/${r.owner}/${r.repo}/contents/${enc}`, { method: 'DELETE', token, body: { ...commit, sha: head.sha }, signal })
      } else {
        if (action === 'create' && String(args.content).length === 0) {
          return invalidErr('create 的 content 不能为空', '要清空文件请用 update 传一个占位内容，或删除文件')
        }
        const payload = { ...commit, content: Buffer.from(String(args.content), 'utf8').toString('base64') }
        if (action === 'update') payload.sha = head.sha
        res = await gh(`/repos/${r.owner}/${r.repo}/contents/${enc}`, { method: 'PUT', token, body: payload, signal })
      }
      if (res.kind !== 'ok') return errFromGh(res)
      return {
        write: {
          action,
          path: p,
          branch: branch ?? '(default)',
          commitSha: sha7(res.json?.commit?.sha),
          htmlUrl: action === 'delete' ? (head?.htmlUrl ?? null) : (res.json?.content?.html_url ?? null),
        },
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `GitHub file ${args.action}`, kind: 'write', rawInput: args }),
  }))

  // expose the fmtErr-style helpers for sibling modules via env passthrough
  env.fmtErr = fmtErr
  env.confirmErr = confirmErr
  env.writeGate = writeGate
}
