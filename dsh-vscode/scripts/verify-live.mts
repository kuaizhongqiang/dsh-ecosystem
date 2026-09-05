import { authenticateWithToken } from '../src/client/auth.ts'
import { DshConnection, type DshEvent } from '../src/client/connection.ts'

const base = process.argv[2] ?? 'http://127.0.0.1:3080'
const token = process.argv[3] ?? ''

async function main(): Promise<void> {
  const auth = await authenticateWithToken(base, token, {})
  console.log('STEP cookie length:', auth.cookie.length)

  const connection = new DshConnection(base, { token })
  const approvals: unknown[] = []
  const questions: unknown[] = []
  const sessions: DshEvent[] = []
  connection.onEvent((event) => {
    if (event.kind === 'approval-requested') approvals.push(event)
    if (event.kind === 'question-requested') questions.push(event)
    if (event.kind === 'host-frame') sessions.push(event)
  })

  await connection.connect()
  console.log('STEP connect OK, mux connected =', connection.connected)

  // workspace/create (idempotent)
  try {
    const ws = await connection.createWorkspace(process.cwd())
    console.log('STEP workspace/create OK, created =', ws.created, 'id =', ws.workspace.workspaceId)
  } catch (error) {
    console.error('STEP workspace/create FAILED:', String(error))
  }

  // create + prompt that may trigger approval/question
  const seen: string[] = []
  try {
    const { sessionId } = await connection.createSession({ cwd: process.cwd() })
    console.log('STEP createSession OK, id =', sessionId)
    const follow = connection.followSession(sessionId, (event) => seen.push(event.type))
    await connection.prompt(sessionId, '用 ls 列出当前目录并返回文件数量', 'queue')
    console.log('STEP prompt sent, waiting 25s for events…')
    await new Promise((resolve) => setTimeout(resolve, 25_000))
    console.log('STEP approvals received:', approvals.length)
    console.log('STEP questions received:', questions.length)
    if (approvals.length > 0) {
      const first = approvals[0] as { eventId: string; frame: { approvalId: string; toolName: string } }
      console.log('STEP approval sample:', JSON.stringify({ eventId: first.eventId, toolName: first.frame.toolName, approvalId: first.frame.approvalId }))
      await connection.approve(first.eventId, first.frame.approvalId ? '' : '', first.frame.approvalId)
      console.log('STEP approve responded')
    }
    await connection.cancel(sessionId).catch(() => undefined)
    follow.close()
  } catch (error) {
    console.error('STEP approval scenario FAILED:', String(error))
  }

  connection.dispose()
  console.log('STEP DONE')
}

void main()
