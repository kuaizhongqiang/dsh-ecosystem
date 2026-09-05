// In-memory ring buffer for dsh server output + app log messages.
// Pushed to renderers via 'app:event' { type: 'log', entry }.
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { LOG_RING_SIZE } from './constants.js'

export type LogLevel = 'info' | 'warn' | 'error'
export type LogSource = 'connect' | 'launcher' | 'app' | 'updater'

export interface LogEntry {
  id: number
  ts: number
  level: LogLevel
  source: LogSource
  text: string
}

class LogStore extends EventEmitter {
  private ring: LogEntry[] = []
  private nextId = 1

  push(level: LogLevel, source: LogSource, text: string): void {
    const now = Date.now()
    for (const line of String(text).split(/\r?\n/)) {
      if (line.length === 0) continue
      const entry: LogEntry = { id: this.nextId++, ts: now, level, source, text: line }
      this.ring.push(entry)
      if (this.ring.length > LOG_RING_SIZE) this.ring.shift()
      this.emit('entry', entry)
    }
  }

  info(source: LogSource, text: string): void { this.push('info', source, text) }
  warn(source: LogSource, text: string): void { this.push('warn', source, text) }
  error(source: LogSource, text: string): void { this.push('error', source, text) }

  getRecent(n = 500): LogEntry[] {
    return this.ring.slice(-n)
  }

  clear(): void {
    this.ring = []
    this.emit('cleared')
  }

  exportTo(filePath: string): void {
    const body = this.ring
      .map((e) => `[${new Date(e.ts).toISOString()}] [${e.level}] [${e.source}] ${e.text}`)
      .join('\n')
    writeFileSync(filePath, body + '\n', 'utf8')
  }
}

export const logs = new LogStore()
