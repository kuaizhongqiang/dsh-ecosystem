/**
 * Session store: the extension-wide cache of sessions and workspaces, kept
 * fresh by session.list + live mux/host frames. UI (sidebar, status bar,
 * chat panels) subscribes via onChanged.
 */

import type { DshConnection, DshEvent } from './client/connection.ts'
import type { SessionId, SessionListEntry, WorkspaceView } from './client/types.ts'

export interface StoredSession {
  sessionId: SessionId
  updatedAt: number
  running: boolean
  blank: boolean
  cwd: string
  agentPreset: string
  title?: string
  goal?: unknown
  lastPromptAt?: number | null
  /** Higher-seq-wins projection store, keyed by projection key. */
  projections: Map<string, { value: unknown; seq: number }>
  /** Total number of turns seen (from sessionStats projection when available). */
  turns?: number
}

export type StoreChangedListener = () => void

export class SessionStore {
  private sessions = new Map<SessionId, StoredSession>()
  private workspaces: WorkspaceView[] = []
  private listeners = new Set<StoreChangedListener>()
  private disposers: (() => void)[] = []

  constructor(private readonly connection: DshConnection) {
    const off = connection.onEvent((event) => this.handleEvent(event))
    this.disposers.push(off)
  }

  get allSessions(): StoredSession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get allWorkspaces(): WorkspaceView[] {
    return this.workspaces
  }

  getSession(sessionId: SessionId): StoredSession | undefined {
    return this.sessions.get(sessionId)
  }

  onChanged(listener: StoreChangedListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    for (const disposer of this.disposers) disposer()
    this.listeners.clear()
  }

  /** Full refresh from the server (session.list + workspace.list). */
  async refresh(): Promise<void> {
    try {
      const [entries, workspaces] = await Promise.all([
        this.connection.listSessions(),
        this.connection.listWorkspaces(),
      ])
      this.applyList(entries)
      this.workspaces = workspaces
      this.emitChanged()
    } catch (error) {
      throw error
    }
  }

  async refreshWorkspaces(): Promise<void> {
    this.workspaces = await this.connection.listWorkspaces()
    this.emitChanged()
  }

  // ---- Internals ----

  private applyList(entries: SessionListEntry[]): void {
    const seen = new Set<SessionId>()
    for (const entry of entries) {
      seen.add(entry.sessionId)
      const existing = this.sessions.get(entry.sessionId)
      const projections = new Map<string, { value: unknown; seq: number }>()
      if (existing !== undefined) {
        for (const [key, p] of existing.projections) projections.set(key, p)
      }
      if (entry.projections !== undefined) {
        for (const [key, value] of Object.entries(entry.projections.values)) {
          projections.set(key, { value, seq: entry.projections.asOfSeq })
        }
      }
      const session: StoredSession = {
        sessionId: entry.sessionId,
        updatedAt: entry.updatedAt,
        running: entry.running,
        blank: entry.blank,
        cwd: entry.cwd,
        agentPreset: entry.agentPreset,
        projections,
      }
      this.applyProjectionsToSession(session)
      this.sessions.set(entry.sessionId, session)
    }
    for (const sessionId of [...this.sessions.keys()]) {
      if (!seen.has(sessionId)) this.sessions.delete(sessionId)
    }
  }

  private applyProjectionsToSession(session: StoredSession): void {
    const title = session.projections.get('title')
    session.title = typeof title?.value === 'string' ? title.value : undefined
    const goal = session.projections.get('goal')
    session.goal = goal?.value ?? undefined
    const listMeta = session.projections.get('sessionListMetadata')
    const lastPromptAt = listMeta?.value as { lastPromptAt?: number | null } | undefined
    session.lastPromptAt = lastPromptAt?.lastPromptAt ?? null
    const stats = session.projections.get('sessionStats')
    const turns = stats?.value as { turns?: number } | undefined
    session.turns = turns?.turns
  }

  private handleEvent(event: DshEvent): void {
    let changed = false
    switch (event.kind) {
      case 'projection': {
        const session = this.sessions.get(event.sessionId)
        if (session !== undefined) {
          const prev = session.projections.get(event.key)
          if (prev === undefined || event.seq >= prev.seq) {
            session.projections.set(event.key, { value: event.value, seq: event.seq })
            this.applyProjectionsToSession(session)
            changed = true
          }
        }
        break
      }
      case 'session-event': {
        const session = this.sessions.get(event.sessionId)
        if (session !== undefined) {
          session.updatedAt = event.event.time
          changed = true
        }
        break
      }
      case 'host-frame': {
        const frame = event.frame as unknown as { type: string; [k: string]: unknown }
        switch (frame.type) {
          case 'host/session-added': {
            const f = frame as unknown as { sessionId: SessionId; blank: boolean; cwd?: string; agentPreset?: string }
            if (!this.sessions.has(f.sessionId)) {
              this.sessions.set(f.sessionId, {
                sessionId: f.sessionId,
                updatedAt: Date.now(),
                running: false,
                blank: f.blank,
                cwd: f.cwd ?? '',
                agentPreset: f.agentPreset ?? 'standard',
                projections: new Map(),
              })
              changed = true
            }
            break
          }
          case 'host/session-removed': {
            const f = frame as unknown as { sessionId: SessionId }
            changed = this.sessions.delete(f.sessionId)
            break
          }
          case 'host/session-status': {
            const f = frame as unknown as { sessionId: SessionId; running: boolean }
            const session = this.sessions.get(f.sessionId)
            if (session !== undefined && session.running !== f.running) {
              session.running = f.running
              changed = true
            }
            break
          }
          case 'host/session-activity': {
            const f = frame as unknown as { sessionId: SessionId; time: number }
            const session = this.sessions.get(f.sessionId)
            if (session !== undefined && f.time > session.updatedAt) {
              session.updatedAt = f.time
              changed = true
            }
            break
          }
          case 'host/workspace-changed': {
            const f = frame as unknown as { workspace: WorkspaceView }
            const index = this.workspaces.findIndex((w) => w.workspaceId === f.workspace.workspaceId)
            if (index >= 0) this.workspaces[index] = f.workspace
            else this.workspaces.push(f.workspace)
            changed = true
            break
          }
          case 'host/workspace-removed': {
            const f = frame as unknown as { workspaceId: string }
            this.workspaces = this.workspaces.filter((w) => w.workspaceId !== f.workspaceId)
            changed = true
            break
          }
          case 'host/workspace-order-changed': {
            const f = frame as unknown as { workspaceIds: string[] }
            const byId = new Map(this.workspaces.map((w) => [w.workspaceId, w]))
            this.workspaces = f.workspaceIds
              .map((id) => byId.get(id))
              .filter((w): w is WorkspaceView => w !== undefined)
            changed = true
            break
          }
        }
        break
      }
      default:
        return
    }
    if (changed) this.emitChanged()
  }

  private emitChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // never let a UI listener break the store
      }
    }
  }
}
