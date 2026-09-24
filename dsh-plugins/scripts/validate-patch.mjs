// Validate a dsh profile's cordis.patch.yml after an install script edits it.
//
// Why this exists: a plugin entry is YAML, and YAML fails silently in ways that
// look like plugin bugs. A comment line placed directly after a bare `config:`
// key, for example, folds the next line into the comment run:
//
//     config:
//       # note requireApproval: false      <- parses as config: null
//
// The plugin then runs on its defaults and the tool misbehaves with no error
// anywhere.
//
// Two layers of checking, so the guard still works on a machine with no YAML
// parser installed next to the profile:
//   1. a dependency-free structural lint of the file (always runs)
//   2. a full js-yaml parse plus per-entry checks, when a parser is findable
//
// Usage:  node validate-patch.mjs "<path to cordis.patch.yml>"
// Exit:   0 = valid, 1 = missing file, damaged encoding, or a structural problem
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node validate-patch.mjs <cordis.patch.yml>')
  process.exit(1)
}
if (!existsSync(file)) {
  console.error(`FAIL patch file not found: ${file}`)
  process.exit(1)
}

const text = readFileSync(file, 'utf8')
const problems = []

// --- layer 1: dependency-free structural lint -------------------------------
// Rejects the specific shapes this repo's installers can produce by accident.
const lines = text.split(/\r?\n/)

if (text.includes('\uFFFD')) {
  problems.push('the file contains U+FFFD replacement characters; a writer damaged its encoding')
}
if (text.includes('\t')) {
  problems.push('the file contains TAB characters; dsh writes spaces')
}

for (let index = 0; index < lines.length; index++) {
  const line = lines[index]
  const trimmed = line.trim()

  // A second consecutive blank line starts a new YAML document; every entry
  // after it is silently discarded.
  if (trimmed === '') {
    if (index > 0 && lines[index - 1].trim() === ''
      && lines.slice(index + 1).some((rest) => rest.trim() !== '')) {
      problems.push(`line ${index + 1}: a run of blank lines starts a second YAML document; later entries would be discarded`)
    }
    continue
  }

  const indent = line.length - line.trimStart().length
  if (trimmed.startsWith('#')) continue

  // Every structural line is a `key:`, `key: value`, or `- item`.
  if (!/^-\s*\S/.test(trimmed) && !/^["']?[A-Za-z_][\w."'-]*["']?\s*:/.test(trimmed)) {
    problems.push(`line ${index + 1}: not a comment, list item, or "key: value" - ${JSON.stringify(trimmed.slice(0, 60))}`)
    continue
  }

  // `key:` with an empty value must be a mapping/sequence header: its next
  // meaningful line has to be MORE indented. A comment directly after it folds
  // the following line into the comment run (the bug this guard exists for).
  const keyOnly = trimmed.match(/^["']?([A-Za-z_][\w."'-]*)["']?:\s*$/)
  if (keyOnly !== null) {
    const next = lines[index + 1]
    if (next !== undefined && next.trim() !== '') {
      const nextIndent = next.length - next.trimStart().length
      if (nextIndent <= indent) {
        problems.push(`line ${index + 1}: "${keyOnly[1]}:" has no nested value (next line is not indented) - its keys would resolve to null`)
      } else if (next.trimStart().startsWith('#')) {
        const after = lines[index + 2]
        problems.push(`line ${index + 2}: a comment sits directly after "${keyOnly[1]}:"`
          + (after !== undefined && after.trim() !== '' ? '; the next line would fold into the comment run' : ''))
      }
    }
  }
}

// --- layer 2: full parse, when a parser is available -------------------------
const require = createRequire(import.meta.url)
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const apdata = process.env.APPDATA ?? ''
const profileDir = dirname(file)

/**
 * Enumerate the places a YAML parser may live. `js-yaml` is what dsh itself
 * uses; a dev-profile copy can also sit in a pnpm store directory, so those are
 * expanded when present.
 */
function yamlCandidates() {
  const bases = [
    join(repoRoot, '..'),
    dirname(repoRoot),
    process.cwd(),
    profileDir,
    join(dshHome, 'profiles'),
    join(dshHome, 'profiles', 'web'),
    join(apdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    join(apdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh-cli'),
  ]
  const candidates = ['js-yaml']
  for (const base of bases) {
    candidates.push(join(base, 'node_modules', 'js-yaml'))
    const pnpm = join(base, 'node_modules', '.pnpm')
    if (!existsSync(pnpm)) continue
    try {
      for (const entry of readdirSync(pnpm)) {
        if (entry.startsWith('js-yaml@')) candidates.push(join(pnpm, entry, 'node_modules', 'js-yaml'))
      }
    } catch {
      // unreadable store: the other candidates still apply
    }
  }
  return candidates
}

function loadYaml() {
  for (const candidate of yamlCandidates()) {
    try {
      return require(candidate)
    } catch {
      // try the next candidate
    }
  }
  return null
}

const yaml = loadYaml()
const ids = []
const rows = []
if (yaml === null) {
  console.log('NOTE no YAML parser found; ran the structural lint only (set NODE_PATH to a node_modules with js-yaml for the full check)')
} else {
  let doc
  try {
    doc = yaml.load(text)
  } catch (error) {
    problems.push(`not valid YAML: ${error.message}`)
    doc = undefined
  }
  if (doc !== undefined && !Array.isArray(doc)) {
    problems.push(`top level must be a YAML array of patch entries, got ${typeof doc}`)
  }
  if (Array.isArray(doc)) {
    for (const [index, entry] of doc.entries()) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push(`entry ${index} is not an object (got ${JSON.stringify(entry)})`)
        continue
      }
      const keys = Object.keys(entry)
      if (keys.includes('insert')) {
        if (keys.length !== 1) {
          problems.push(`entry ${index} mixes "insert" with other keys (keys: ${JSON.stringify(keys)})`)
          continue
        }
        for (const item of entry.insert) {
          if (item === null || typeof item !== 'object' || typeof item.id !== 'string') {
            problems.push(`entry ${index} holds an insert item without a string id`)
            continue
          }
          ids.push(item.id)
          if ('config' in item && item.config === null) {
            problems.push(`insert ${item.id} resolves to config: null - its keys were swallowed`)
          }
          if (!('name' in item)) problems.push(`insert ${item.id} has no plugin name`)
        }
        continue
      }
      // dsh 0.1.7 起，profile patch 也直接承载**扁平行**（`{id,name,config}`，不裹 insert）——
      // 设置迁移就是这样写进来的（ui-* / permission / llm-pi-ai / agent-default-model）。
      // 老版本只认 insert，会对升级后的 profile 全线误报。
      if (typeof entry.id !== 'string' || typeof entry.name !== 'string') {
        problems.push(`entry ${index} is neither an "insert:" object nor a direct {id,name} row (keys: ${JSON.stringify(keys)})`)
        continue
      }
      rows.push(entry.id)
      if ('config' in entry && entry.config === null) {
        problems.push(`row ${entry.id} resolves to config: null - its keys were swallowed`)
      }
    }
  }
}

if (ids.length > 0) console.log(`${ids.length} insert item(s): ${ids.join(', ')}`)
if (rows.length > 0) console.log(`${rows.length} direct row(s): ${rows.join(', ')}`)
if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL ${problem}`)
  process.exit(1)
}
console.log('OK patch structure is well formed')
