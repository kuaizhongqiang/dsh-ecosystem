/**
 * Remote stream mux client: a WebSocket to {base}/api/remote.mux.
 *
 * The current DSH carries every logical stream (session/follow, session/control,
 * workspace/follow, $events) over one multiplexed WebSocket. The client opens a
 * stream by sending `{ type:'open', streamId, endpoint, payload:{args} }` and
 * the server replies with `{ type:'item', streamId, value }` frames, terminating
 * each stream with `{ type:'end'|'error', streamId }`.
 *
 * This client reconnects with backoff and re-opens the previously requested
 * streams. It uses the `ws` package (not the Node global WebSocket) so the
 * handshake can carry the auth `Cookie` header.
 */

import WebSocket from 'ws'
import type {
  RemoteStreamClientMessage,
  RemoteStreamOpenMessage,
  RemoteStreamServerMessage,
} from './types.ts'

/** Callbacks scoped to one logical stream. */
export interface RemoteStreamCallbacks {
  onItem?: (value: unknown) => void
  onEnd?: () => void
  onError?: (error: unknown) => void
}

/** One requested (or active) logical stream. */
interface StreamSlot {
  readonly streamId: string
  readonly endpoint: string
  readonly payload: unknown
  readonly callbacks: RemoteStreamCallbacks
}

export interface RemoteMuxCallbacks {
  onOpen?: () => void
  onClose?: (reason: string) => void
  onError?: (error: unknown) => void
}

export interface RemoteMuxOptions {
  baseUrl: string
  /** Auth cookie / extra headers for the WebSocket handshake. */
  requestHeaders?: Record<string, string>
  /** Reconnect interval after an unexpected close (ms). */
  reconnectIntervalMs?: number
  /** Max consecutive reconnect attempts before giving up (0 = unlimited). */
  maxReconnects?: number
}

const SOCKET_CLOSED_BY_US = 4000
const OPENED_STREAM_PREFIX = 'ds'

export class RemoteMuxClient {
  private readonly baseUrl: string
  private readonly requestHeaders: Record<string, string>
  private readonly reconnectIntervalMs: number
  private readonly maxReconnects: number
  private readonly callbacks: RemoteMuxCallbacks
  private socket: WebSocket | undefined
  private closedByUs = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private aborted = false
  private readonly streams = new Map<string, StreamSlot>()
  private streamCounter = 0

  constructor(options: RemoteMuxOptions, callbacks: RemoteMuxCallbacks = {}) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.requestHeaders = { ...(options.requestHeaders ?? {}) }
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 3000
    this.maxReconnects = options.maxReconnects ?? 0
    this.callbacks = callbacks
  }

  get connected(): boolean {
    return this.socket !== undefined && this.socket.readyState === WebSocket.OPEN
  }

  connect(): void {
    if (this.socket !== undefined && this.socket.readyState === WebSocket.OPEN) return
    this.closedByUs = false
    this.openSocket()
  }

  /** Close for good; stops reconnecting and drops all streams. */
  close(): void {
    this.aborted = true
    this.closedByUs = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.socket !== undefined) {
      try {
        this.socket.close(SOCKET_CLOSED_BY_US, 'client closed')
      } catch {
        // already gone
      }
      this.socket = undefined
    }
    for (const slot of [...this.streams.values()]) {
      this.streams.delete(slot.streamId)
      slot.callbacks.onEnd?.()
    }
  }

  /**
   * Open one logical stream. Returns a handle to cancel it. If the socket is
   * not yet connected, the open is queued and sent after connect.
   */
  openStream(endpoint: string, payload: unknown, callbacks: RemoteStreamCallbacks): { close: () => void } {
    const streamId = `${OPENED_STREAM_PREFIX}${++this.streamCounter}`
    const slot: StreamSlot = { streamId, endpoint, payload, callbacks }
    this.streams.set(streamId, slot)
    this.sendOpen(slot)
    return {
      close: () => {
        this.cancelStream(streamId)
      },
    }
  }

  /** Cancel one logical stream. */
  private cancelStream(streamId: string): void {
    const slot = this.streams.get(streamId)
    if (slot === undefined) return
    this.streams.delete(streamId)
    if (this.socket !== undefined && this.socket.readyState === WebSocket.OPEN) {
      const message: RemoteStreamClientMessage = { type: 'cancel', streamId }
      this.sendJson(message)
    }
    slot.callbacks.onEnd?.()
  }

  private sendOpen(slot: StreamSlot): void {
    if (this.socket === undefined || this.socket.readyState !== WebSocket.OPEN) return
    const message: RemoteStreamOpenMessage = {
      type: 'open',
      streamId: slot.streamId,
      endpoint: slot.endpoint,
      payload: slot.payload,
    }
    this.sendJson(message)
  }

  private sendJson(message: RemoteStreamClientMessage): void {
    if (this.socket === undefined || this.socket.readyState !== WebSocket.OPEN) return
    try {
      this.socket.send(JSON.stringify(message))
    } catch {
      // ignored; the close handler owns recovery
    }
  }

  private openSocket(): void {
    if (this.aborted) return
    const url = new URL('/api/remote.mux', this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    let socket: WebSocket
    try {
      socket = new WebSocket(url, { headers: this.requestHeaders })
    } catch (error) {
      this.emitError(error)
      return
    }
    this.socket = socket

    socket.on('open', () => {
      this.reconnectAttempts = 0
      // Re-open every requested stream on this fresh generation.
      for (const slot of this.streams.values()) this.sendOpen(slot)
      this.callbacks.onOpen?.()
    })

    socket.on('message', (data) => {
      let message: RemoteStreamServerMessage
      try {
        const raw = typeof data === 'string' ? data : data.toString()
        message = JSON.parse(raw) as RemoteStreamServerMessage
      } catch {
        return // malformed frame — drop
      }
      this.handleServerMessage(message)
    })

    socket.on('close', (code, reason) => {
      if (this.socket === socket) this.socket = undefined
      this.callbacks.onClose?.(reason.toString() || `code ${code}`)
      if (!this.closedByUs && !this.aborted) this.scheduleReconnect()
    })

    socket.on('error', (error) => {
      // 'close' always follows 'error'; the close handler owns recovery.
      this.emitError(error)
    })
  }

  private handleServerMessage(message: RemoteStreamServerMessage): void {
    const slot = this.streams.get(message.streamId)
    switch (message.type) {
      case 'item': {
        slot?.callbacks.onItem?.(message.value)
        return
      }
      case 'end': {
        if (slot !== undefined) this.streams.delete(message.streamId)
        slot?.callbacks.onEnd?.()
        return
      }
      case 'error': {
        if (slot !== undefined) this.streams.delete(message.streamId)
        slot?.callbacks.onError?.(message.error)
        slot?.callbacks.onEnd?.()
        return
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.aborted) return
    if (this.maxReconnects > 0 && this.reconnectAttempts >= this.maxReconnects) {
      this.emitError(new Error(`事件流重连失败（已达 ${this.maxReconnects} 次上限）`))
      return
    }
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => this.openSocket(), this.reconnectIntervalMs)
  }

  private emitError(error: unknown): void {
    this.callbacks.onError?.(error)
  }
}
