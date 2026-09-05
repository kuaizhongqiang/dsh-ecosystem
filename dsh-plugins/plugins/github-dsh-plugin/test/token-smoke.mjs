/**
 * Authenticated smoke test for the tool-github plugin (GITHUB_TOKEN paths).
 *
 * Token resolution: process.env.GITHUB_TOKEN, else refs.GITHUB_TOKEN from
 * %DSH_HOME%\.credentials.yaml (parsed inline; the value is never printed).
 *
 * Usage: node token-smoke.mjs <path-to-plugin-index.js> <projectRoot-tmp>
 *
 * Network-write steps (push / file_write / pr / issue) run against
 * kuaizhongqiang/dsh-plugins on a dedicated smoke branch. Results are
 * classified: PASS / PERM (PAT permission missing — not a plugin bug) /
 * FAIL (plugin or test bug). Test artifacts: one remote branch, one closed
 * draft PR, one closed issue — all prefixed [smoke] / smoke/ and deletable.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [, , pluginPath, projectRoot] = process.argv

// --- token resolution (never printed) ---------------------------------------
let TOKEN = process.env.GITHUB_TOKEN || null
if (!TOKEN) {
  const credFile = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
  const m = readFileSync(credFile, 'utf8').match(/^\s{2}GITHUB_TOKEN:\s*(\S+)\s*$/m)
  if (m) TOKEN = m[1]
}
if (!TOKEN) {
  console.error('no GITHUB_TOKEN found (env or credentials file)')
  process.exit(2)
}
const scrub = (s) => String(s).replace(/github_pat_[A-Za-z0-9_]+/g, '***').split(TOKEN).join('***')

// --- plugin wiring ------------------------------------------------------------
const mod = await import(pathToFileURL(pluginPath).href)
const tools = []
process.env.GITHUB_TOKEN = TOKEN
mod.apply({ tools: { register: (t) => tools.push(t) }, get: () => undefined }, { projectRoot, workspaceRoot: join(projectRoot, 'global-ws') })
const byName = Object.fromEntries(tools.map((t) => [t.name, t]))

let failures = 0
let perms = 0
const pass = (label, detail) => console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`)
const ok = (label, cond, detail, r) => {
  if (cond) return pass(label, detail)
  const status = r?.error?.status
  const msg = r?.error ? scrub(r.error.message) : ''
  if (status === 403 || status === 401 || (status === 'git' && /denied|permission|403|authentication|must/i.test(msg))) {
    perms++
    console.log(`PERM  ${label} — PAT 权限不足: ${msg}`)
    return
  }
  failures++
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}
const run = async (name, args) => byName[name].execute(args, {})
const show = (r) => console.log('      ', scrub(JSON.stringify(r)).slice(0, 220))

// --- 1. identity & rate -------------------------------------------------------
const me = await run('github_repo', { action: 'me' })
show(me)
ok('me: login resolved', !!me?.me?.login, `login=${me?.me?.login}, kind=${me?.me?.tokenKind}`)
ok('me: authenticated rate (5000/h)', me?.me?.rate?.limit === 5000)
const remainingStart = me?.me?.rate?.remaining ?? 0

// --- 2. token-mode repo list ----------------------------------------------------
const list = await run('github_repo', { action: 'list', type: 'owner', perPage: 5 })
ok('repo list (token /user/repos)', Array.isArray(list?.repos) && list.repos.length > 0, `${list?.count} repos`)
show(list)

// --- 3. code search (token-only scope) ------------------------------------------
const code = await run('github_search', { scope: 'code', q: 'defineTool repo:kuaizhongqiang/dsh-plugins' })
ok('code search with token', Array.isArray(code?.results), `total=${code?.total}`)
show(code)

// --- 5. issues read (public repo) -----------------------------------------------
const issues = await run('github_issue', { action: 'list', repo: 'microsoft/vscode', perPage: 3 })
ok('issue list (per_page honored)', Array.isArray(issues?.issues) && issues.issues.length >= 1 && issues.issues.length <= 3, `count=${issues?.count}`)
const issueNo = issues?.issues?.[0]?.number
const issue = await run('github_issue', { action: 'get', repo: 'microsoft/vscode', number: issueNo, includeComments: true })
ok('issue get + comments', !!issue?.issue?.title, `#${issueNo}`, issue)
show(issue)

// --- 6. PRs read (public repo) -----------------------------------------------------
const pulls = await run('github_pr', { action: 'list', repo: 'microsoft/vscode', perPage: 3 })
ok('pr list (per_page honored)', Array.isArray(pulls?.pulls) && pulls.pulls.length >= 1 && pulls.pulls.length <= 3, `count=${pulls?.count}`)
const prNo = pulls?.pulls?.[0]?.number
const pr = await run('github_pr', { action: 'get', repo: 'microsoft/vscode', number: prNo, diff: true })
ok('pr get + diff (clipped)', typeof pr?.pull?.diff === 'string' && pr.pull.diff.length > 0, `#${prNo}`, pr)
show(pr)

// --- 7. write path on kuaizhongqiang/dsh-plugins --------------------------------------
const REPO = 'kuaizhongqiang/dsh-plugins'
const branch = `smoke/tool-github-${Math.floor(Date.now() / 1000)}`

const clone = await run('github_sync', { subcommand: 'clone', repo: REPO, scope: 'project', projectRoot })
ok('sync clone', !!clone?.sync?.path)
if (!clone?.sync?.path) { console.log('abort: no clone'); process.exit(1) }
const dir = clone.sync.path

await run('github_sync', { subcommand: 'branch', path: dir, name: branch, create: true })
const smokeFile = join(dir, 'SMOKE.md')
writeFileSync(smokeFile, `tool-github token smoke ${new Date().toISOString()}\n`)
const commit = await run('github_sync', { subcommand: 'commit', path: dir, message: 'test: tool-github token smoke' })
ok('sync commit (identity+trailer)', !!commit?.sync?.sha7 && /Co-authored-by: coworker \(DeepSeek Harness GLM\)/.test(commit.sync.message))
show(commit)

const push = await run('github_sync', { subcommand: 'push', path: dir, confirm: true })
ok('sync push (token extraheader)', push?.sync?.sub === 'push', `prHint=${push?.sync?.prHintUrl ?? 'n/a'}`, push)
show(push)

if (push?.sync?.sub === 'push') {
  const w1 = await run('github_file_write', { action: 'create', repo: REPO, path: 'SMOKE-API.md', message: 'test: api create', content: '# smoke\n', branch })
  ok('file_write create (api)', !!w1?.write?.commitSha, `branch=${branch}`, w1)
  if (w1?.write?.commitSha) {
    const w2 = await run('github_file_write', { action: 'update', repo: REPO, path: 'SMOKE-API.md', message: 'test: api update', content: '# smoke v2\n', branch })
    ok('file_write update (api)', !!w2?.write?.commitSha, undefined, w2)
    const w3 = await run('github_file_write', { action: 'delete', repo: REPO, path: 'SMOKE-API.md', message: 'test: api delete', branch, confirm: true })
    ok('file_write delete (api)', !!w3?.write?.commitSha, undefined, w3)
  }

  const prNew = await run('github_pr', { action: 'create', repo: REPO, title: '[smoke] tool-github token test (可删除)', head: branch, base: 'main', body: 'token smoke test PR — safe to close & delete.', draft: true })
  ok('pr create (draft, no number needed)', !!prNew?.pull?.number, `#${prNew?.pull?.number}`, prNew)
  show(prNew)
  if (prNew?.pull?.number) {
    const prGet = await run('github_pr', { action: 'get', repo: REPO, number: prNew.pull.number, diff: true })
    ok('pr get (own repo, diff)', typeof prGet?.pull?.diff === 'string', undefined, prGet)
    const prClose = await run('github_pr', { action: 'close', repo: REPO, number: prNew.pull.number })
    ok('pr close', prClose?.pull?.state === 'closed', undefined, prClose)
  }
}

const issNew = await run('github_issue', { action: 'create', repo: REPO, title: '[smoke] tool-github token test (可删除)', body: 'token smoke test issue — safe to delete.' })
ok('issue create (no number needed)', !!issNew?.issue?.number, `#${issNew?.issue?.number}`, issNew)
if (issNew?.issue?.number) {
  const c = await run('github_issue', { action: 'comment', repo: REPO, number: issNew.issue.number, body: 'smoke comment' })
  ok('issue comment', !!c?.comment?.htmlUrl, undefined, c)
  const cl = await run('github_issue', { action: 'close', repo: REPO, number: issNew.issue.number, comment: 'smoke done' })
  ok('issue close (+parting comment)', cl?.issue?.state === 'closed', undefined, cl)
}

// --- 8. rate after ------------------------------------------------------------------
const me2 = await run('github_repo', { action: 'me' })
ok('rate budget sane', (me2?.me?.rate?.remaining ?? 0) <= remainingStart && me2?.me?.rate?.remaining !== null, `remaining=${me2?.me?.rate?.remaining}`)

console.log(`\nRESULT: ${failures} plugin/test bug(s), ${perms} permission-gated item(s)`)
console.log(failures === 0 ? 'PLUGIN SIDE ALL GREEN' : 'PLUGIN BUGS REMAIN')
process.exit(failures === 0 ? 0 : 1)
