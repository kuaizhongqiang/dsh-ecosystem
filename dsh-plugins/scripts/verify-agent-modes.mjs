// agent-modes 载荷的 **preset 级断言**，补充 scripts/validate-patch.mjs 的结构门：
//   - 重复的 preset id / 重复的 order
//   - 每个 preset 内 plugin id 唯一（含 cordis:group 的子项）
//   - 禁用行不得出现：tool-goal / command-goal / tool-ralph / tool-schedule /
//     tool-subagent / tool-subagent-fork / tool-workflow
// 结构门（编码损坏、空行串、块标量、裸 config 后接注释）由 validate-patch.mjs 负责，
// 两者互补：本脚本做声明语义，结构门做 YAML 形状。
//
// Usage: node scripts/verify-agent-modes.mjs <cordis.patch.yml>
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// js-yaml 的查找沿用 validate-patch.mjs 的策略：不写死本机绝对路径。
const scriptDir = dirname(fileURLToPath(import.meta.url))
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')

function loadYaml() {
  const require = createRequire(import.meta.url)
  const bases = [
    join(scriptDir, '..'),
    process.cwd(),
    join(dshHome, 'profiles', 'web'),
    join(dshHome, 'profiles'),
  ]
  for (const base of bases) {
    try {
      return require(join(base, 'node_modules', 'js-yaml'))
    } catch {
      // 试下一个候选
    }
    const pnpm = join(base, 'node_modules', '.pnpm')
    if (!existsSync(pnpm)) continue
    try {
      for (const entry of readdirSync(pnpm)) {
        if (!entry.startsWith('js-yaml@')) continue
        try {
          return require(join(pnpm, entry, 'node_modules', 'js-yaml'))
        } catch {
          // 试下一个候选
        }
      }
    } catch {
      // 不可读的 store：其余候选仍然适用
    }
  }
  return null
}

const yaml = loadYaml()
if (yaml === null) {
  console.error('FAIL 找不到 YAML 解析器；把 NODE_PATH 指向含 js-yaml 的 node_modules 后重试')
  process.exit(1)
}

// 无参运行时默认校验本包载荷（与其他 verify-*.mjs 一致，便于整组跑门）。
const defaultPayload = join(scriptDir, '..', 'plugins', 'agent-modes-dsh-plugin', 'presets', 'cordis.patch.yml')
const file = process.argv[2] ?? defaultPayload
const text = readFileSync(file, 'utf8')
const problems = []

if (text.includes('\t')) problems.push('contains TAB characters')
if (text.includes('\uFFFD')) problems.push('contains U+FFFD replacement characters')
if (/\n[ \t]*\n[ \t]*\n/.test(text)) problems.push('a run of blank lines starts a second YAML document')

let doc
try {
  doc = yaml.load(text)
} catch (error) {
  console.error(`FAIL not valid YAML: ${error.message}`)
  process.exit(1)
}

if (!Array.isArray(doc)) {
  console.error(`FAIL top level must be an array, got ${typeof doc}`)
  process.exit(1)
}

const presets = []
for (const [index, entry] of doc.entries()) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    problems.push(`entry ${index} is not an object`)
    continue
  }
  if (!Array.isArray(entry.insert)) {
    problems.push(`entry ${index} has no insert array`)
    continue
  }
  for (const item of entry.insert) {
    if (typeof item?.id !== 'string' || typeof item?.name !== 'string') {
      problems.push(`insert item missing id/name: ${JSON.stringify(item)}`)
      continue
    }
    if (item.name !== '@deepseek-ai/dsh-agent-preset') continue
    const cfg = item.config
    if (cfg === undefined || cfg === null) {
      problems.push(`${item.id}: config is missing or null`)
      continue
    }
    for (const key of ['id', 'plugins']) {
      if (!(key in cfg)) problems.push(`${item.id}: preset config is missing "${key}"`)
    }
    if (!Array.isArray(cfg.plugins)) {
      problems.push(`${item.id}: plugins must be a list`)
      continue
    }
    const seen = new Set()
    const top = []
    for (const plugin of cfg.plugins) {
      if (typeof plugin?.id !== 'string' || typeof plugin?.name !== 'string') {
        problems.push(`${item.id}: plugin entry missing id/name`)
        continue
      }
      if (seen.has(plugin.id)) problems.push(`${item.id}: duplicate plugin id "${plugin.id}"`)
      seen.add(plugin.id)
      top.push(plugin.id)
      if (plugin.name === 'cordis:group') {
        if (!Array.isArray(plugin.config)) {
          problems.push(`${item.id}/${plugin.id}: group config must be a list`)
          continue
        }
        for (const child of plugin.config) {
          if (typeof child?.id !== 'string' || typeof child?.name !== 'string') {
            problems.push(`${item.id}/${plugin.id}: group child missing id/name`)
            continue
          }
          if (seen.has(child.id)) problems.push(`${item.id}: duplicate plugin id "${child.id}"`)
          seen.add(child.id)
        }
      }
    }
    presets.push({ preset: cfg.id, name: cfg.name, order: cfg.order, rows: cfg.plugins.length, ids: top })
  }
}

presets.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
console.log(`parsed ${presets.length} preset declaration(s)`)
for (const preset of presets) {
  console.log(`  ${String(preset.order).padStart(2)}  ${preset.preset.padEnd(11)} ${preset.name}  (${preset.rows} rows)`)
  console.log(`      ${preset.ids.join(', ')}`)
}

const orders = presets.map((preset) => preset.order)
if (new Set(orders).size !== orders.length) problems.push(`duplicate preset order values: ${orders.join(', ')}`)
const ids = presets.map((preset) => preset.preset)
if (new Set(ids).size !== ids.length) problems.push(`duplicate preset ids: ${ids.join(', ')}`)
for (const preset of presets) {
  const bans = ['tool-goal', 'command-goal', 'tool-ralph', 'tool-schedule', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow']
  for (const ban of bans) {
    if (preset.ids.includes(ban)) problems.push(`${preset.preset}: "${ban}" must not be mounted in a stage mode`)
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL ${problem}`)
  process.exit(1)
}
console.log('OK patch parses and every preset declaration is well formed')
