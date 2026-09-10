import { describe, expect, it } from 'vitest'
import {
  MAX_CONTEXT_CHARS,
  clipContext,
  formatFileContext,
  formatSelectionContext,
  type EditorContextSource,
} from './editorContext.ts'

const selection: EditorContextSource = {
  fileName: '/work/repo/src/app.ts',
  relativePath: 'src/app.ts',
  languageId: 'typescript',
  text: 'const a = 1\nconst b = 2',
  startLine: 12,
  endLine: 13,
}

describe('clipContext', () => {
  it('keeps short text intact', () => {
    expect(clipContext('abc', 10)).toEqual({ text: 'abc', truncated: false })
  })
  it('clips long text and reports truncation', () => {
    const long = 'x'.repeat(MAX_CONTEXT_CHARS + 5)
    const out = clipContext(long)
    expect(out.truncated).toBe(true)
    expect(out.text).toHaveLength(MAX_CONTEXT_CHARS)
  })
})

describe('formatSelectionContext', () => {
  it('renders path, range, language fence and code', () => {
    const out = formatSelectionContext(selection)
    expect(out).toContain('[VS Code 上下文] 文件：src/app.ts（typescript） · 选中 12-13 行')
    expect(out).toContain('```typescript')
    expect(out).toContain('const a = 1')
    expect(out).toContain('```')
  })

  it('falls back to the basename when no relative path exists', () => {
    const out = formatSelectionContext({ fileName: 'C:\\proj\\win\\main.ts', text: 'x', startLine: 1, endLine: 1 })
    expect(out).toContain('文件：main.ts（text）')
  })

  it('marks an empty selection instead of emitting an empty code block', () => {
    const out = formatSelectionContext({ fileName: 'a.ts', text: '   \n', startLine: 1, endLine: 1 })
    expect(out).toContain('（选区内没有可提取的文本）')
    expect(out).not.toContain('```')
  })

  it('reports truncation with original and kept lengths', () => {
    const out = formatSelectionContext({ ...selection, text: 'y'.repeat(MAX_CONTEXT_CHARS + 100) })
    expect(out).toContain(`[上下文截断：原文 ${String(MAX_CONTEXT_CHARS + 100)} 字符，仅保留前 ${String(MAX_CONTEXT_CHARS)} 字符]`)
  })
})

describe('formatFileContext', () => {
  it('includes total line count', () => {
    const out = formatFileContext({ fileName: '/work/repo/src/app.ts', relativePath: 'src/app.ts', languageId: 'typescript', text: 'a\nb\nc', totalLines: 3 })
    expect(out).toContain('文件：src/app.ts（typescript） · 全文 3 行')
    expect(out).toContain('a\nb\nc')
  })

  it('marks an empty file', () => {
    const out = formatFileContext({ fileName: 'empty.md', text: '', totalLines: 0 })
    expect(out).toContain('（文件内容为空）')
  })
})
