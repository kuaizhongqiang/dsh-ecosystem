import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  buildBrowserUrl,
  buildSeamOpenUrl,
  decideEmbed,
  probeSeamCapability,
  resetSeamCapabilityCache,
  EMBED_CAPABILITY_PATH,
} from './embedModel.ts'

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response
}

afterEach(() => resetSeamCapabilityCache())

describe('buildSeamOpenUrl', () => {
  it('encodes token and session path', () => {
    const u = buildSeamOpenUrl('http://127.0.0.1:3080/', 'tok +abc', 'sess-1 /x')
    expect(u).toBe('http://127.0.0.1:3080/api/embed/open?t=tok%20%2Babc&path=%2Fsession%2Fsess-1%20%2Fx')
  })
  it('root path when no session', () => {
    expect(buildSeamOpenUrl('http://127.0.0.1:3080', 'tok')).toContain('path=%2F')
  })
})

describe('buildBrowserUrl', () => {
  it('token root url', () => {
    expect(buildBrowserUrl('http://127.0.0.1:3080', 't k')).toBe('http://127.0.0.1:3080/?token=t%20k')
  })
  it('plain base without token', () => {
    expect(buildBrowserUrl('http://127.0.0.1:3080/')).toBe('http://127.0.0.1:3080/')
  })
})

describe('probeSeamCapability', () => {
  it('true when seam=true', async () => {
    const f = vi.fn(async () => jsonResponse({ seam: true }))
    await expect(probeSeamCapability('http://x:1', { fetchImpl: f as unknown as typeof fetch })).resolves.toBe(true)
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('false on 404 / non-json / error / timeout', async () => {
    await expect(probeSeamCapability('http://x:1', { fetchImpl: (async () => jsonResponse({}, 404)) as typeof fetch })).resolves.toBe(false)
    await expect(probeSeamCapability('http://x:2', { fetchImpl: (async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' } })) as unknown as typeof fetch })).resolves.toBe(false)
    await expect(probeSeamCapability('http://x:3', { fetchImpl: (async () => { throw new Error('boom') }) as unknown as typeof fetch })).resolves.toBe(false)
  })
  it('caches by base and honors cache:false + reset', async () => {
    const f = vi.fn(async () => jsonResponse({ seam: true }))
    const impl = f as unknown as typeof fetch
    await probeSeamCapability('http://c:1', { fetchImpl: impl })
    await probeSeamCapability('http://c:1', { fetchImpl: impl })
    expect(f).toHaveBeenCalledTimes(1)
    resetSeamCapabilityCache()
    await probeSeamCapability('http://c:1', { fetchImpl: impl })
    expect(f).toHaveBeenCalledTimes(2)
    await probeSeamCapability('http://c:2', { fetchImpl: impl, cache: false })
    await probeSeamCapability('http://c:2', { fetchImpl: impl, cache: false })
    expect(f).toHaveBeenCalledTimes(4)
  })
  it('requests capability path with accept header', async () => {
    const f = vi.fn(async () => jsonResponse({ enabled: 'true' }))
    await probeSeamCapability('http://d:1', { fetchImpl: f as unknown as typeof fetch })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://d:1' + EMBED_CAPABILITY_PATH)
    expect((init.headers as Record<string, string>)?.Accept).toBe('application/json')
  })
})

describe('decideEmbed', () => {
  it('no base -> unreachable fallback', async () => {
    const d = await decideEmbed({ base: '', token: 't' })
    expect(d.kind).toBe('fallback')
    expect(d.reason).toBe('unreachable')
  })
  it('no token -> no-token fallback (never probes)', async () => {
    const f = vi.fn()
    const d = await decideEmbed({ base: 'http://x:1', token: undefined }, { fetchImpl: f as unknown as typeof fetch })
    expect(d.kind).toBe('fallback')
    expect(d.reason).toBe('no-token')
    expect(f).not.toHaveBeenCalled()
  })
  it('seam available -> embed url with session deep-link', async () => {
    const d = await decideEmbed(
      { base: 'http://127.0.0.1:3080', token: 'tok', sessionId: 's1' },
      { fetchImpl: (async () => jsonResponse({ seam: true })) as unknown as typeof fetch },
    )
    expect(d.kind).toBe('embed')
    if (d.kind === 'embed') {
      expect(d.url).toContain('/api/embed/open?t=tok&path=%2Fsession%2Fs1')
      expect(d.reason).toBe('seam')
    }
  })
  it('no seam -> fallback with browser token url', async () => {
    const d = await decideEmbed(
      { base: 'http://127.0.0.1:3080/', token: 'tok', sessionId: 's2' },
      { fetchImpl: (async () => jsonResponse({}, 404)) as unknown as typeof fetch },
    )
    expect(d.kind).toBe('fallback')
    if (d.kind === 'fallback') {
      expect(d.reason).toBe('no-seam')
      expect(d.browserUrl).toBe('http://127.0.0.1:3080/?token=tok')
    }
  })
})
