// Build: tsc + copy renderer static assets (html/css) into out/renderer.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(dirname(fileURLToPath(import.meta.url))))

// Invoke tsc directly with the local node binary (no shell, no deprecation noise).
execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
  stdio: 'inherit', cwd: root,
})

const srcRenderer = join(root, 'src', 'renderer')
const outRenderer = join(root, 'out', 'renderer')
mkdirSync(outRenderer, { recursive: true })
cpSync(srcRenderer, outRenderer, {
  recursive: true,
  filter: (src) => !src.endsWith('.ts') && !src.endsWith('.ts.map'),
})

console.log('[build] ok')
