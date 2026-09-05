/**
 * DSH wire protocol types — the minimal subset the extension speaks.
 * Mirrors the shapes in @deepseek-ai/dsh-host-apiproxy/api and the mux frame
 * union from the events contract. Keep this file dependency-free.
 */

// ---- RPC envelope ----

export type RpcId = string

export interface RpcError {
  code: string
  message: string
  details: unknown
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

export interface ClientRequest {
  type: 'client-request'
  rpcId: RpcId
  method: string
  payload: unknown
}

export interface ServerResponse {
  type: 'server-response'
  rpcId: RpcId
  result: RpcResult<unknown>
}

export interface ServerRequest {
  type: 'server-request'
  rpcId: RpcId
  method: string
  payload: unknown
}

export interface ClientResponse {
  type: 'client-response'
  rpcId: RpcId
  result: RpcResult<unknown>
}

// ---- Session ----

export type SessionId = string

/** One Session list entry as returned by session/list. */
export interface SessionSummary {
  sessionId: SessionId
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: SessionId
  origin?: 'subagent'
  cwd?: string
  projections?: {
    asOfSeq: number
    values: Record<string, unknown>
  }
}

export interface SessionListEntry {
  sessionId: SessionId
  updatedAt: number
  running: boolean
  blank: boolean
  cwd: string
  agentPreset: string
  projections?: {
    asOfSeq: number
    values: Record<string, unknown>
  }
}

export interface SessionListResult {
  items: SessionListEntry[]
}

export interface HistoryEntry {
  event: SessionEvent
  view?: unknown
}

export interface SessionHistoryResult {
  events: HistoryEntry[]
  hasMore: boolean
  projections?: {
    asOfSeq: number
    values: Record<string, unknown>
  }
}

// ---- Session events (wire view of the dsh-session log) ----

export interface SessionEventBase {
  seq: number
  type: string
  time: number
  source?: { kind: string; [k: string]: unknown }
  data: Record<string, unknown>
}

export type SessionEvent = SessionEventBase

/** User message projected by a user/message event. */
export interface UserMessageEvent {
  seq: number
  time: number
  type: 'user/message'
  data: {
    content: ContentBlock[]
    source?: { kind: string; [k: string]: unknown }
    role: 'user'
    id: string
  }
}

export interface AssistantChunkEvent {
  seq: number
  time: number
  type: 'assistant/chunk'
  data: { turn: number; step: number; chunk: StreamChunk }
}

export interface AssistantMessageEvent {
  seq: number
  time: number
  type: 'assistant/message'
  data: {
    turn: number
    step: number
    message: AssistantMessage
    interrupted?: true
  }
}

export interface ToolCallEvent {
  seq: number
  time: number
  type: 'tool/call'
  data: { turn: number; step: number; callId: string; name: string; arguments: string }
}

export interface ToolResultEvent {
  seq: number
  time: number
  type: 'tool/result'
  data: {
    turn: number
    step: number
    message: ToolResultMessage
    error?: { name: string; code: string }
  }
}

export interface TurnStartEvent {
  seq: number
  time: number
  type: 'turn/start'
  data: { turn: number }
}

export interface TurnEndEvent {
  seq: number
  time: number
  type: 'turn/end'
  data: { turn: number; reason: { kind: string; [k: string]: unknown } }
}

// ---- Content blocks & messages ----

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

export interface ImageBlock {
  type: 'image'
  attachment: unknown
}

export interface ToolCallBlock {
  type: 'tool-call'
  id: string
  name: string
  arguments: string
}

export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: string
  content: ContentBlock[]
  isError?: boolean
}

export type ContentBlock = TextBlock | ReasoningBlock | ImageBlock | ToolCallBlock | ToolResultBlock

export interface AssistantMessage {
  role: 'assistant'
  content: ContentBlock[]
  finishReason?: unknown
  source?: { kind: string; provider?: string; model?: string }
  id?: string
}

export interface ToolResultMessage {
  role: 'tool'
  source?: { kind: 'tool'; callId?: string }
  content: ContentBlock[]
  isError?: boolean
}

export type StreamChunk =
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name: string; argumentsDelta: string }
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: unknown }
  | { type: 'finish'; reason: unknown }
  | { type: 'unknown-chunk' }

// ---- Mux stream frames ----

export interface MuxEventFrame {
  type: 'session/event'
  sessionId: SessionId
  event: SessionEvent
  view?: unknown
}

export interface MuxSubscribedFrame {
  type: 'session/subscribed'
  sessionId: SessionId
  lastSeq: number
}

export interface MuxProjectionFrame {
  type: 'session/projection'
  sessionId: SessionId
  key: string
  value: unknown
  seq: number
}

