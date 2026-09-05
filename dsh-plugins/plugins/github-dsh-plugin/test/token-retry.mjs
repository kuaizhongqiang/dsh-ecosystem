/**
 * Focused retry for permission-gated items after a PAT permission edit.
 * Reuses the existing local clone + smoke branch + issue #1 — no new artifacts.
 * Usage: node token-retry.mjs <plugin-index.js> <local-clone-dir> <issue-number>
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [, , pluginPath, cloneDir, issueNoArg] = process.argv

let TOKEN = process.env.GITHUB_TOKEN || null
if (!TOKEN) {
  const credFile = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
  const m = readFileSync(credFile, 'utf8').match(/^\s{2}GITHUB_TOKEN:\s*(\S+)\s*$/m)
  if (m) TOKEN = m[1]
}
const scrub = (s) => String(s).replace(/github_pat_[A-Za-z0-9_]+/g, '***').split(TOKEN).join('***')

const mod = await import(pathToFileURL(pluginPath).href)
const tools = []
process.env.GITHUB_TOKEN = TOKEN
mod.apply({ tools: { register: (t) => tools.push(t) }, get: () => undefined }, { projectRoot: process.env.TEMP, workspaceRoot: join(process.env.TEMP, 'global-ws') })
const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
const run = async (name, args) => byName[name].execute(args, {})
const line = (label, r) => console.log(`${r?.error ? 'STILL-403' : 'PASS    '}  ${label}  ${scrub(JSON.stringify(r)).slice(0, 160)}`)

const issueNo = Number(issueNoArg)
const REPO = 'kuaizhongqiang/dsh-plugins'

const push = await run('github_sync', { subcommand: 'push', path: cloneDir, confirm: true })
line('sync push', push)
if (push?.sync?.sub === 'push') {
  const branch = push.sync.branch
  const w1 = await run('github_file_write', { action: 'create', repo: REPO, path: 'SMOKE-API.md', message: 'test: api create', content: '# smoke\n', branch })
  line(`file_write create @${branch}`, w1)
  if (w1?.write?.commitSha) {
    line('file_write update', await run('github_file_write', { action: 'update', repo: REPO, path: 'SMOKE-API.md', message: 'test: api update', content: '# smoke v2\n', branch }))
    line('file_write delete', await run('github_file_write', { action: 'delete', repo: REPO, path: 'SMOKE-API.md', message: 'test: api delete', branch, confirm: true }))
  }
  const prNew = await run('github_pr', { action: 'create', repo: REPO, title: '[smoke] tool-github token test (可删除)', head: branch, base: 'main', body: 'token smoke test PR — safe to close & delete.', draft: true })
  line('pr create (draft)', prNew)
  if (prNew?.pull?.number) {
    const prGet = await run('github_pr', { action: 'get', repo: REPO, number: prNew.pull.number, diff: true })
    line(`pr get #${prNew.pull.number} (diff)`, prGet?.pull?.diff !== undefined ? { ok: true, diffLen: prGet.pull.diff?.length, files: prGet.pull.files?.length } : prGet)
    line(`pr close #${prNew.pull.number}`, await run('github_pr', { action: 'close', repo: REPO, number: prNew.pull.number }))
  }
}

if (issueNo) {
  line(`issue comment #${issueNo}`, await run('github_issue', { action: 'comment', repo: REPO, number: issueNo, body: 'smoke comment' }))
  line(`issue close #${issueNo}`, await run('github_issue', { action: 'close', repo: REPO, number: issueNo, comment: 'smoke done' }))
}
