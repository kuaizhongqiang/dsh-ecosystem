/**
 * Smoke test for the tool-github plugin (run outside dsh, mock registry).
 * Usage: node dsh-github-smoke.mjs <path-to-plugin-index.js> <projectRoot-tmp>
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const [, , pluginPath, projectRoot] = process.argv
const mod = await import(pathToFileURL(pluginPath).href)

const tools = []
const ctx = { tools: { register: (t) => tools.push(t) }, get: () => undefined }
mod.apply(ctx, { projectRoot, workspaceRoot: join(projectRoot, 'global-ws') })

const names = tools.map((t) => t.name)
console.log('registered:', names.join(', '))
if (names.length !== 8) throw new Error(`expected 8 tools, got ${names.length}`)

const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
const renderOf = (name, args, value) => {
  try { return byName[name].output.render(args, value)[0]?.text.slice(0, 200) } catch { return '(render failed)' }
}
const run = async (label, name, args) => {
  const r = await byName[name].execute(args, {})
  const ok = !r?.error
  console.log(`\n=== [${ok ? 'OK' : 'ERR'}] ${label} (${name}) ===`)
  console.log(JSON.stringify(r).slice(0, 500))
  console.log('render>', renderOf(name, args, r)?.split('\n')[0])
  return r
}

// 1. repo get on a small public repo (anonymous)
await run('repo get public', 'github_repo', { repo: 'octocat/Hello-World' })

// 2. repo me (anonymous)
await run('repo me anonymous', 'github_repo', { action: 'me' })

// 3. files read
await run('files read README', 'github_files', { repo: 'octocat/Hello-World', path: 'README' })

// 4. files tree
await run('files tree root', 'github_files', { repo: 'octocat/Hello-World', action: 'tree', path: '/' })

// 5. commits list
await run('commits list', 'github_commit', { repo: 'octocat/Hello-World', perPage: 3 })

// 6. search repos
await run('search repos', 'github_search', { scope: 'repos', q: 'hello-world user:octocat' })

// 7. file_write missing content -> structured invalid-arg error
await run('file_write missing content', 'github_file_write', { action: 'create', repo: 'octocat/Hello-World', path: 'x.txt', message: 'x' })

// 9. sync: clone (project scope), status, branch, commit, list — local git only
const cloneRes = await run('sync clone project scope', 'github_sync', { subcommand: 'clone', repo: 'octocat/Hello-World', scope: 'project', projectRoot })
const clonePath = cloneRes?.sync?.path
if (!clonePath) throw new Error('clone failed')

await run('sync status', 'github_sync', { subcommand: 'status', path: clonePath })
await run('sync branch create', 'github_sync', { subcommand: 'branch', path: clonePath, name: 'smoke-test', create: true })

const { writeFileSync } = await import('node:fs')
writeFileSync(join(clonePath, 'SMOKE.md'), `smoke ${new Date().toISOString()}\n`)
const commitRes = await run('sync commit', 'github_sync', { subcommand: 'commit', path: clonePath, message: 'smoke test commit' })
if (!commitRes?.sync?.sha7) throw new Error('commit failed')

// dirty-worktree guard: modify + try pull
writeFileSync(join(clonePath, 'SMOKE.md'), 'dirty\n')
const pullRes = await run('sync pull on dirty', 'github_sync', { subcommand: 'pull', path: clonePath })
if (pullRes?.error?.status !== 'dirty-worktree') throw new Error('expected dirty-worktree rejection')

// push confirm gate (no confirm -> error, no network)
const pushRes = await run('sync push no confirm', 'github_sync', { subcommand: 'push', path: clonePath })
if (pushRes?.error?.status !== 'confirm-required') throw new Error('expected confirm-required gate')

await run('sync list', 'github_sync', { subcommand: 'list', projectRoot })

console.log('\nALL SMOKE CHECKS PASSED')
