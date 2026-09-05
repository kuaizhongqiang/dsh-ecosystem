/**
 * High-level DSH connection for the current Typert Remote protocol.
 *
 * Replaces the legacy events.mux + dot-method RPC with:
 *   - unary RPC via POST /api/{ns}/{method} (DshRpcClient)
 *   - a /api/remote.mux WebSocket carrying logical streams:
 *       $events           → forwarded app events (approval/question waterfalls)
 *       session/control   → queue/jobs/projection live state
 *       workspace/follow  → workspace baseline + increments
 *       session/follow    → per-open-session durable event stream
 *
 * It exposes the same DshConnection surface the rest of the extension uses, so
 * consumers (store, chat, sidebar, extension) keep working against it.
 */

import { randomUUID } from 'node:crypto'
import { DshRpcClient, DshTransportError } from './rpc.ts'
import { authenticateWithToken } from './auth.ts'
import { RemoteMuxClient } from './mux.ts'
import type {
  ApprovalRequestWire,
  AgentPresetEntry,
  ModelCatalog,
  QuestionItem,
  RemoteEventDownlinkFrame,
  RemoteEventInvocationFrame,
  SessionAddress,
  SessionControlFrame,
  SessionEvent,
  SessionFollowFrame,
  SessionHistoryRecord,
  SessionId,
  SessionListEntry,
  SessionPage,
  SessionSummary,
  WorkspaceFollowFrame,
  WorkspaceView,
} from './types.ts'

export type DshEvent =
  | { kind: 'connected'; baseUrl: string }
  | { kind: 'disconnected'; reason: string }
  | { kind: 'session-event'; sessionId: SessionId; event: SessionEvent }
  | { kind: 'projection'; sessionId: SessionId; key: string; value: unknown; seq: number }
  | { kind: 'approval-requested'; sessionId: SessionId; eventId: string; frame: ApprovalRequestWire }
  | { kind: 'approval-resolved'; sessionId: SessionId; approvalId: string; outcome: string }
  | { kind: 'question-requested'; sessionId: SessionId; eventId: string; questions: QuestionItem[] }
  | { kind: 'question-resolved'; sessionId: SessionId; outcome: string }
  | { kind: 'session-jobs'; sessionId: SessionId; jobs: unknown[] }
  | { kind: 'session-queued'; sessionId: SessionId; items: unknown[] }
  | { kind: 'host-frame'; frame: { type: string; [k: string]: unknown } }
  | { kind: 'stream-error'; error: unknown }

export interface DshConnectionOptions {
  reconnectIntervalMs?: number
  /** Extra headers on every /api request and the mux WebSocket handshake. */
  extraHeaders?: Record<string, string>
  /** DSH process launch token. When present, the extension exchanges it for the
   * browser-session cookie used to authenticate /api and remote.mux. */
  token?: string
}

export type DshEventListener = (event: DshEvent) => void

export class DshConnection {
  readonly rpc: DshRpcClient
  private mux: RemoteMuxClient | undefined
  private listeners = new Set<DshEventListener>()
  private reconnectIntervalMs: number
  private readonly extraHeaders: Record<string, string>
  private readonly token: string
  private authCookie = ''
  private authDone = false
  /** 最近一次 token→cookie 交换失败原因（供 401 诊断信息展示）。 */
  private authError = ''

  // Live workspace cache kept fresh by the workspace/follow stream.
  private workspaces: WorkspaceView[] = []
  private readonly followStreams = new Map<SessionId, { close: () => void }>()
  /** Latest durable sequence per Session, learned from follow snapshot frames. */
  private readonly sessionCursors = new Map<SessionId, number>()
  private currentClientId: string | undefined

  constructor(baseUrl: string, options: DshConnectionOptions = {}) {
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 3000
    this.extraHeaders = options.extraHeaders ?? {}
    this.token = options.token ?? ''
    this.rpc = new DshRpcClient(baseUrl, { extraHeaders: this.extraHeaders })
  }

  get baseUrl(): string {
    return this.rpc.url
  }

  get connected(): boolean {
    return this.mux !== undefined && this.mux.connected
  }

