/**
 * Local plugin catalog for the "插件库" sidebar entry.
 *
 * Data sources (per issue #5, "数据来源由实现确定"):
 *  - 已安装: ${DSH_HOME}/skills 下的 skill 子目录（含 SKILL.md）、${DSH_HOME}/tools、${DSH_HOME}/presets
 *  - 可用:   DSH_PLUGINS_HOME 或 ~/dsh-project/dsh-plugins / ~/dsh-plugins（dsh-plugins 合集仓库）
 *
 * Each entry carries a name, a one-line description, a kind and an absolute
 * path so the sidebar can open it in the explorer.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dshHome } from './dshHome.ts'

export type PluginKind = 'skill' | 'tool' | 'preset' | 'plugin'

export interface PluginEntry {
  name: string
  description: string
  kind: PluginKind
  path: string
  /** true = 已安装到 DSH_HOME；false = 可用但未安装。 */
  installed: boolean
}

/** DSH_HOME 解析统一走 dshHome.ts（与共享 token 文件同一来源）。 */
export { dshHome } from './dshHome.ts'

/** Scan installed plugins under DSH_HOME (skills / tools / presets). */
export function scanInstalledPlugins(): PluginEntry[] {
  const home = dshHome()
  const out: PluginEntry[] = []
  collectSkillDirs(home, out)
  collectToolDirs(home, out)
  collectPresets(home, out)
  return out.sort(byName)
}

/** Scan the dsh-plugins collection repo if present (available plugins). */
export function scanAvailablePlugins(): PluginEntry[] {
  const root = findPluginsRoot()
  if (root === undefined) return []
  const out: PluginEntry[] = []
  collectSkillDirs(root, out, false)
  const pluginsDir = join(root, 'plugins')
  if (existsSync(pluginsDir)) {
    for (const name of readdirSync(pluginsDir)) {
      const dir = join(pluginsDir, name)
      if (!statSync(dir).isDirectory()) continue
      if (!existsSync(join(dir, 'install.ps1')) && !existsSync(join(dir, 'README.md'))) continue
      out.push({ name, description: readDescription(dir, ['README.md', 'SKILL.md']), kind: 'plugin', path: dir, installed: false })
    }
  }
  return out.sort(byName)
}

function findPluginsRoot(): string | undefined {
  const candidates = [
    process.env.DSH_PLUGINS_HOME,
    join(homedir(), 'dsh-project', 'dsh-plugins'),
    join(homedir(), 'dsh-plugins'),
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate)) return candidate
  }
  return undefined
}

function collectSkillDirs(root: string, out: PluginEntry[], installed = true): void {
  const skillsDir = join(root, 'skills')
  if (!existsSync(skillsDir)) return
  for (const name of readdirSync(skillsDir)) {
    const dir = join(skillsDir, name)
    if (!statSync(dir).isDirectory()) continue
    if (!existsSync(join(dir, 'SKILL.md'))) continue
    out.push({ name, description: readDescription(dir, ['SKILL.md']), kind: 'skill', path: dir, installed })
  }
}

function collectToolDirs(root: string, out: PluginEntry[], installed = true): void {
  const toolsDir = join(root, 'tools')
  if (!existsSync(toolsDir)) return
  for (const name of readdirSync(toolsDir)) {
    const dir = join(toolsDir, name)
    if (!statSync(dir).isDirectory()) continue
    const hasDesc = ['tool.md', 'tool.yaml', 'tool.yml', 'README.md'].some((f) => existsSync(join(dir, f)))
    if (!hasDesc) continue
    out.push({ name, description: readDescription(dir, ['tool.md', 'README.md']), kind: 'tool', path: dir, installed })
  }
}

function collectPresets(root: string, out: PluginEntry[], installed = true): void {
  const presetsDir = join(root, 'presets')
  if (!existsSync(presetsDir)) return
  for (const name of readdirSync(presetsDir)) {
    const file = join(presetsDir, name)
    if (!statSync(file).isFile() || !name.endsWith('.md')) continue
    out.push({ name: name.replace(/\.md$/, ''), description: readDescriptionFile(file), kind: 'preset', path: file, installed })
  }
}

function readDescription(dir: string, files: string[]): string {
  for (const file of files) {
    const full = join(dir, file)
    if (existsSync(full)) {
      const desc = readDescriptionFile(full)
      if (desc.length > 0) return desc
    }
  }
  return ''
}

function readDescriptionFile(file: string): string {
  try {
    const text = readFileSync(file, 'utf8')
    // Skip YAML front matter and heading lines; take the first meaningful line.
    const lines = text.split(/\r?\n/)
    let inFrontMatter = lines[0]?.trim() === '---'
    let sawBody = false
    for (const line of lines.slice(inFrontMatter ? 1 : 0)) {
      if (inFrontMatter) {
        if (line.trim() === '---') {
          inFrontMatter = false
          continue
        }
        continue
      }
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      if (/^#{1,6}\s+/.test(trimmed)) continue // heading
      if (/^```/.test(trimmed)) continue
      if (/^[-*]\s/.test(trimmed)) continue // list item
      sawBody = true
      return trimmed.replace(/^>\s?/, '').slice(0, 120)
    }
    void sawBody
    return ''
  } catch {
    return ''
  }
}

function byName(a: PluginEntry, b: PluginEntry): number {
  return a.name.localeCompare(b.name)
}
