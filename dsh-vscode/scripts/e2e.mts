/**
 * End-to-end test: create a session, send a prompt, watch the session/follow
 * stream for user/message + assistant/message events, then cancel. Exercises
 * exactly the pipeline the extension's chat panel uses. Costs a negligible
 * amount of model tokens (prompt asks for a one-word reply).
 *
 * Run: node --experimental-strip-types scripts/e2e.mts http://127.0.0.1:3080 [token]
 */
import { DshConnection } from '../src/client/connection.ts'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3080'
const token = process.argv[3] ?? ''

async function main(): Promise<void> {
  const connection = new DshConnection(baseUrl, { reconnectIntervalMs: 1000, token })
  await connection.connect()
  const deadline = Date.now() + 5000
  while (!connection.connected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  console.log('mux connected:', connection.connected)

  const { sessionId } = await connection.createSession({ cwd: process.cwd() })
  console.log('session created:', sessionId)

  const seen: string[] = []
  const follow = connection.followSession(sessionId, (event) => {
    seen.push(event.type)
  })

  await connection.prompt(sessionId, '只回复三个字：测试通过', 'queue')
  console.log('prompt sent, waiting for assistant/message…')

  const watchDeadline = Date.now() + 90_000
  while (Date.now() < watchDeadline) {
    if (seen.includes('assistant/message')) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  const history = await connection.history(sessionId, 3)
  const records = history.records.filter((entry) =>
    entry.type === 'event'
    && (entry.event.type === 'user/message' || entry.event.type === 'assistant/message'))
  console.log('--- captured messages ---')
  for (const record of records) {
    if (record.type !== 'event') continue
    const data = record.event.data as { role?: string; content?: { type: string; text?: string }[] }
    const text = (data.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .slice(0, 200)
    console.log(`[${record.event.type}] ${text}`)
  }
  const ok = records.some((r) => r.type === 'event' && r.event.type === 'user/message')
    && records.some((r) => r.type === 'event' && r.event.type === 'assistant/message')
  console.log(ok ? 'PASS e2e prompt → stream → history' : 'FAIL e2e')
  await connection.cancel(sessionId).catch(() => undefined)
  follow.close()
  connection.dispose()
  process.exit(ok ? 0 : 1)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
