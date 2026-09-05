// Publish the desktop shell to npm as a directly-runnable package.
//
// Why a separate staging dir: electron-builder only allows `electron` in
// devDependencies, but npm consumers need it as a dependency so `npm i -g` /
// `npx` installs the Electron binary. So the repo manifest keeps electron in
// devDependencies (clean NSIS builds), and this script publishes a generated
// manifest (electron in dependencies) from a temp staging dir containing the
// compiled app.
//
// Usage:
//   node scripts/publish-npm.mjs            # real publish (@kuaizhongqiang/dsh-desktop)
//   node scripts/publish-npm.mjs --dry-run  # pack + list contents, no publish
// Env: NPM_TOKEN (optional, CI) — used as the registry auth token.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))))
const dryRun = process.argv.includes('--dry-run')
const repo = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('[publish:npm] out/ 不存在，请先执行 npm run build')
  process.exit(2)
}

// ---- publish manifest (electron as a real dependency) ----
const electronRange = repo.devDependencies?.electron
if (!electronRange) {
  console.error('[publish:npm] repo devDependencies 缺少 electron 版本范围')
  process.exit(2)
}
const manifest = {
  name: '@kuaizhongqiang/dsh-desktop',
  version: repo.version,
  description: repo.description,
  license: repo.license,
  type: repo.type,
  main: repo.main,
  bin: repo.bin,
  os: repo.os ?? ['win32'],
  author: repo.author,
  engines: repo.engines,
  keywords: ['deepseek', 'deepseek-harness', 'dsh', 'desktop', 'electron', 'shell', 'windows'],
  repository: { type: 'git', url: 'git+https://github.com/kuaizhongqiang/dsh-desktop.git' },
  dependencies: {
    electron: electronRange,
    'electron-updater': repo.dependencies?.['electron-updater'] ?? '^6.6.2',
  },
  // npm >= 11.16 install-script policy: allow electron's binary download
  // postinstall for project installs (npx / as a dependency).
  allowScripts: { electron: true },
}

// ---- stage the app ----
const stage = mkdtempSync(join(tmpdir(), 'dsh-desktop-npm-'))
for (const rel of ['out', 'preload', 'assets', 'bin']) {
  cpSync(join(root, rel), join(stage, rel), {
    recursive: true,
    filter: (src) => !src.endsWith('.map'),
  })
}
cpSync(join(root, 'config.json'), join(stage, 'config.json'))
if (existsSync(join(root, 'README.md'))) cpSync(join(root, 'README.md'), join(stage, 'README.md'))
if (existsSync(join(root, 'LICENSE'))) cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'))
writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

if (process.env.NPM_TOKEN) {
  // registry auth for CI; npm excludes .npmrc from the published tarball.
  writeFileSync(join(stage, '.npmrc'), `//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}\n`, 'utf8')
}

// ---- publish / dry-run ----
const args = ['publish', '--access', 'public']
if (dryRun) args.push('--dry-run')
console.log(`[publish:npm] ${dryRun ? 'dry-run' : 'publish'} ${manifest.name}@${manifest.version} (electron=${electronRange})`)
const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
  cwd: stage, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32',
})
rmSync(stage, { recursive: true, force: true })
if (r.status !== 0) {
  console.error(`[publish:npm] npm publish 退出码 ${r.status}`)
  process.exit(r.status ?? 1)
}
console.log(`[publish:npm] ${dryRun ? 'dry-run 通过' : `已发布 https://www.npmjs.com/package/${manifest.name}`}`)