export interface ApprovalRequestedFrame {
  type: 'approval/requested'
  sessionId: SessionId
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
}

export interface ApprovalResolvedFrame {
  type: 'approval/resolved'
  sessionId: SessionId
  approvalId: string
  outcome: 'allowed-once' | 'rejected' | string
}

export interface QuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
  intent?: { kind: string; approve?: string }
}

export interface QuestionRequestedFrame {
  type: 'question/requested'
  sessionId: SessionId
  questions: QuestionItem[]
}

export interface QuestionResolvedFrame {
  type: 'question/resolved'
  sessionId: SessionId
  questionRpcId: string
  outcome: string
}

export interface SessionQueueFrame {
  type: 'session/queue'
  sessionId: SessionId
  items: unknown[]
}

export interface SessionJobsFrame {
  type: 'session/jobs'
  sessionId: SessionId
  jobs: unknown[]
}

export interface StreamErrorFrame {
  type: 'stream/error'
  error: RpcError
}

export type MuxFrame =
  | MuxEventFrame
  | MuxSubscribedFrame
  | MuxProjectionFrame
  | ApprovalRequestedFrame
  | ApprovalResolvedFrame
  | QuestionRequestedFrame
  | QuestionResolvedFrame
  | SessionQueueFrame
  | SessionJobsFrame
  | StreamErrorFrame
  | { type: string; sessionId?: SessionId; [k: string]: unknown }

export interface HostFrameBase {
  type: string
  [k: string]: unknown
}

export type HostFrame = HostFrameBase

// ---- Responses ----

export interface ApprovalResponsePayload {
  sessionId: SessionId
  approvalId: string
  outcome: 'allowed-once' | 'rejected'
}

export interface QuestionResponsePayload {
  sessionId: SessionId
  answer: {
    answers: { id: string; selected: string[]; custom?: string }[]
  }
}

// ---- Workspace ----

export type WorkspaceId = string

export interface WorkspaceView {
  workspaceId: WorkspaceId
  path: string
  title: string
  sessionIds: SessionId[]
  createdAt: string
  updatedAt: string
}

// ---- Models & presets ----

export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: unknown
}

export interface ModelProviderGroup {
  id: string
  name: string
  models: ModelCatalogModel[]
}

export interface SessionModels {
  current: { provider: string; model: string; reasoningEffort?: string }
  routable: boolean
  groups: ModelProviderGroup[]
  failures: { id: string; name: string; message: string }[]
}

export interface AgentPresetEntry {
  id: string
  trust: 'system' | 'user'
  isDefault: boolean
}

// ---- New DSH wire protocol (Typert Remote / API Gateway) ----
// The current DSH speaks namespace/method endpoints with { args } payloads and
// carries streams over /api/remote.mux. Types below mirror the wire exactly.

/** Standard Remote payload wrapper: every unary/stream method receives { args }. */
export interface RemoteArgsPayload<T = unknown> {
  args: T
}

/** Durable Session address for page/follow/prompt operations. */
export type SessionAddress =
  | { kind: 'session'; sessionId: SessionId }
  | { kind: 'subagent'; parentSessionId: SessionId; childSessionId: SessionId; mode: 'one-shot' | 'continuable' }

// ---- remote.mux stream frames ----

export interface RemoteStreamOpenMessage {
  type: 'open'
  streamId: string
  endpoint: string
  payload: unknown
}

export interface RemoteStreamCancelMessage {
  type: 'cancel'
  streamId: string
}

export type RemoteStreamClientMessage = RemoteStreamOpenMessage | RemoteStreamCancelMessage

export interface RemoteStreamItem {
  type: 'item'
  streamId: string
  value?: unknown
}

export interface RemoteStreamEnd {
  type: 'end'
  streamId: string
}

export interface RemoteStreamError {
  type: 'error'
  streamId: string
  error: { code: string; message: string; details: object }
}

export type RemoteStreamServerMessage = RemoteStreamItem | RemoteStreamEnd | RemoteStreamError

/** WebSocket route carrying every Typert Remote stream. */
export const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'
/** Gateway-internal logical stream carrying selected Cordis events. */
export const REMOTE_EVENT_STREAM_ENDPOINT = '$events'
/** Empty payload used to open the forwarded-event stream. */
export const REMOTE_EVENT_STREAM_PAYLOAD = { args: {} } as const
/** Unary endpoint returning one Remote Event outcome. */
export const REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'

// ---- $events forwarded-event frames ----

export interface RemoteEventReadyFrame {
  type: 'ready'
  clientId: string
  host: { home: string }
}

export interface RemoteEventEmitFrame {
  type: 'emit'
  event: string
  args: readonly unknown[]
}

