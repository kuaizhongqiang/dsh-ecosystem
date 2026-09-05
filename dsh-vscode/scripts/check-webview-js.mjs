/**
 * Syntax-check the inline JS inside media/webview.html (CI helper).
 * Usage: node scripts/check-webview-js.mjs
 */
import { readFileSync } from 'node:fs'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const html = readFileSync(new URL('../media/webview.html', import.meta.url), 'utf8')
const match = /<script>([\s\S]*?)<\/script>/.exec(html)
if (match === null) {
  console.error('FAIL: media/webview.html contains no inline <script>')
  process.exit(1)
}
const dir = mkdtempSync(join(tmpdir(), 'dsh-webview-'))
const file = join(dir, 'webview.js')
writeFileSync(file, match[1])
execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
console.log('PASS: webview inline JS syntax OK')
