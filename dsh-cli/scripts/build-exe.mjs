// scripts/build-exe.mjs —— 产出**自包含单文件** dshcli.exe（目标机不需要装 Node）。
//
// 步骤（Node 官方 SEA 配方）：
//   1. esbuild 打包成 dist/dshcli.cjs（单文件）
//   2. `node --experimental-sea-config` 生成 dist/dshcli.blob
//   3. 复制当前 node 可执行文件 → dist/dshcli.exe
//   4. postject 把 blob 注入（NODE_SEA_BLOB + sentinel fuse）
//   5. 另存一份带版本号的名字 dshcli-<ver>.exe —— launcher 的 `launcher_cli --version` 用这个资产名

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBundle, readPkg, root } from './build-bundle.mjs'

const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

/** 构建 exe，返回产物路径信息。 */
export async function buildExe() {
  const pkg = readPkg()
  const dist = join(root, 'dist')
  mkdirSync(dist, { recursive: true })
  await buildBundle()

  const seaConfig = join(dist, 'sea-config.json')
  writeFileSync(seaConfig, `${JSON.stringify({
    main: 'dshcli.cjs',
    output: 'dshcli.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }, null, 2)}\n`, 'utf8')

  const generated = spawnSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: dist, encoding: 'utf8' })
  if (generated.status !== 0) throw new Error(`SEA blob 生成失败（${generated.status}）：${generated.stderr || generated.stdout}`)

  const tag = platformTag()
  const exe = join(dist, process.platform === 'win32' ? 'dshcli.exe' : `dshcli-${tag}`)
  rmSync(exe, { force: true })
  copyFileSync(process.execPath, exe)

  const { inject } = await import('postject')
  await inject(exe, 'NODE_SEA_BLOB', readFileSync(join(dist, 'dshcli.blob')), { sentinelFuse: SENTINEL_FUSE })

  const versioned = join(dist, process.platform === 'win32' ? `dshcli-${pkg.version}.exe` : `dshcli-${pkg.version}-${tag}`)
  copyFileSync(exe, versioned)
  return { exe, versioned, platformTag: tag, version: pkg.version, bytes: readFileSync(exe).length }
}

/**
 * 资产名的平台后缀。
 *
 * 约定（0.11.4 起）：Windows 沿用历史资产名 `dshcli.exe` / `dshcli-<ver>.exe`（**不变**，
 * 老消费者不受影响）；其余平台用显式平台名，避免多平台资产互相覆盖：
 *   linux  → `dshcli-linux-x64`        / `dshcli-<ver>-linux-x64`
 *   darwin → `dshcli-darwin-<arch>`    / `dshcli-<ver>-darwin-<arch>`
 */
export function platformTag(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined
  return os === undefined ? undefined : `${os}-${arch}`
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('build-exe.mjs')) {
  const result = await buildExe()
  console.log(`exe: ${result.exe}`)
  console.log(`versioned: ${result.versioned}`)
  console.log(`platformTag: ${result.platformTag}`)
  console.log(`bytes: ${result.bytes}`)
}
