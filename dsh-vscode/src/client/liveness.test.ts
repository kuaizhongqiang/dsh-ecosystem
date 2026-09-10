import { describe, expect, it } from 'vitest'
import { ConnectionLiveness, formatDuration } from './liveness.ts'

function clock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(12_400)).toBe('12s')
    expect(formatDuration(185_000)).toBe('3m05s')
    expect(formatDuration(3_720_000)).toBe('1h02m')
  })
})

describe('ConnectionLiveness', () => {
  it('starts offline and reports the first outage', () => {
    const c = clock()
    const l = new ConnectionLiveness(c.now)
    l.onDisconnected()
    c.advance(5_000)
    const snap = l.snapshot()
    expect(snap.state).toBe('offline')
    expect(snap.attempts).toBe(1)
    expect(snap.offlineMs).toBe(5_000)
    expect(snap.text).toBe('连接断开，重连中 · 5s')
  })

  it('counts repeated close events within one outage', () => {
    const c = clock()
    const l = new ConnectionLiveness(c.now)
    l.onDisconnected()
    c.advance(3_000)
    l.onDisconnected()
    c.advance(3_000)
    l.onDisconnected()
    expect(l.snapshot().attempts).toBe(3)
    expect(l.snapshot().text).toContain('第 3 次')
    expect(l.snapshot().offlineMs).toBe(6_000)
  })

  it('reports recovery text after a meaningful outage and resets on connect', () => {
    const c = clock()
    const l = new ConnectionLiveness(c.now)
    l.onDisconnected()
    c.advance(9_000)
    l.onConnected()
    expect(l.snapshot().state).toBe('online')
    expect(l.snapshot().attempts).toBe(0)
    expect(l.snapshot().offlineMs).toBe(0)
    expect(l.snapshot().lastOutageMs).toBe(9_000)
    expect(l.recoveredText).toBe('连接已恢复（断开 9s）')
  })

  it('suppresses recovery noise for blips under a second', () => {
    const c = clock()
    const l = new ConnectionLiveness(c.now)
    l.onDisconnected()
    c.advance(400)
    l.onConnected()
    expect(l.recoveredText).toBeUndefined()
  })
})
