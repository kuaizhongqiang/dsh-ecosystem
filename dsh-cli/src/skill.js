/**
 * 技能说明（SKILL.md）的位置、内嵌与落盘。
 *
 * 定位：**跟着 exe 走** —— 技能与 `dshcli.exe` 同级（主人 2026-09-24 定）。
 * 第一接触命令（`-h` / `-i` / `-v` / `doctor`）会提示「建议先读技能说明」，把绝对路径给出来，
 * 让调用方（尤其别的 agent）知道「这个工具有自描述、先看它」。
 *
 * 三重保障：① 正文在构建时**内嵌进 exe**（`__DSHCLI_SKILL__`），exe 到哪技能到哪；
 * ② 首次运行尝试**自动落一份**到 exe 同级（只读目录下静默降级）；③ `dshcli skill` 随时可打印/重装。
 *
 * 为什么不是 `%DSH_HOME%\skills\`：那里是 **dsh 本体**发现技能的地方，而这份技能是给
 * **调用 dshcli 的一方**（openclaw / 别的 agent / 人）看的，跟 exe 放一起最不容易丢。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 技能文件名（与 exe 同级，名字带前缀避免与 bin 目录里别的文件冲突）。 */
export const SKILL_FILENAME = 'dshcli.SKILL.md'

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** 判断是不是在自包含 exe 里跑（SEA）；不是则退回源码 / npm 场景。 */
export function isSelfContained() {
  try {
    const sea = globalThis.process?.getBuiltinModule?.('node:sea')
    return sea !== undefined && typeof sea.isSea === 'function' && sea.isSea() === true
  } catch {
    return false
  }
}

/** 技能应当落在哪个目录：exe 同级（SEA）或 `%DSH_HOME%\bin`（源码 / npm 场景，跟 exe 习惯一致）。 */
export function skillDir() {
  if (isSelfContained()) return dirname(process.execPath)
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'bin')
}

/** 技能文件绝对路径。 */
export function skillFilePath() {
  return join(skillDir(), SKILL_FILENAME)
}

/** 技能文件在不在。 */
export function skillFileExists() {
  return existsSync(skillFilePath())
}

/**
 * 内嵌的技能正文（构建时 define 注入；源码 / npm 场景退回读 `skills/dshcli.SKILL.md`）。
 * @returns 正文，或 undefined（两处都拿不到）
 */
export function embeddedSkill() {
  if (typeof __DSHCLI_SKILL__ === 'string' && __DSHCLI_SKILL__ !== '') return __DSHCLI_SKILL__
  try {
    return readFileSync(new URL(`../skills/${SKILL_FILENAME}`, import.meta.url), 'utf8')
  } catch {
    return undefined
  }
}

/** 技能状态（`dshcli skill --where` 用）：路径 / 是否落盘 / 与内嵌是否一致。 */
export function skillStatus() {
  const file = skillFilePath()
  const embedded = embeddedSkill()
  let installed
  try {
    installed = readFileSync(file, 'utf8')
  } catch {
    installed = undefined
  }
  const matches = installed !== undefined && embedded !== undefined && sha(installed) === sha(embedded)
  const advice = installed === undefined
    ? '尚未落盘：跑 `dshcli skill --install`'
    : matches
      ? '已落盘且与 exe 内嵌一致'
      : '已落盘但与 exe 内嵌不一致（exe 升级过？）—— 跑 `dshcli skill --install` 刷新'
  return {
    path: file,
    installed: installed !== undefined,
    embedded: embedded !== undefined,
    matches,
    advice,
    ...(installed === undefined ? {} : { bytes: Buffer.byteLength(installed, 'utf8') }),
    ...(embedded === undefined ? {} : { embeddedHash: sha(embedded).slice(0, 12) }),
  }
}

/** 把内嵌正文落到目标目录（默认 exe 同级）；幂等，返回落盘结果。 */
export function installSkill(options = {}) {
  const text = embeddedSkill()
  if (text === undefined) {
    const error = new Error('找不到技能正文（exe 内嵌缺失且源文件读不到）')
    error.code = 'unavailable'
    throw error
  }
  const dir = options.to ?? skillDir()
  const file = join(dir, SKILL_FILENAME)
  let before
  try {
    before = readFileSync(file, 'utf8')
  } catch {
    before = undefined
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, text, 'utf8')
  return { path: file, bytes: Buffer.byteLength(text, 'utf8'), changed: before !== text, hash: sha(text).slice(0, 12) }
}

/** 首次运行尝试自动落一份（失败静默 —— 只读目录、权限不足都不该挡住 CLI 干活）。 */
export function ensureSkillFile() {
  if (skillFileExists()) return
  try {
    installSkill()
  } catch {
    // 落不了就靠 `dshcli skill` 打印，别报错
  }
}
