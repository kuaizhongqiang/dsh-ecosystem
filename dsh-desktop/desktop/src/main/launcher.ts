// dsh-launcher delegation.
//
// The desktop is a pure shell and never spawns dsh. To start the shared server
// it asks dsh-launcher (which installs dsh and runs it as its own bound child
// with a hidden console): `dsh-launcher.exe start --no-browser` stays resident
// and owns the server — closing the desktop does not stop it, matching
// "whoever started first carries the server".
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LAUNCHER_EXE, LAUNCHER_START_ARGS, LAUNCHER_STOP_ARGS, READY_TIMEOUT_MS, PROBE_INTERVAL_MS } from './constants.js'
import { preflight } from './connect.js'
import { logs } from './log-store.js'
import { getSettings } from './settings.js'

/** Candidate launcher locations (checked in order, first hit wins). */
export function launcherCandidates(): string[] {
  const list: string[] = []
  const settings = getSettings()
  if (settings.launcherPath.trim()) list.push(settings.launcherPath.trim())

  // PATH
  const pathDirs = (process.env.PATH ?? '').split(';').filter((d) => d.trim().length > 0)
  for (const dir of pathDirs) list.push(join(dir, LAUNCHER_EXE))

  // Common install locations
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  // NSIS per-user install dir (electron-builder default)
  list.push(join(local, 'Programs', 'dsh-launcher', LAUNCHER_EXE))
  list.push(join(local, 'dsh-launcher', LAUNCHER_EXE))
  const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files'
  list.push(join(programFiles, 'dsh-launcher', LAUNCHER_EXE))
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
  list.push(join(programFilesX86, 'dsh-launcher', LAUNCHER_EXE))
  return list
}

/** Resolve the dsh-launcher.exe path ('' when not found). */
export function findLauncher(): string {
  for (const candidate of launcherCandidates()) {
    if (candidate && existsSync(candidate)) {
      logs.info('launcher', `found dsh-launcher: ${candidate}`)
      return candidate
    }
  }
  return ''
}

export function launcherFound(): boolean {
  return findLauncher() !== ''
}

/** Spawn a detached dsh-launcher CLI command (never blocks the desktop). */
function spawnLauncher(exe: string, args: string[]): void {
  try {
    const child = spawn(exe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    logs.info('launcher', `spawned detached: ${exe} ${args.join(' ')} (pid ${child.pid ?? '?'})`)
  } catch (err) {
    logs.error('launcher', `failed to spawn ${exe}: ${(err as Error).message}`)
    throw err
  }
}

/**
 * Ask dsh-launcher to start the shared server (resident), then wait until the
 * configured port answers dsh. Does not spawn dsh itself.
 */
export async function startServerViaLauncher(): Promise<{ ok: boolean; error?: string }> {
  const exe = findLauncher()
  if (!exe) {
    return {
      ok: false,
      error: '未找到 dsh-launcher.exe。请在「设置」中指定其路径，或从 https://github.com/kuaizhongqiang/dsh-launcher/releases 安装（安装版会注册到标准位置，桌面端即可自动找到）。',
    }
  }
  const port = getSettings().port
  spawnLauncher(exe, LAUNCHER_START_ARGS)

  logs.info('launcher', `waiting for dsh server on port ${port} (timeout ${READY_TIMEOUT_MS / 1000}s)`)
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await preflight(port)
    if (result.mode === 'dsh') return { ok: true }
    if (result.mode === 'busy') {
      return { ok: false, error: result.detail }
    }
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS))
  }
  return {
    ok: false,
    error: `等待 dsh server 就绪超时（${READY_TIMEOUT_MS / 1000}s）。若 dsh 尚未安装，请先运行 dsh-launcher 完成安装（日志：%TEMP%\\dsh-launcher.log）。`,
  }
}

/** Ask dsh-launcher to stop the server it owns. */
export async function stopServerViaLauncher(): Promise<{ ok: boolean; error?: string }> {
  const exe = findLauncher()
  if (!exe) return { ok: false, error: '未找到 dsh-launcher.exe。' }
  spawnLauncher(exe, LAUNCHER_STOP_ARGS)
  return { ok: true }
}
