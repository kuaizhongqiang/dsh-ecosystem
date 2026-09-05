/**
 * Local git integration for `github_sync` in the tool-github plugin.
 *
 * The token is injected per invocation through `http.https://github.com/.extraheader`
 * so it never lands in `.git/config` or a credential helper. All git output is
 * sanitized (token patterns + the exact base64 header) before it reaches the
 * model, and interactive prompts are disabled to avoid hangs.
 */

import { existsSync, readdirSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const STATUS_ENTRY_CAP = 50
const SYNC_LIST_CAP = 50

/**
 * Build the git toolkit.
 * @param {object} core - toolkit from createCore().
 * @param {object} opts
 * @param {() => Promise<string|null>} opts.getToken
 * @param {string} opts.gitUserName - configured commit name ('' = derive).
 * @param {string} opts.gitUserEmail - configured commit email ('' = derive).
 * @param {string} opts.coworkerName - Co-authored-by name.
 * @param {string} opts.coworkerEmail - Co-authored-by email.
 * @param {string} opts.workspaceRoot - global scope root ('' = %DSH_HOME%\github).
 * @param {string} opts.projectRoot - project scope root ('' = required per call).
 */
export function createGitKit(core, { getToken, gitUserName, gitUserEmail, coworkerName, coworkerEmail, workspaceRoot, projectRoot }) {
  const { errOf, invalidErr } = core

  const TOKEN_PATTERNS = [/gh[pousr]_[A-Za-z0-9]{16,}/g, /github_pat_[A-Za-z0-9_]{20,}/g]

  const sanitize = (text, token) => {
    let out = String(text ?? '')
    for (const re of TOKEN_PATTERNS) out = out.replace(re, '***')
    if (token) {
      out = out.split(token).join('***')
      out = out.split(Buffer.from(`x-access-token:${token}`).toString('base64')).join('***')
    }
    return out
  }

  const authHeaderOf = (token) => (token
    ? `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
    : null)

  /** Run git with optional per-invocation auth; resolves {code, out, err} (sanitized). */
  const runGit = (gitArgs, { cwd, token } = {}) => new Promise((done) => {
    const finalArgs = [...gitArgs]
    const auth = authHeaderOf(token)
    if (auth) finalArgs.unshift('-c', `http.https://github.com/.extraheader=${auth}`)
    let child
    try {
      child = spawn('git', finalArgs, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        windowsHide: true,
      })
    } catch (e) {
      done({ code: -1, out: '', err: sanitize(String(e), token) })
      return
    }
    let out = ''
    let err = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      done({ code: code ?? -1, out, err: sanitize(err, token) })
    }
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', (e) => { err += String(e); finish(-1) })
    child.on('close', (code) => finish(code))
  })

  const gitErrOf = (r, what) => {
    const detail = (r.err || r.out).trim()
    if (r.code === -1 && /enoent|not recognized|cannot find/i.test(detail)) {
      return { error: { status: 'git-missing', message: 'git 不可用（未安装或不在 PATH）', hint: '安装 Git for Windows 后重试' } }
    }
    return errOf('git', `${what}失败（exit ${r.code}）：${detail.slice(0, 2000) || '无输出'}`)
  }

  /** Commit identity: config wins, else GitHub login, else neutral fallback. */
  const gitIdentity = async () => {
    let name = gitUserName
    if (!name) {
      const token = await getToken()
      const login = await core.loginOf(token)
      name = login ?? 'dsh'
    }
    const email = gitUserEmail || (name.includes('@') ? name : `${name}@users.noreply.github.com`)
    return { name, email }
  }

  /** Append the AI-coworker Co-authored-by trailer unless already present. */
  const withCoAuthor = (message) => (/co-authored-by:/i.test(message)
    ? message
    : `${message.trimEnd()}\n\nCo-authored-by: ${coworkerName} <${coworkerEmail}>`)

  /** Parse `git status --porcelain=v1 -b` output. */
  const parseStatus = (porcelain) => {
    let header = ''
    const staged = []
    const modified = []
    const untracked = []
    for (const line of porcelain.split('\n')) {
      if (!line.trim()) continue
      if (line.startsWith('## ')) { header = line.slice(3); continue }
      const file = line.slice(3).trim()
      if (line.startsWith('??')) { untracked.push(file); continue }
      const x = line[0]
      const y = line[1]
      if (x && x !== ' ' && x !== '?') staged.push(file)
      if (y && y !== ' ' && y !== '?') modified.push(file)
    }
    let branch = ''
    let ahead = 0
    let behind = 0
    const m = header.match(/^(\S+?)(?:\.{3}\S+)?(?:\s+\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?\s*$/)
    if (m) {
      branch = m[1]
      ahead = Number(m[2] ?? 0)
      behind = Number(m[3] ?? 0)
    }
    const cap = (list) => (list.length > STATUS_ENTRY_CAP ? { files: list.slice(0, STATUS_ENTRY_CAP), truncated: true } : { files: list, truncated: false })
    return {
      branch,
      ahead,
      behind,
      staged: cap(staged),
      modified: cap(modified),
      untracked: cap(untracked),
      dirty: staged.length + modified.length > 0,
    }
  }

  /** Full status of a local repo dir → parsed fields | {error}. */
  const statusOf = async (dir, token) => {
    const br = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, token })
    if (br.code !== 0) return { error: gitErrOf(br, '读取分支') }
    const porcelain = await runGit(['status', '--porcelain=v1', '-b'], { cwd: dir, token })
    if (porcelain.code !== 0) return { error: gitErrOf(porcelain, '读取状态') }
    const sha = await runGit(['rev-parse', '--short=7', 'HEAD'], { cwd: dir, token })
    return { ...parseStatus(porcelain.out), sha7: sha.code === 0 ? sha.out.trim() : '' }
  }

  const globalRoot = () => workspaceRoot || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'github')

  const projectRootOf = (argValue) => {
    const p = String(argValue || projectRoot || '').trim()
    return p ? resolve(p) : null
  }

  /**
   * Resolve the local dir for a sync call: explicit `path` wins, else
   * `<root>/<owner>/<repo>` under the requested scope.
   */
  const syncDirFor = (args, repoParamFn) => {
    if (args.path) {
      const p = resolve(String(args.path).trim())
      if (!existsSync(p)) return invalidErr(`本地路径不存在: ${p}`)
      return { dir: p }
    }
    const r = repoParamFn(args)
    if (r.error) return r
    const scope = args.scope === 'project' ? 'project' : 'global'
    let root
    if (scope === 'global') {
      root = globalRoot()
    } else {
      const pr = projectRootOf(args.projectRoot)
      if (!pr) {
        return invalidErr(
          'project scope 需要 projectRoot：在 cordis.patch.yml 配置 config.projectRoot，或调用时传 projectRoot 参数（当前项目目录）',
        )
      }
      root = join(pr, '.dsh-github')
    }
    return { dir: join(root, r.owner, r.repo), root, owner: r.owner, repo: r.repo, scope }
  }

  /** Enumerate owner/repo dirs under a workspace root, with current branches. */
  const scanRoot = async (root, scope) => {
    const repos = []
    const out = { scope, root: root ?? null, repos }
    if (!root || !existsSync(root)) return out
    let owners = []
    try {
      owners = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      return out
    }
    for (const owner of owners) {
      const ownerDir = join(root, owner)
      let names = []
      try {
        names = readdirSync(ownerDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      } catch {
        continue
      }
      for (const name of names) {
        if (repos.length >= SYNC_LIST_CAP) { out.truncated = true; return out }
        const dir = join(ownerDir, name)
        const st = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
        repos.push({ name: `${owner}/${name}`, branch: st.code === 0 ? st.out.trim() : null })
      }
    }
    return out
  }

  /** Ensure the parent dir of a clone target exists. */
  const ensureParent = (dir) => {
    mkdirSync(dir, { recursive: true })
  }

  return {
    runGit,
    gitErrOf,
    sanitize,
    gitIdentity,
    withCoAuthor,
    parseStatus,
    statusOf,
    globalRoot,
    projectRootOf,
    syncDirFor,
    scanRoot,
    ensureParent,
  }
}
