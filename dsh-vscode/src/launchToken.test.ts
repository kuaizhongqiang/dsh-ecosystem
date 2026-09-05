/**
 * Unit tests for the shared launch-token file module.
 *
 * Runs against a throwaway DSH_HOME (tmp dir) so the real ~/.dsh is never
 * touched. The same spec is implemented on the dsh-launcher side.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  clearLaunchToken,
  launchTokenFilePath,
  readLaunchToken,
  redactTokenUrl,
  tokenFromUrl,
  tokenUrlFromLogs,
  writeLaunchToken,
} from './launchToken.ts'

let home: string
let savedDshHome: string | undefined

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-launch-token-test-'))
  savedDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})

afterAll(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedDshHome
  rmSync(home, { recursive: true, force: true })
})

describe('tokenUrlFromLogs', () => {
  it('extracts the last token URL from mixed dsh output', () => {
    const text = [
      'some log line',
      'dsh web: http://127.0.0.1:3080/?token=first_token',
      'dsh web: opening the default browser; pass --no-open to disable',
      'dsh web: http://127.0.0.1:3080/?token=second_token',
    ].join('\n')
    expect(tokenUrlFromLogs(text)).toBe('http://127.0.0.1:3080/?token=second_token')
  })

  it('returns undefined when no token URL is present', () => {
    expect(tokenUrlFromLogs('plain log without token')).toBeUndefined()
    expect(tokenUrlFromLogs('')).toBeUndefined()
  })
})

describe('tokenFromUrl', () => {
  it('parses the bare token', () => {
    expect(tokenFromUrl('http://127.0.0.1:3080/?token=abc_XYZ-123')).toBe('abc_XYZ-123')
  })

  it('returns undefined for malformed input or missing token', () => {
    expect(tokenFromUrl('not a url')).toBeUndefined()
    expect(tokenFromUrl('http://127.0.0.1:3080/')).toBeUndefined()
  })
})

describe('redactTokenUrl', () => {
  it('redacts ?token= and &token= values without touching the rest', () => {
    expect(redactTokenUrl('http://127.0.0.1:3080/?token=abc_XYZ-123')).toBe('http://127.0.0.1:3080/?token=***')
    expect(redactTokenUrl('a=1&token=abc_XYZ-123&b=2')).toBe('a=1&token=***&b=2')
    expect(redactTokenUrl('http://127.0.0.1:3080/')).toBe('http://127.0.0.1:3080/')
  })

  it('keeps an already-redacted token unchanged', () => {
    expect(redactTokenUrl('http://127.0.0.1:3080/?token=***')).toBe('http://127.0.0.1:3080/?token=***')
  })
})

describe('writeLaunchToken / readLaunchToken', () => {
  it('round-trips a record and fills version/writtenAt', () => {
    writeLaunchToken({
      token: 'abc_XYZ-123',
      port: 3080,
      url: 'http://127.0.0.1:3080/?token=abc_XYZ-123',
      pid: 4242,
      source: 'dsh-vscode',
    })
    const record = readLaunchToken()
    expect(record).toBeDefined()
    expect(record?.version).toBe(1)
    expect(record?.token).toBe('abc_XYZ-123')
    expect(record?.port).toBe(3080)
    expect(record?.pid).toBe(4242)
    expect(record?.source).toBe('dsh-vscode')
    expect(record?.writtenAt).toBeTruthy()
  })

  it('creates the parent directory and writes a readable file', () => {
    const file = launchTokenFilePath()
    const raw = readFileSync(file, 'utf8')
    expect(raw).toContain('"token": "abc_XYZ-123"')
    // POSIX 上应限制为本用户可读（0600）。
    if (process.platform !== 'win32') {
      const mode = statSync(file).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('returns undefined for missing / corrupt / wrong-version files', () => {
    rmSync(launchTokenFilePath(), { force: true })
    expect(readLaunchToken()).toBeUndefined()
    // 破坏为非法 JSON
    writeFileSync(launchTokenFilePath(), '{not json', 'utf8')
    expect(readLaunchToken()).toBeUndefined()
    // 版本不符
    writeFileSync(launchTokenFilePath(), JSON.stringify({ version: 99, token: 'x', url: 'http://127.0.0.1:1/?token=x' }), 'utf8')
    expect(readLaunchToken()).toBeUndefined()
  })
})

describe('clearLaunchToken', () => {
  beforeEach(() => {
    writeLaunchToken({
      token: 'keep_me',
      url: 'http://127.0.0.1:3080/?token=keep_me',
      pid: 1001,
      source: 'dsh-vscode',
    })
  })

  it('removes the file when source and pid match the writer', () => {
    expect(readLaunchToken()).toBeDefined()
    clearLaunchToken('dsh-vscode', 1001)
    expect(readLaunchToken()).toBeUndefined()
  })

  it('keeps the file when the pid differs (another instance owns it)', () => {
    clearLaunchToken('dsh-vscode', 9999)
    expect(readLaunchToken()?.token).toBe('keep_me')
  })

  it('keeps the file when the source differs (launcher owns it)', () => {
    clearLaunchToken('dsh-launcher', 1001)
    expect(readLaunchToken()?.token).toBe('keep_me')
  })

  it('keeps the file when no pid is given and the record has one', () => {
    clearLaunchToken('dsh-vscode')
    expect(readLaunchToken()).toBeDefined()
  })

  it('removes a legacy pid-less record owned by the same source', () => {
    writeLaunchToken({ token: 'legacy', url: 'http://127.0.0.1:3080/?token=legacy', source: 'dsh-vscode' })
    clearLaunchToken('dsh-vscode', 555)
    expect(readLaunchToken()).toBeUndefined()
  })
})
