// scripts/build-bundle.mjs —— 把多文件 ESM 入口打成**单文件**（自包含 exe 的前置）。
//
// 为什么需要：Node SEA（Single Executable Application）只接受**一个**入口脚本，
// 而 dsh-cli 是多文件模块；这里用 esbuild 打包成 dist/dshcli.cjs，并把版本号 define 进去
// （这样 bump 版本只需要改 package.json，不用改代码）。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

export const root = dirname(dirname(fileURLToPath(import.meta.url)))

export function readPkg() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
}

/** 打包入口 → dist/dshcli.cjs，返回产物路径。 */
export async function buildBundle() {
  const pkg = readPkg()
  const outfile = join(root, 'dist', 'dshcli.cjs')
  await build({
    entryPoints: [join(root, 'src', 'entry.js')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    legalComments: 'none',
    define: {
      __DSHCLI_VERSION__: JSON.stringify(pkg.version),
    },
    banner: { js: '// dsh-cli 单文件包（esbuild）—— Node SEA 的入口，来源见 dsh-cli/src/' },
  })
  return outfile
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('build-bundle.mjs')) {
  const outfile = await buildBundle()
  console.log(`bundle: ${outfile}`)
}
