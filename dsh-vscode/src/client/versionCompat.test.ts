import { describe, expect, it } from 'vitest'
import { checkEmbedCompat, MAX_TESTED_EMBED_SEAM_VERSION, MIN_EMBED_SEAM_VERSION } from './versionCompat.ts'

describe('checkEmbedCompat', () => {
  it('accepts the verified seam version', () => {
    const r = checkEmbedCompat(MIN_EMBED_SEAM_VERSION)
    expect(r.level).toBe('ok')
    expect(r.message).toContain('兼容')
  })

  it('warns, not fails, when the server is newer than tested', () => {
    const r = checkEmbedCompat(MAX_TESTED_EMBED_SEAM_VERSION + 1)
    expect(r.level).toBe('warn')
    expect(r.message).toContain('高于本扩展已验证')
  })

  it('marks an older seam unsupported so the caller can fall back', () => {
    const r = checkEmbedCompat(MIN_EMBED_SEAM_VERSION - 1)
    expect(r.level).toBe('unsupported')
    expect(r.message).toContain('降级为浏览器打开')
  })

  it('warns when the seam is advertised without a version', () => {
    expect(checkEmbedCompat(undefined).level).toBe('warn')
  })

  it('treats non-finite versions as unsupported', () => {
    expect(checkEmbedCompat(Number.NaN).level).toBe('unsupported')
  })
})
