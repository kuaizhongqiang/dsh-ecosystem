#!/usr/bin/env node
// dshcli / dshc 入口：只做转发，逻辑都在 src/。
// 注意：命令名刻意不叫 `dsh` —— dsh 本体已占用该命令，按设计约定「命令冲突时 CLI 让路」。
import { main } from '../src/cli.js'

process.exitCode = await main(process.argv.slice(2))
