/**
 * GitHub REST layer + shared helpers for the tool-github plugin.
 *
 * `createCore` wires a fetch wrapper around api.github.com (or a GHES base),
 * unified error normalization with actionable hints, rate-limit tracking, and
 * the small text/query utilities every tool module shares.
 */

const API_VERSION = '2022-11-28'
const USER_AGENT = 'dsh-tool-github'
const BODY_CLIP = 2_000

/**
 * Build the shared HTTP/toolkit surface.
 * @param {object} options
 * @param {string} options.apiBase - API root, no trailing slash.
 * @param {number} options.timeoutMs - per-request timeout.
 * @param {() => Promise<string|null>} options.getToken - credentials seam resolver.
 */
export function createCore({ apiBase, timeoutMs, getToken }) {
  const rate = { remaining: null, limit: null, resetAt: null }

  const trackRate = (headers) => {
    const remaining = headers.get('x-ratelimit-remaining')
    const limit = headers.get('x-ratelimit-limit')
    const reset = headers.get('x-ratelimit-reset')
    if (remaining !== null) rate.remaining = Number(remaining)
    if (limit !== null) rate.limit = Number(limit)
    if (reset !== null) rate.resetAt = new Date(Number(reset) * 1000).toISOString()
  }

  /** Warning line appended to renders when the rate budget runs low. */
  const rateNote = () => (rate.remaining !== null && rate.remaining < 20
    ? `⚠ GitHub API rate: ${rate.remaining}/${rate.limit ?? '?'} remaining, resets ${rate.resetAt ?? '?'}`
    : '')

  /**
   * JSON API call. Never throws: returns a discriminated result.
   * @returns {Promise<{kind:'ok', json:any, headers:Headers}|{kind:'http', status:number, message:string}|{kind:'network', message:string}>}
   */
  const gh = async (path, { method = 'GET', body, token, signal } = {}) => {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
    }
    if (token) headers.Authorization = `Bearer ${token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(new Error(`GitHub API timed out after ${timeoutMs}ms`)), timeoutMs)
    const composed = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
    let res
    try {
      res = await fetch(`${apiBase}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: composed,
      })
    } catch (e) {
      return { kind: 'network', message: e?.message ?? String(e) }
    } finally {
      clearTimeout(timer)
    }
    trackRate(res.headers)
    if (!res.ok) {
      let message = `HTTP ${res.status}`
      try {
        const parsed = await res.json()
        if (parsed && typeof parsed.message === 'string') message = parsed.message
      } catch { /* non-JSON error body */ }
      return { kind: 'http', status: res.status, message }
    }
    const text = await res.text()
    let json = null
    if (text) {
      try { json = JSON.parse(text) } catch { json = text }
    }
    return { kind: 'ok', json, headers: res.headers }
  }

  /**
   * Raw-body API call (diffs, raw file contents). Returns a Buffer.
   * @returns {Promise<{kind:'ok', buffer:Buffer}|{kind:'http', status:number, message:string}|{kind:'network', message:string}>}
   */
  const ghRaw = async (path, accept, { token, signal } = {}) => {
    const headers = { Accept: accept, 'User-Agent': USER_AGENT }
    if (token) headers.Authorization = `Bearer ${token}`
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(new Error(`GitHub API timed out after ${timeoutMs}ms`)), timeoutMs)
    const composed = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
    let res
    try {
      res = await fetch(`${apiBase}${path}`, { headers, signal: composed })
    } catch (e) {
      return { kind: 'network', message: e?.message ?? String(e) }
    } finally {
      clearTimeout(timer)
    }
    trackRate(res.headers)
    if (!res.ok) {
      let message = `HTTP ${res.status}`
      try {
        const parsed = await res.json()
        if (parsed && typeof parsed.message === 'string') message = parsed.message
      } catch { /* raw error body */ }
      return { kind: 'http', status: res.status, message }
    }
    return { kind: 'ok', buffer: Buffer.from(await res.arrayBuffer()) }
  }

  const hintFor = (status, message) => {
    const msg = message ?? ''
    if (status === 401) return 'token 无效或权限不足；fine-grained PAT 需勾选目标仓库与对应权限'
    if (status === 403) {
      return /rate limit/i.test(msg)
        ? 'API 限流，稍后再试；配置 GITHUB_TOKEN 可提升到 5000 次/时'
        : '权限不足；检查 token 权限或仓库可见性'
    }
    if (status === 404) return '资源不存在；若为私有仓库，请先用 credentials_set 配置 GITHUB_TOKEN'
    if (status === 422) return '请求被拒绝；常见原因是文件已存在（需 sha）或参数不合法'
    if (status === 429) return '请求过于频繁，稍后再试'
    return null
  }

  const errOf = (status, message, hint) => ({
    error: { status, message, ...(hint ?? hintFor(status, message) ? { hint: hint ?? hintFor(status, message) } : {}) },
  })
  const errFromGh = (res) => (res.kind === 'network' ? networkErr(res.message) : errOf(res.status, res.message))
  const networkErr = (message) => ({ error: { status: 'network', message, hint: '检查网络连接后重试' } })
  const noTokenErr = (what) => ({
    error: {
      status: 'no-token',
      message: `${what} 需要 GITHUB_TOKEN（匿名模式不可用）`,
      hint: '通过 credentials_set 配置 GITHUB_TOKEN 后重试',
    },
  })
  const invalidErr = (message, hint) => ({ error: { status: 'invalid', message, ...(hint ? { hint } : {}) } })

  const withQuery = (path, params) => {
    const usp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') usp.set(k, String(v))
    }
    const qs = usp.toString()
    return qs ? `${path}?${qs}` : path
  }

  const clipText = (text, max = BODY_CLIP) => {
    const s = typeof text === 'string' ? text : ''
    return s.length <= max ? { text: s, truncated: false } : { text: s.slice(0, max), truncated: true }
  }

  const clipLines = (text, maxLines, maxChars = 50_000) => {
    const s = typeof text === 'string' ? text : ''
    const lines = s.split('\n')
    if (lines.length <= maxLines && s.length <= maxChars) return { text: s, truncated: false }
    return { text: lines.slice(0, maxLines).join('\n').slice(0, maxChars), truncated: true }
  }

  const sha7 = (sha) => (typeof sha === 'string' && sha.length > 7 ? sha.slice(0, 7) : sha ?? '')
  const csv = (s) => (typeof s === 'string' && s.trim() ? s.split(',').map((x) => x.trim()).filter(Boolean) : [])

  /** Accept `owner/repo`, a github.com URL (…/tree/… suffix tolerated), or fall back. */
  const resolveRepo = (input, fallback = '') => {
    const raw = String(input ?? fallback ?? '').trim()
    if (!raw) return null
    const stripped = raw
      .replace(/^https?:\/\/[^/]+\//i, '')
      .replace(/[?#].*$/, '')
      .replace(/\.git$/i, '')
    const parts = stripped.split('/').map((s) => s.trim()).filter(Boolean)
    if (parts.length < 2) return null
    return { owner: parts[0], repo: parts[1] }
  }

  /** repo args → {owner, repo} | {error} */
  const repoParam = (args, fallback) => {
    const r = resolveRepo(args.repo, fallback)
    if (r) return r
    return invalidErr(
      `无法从 "${args.repo ?? ''}" 解析仓库；支持 owner/repo 或完整 GitHub URL`,
      fallback ? `也可省略 repo 参数（当前默认 ${fallback}）` : '或在 cordis.patch.yml 的 config.defaultRepo 配置默认仓库',
    )
  }

  let loginCache = { value: undefined, at: 0 }
  const loginOf = async (token) => {
    if (!token) return null
    if (loginCache.value !== undefined && Date.now() - loginCache.at < 300_000) return loginCache.value
    const res = await gh('/user', { token })
    loginCache = { value: res.kind === 'ok' ? (res.json?.login ?? null) : null, at: Date.now() }
    return loginCache.value
  }

  const defaultBranchCache = new Map()
  const defaultBranchOf = async (owner, repo, token) => {
    const key = `${owner}/${repo}`
    if (defaultBranchCache.has(key)) return defaultBranchCache.get(key)
    const res = await gh(`/repos/${owner}/${repo}`, { token })
    const branch = res.kind === 'ok' ? res.json?.default_branch ?? 'main' : 'main'
    defaultBranchCache.set(key, branch)
    return branch
  }

  return {
    rate,
    trackRate,
    rateNote,
    gh,
    ghRaw,
    errOf,
    errFromGh,
    networkErr,
    noTokenErr,
    invalidErr,
    withQuery,
    clipText,
    clipLines,
    sha7,
    csv,
    resolveRepo,
    repoParam,
    loginOf,
    defaultBranchOf,
  }
}
