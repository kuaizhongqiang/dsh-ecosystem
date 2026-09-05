#!/usr/bin/env node
// Launch dsh-desktop (pure Electron shell) from the npm package.
// Usage: `npx @kuaizhongqiang/dsh-desktop` or, after `npm i -g`, `dsh-desktop`.
//
// The package declares `electron` as a dependency; require('electron') from a
// plain Node process returns the path to the Electron binary, which we then
// point at this package's app directory (out/main/index.js is the app entry).
'use strict'
const { spawn } = require('node:child_process')
const path = require('node:path')

let electronPath
try {
  electronPath = require('electron')
} catch {
  console.error('[dsh-desktop] 找不到 Electron 二进制。')
  console.error('  npm >= 11.16 默认拦截安装脚本：请先执行  npm config set allow-scripts electron')
  console.error('  然后重新安装本包（国内网络可加 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ 加速）。')
  process.exit(1)
}

const appDir = path.join(__dirname, '..')
const child = spawn(electronPath, [appDir], { stdio: 'inherit' })
child.on('error', (err) => {
  console.error(`[dsh-desktop] 启动 Electron 失败：${err.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  process.exit(code !== null ? code : signal ? 1 : 0)
})