export interface RemoteEventInvocationFrame {
  type: 'waterfall'
  event: string
  eventId: string
  agentId: string
  request: Readonly<Record<string, unknown>>
}

export interface RemoteEventCancellationFrame {
  type: 'cancel'
  eventId: string
}

export type RemoteEventDownlinkFrame =
  | RemoteEventReadyFrame
  | RemoteEventEmitFrame
  | RemoteEventInvocationFrame
  | RemoteEventCancellationFrame

/** Client response to one scoped Remote Event delivery. */
export interface RemoteEventResultPayload {
  clientId: string
  eventId: string
  outcome:
    | { kind: 'next' }
    | { kind: 'result'; value?: unknown }
    | { kind: 'rejected'; error: { name: string; message: string; code?: string; details?: unknown } }
}

// ---- session follow / page / control ----

/** One raw Session event in the Remote journal. */
export interface SessionWireEvent {
  type: string
  seq: number
  time: number
  data: unknown
  sourceEventSeqs?: number[]
  surfaceOp?: unknown
}

/** One history-page record: a raw event or a packed Assistant delta run. */
export type SessionHistoryRecord =
  | { type: 'event'; event: SessionWireEvent }
  | { type: 'chunks'; event: { type: string; seq: number; time: number; data: unknown } }

/** Session follow request. */
export interface SessionFollowRequest {
  address: SessionAddress
  maxMessages?: number
}

/** Complete opening window followed by ordered events. */
export type SessionFollowFrame =
  | {
    type: 'snapshot'
    header: unknown
    cursor: number
    records: SessionHistoryRecord[]
    hasMore: boolean
    projections: { asOfSeq: number; values: Record<string, unknown> }
  }
  | SessionHistoryRecord

/** One contiguous backwards page of a Session log. */
export interface SessionPage {
  records: SessionHistoryRecord[]
  hasMore: boolean
}

/** Session page request. */
export interface SessionPageRequest {
  address: SessionAddress
  throughSeq: number
  beforeSeq?: number
  maxMessages?: number
}

/** One pending inbox occurrence in the authoritative queue snapshot. */
export interface SessionQueuedItem {
  id: string
  placement: 'queued' | 'steering' | 'context'
  rpcId?: string
  message: { id: string; content: unknown[] }
}

/** Browser-safe background-job row. */
export interface SessionJob {
  id: string
  kind: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  detail?: string
  startedAt: number
  finishedAt?: number
}

/** Host-wide live control state. Each generation starts with one baseline. */
export type SessionControlFrame =
  | {
    type: 'baseline'
    value: {
      queues: Record<SessionId, SessionQueuedItem[]>
      jobs: Record<SessionId, SessionJob[]>
      projections: Record<SessionId, { asOfSeq: number; values: Record<string, unknown> }>
    }
  }
  | { type: 'queue'; sessionId: SessionId; items: SessionQueuedItem[] }
  | { type: 'jobs'; sessionId: SessionId; jobs: SessionJob[] }
  | { type: 'projection'; sessionId: SessionId; key: string; value: unknown; seq: number }

// ---- workspace ----

export interface WorkspaceBaseline {
  items: WorkspaceView[]
  archivedSessionIds: string[]
}

export type WorkspaceFollowFrame =
  | { type: 'baseline'; value: WorkspaceBaseline }
  | { type: 'upsert'; workspace: WorkspaceView }
  | { type: 'remove'; workspaceId: WorkspaceId }
  | { type: 'order'; workspaceIds: WorkspaceId[] }
  | { type: 'archived'; archivedSessionIds: string[] }

// ---- model catalog ----

export interface ModelCatalog {
  default: { provider: string; model: string; reasoningEffort?: string }
  routableProviders: string[]
  groups: ModelProviderGroup[]
  failures: { id: string; name: string; message: string }[]
}

// ---- approval / question waterfall request payloads (via $events) ----

/** Payload of an `approval/request` waterfall event. */
export interface ApprovalRequestWire {
  sessionId?: string
  agentId?: string
  toolName: string
  callId?: string
  reason?: string
  [k: string]: unknown
}

/** Payload of a `user-questions/request` waterfall event. */
export interface UserQuestionsRequestWire {
  questions: QuestionItem[]
  [k: string]: unknown
}

/** Response for an approval/request waterfall. */
export interface ApprovalResponseWire {
  sessionId?: string
  approvalId?: string
  outcome: 'allowed-once' | 'rejected' | string
  [k: string]: unknown
}

/** Response for a user-questions/request waterfall. */
export interface UserQuestionsResponseWire {
  sessionId?: string
  answer: { answers: { id: string; selected: string[]; custom?: string }[] }
  [k: string]: unknown
}
