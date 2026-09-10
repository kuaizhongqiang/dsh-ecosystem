/**
 * Editor-context injection (milestone #2, issue #23): turn the active editor's
 * selection or whole file into a bounded prompt context block.
 *
 * Pure formatting only — the extension command layer supplies the editor state
 * and the chat panel, so this module stays unit-testable without VS Code.
 */

/** Context block budget; longer sources are clipped with an explicit note. */
export const MAX_CONTEXT_CHARS = 12000

export interface EditorContextSource {
  /** Absolute or workspace file name as reported by the editor. */
  fileName: string
  /** Workspace-relative path when available (preferred in the header). */
  relativePath?: string
  /** VS Code language id (drives the fenced code language). */
  languageId?: string
  /** Selected or whole-document text. */
  text: string
  /** 1-based first selected line (selection only). */
  startLine?: number
  /** 1-based last selected line (selection only). */
  endLine?: number
  /** 1-based total line count (whole-file context). */
  totalLines?: number
}

function basename(fileName: string): string {
  const normalized = fileName.replaceAll('\\', '/')
  const at = normalized.lastIndexOf('/')
  return at === -1 ? normalized : normalized.slice(at + 1)
}

function displayPath(source: EditorContextSource): string {
  const relative = source.relativePath?.trim()
  if (relative !== undefined && relative.length > 0) return relative
  return basename(source.fileName)
}

function fenceLanguage(source: EditorContextSource): string {
  const languageId = source.languageId?.trim()
  return languageId !== undefined && languageId.length > 0 ? languageId : 'text'
}

/** Clip a source text to the context budget, reporting whether clipping happened. */
export function clipContext(text: string, max = MAX_CONTEXT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

function body(source: EditorContextSource): string {
  const clip = clipContext(source.text)
  const lines = [`\`\`\`${fenceLanguage(source)}`, clip.text, '```']
  if (clip.truncated) {
    lines.push(`[上下文截断：原文 ${String(source.text.length)} 字符，仅保留前 ${String(clip.text.length)} 字符]`)
  }
  return lines.join('\n')
}

/** Format a selection context block for a prompt. */
export function formatSelectionContext(source: EditorContextSource): string {
  const hasLines = source.startLine !== undefined && source.endLine !== undefined
  const range = hasLines ? ` · 选中 ${String(source.startLine)}-${String(source.endLine)} 行` : ''
  const empty = source.text.trim().length === 0
  return [
    `[VS Code 上下文] 文件：${displayPath(source)}（${fenceLanguage(source)}）${range}`,
    empty ? '（选区内没有可提取的文本）' : body(source),
  ].join('\n')
}

/** Format a whole-file context block for a prompt. */
export function formatFileContext(source: EditorContextSource): string {
  const lines = source.totalLines !== undefined ? ` · 全文 ${String(source.totalLines)} 行` : ''
  const empty = source.text.trim().length === 0
  return [
    `[VS Code 上下文] 文件：${displayPath(source)}（${fenceLanguage(source)}）${lines}`,
    empty ? '（文件内容为空）' : body(source),
  ].join('\n')
}
