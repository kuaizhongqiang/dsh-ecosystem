/**
 * `dshcli skill` —— 技能说明的打印 / 落盘 / 查状态。
 *
 *   dshcli skill              打印内嵌正文（文件丢了也能读）
 *   dshcli skill --install    落盘到 exe 同级（`--to <目录>` 可指定）
 *   dshcli skill --where      报路径 / 是否已落盘 / 与内嵌是否一致
 */

import { installSkill, skillStatus, embeddedSkill, skillFilePath } from './skill.js'

/** 极简开关解析（本命令参数少，不需要完整解析器）。 */
function parse(argv) {
  const flags = { install: false, where: false, json: false, to: undefined, help: false }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--install') flags.install = true
    else if (token === '--where') flags.where = true
    else if (token === '--json' || token === '-j') flags.json = true
    else if (token === '-h' || token === '--help') flags.help = true
    else if (token === '--to') flags.to = argv[++index]
    else return { error: `未知开关：${token}（可用 --install / --where / --to <目录> / --json）` }
  }
  return flags
}

export async function skillCommand(argv, { output }) {
  const flags = parse(argv)
  if (flags.error !== undefined) {
    process.stderr.write(`${flags.error}\n`)
    return 1
  }
  if (flags.help) {
    process.stdout.write([
      'dshcli skill —— 技能说明（与 exe 同级）',
      '  dshcli skill              打印内嵌正文',
      '  dshcli skill --install    落盘（--to <目录> 可指定；默认 exe 同级）',
      '  dshcli skill --where      报路径 / 是否已落盘 / 与内嵌是否一致',
    ].join('\n') + '\n')
    return 0
  }
  if (flags.where) {
    const status = skillStatus()
    if (flags.json) output(status, { json: true })
    else process.stdout.write(`${status.path}\n${status.advice}\n`)
    return 0
  }
  if (flags.install) {
    const result = installSkill(flags.to === undefined ? {} : { to: flags.to })
    if (flags.json) output(result, { json: true })
    else process.stdout.write(`技能已${result.changed ? '更新' : '就位'}：${result.path}（${result.bytes} 字节，sha ${result.hash}）\n`)
    return 0
  }
  const text = embeddedSkill()
  if (text === undefined) {
    process.stderr.write(`技能正文不可用（既没内嵌也读不到源文件）；目标路径：${skillFilePath()}\n`)
    return 1
  }
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
  return 0
}
