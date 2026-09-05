/**
 * esbuild bundler for the dsh-vscode extension.
 * Produces a single CJS bundle at dist/extension.js (VSCode host loads it).
 */
const esbuild = require('esbuild')

const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
  sourcemap: true,
  logLevel: 'info',
}

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options)
    await ctx.watch()
    console.log('[dsh-vscode] watching…')
  } else {
    await esbuild.build(options)
    console.log('[dsh-vscode] build complete: dist/extension.js')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
