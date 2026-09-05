/**
 * Idempotent patch for the npm dsh install's dsh-host-apiproxy: when the
 * session model is text-only and a prompt carries images, and the
 * describe_image tool is mounted, store the images as durable attachments and
 * replace each image block with a hint text block instead of rejecting with
 * MODEL_DOES_NOT_SUPPORT_IMAGES. The hint format is owned by the profile's
 * describe-image plugin (same bracket syntax); both sides must stay in lockstep.
 *
 * Run: node patch-apiproxy.mjs
 * Safe to re-run: an already-patched file is detected and left untouched.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const MARKER = '// === dsh-native describe_image hint patch v1 ==='

/** Resolve the apiproxy lib path the web profile actually loads. */
function apiproxyLibPath() {
  const home = process.env.DSH_HOME ?? (process.env.USERPROFILE + '/.dsh')
  // Resolve from the web profile directory so the module-fallback junction
  // (pointing at the npm install the running CLI loaded) is used, never a
  // workspace checkout in the current working directory.
  const require = createRequire('file://' + home.replaceAll('\\', '/') + '/profiles/web/')
  try {
    return require.resolve('@deepseek-ai/dsh-host-apiproxy')
  } catch {
    return home + '/profiles/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js'
  }
}

/**
 * Locate the admission block by its stable text anchors. Returns the start of
 * the `if (hasImage) {` line and the end just past `});` of createUserMessage,
 * or null when any anchor is missing (version drift).
 */
function findAdmissionBlock(source) {
  const start = source.indexOf('if (hasImage) {')
  if (start < 0) return null
  const anchor1 = source.indexOf('const current = selectionFor(agent).current;', start)
  if (anchor1 < 0 || anchor1 - start > 200) return null
  const anchor2 = source.indexOf('const modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model);', anchor1)
  if (anchor2 < 0 || anchor2 - anchor1 > 200) return null
  const anchor3 = source.indexOf('does not support image input.', anchor2)
  if (anchor3 < 0 || anchor3 - anchor2 > 400) return null
  const close1 = source.indexOf('});', anchor3)
  if (close1 < 0 || close1 - anchor3 > 200) return null
  const afterIf = source.indexOf('\n', close1)
  const close2 = source.indexOf('}', afterIf + 1)
  if (close2 < 0 || close2 - afterIf > 60) return null
  const msgStart = source.indexOf('const message = createUserMessage({', close2)
  if (msgStart < 0 || msgStart - close2 > 60) return null
  const contentStart = source.indexOf('content: await durablePromptContent(ctx, content),', msgStart)
  if (contentStart < 0 || contentStart - msgStart > 120) return null
  const close3 = source.indexOf('});', contentStart)
  if (close3 < 0 || close3 - contentStart > 120) return null
  const end = close3 + 3
  // The line indent for the if/hasImage line.
  const lineStart = source.lastIndexOf('\n', start - 1) + 1
  return { start: lineStart, end, indent: source.slice(lineStart, start) }
}

/** The hint writer, kept byte-identical to the plugin's imageRefHint. */
function hintImplementation() {
  return `${MARKER}
function describeImageHint(ref) {
\tconst name = ref.name === void 0 ? "" : \`, \${JSON.stringify(ref.name)}\`;
\tconst bracket = \`[图片附件 \${String(ref.attachmentId)} (\${ref.mediaType}, \${ref.width}×\${ref.height}, \${ref.bytes}B\${name})]\`;
\treturn \`\${bracket} — 使用 describe_image 工具（参数 attachmentId=\${String(ref.attachmentId)}）查看此图片\`;
}
`
}

/** Replacement admission block using the caller's indentation. */
function newAdmission(indent) {
  const t = indent
  const t2 = t + '\t'
  const t3 = t + '\t\t'
  const t4 = t + '\t\t\t'
  return `${t}let convertToHints = false;
${t}if (hasImage) {
${t2}const current = selectionFor(agent).current;
${t2}const modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model);
${t2}const textOnly = modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image");
${t2}if (textOnly) {
${t3}// The main model is text-only, but the describe_image tool can see the
${t3}// image: store it as a durable attachment and show the model hint text
${t3}// instead. Without the tool the historical rejection stays.
${t3}convertToHints = ctx.get("tools")?.get("describe_image") !== void 0;
${t3}if (!convertToHints) return err(request, {
${t4}code: "attachment-error",
${t4}message: \`Model "\${current.model}" does not support image input.\`,
${t4}details: { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" }
${t3}});
${t2}}
${t}}
${t}const durable = await durablePromptContent(ctx, content);
${t}const converted = convertToHints
${t}? durable.map(block => block.type === "image"
${t}? { type: "text", text: describeImageHint(block.attachment) }
${t}: block)
${t}: durable;
${t}const message = createUserMessage({
${t2}content: converted,
${t}source
${t}});`
}

const libPath = apiproxyLibPath()
if (!existsSync(libPath)) {
  console.error(`dsh-host-apiproxy not found at ${libPath}`)
  process.exit(1)
}
const source = readFileSync(libPath, 'utf8')
if (source.includes(MARKER)) {
  console.log(`already patched: ${libPath}`)
  process.exit(0)
}
const block = findAdmissionBlock(source)
if (block === null) {
  console.error('admission block not found; the npm version may have changed — recheck the patch')
  process.exit(1)
}
const patched = source.slice(0, block.start)
  + newAdmission(block.indent)
  + source.slice(block.end)
const anchor = 'import { release } from "node:os";\n'
const anchorAt = patched.indexOf(anchor)
if (anchorAt < 0) {
  console.error('import anchor not found; aborting without writing')
  process.exit(1)
}
const final = patched.slice(0, anchorAt + anchor.length)
  + hintImplementation()
  + patched.slice(anchorAt + anchor.length)
if (!final.includes(MARKER) || final === source) {
  console.error('patch failed to apply; aborting without writing')
  process.exit(1)
}
writeFileSync(libPath, final, 'utf8')
console.log(`patched: ${libPath}`)
