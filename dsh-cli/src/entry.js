/**
 * 可执行入口（自包含 exe 用）。
 *
 * 为什么单独一个文件：Node SEA 的入口必须是**会自己跑起来**的脚本，而 `src/cli.js` 只导出 `main`；
 * 这里负责调用它。刻意不用顶层 await —— esbuild 打成 CJS 时顶层 await 不可用。
 */

import { main } from './cli.js'

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code ?? 0 },
  (error) => {
    process.stderr.write(`dshcli 内部错误：${error?.stack ?? error}\n`)
    process.exitCode = 1
  },
)
