/** 本机路径与项目键：dsh 的 profile / 会话 / 我们自己的状态都落在这里。 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** `%DSH_HOME%`（缺省 `~/.dsh`）。 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** dsh 的会话根目录：`%DSH_HOME%/sessions/<项目键>/<session-id>/`。 */
export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/** 我们自己的状态目录（绝不放明文 token）。 */
export function stateDir() {
  return process.env.DSHCLI_STATE_DIR ?? join(dshHome(), 'dsh-cli')
}

/**
 * dsh 用「项目键」给会话分目录：`F:\Project\dsh-ecosystem` → `--F-Project-dsh-ecosystem--`
 * （去掉盘符冒号，路径分隔符换 `-`，首尾各加 `--`）。这里只当**快路径**用，
 * 真值一律以会话头里的 `cwd` 为准（见 findProjectKey）。
 */
export function projectKeyFor(cwd) {
  const normalized = resolve(cwd)
  const body = normalized.replace(/:/g, '').replace(/[\\/]+/g, '-')
  return `--${body}--`
}

/** 列出 sessions 下所有项目目录。 */
export function listProjectDirs() {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
}

/** 待确认 cwd 对应哪个项目目录（键不存在时返回 undefined，交给调用方按 cwd 扫描）。 */
export function findProjectKey(cwd) {
  const key = projectKeyFor(cwd)
  return existsSync(join(sessionsRoot(), key)) ? key : undefined
}