  onEvent(listener: DshEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Establish the connection: authenticate, verify the server answers, then
   * open the mux stream (which reconnects itself afterwards). Idempotent.
   * Resolves once the mux WebSocket is actually open. */
  async connect(): Promise<void> {
    if (this.mux !== undefined && this.mux.connected) return
    await this.ensureAuth()
    // Verification call — throws on network failure or bad URL.
    try {
      await this.rpc.call<{ items: SessionSummary[] }>('session/list', { _request: {} })
    } catch (error) {
      if (error instanceof DshTransportError && error.status === 401) {
        const authHint = this.authError.length > 0
          ? `（认证交换失败：${this.authError}）`
          : '（已用 token 换取 cookie，但 /api 仍拒绝——请确认 dsh.serverUrl 与 token 匹配）'
        throw new Error(
          `DSH 返回 401 未授权：新版 DSH 即使本地也默认开启浏览器会话认证。请在设置里为 dsh.token 填入当前 dsh web 打印的 ?token= 值（服务重启后需更新）。${authHint}`,
        )
      }
      throw error
    }
    if (this.mux === undefined) {
      this.mux = new RemoteMuxClient(
        {
          baseUrl: this.rpc.url,
          requestHeaders: this.rpc.requestHeaders(),
          reconnectIntervalMs: this.reconnectIntervalMs,
        },
        {
          onOpen: () => {
            this.openSystemStreams()
            this.emit({ kind: 'connected', baseUrl: this.rpc.url })
          },
          onClose: (reason) => this.emit({ kind: 'disconnected', reason }),
          onError: (error) => this.emit({ kind: 'stream-error', error }),
        },
      )
      this.mux.connect()
    } else {
      this.mux.connect()
    }
    // Wait until the mux WebSocket is open (bounded) so `connected` reflects
    // reality for the caller and auto-attach runs against a live stream.
    const deadline = Date.now() + 5000
    while (!this.connected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  disconnect(): void {
    this.mux?.close()
    this.mux = undefined
    this.followStreams.clear()
  }

  dispose(): void {
    this.disconnect()
    this.listeners.clear()
  }

  // ---- auth ----

  private async ensureAuth(): Promise<void> {
    if (this.authDone) return
    this.authDone = true
    if (this.token.trim().length === 0) return
    try {
      const auth = await authenticateWithToken(this.rpc.url, this.token, this.extraHeaders)
      this.authCookie = auth.cookie
      this.rpc.applyAuth(auth)
    } catch (error) {
      // 记录失败原因，401 诊断信息会带上；非致命：未开启认证的服务仍可连。
      this.authError = error instanceof Error ? error.message : String(error)
      void this.authError
    }
  }

  // ---- sessions ----

  async listSessions(): Promise<SessionListEntry[]> {
    const result = await this.rpc.call<{ items: SessionSummary[] }>('session/list', { _request: {} })
    return result.items.map((item) => ({
      sessionId: item.sessionId,
      updatedAt: item.updatedAt,
      running: item.running,
      blank: item.blank,
      cwd: item.cwd ?? '',
      agentPreset: '',
      projections: item.projections,
    }))
  }

  async createSession(options: {
    workspaceId?: string
    cwd?: string
    sessionId?: string
    agentPreset?: string
  } = {}): Promise<{ sessionId: SessionId; agentPreset?: string }> {
    return this.rpc.call<{ sessionId: SessionId; agentPreset?: string }>('session/create', { request: options })
  }

  async history(sessionId: SessionId, maxMessages = 40): Promise<SessionPage> {
    return this.page(sessionId, maxMessages)
  }

  /** Read one message-aligned page. `throughSeq` is required by the DSH wire
   * contract; when absent, it is resolved from the followed cursor, or probed
   * via a short-lived follow opening snapshot. */
  async page(
    sessionId: SessionId,
    maxMessages = 40,
    throughSeq?: number,
    beforeSeq?: number,
  ): Promise<SessionPage> {
    const address: SessionAddress = { kind: 'session', sessionId }
    const resolvedThrough = throughSeq ?? await this.resolveThroughSeq(sessionId)
    const request: Record<string, unknown> = { address, maxMessages, throughSeq: resolvedThrough }
    if (beforeSeq !== undefined) request['beforeSeq'] = beforeSeq
    return this.rpc.call<SessionPage>('session/page', { request })
  }

  /** Latest durable sequence for a Session, from the followed cursor or a
   * short-lived follow probe. */
  private async resolveThroughSeq(sessionId: SessionId): Promise<number> {
    const cached = this.sessionCursors.get(sessionId)
    if (cached !== undefined) return cached
    const address: SessionAddress = { kind: 'session', sessionId }
    const found = await new Promise<number | undefined>((resolve) => {
      const handle = this.mux?.openStream(
        'session/follow',
        { args: { request: { address } } },
        {
          onItem: (value) => {
            const frame = value as SessionFollowFrame
            if (frame.type === 'snapshot') {
              resolve(frame.cursor)
              handle?.close()
            }
          },
          onEnd: () => resolve(undefined),
        },
      )
    })
    return found ?? -1
  }

  async prompt(
    sessionId: SessionId,
    text: string,
    mode: 'queue' | 'steer' = 'queue',
    images: { name?: string; mediaType: string; data: string }[] = [],
  ): Promise<void> {
    const requestId = randomUUID()
    const content: unknown[] = [{ type: 'text', text }]
    for (const image of images) {
      content.push({ type: 'image', mediaType: image.mediaType, data: image.data, name: image.name })
    }
    await this.rpc.call('session/prompt', {
      request: {
        requestId,
        sessionId,
        mode,
        content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    })
  }

  async cancel(sessionId: SessionId): Promise<void> {
    await this.rpc.call('session/cancel', { request: { sessionId } })
  }

  async rename(sessionId: SessionId, title: string): Promise<string> {
    const result = await this.rpc.call<{ title: string }>('session/rename', { request: { sessionId, title } })
    return result.title
  }

  async fork(sessionId: SessionId): Promise<SessionId> {
    const result = await this.rpc.call<{ sessionId: SessionId }>('session/fork', { request: { sessionId } })
    return result.sessionId
  }

  // ---- workspaces ----

  /** Current workspace cache (kept fresh by the workspace/follow stream). */
  async listWorkspaces(): Promise<WorkspaceView[]> {
    // If the follow stream hasn't delivered a baseline yet, do a one-shot read
    // is impossible (no unary list) — return whatever we have.
    return this.workspaces
  }

  async createWorkspace(path: string): Promise<{ workspace: WorkspaceView; created: boolean }> {
    return this.rpc.call<{ workspace: WorkspaceView; created: boolean }>('workspace/create', { request: { path } })
  }

  // ---- models ----

  async models(sessionId: SessionId): Promise<{
    current: { provider: string; model: string; reasoningEffort?: string } | undefined
    routable: boolean
    groups: ModelCatalog['groups']
    failures: ModelCatalog['failures']
  }> {
    const catalog = await this.rpc.call<ModelCatalog>('session/modelCatalog', {})
    return {
      current: catalog.default,
      routable: catalog.routableProviders.length > 0,
      groups: catalog.groups,
      failures: catalog.failures,
    }
  }

  async selectModel(sessionId: SessionId, provider: string, model: string): Promise<void> {
    await this.rpc.call('session/selectModel', { request: { sessionId, provider, model } })
  }

  // ---- agent presets ----

  /** DSH no longer exposes a unary preset list. Presets are chosen by id and
   * validated server-side, so we report none to disable the preset picker. */
  async listPresets(): Promise<AgentPresetEntry[]> {
    return []
  }

  // ---- responding to forwarded events (approvals / questions) ----

  /** Approve a pending tool approval waterfall. `eventId` is the $events eventId. */
  async approve(eventId: string, sessionId: SessionId, approvalId: string): Promise<void> {
    await this.respondEvent(eventId, {
      sessionId,
      approvalId,
      outcome: 'allowed-once',
    })
  }

  async reject(eventId: string, sessionId: SessionId, approvalId: string): Promise<void> {
    await this.respondEvent(eventId, {
      sessionId,
      approvalId,
      outcome: 'rejected',
    })
  }

  async answerQuestion(
    eventId: string,
    sessionId: SessionId,
    answers: { id: string; selected: string[]; custom?: string }[],
  ): Promise<void> {
    await this.respondEvent(eventId, { sessionId, answer: { answers } })
  }

  private async respondEvent(eventId: string, value: unknown): Promise<void> {
    if (this.currentClientId === undefined) {
      throw new Error('未连接到 DSH 事件流，无法应答')
    }
    await this.rpc.respondEvent({
      clientId: this.currentClientId,
      eventId,
      outcome: { kind: 'result', value },
    })
  }

  // ---- internals ----

  private openSystemStreams(): void {
    if (this.mux === undefined) return
    // $events — forwarded app events (approval/question waterfalls).
    this.mux.openStream('$events', { args: {} }, {
      onItem: (value) => this.handleEventDownlink(value as RemoteEventDownlinkFrame),
    })
    // session/control — queue/jobs/projections live state.
    this.mux.openStream('session/control', { args: {} }, {
      onItem: (value) => this.handleControlFrame(value as SessionControlFrame),
    })
    // workspace/follow — workspace baseline + increments.
    this.mux.openStream('workspace/follow', { args: {} }, {
      onItem: (value) => this.handleWorkspaceFrame(value as WorkspaceFollowFrame),
    })
  }

  /** Follow one session's durable event stream (for live chat updates). */
  followSession(sessionId: SessionId, onEvent: (event: SessionEvent) => void): { close: () => void } {
    const existing = this.followStreams.get(sessionId)
    if (existing !== undefined) return existing
    const handle: { close: () => void } = this.mux?.openStream(
      'session/follow',
      { args: { request: { address: { kind: 'session', sessionId } } } },
      {
        onItem: (value) => {
          const frame = value as SessionFollowFrame
          if (frame.type === 'snapshot') {
            this.sessionCursors.set(sessionId, frame.cursor)
            for (const record of frame.records) {
              if (record.type === 'event') onEvent(record.event as SessionEvent)
            }
            return
          }
          // a raw event frame
          if (frame.type === 'event') onEvent(frame.event as SessionEvent)
        },
        onEnd: () => this.followStreams.delete(sessionId),
      },
    ) ?? { close: () => {} }
    this.followStreams.set(sessionId, handle)
    return handle
  }

  private handleEventDownlink(frame: RemoteEventDownlinkFrame): void {
    switch (frame.type) {
      case 'ready': {
        this.currentClientId = frame.clientId
        return
      }
      case 'emit': {
        this.handleEventEmit(frame.event, frame.args)
        return
      }
      case 'waterfall': {
        this.handleWaterfall(frame)
        return
      }
      case 'cancel': {
        this.emit({ kind: 'host-frame', frame: { type: '$events/cancel', eventId: frame.eventId } })
        return
      }
    }
  }

  /** Translate forwarded Cordis `emit` frames into the host-frame vocabulary
   * the store/sidebar/extension understand. */
  private handleEventEmit(event: string, args: readonly unknown[]): void {
    switch (event) {
      case 'api-session/added': {
        const summary = args[0] as SessionSummary | undefined
        if (summary === undefined) return
        this.emit({
          kind: 'host-frame',
          frame: {
            type: 'host/session-added',
            sessionId: summary.sessionId,
            blank: summary.blank,
            cwd: summary.cwd ?? '',
            agentPreset: '',
            running: summary.running,
          },
        })
        return
      }
      case 'api-session/removed': {
        const sessionId = typeof args[0] === 'string' ? args[0] : ''
        if (sessionId.length === 0) return
        this.emit({ kind: 'host-frame', frame: { type: 'host/session-removed', sessionId } })
        return
      }
      case 'api-session/status': {
        const sessionId = typeof args[0] === 'string' ? args[0] : ''
        const running = args[1] === true
        if (sessionId.length === 0) return
        this.emit({ kind: 'host-frame', frame: { type: 'host/session-status', sessionId, running } })
        return
      }
      case 'api-session/error': {
        const sessionId = typeof args[0] === 'string' ? args[0] : ''
        const message = typeof args[1] === 'string' ? args[1] : String(args[1] ?? '')
        this.emit({
          kind: 'host-frame',
          frame: { type: 'host/session-error', sessionId, message },
        })
        return
      }
      case 'api-session/activity': {
        const sessionId = typeof args[0] === 'string' ? args[0] : ''
        const time = typeof args[1] === 'number' ? args[1] : Date.now()
        this.emit({
          kind: 'host-frame',
          frame: { type: 'host/session-activity', sessionId, time },
        })
        return
      }
      default:
        this.emit({ kind: 'host-frame', frame: { type: event, args } })
        return
    }
  }

  private handleWaterfall(frame: RemoteEventInvocationFrame): void {
    const sessionId = typeof frame.request?.sessionId === 'string'
      ? frame.request.sessionId
      : typeof frame.agentId === 'string'
        ? frame.agentId
        : ''
    switch (frame.event) {
      case 'approval/request': {
        const req = frame.request as unknown as ApprovalRequestWire
        const approvalId = typeof req.approvalId === 'string'
          ? req.approvalId
          : `${frame.agentId}/${req.toolName}/${req.callId ?? ''}`
        this.emit({
          kind: 'approval-requested',
          sessionId,
          eventId: frame.eventId,
          frame: { ...req, sessionId, approvalId },
        })
        return
      }
      case 'user-questions/request': {
        const req = frame.request as unknown as { questions?: QuestionItem[] }
        this.emit({
          kind: 'question-requested',
          sessionId,
          eventId: frame.eventId,
          questions: Array.isArray(req.questions) ? req.questions : [],
        })
        return
      }
      default:
        // Unknown waterfall — decline (next) so the Host doesn't stall.
        if (this.currentClientId !== undefined) {
          void this.rpc.respondEvent({
            clientId: this.currentClientId,
            eventId: frame.eventId,
            outcome: { kind: 'next' },
          })
        }
    }
  }

  private handleControlFrame(frame: SessionControlFrame): void {
    switch (frame.type) {
      case 'baseline': {
        for (const [sessionId, jobs] of Object.entries(frame.value.jobs)) {
          this.emit({ kind: 'session-jobs', sessionId, jobs })
        }
        for (const [sessionId, queues] of Object.entries(frame.value.queues)) {
          this.emit({ kind: 'session-queued', sessionId, items: queues })
        }
        for (const [sessionId, proj] of Object.entries(frame.value.projections)) {
          for (const [key, value] of Object.entries(proj.values)) {
            this.emit({ kind: 'projection', sessionId, key, value, seq: proj.asOfSeq })
          }
        }
        return
      }
      case 'queue': {
        this.emit({ kind: 'session-queued', sessionId: frame.sessionId, items: frame.items })
        return
      }
      case 'jobs': {
        this.emit({ kind: 'session-jobs', sessionId: frame.sessionId, jobs: frame.jobs })
        return
      }
      case 'projection': {
        this.emit({
          kind: 'projection',
          sessionId: frame.sessionId,
          key: frame.key,
          value: frame.value,
          seq: frame.seq,
        })
        return
      }
    }
  }

  private handleWorkspaceFrame(frame: WorkspaceFollowFrame): void {
    switch (frame.type) {
      case 'baseline': {
        this.workspaces = [...frame.value.items]
        return
      }
      case 'upsert': {
        const index = this.workspaces.findIndex((w) => w.workspaceId === frame.workspace.workspaceId)
        if (index >= 0) this.workspaces[index] = frame.workspace
        else this.workspaces.push(frame.workspace)
        this.emit({
          kind: 'host-frame',
          frame: { type: 'host/workspace-changed', workspace: frame.workspace },
        })
        return
      }
      case 'remove': {
        this.workspaces = this.workspaces.filter((w) => w.workspaceId !== frame.workspaceId)
        this.emit({ kind: 'host-frame', frame: { type: 'host/workspace-removed', workspaceId: frame.workspaceId } })
        return
      }
      case 'order': {
        const byId = new Map(this.workspaces.map((w) => [w.workspaceId, w]))
        this.workspaces = frame.workspaceIds
          .map((id) => byId.get(id))
          .filter((w): w is WorkspaceView => w !== undefined)
        this.emit({ kind: 'host-frame', frame: { type: 'host/workspace-order-changed', workspaceIds: frame.workspaceIds } })
        return
      }
      case 'archived':
        return
    }
  }

  private emit(event: DshEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // a listener must not break the hub
      }
    }
  }
}
