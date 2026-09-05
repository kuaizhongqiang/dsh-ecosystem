/**
 * `github_sync` — local workspace synchronization for tool-github.
 *
 * Subcommands: list / clone / status / pull / branch / commit / push.
 * Workspaces are separated by scope (global vs project, see createGitKit).
 * After a clone the tool returns the local path so the agent can edit files
 * with its regular file tools, then commit + push back through this tool.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

const OUTPUT_TAIL = 2_000

/** Loose schema nodes (the harness demands explicit additionalProperties). */
const OBJ = { type: 'object', additionalProperties: true }

/**
 * Register github_sync.
 * @param {object} ctx - registrant context carrying the tool registry.
 * @param {object} env - shared plugin environment (cfg, core helpers, git kit).
 */
export function register(ctx, env) {
  const { errOf, invalidErr, sha7, csv, clipText, repoParam, defaultBranchOf, resolveToken } = env
  const git = env.git
  const cfg = env.cfg

  const fmtErr = (e) => [`❌ [${e.status}] ${e.message}`, ...(e.hint ? [`💡 ${e.hint}`] : [])]
  const confirmErr = (what) => errOf('confirm-required', `${what}属于破坏性操作，必须显式传 confirm: true`)
  const writeGate = () => (cfg.allowWrite ? null : errOf('forbidden', '插件处于只读模式（config.allowWrite: false）'))

  /** owner/repo from the origin remote URL, or null. */
  const remoteOwnerRepo = async (dir) => {
    const r = await git.runGit(['remote', 'get-url', 'origin'], { cwd: dir })
    if (r.code !== 0) return null
    const m = String(r.out).trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
    return m ? { owner: m[1], repo: m[2] } : null
  }

  const tail = (r) => clipText((r.out || r.err || '').trim().split('\n').slice(-8).join('\n'), OUTPUT_TAIL).text

  // --- github_sync ------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'github_sync',
    description: 'Local GitHub workspace synchronization. clone a repo into the workspace (global scope under '
      + '%DSH_HOME%\\github, project scope under <projectRoot>\\.dsh-github — pass projectRoot for project scope), '
      + 'then edit files locally with the regular file tools and commit/push back. status shows branch/ahead/behind/'
      + 'changes; pull is fast-forward only and refuses dirty worktrees; commit takes a message and add strategy '
      + '(all | staged | comma-separated paths); push requires confirm:true. Force push and remote branch deletion '
      + 'are not supported.',
    timeoutMs: 120_000,
    parameters: {
      subcommand: { type: 'string', required: true, description: 'list | clone | status | pull | branch | commit | push.' },
      repo: { type: 'string', description: 'owner/repo or GitHub URL (clone; others when path is omitted).' },
      path: { type: 'string', description: 'explicit local repo path (overrides repo/scope).' },
      scope: { type: 'string', description: 'global (default) | project.' },
      projectRoot: { type: 'string', description: 'project scope root; defaults to config.projectRoot.' },
      ref: { type: 'string', description: 'clone: branch/tag to check out.' },
      depth: { type: 'number', description: 'clone: shallow clone depth.' },
      name: { type: 'string', description: 'branch: branch name to switch to.' },
      create: { type: 'boolean', description: 'branch: create the branch first (checkout -b).' },
      from: { type: 'string', description: 'branch: start point for a new branch.' },
      message: { type: 'string', description: 'commit: commit message (required).' },
      add: { type: 'string', description: 'commit: all (default) | staged | comma-separated paths.' },
      branch: { type: 'string', description: 'push: branch to push; defaults to the current one.' },
      confirm: { type: 'boolean', description: 'push: must be true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sync: OBJ,
          error: OBJ,
        },
      },
      render: (_args, value) => {
        const lines = []
        if (value.error) {
          lines.push(...fmtErr(value.error))
        } else {
          const s = value.sync
          if (s.sub === 'list') {
            for (const sc of s.scopes) {
              lines.push(`[${sc.scope}] ${sc.root ?? '(未配置)'}${sc.note ? ` — ${sc.note}` : ''}`)
              for (const r of sc.repos) lines.push(`  - ${r.name} @${r.branch ?? '?'}`)
              if (sc.truncated) lines.push('  …(已截断)')
            }
          } else if (s.sub === 'clone') {
            lines.push(`✅ clone 完成: ${s.url}`)
            lines.push(`本地路径: ${s.path}（分支 ${s.branch}）`)
            lines.push('可直接用文件工具编辑该目录，改完用 github_sync commit/push 提交。')
          } else if (s.sub === 'status') {
            lines.push(`${s.path} — 分支 ${s.branch}${s.sha7 ? ` @${s.sha7}` : ''}，ahead ${s.ahead} / behind ${s.behind}`)
            const dump = (label, entry) => {
              if (entry.files.length) lines.push(`${label}: ${entry.files.join(', ')}${entry.truncated ? ' …' : ''}`)
            }
            dump('已暂存', s.staged)
            dump('已修改', s.modified)
            dump('未跟踪', s.untracked)
            if (!s.staged.files.length && !s.modified.files.length && !s.untracked.files.length) lines.push('工作区干净')
          } else if (s.sub === 'pull') {
            lines.push(`✅ pull 完成: ${s.path}（${s.branch}，ahead ${s.ahead} / behind ${s.behind}）${s.upToDate ? ' — 已是最新' : ''}`)
            if (s.output) lines.push(s.output)
          } else if (s.sub === 'branch') {
            lines.push(`✅ 分支切换: ${s.path} → ${s.branch}${s.created ? '（新建）' : ''}`)
          } else if (s.sub === 'commit') {
            lines.push(`✅ commit ${s.sha7} @${s.branch}（${s.path}）`)
            lines.push(`信息: ${s.message.split('\n')[0]}`)
            if (s.files?.length) lines.push(`文件: ${s.files.join(', ')}`)
          } else if (s.sub === 'push') {
            lines.push(`✅ push 完成: ${s.branch} → origin（${s.path}）`)
            if (s.prHintUrl) lines.push(`创建 PR: ${s.prHintUrl}`)
            if (s.compareUrl) lines.push(`对比: ${s.compareUrl}`)
            if (s.output) lines.push(s.output)
          }
        }
        const note = env.rateNote ? env.rateNote() : ''
        if (note) lines.push(note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const token = await resolveToken()
      const sub = args.subcommand
      const known = ['list', 'clone', 'status', 'pull', 'branch', 'commit', 'push']
      if (!known.includes(sub)) {
        return invalidErr(`未知 subcommand: ${sub}`, `支持 ${known.join(' / ')}`)
      }
      if (sub === 'list') {
        const scopes = [await git.scanRoot(git.globalRoot(), 'global')]
        const pr = git.projectRootOf(args.projectRoot)
        if (pr) scopes.push(await git.scanRoot(join(pr, '.dsh-github'), 'project'))
        else scopes.push({ scope: 'project', root: null, repos: [], note: 'projectRoot 未配置（config.projectRoot 或调用参数 projectRoot）' })
        return { sync: { sub, scopes } }
      }
      if (sub === 'clone') {
        const gate = writeGate()
        if (gate) return gate
        const target = git.syncDirFor(args, (a) => repoParam(a, cfg.defaultRepo))
        if (target.error) return target
        if (existsSync(target.dir) && existsSync(join(target.dir, '.git'))) {
          return invalidErr(`${target.dir} 已存在`, '用 subcommand:"status" 查看，或 subcommand:"pull" 更新')
        }
        git.ensureParent(target.root ?? target.dir)
        const url = `https://github.com/${target.owner}/${target.repo}.git`
        const cloneArgs = ['clone']
        if (Number(args.depth) > 0) cloneArgs.push('--depth', String(Math.floor(Number(args.depth))))
        if (args.ref) cloneArgs.push('--branch', String(args.ref))
        cloneArgs.push(url, target.dir)
        const r = await git.runGit(cloneArgs, { cwd: target.root, token })
        if (r.code !== 0) return git.gitErrOf(r, 'clone ')
        const br = await git.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target.dir })
        return { sync: { sub, path: target.dir, url, branch: br.code === 0 ? br.out.trim() : (args.ref ?? null), scope: target.scope } }
      }
      const dir = args.path ? String(args.path).trim() : null
      const target = git.syncDirFor(args, (a) => repoParam(a, cfg.defaultRepo))
      if (target.error) return target
      const workDir = target.dir
      if (!existsSync(join(workDir, '.git'))) {
        return invalidErr(`${workDir} 不是 git 仓库`, '先用 subcommand:"clone" 克隆，或检查 path')
      }
      if (sub === 'status') {
        const st = await git.statusOf(workDir)
        if (st.error) return st
        return { sync: { sub, path: workDir, ...st } }
      }
      if (sub === 'pull') {
        const st = await git.statusOf(workDir)
        if (st.error) return st
        if (st.dirty) {
          return errOf('dirty-worktree', '工作区有未提交改动，pull 已拒绝', '先 subcommand:"commit" 提交，或确认后手动处理')
        }
        const r = await git.runGit(['pull', '--ff-only'], { cwd: workDir, token })
        if (r.code !== 0) return git.gitErrOf(r, 'pull ')
        const after = await git.statusOf(workDir)
        if (after.error) return after
        const upToDate = /already up to date|up-to-date/i.test(r.out + r.err)
        return { sync: { sub, path: workDir, branch: after.branch, ahead: after.ahead, behind: after.behind, upToDate, output: tail(r) } }
      }
      if (sub === 'branch') {
        if (!args.name) return invalidErr('branch 需要 name 参数')
        const create = !!args.create
        const gitArgs = create ? ['checkout', '-b', String(args.name), ...(args.from ? [String(args.from)] : [])] : ['checkout', String(args.name)]
        const r = await git.runGit(gitArgs, { cwd: workDir })
        if (r.code !== 0) return git.gitErrOf(r, '切换分支')
        return { sync: { sub, path: workDir, branch: String(args.name), created: create } }
      }
      if (sub === 'commit') {
        const gate = writeGate()
        if (gate) return gate
        if (!args.message) return invalidErr('commit 需要 message 参数')
        const strategy = args.add || 'all'
        if (strategy === 'all') {
          const r = await git.runGit(['add', '-A'], { cwd: workDir })
          if (r.code !== 0) return git.gitErrOf(r, 'git add ')
        } else if (strategy !== 'staged') {
          const paths = csv(strategy)
          if (!paths.length) return invalidErr(`add 参数无法解析: ${strategy}`, '用 all / staged / 逗号分隔的路径')
          const r = await git.runGit(['add', ...paths], { cwd: workDir })
          if (r.code !== 0) return git.gitErrOf(r, 'git add ')
        }
        const identity = await git.gitIdentity()
        const finalMessage = git.withCoAuthor(String(args.message))
        const r = await git.runGit(
          ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '-m', finalMessage],
          { cwd: workDir },
        )
        if (r.code !== 0) return git.gitErrOf(r, 'commit ')
        const sha = await git.runGit(['rev-parse', '--short=7', 'HEAD'], { cwd: workDir })
        const br = await git.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workDir })
        const names = await git.runGit(['show', '--name-only', '--format=', 'HEAD'], { cwd: workDir })
        return {
          sync: {
            sub,
            path: workDir,
            branch: br.code === 0 ? br.out.trim() : null,
            sha7: sha.code === 0 ? sha.out.trim() : null,
            message: finalMessage,
            files: names.code === 0 ? names.out.split('\n').map((s) => s.trim()).filter(Boolean) : [],
          },
        }
      }
      if (sub === 'push') {
        const gate = writeGate()
        if (gate) return gate
        if (args.confirm !== true) return confirmErr('push 推送到远端')
        const br = await git.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workDir })
        const branch = args.branch || (br.code === 0 ? br.out.trim() : null)
        if (!branch) return invalidErr('无法确定要推送的分支', '传 branch 参数')
        const r = await git.runGit(['push', '-u', 'origin', branch], { cwd: workDir, token })
        if (r.code !== 0) return git.gitErrOf(r, 'push ')
        const combined = r.out + r.err
        const hintMatch = combined.match(/https:\/\/github\.com\/[^\s"']+/)
        const remote = await remoteOwnerRepo(workDir)
        let compareUrl = null
        if (remote) {
          try {
            const def = await defaultBranchOf(remote.owner, remote.repo, token)
            if (def && def !== branch) compareUrl = `https://github.com/${remote.owner}/${remote.repo}/compare/${def}...${encodeURIComponent(branch)}`
          } catch { /* default branch unknown; skip compare URL */ }
        }
        return {
          sync: {
            sub,
            path: workDir,
            branch,
            prHintUrl: hintMatch ? hintMatch[0] : null,
            compareUrl,
            output: tail(r),
          },
        }
      }
      return invalidErr(`未知 subcommand: ${sub}`)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `GitHub sync ${args.subcommand ?? ''}`.trim(),
      kind: ['list', 'status'].includes(args.subcommand) ? 'read' : 'write',
      rawInput: args,
    }),
  }))
}
