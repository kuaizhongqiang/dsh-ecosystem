// One-click installer for the dsh-plugins collection carried as a submodule
// (dsh-plugins/). Installs the plugin-install SKILLS into %DSH_HOME%\skills so
// you can pick plugins inside a dsh session (e.g. `/install-stock`), and prints
// the plugin list + next steps. Idempotent (the underlying ps1 is too).
//
// Plugins install into the shared DSH_HOME (profiles/web/plugins) — server-side,
// so every end (web / vscode / desktop shell) sees them via the same server.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))))
const pluginsRoot = join(root, '..', 'dsh-plugins')
const installSkills = join(pluginsRoot, 'skills', 'install-skills.ps1')

if (!existsSync(pluginsRoot)) {
  console.error('[plugins] 未找到 dsh-plugins 子模块：请先执行 git submodule update --init --recursive')
  process.exit(2)
}
if (!existsSync(installSkills)) {
  console.error(`[plugins] 缺少 ${installSkills}，dsh-plugins 版本过旧？`)
  process.exit(2)
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
console.log(`[plugins] 目标 DSH_HOME：${dshHome}`)
console.log(`[plugins] 运行 ${installSkills}（安装全部安装技能，幂等）…`)

const r = spawnSync(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installSkills],
  { cwd: pluginsRoot, stdio: 'inherit', windowsHide: true },
)
if (r.status !== 0) {
  console.error(`[plugins] install-skills.ps1 退出码 ${r.status}`)
  process.exit(r.status ?? 1)
}

console.log(`
[plugins] 完成 ✓ 技能已装入 ${join(dshHome, 'skills')}
下一步（任选）：
  1. 在 dsh 会话中说「安装 xxx 插件」（例如 安装 stock 插件），Agent 会加载对应技能自动安装；
  2. 或直接运行各插件包：dsh-plugins\\plugins\\<name>-dsh-plugin\\install.ps1；
  3. 装完后重启 dsh web 生效（插件在 %DSH_HOME%\\profiles\\web\\plugins，三端共享）。
插件清单见 dsh-plugins\\README.md`)
