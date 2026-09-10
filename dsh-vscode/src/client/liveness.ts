/**
 * Connection liveness (milestone #2 issue #23): turn the transport's
 * connected/disconnected events into user-facing keepalive state — how long
 * we have been offline, how many reconnect attempts happened, and how long the
 * last outage lasted. Pure and clock-injectable so it is unit-testable; the
 * extension drives it from DshConnection events and renders `text` on the
 * status bar while the mux retries in the background.
 */

export type LivenessState = 'online' | 'offline'

export interface LivenessSnapshot {
  state: LivenessState
  /** Consecutive disconnect count since the last successful connect. */
  attempts: number
  /** Milliseconds since the current outage began (0 while online). */
  offlineMs: number
  /** Duration of the previous outage, once recovered. */
  lastOutageMs?: number
  /** Status-bar text: short and stable for repeated renders. */
  text: string
}

export class ConnectionLiveness {
  private state: LivenessState = 'offline'
  private attempts = 0
  private offlineSince: number | undefined
  private lastOutageMs: number | undefined

  constructor(private readonly now: () => number = () => Date.now()) {}

  onConnected(): void {
    if (this.offlineSince !== undefined) {
      this.lastOutageMs = Math.max(0, this.now() - this.offlineSince)
    }
    this.state = 'online'
    this.attempts = 0
    this.offlineSince = undefined
  }

  onDisconnected(): void {
    if (this.state !== 'online' && this.offlineSince !== undefined) {
      // Repeated close events during one outage: keep timing, count attempts.
      this.attempts += 1
      return
    }
    this.state = 'offline'
    this.offlineSince = this.now()
    this.attempts = 1
  }

  get recoveredText(): string | undefined {
    if (this.lastOutageMs === undefined || this.lastOutageMs < 1000) return undefined
    return `连接已恢复（断开 ${formatDuration(this.lastOutageMs)}）`
  }

  snapshot(): LivenessSnapshot {
    const online = this.state === 'online'
    const offlineMs = online || this.offlineSince === undefined ? 0 : Math.max(0, this.now() - this.offlineSince)
    return {
      state: this.state,
      attempts: this.attempts,
      offlineMs,
      ...(this.lastOutageMs !== undefined ? { lastOutageMs: this.lastOutageMs } : {}),
      text: online ? '已连接' : this.outageText(offlineMs),
    }
  }

  private outageText(offlineMs: number): string {
    const base = this.attempts > 1 ? `重连中（第 ${String(this.attempts)} 次）` : '连接断开，重连中'
    return offlineMs > 0 ? `${base} · ${formatDuration(offlineMs)}` : base
  }
}

/** Compact duration: 12s / 3m05s / 1h02m. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${String(totalSeconds)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${String(minutes)}m${String(seconds).padStart(2, '0')}s`
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, '0')}m`
}
