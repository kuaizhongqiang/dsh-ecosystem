/**
 * 验证 LocalServerManager.start() 在 3080 已被现有 DSH 实例占用时的行为：
 * - 任何 localServerPath 下都应复用 3080 上的实例（reused=true），不重复拉起
 * - launcher.json 的 port 字段不影响预检（dsh web 固定绑定 3080）
 * 临时脚本，验证后可删。
 */
import { LocalServerManager } from '../src/localServer.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fakeInstallDir(port: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fake-'))
  writeFileSync(join(dir, 'dsh.cmd'), '@echo off\necho fake dsh launcher\n')
  writeFileSync(join(dir, 'launcher.json'), JSON.stringify({ dshInstallDir: dir, port }))
  return dir
}

async function main(): Promise<void> {
  let failed = 0
  const check = (name: string, ok: boolean, detail = ''): void => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
    if (!ok) failed = 1
  }

  // 场景 1：真实 D:\dsh，3080 已有 DSH 实例 → 复用
  {
    const manager = new LocalServerManager(() => ({}))
    const result = await manager.start('D:\\dsh')
    const state = manager.getState()
    check('场景1 复用已有实例', result.reused === true && result.url === 'http://127.0.0.1:3080'
      && state.status === 'running' && state.reused === true, JSON.stringify(result))
    manager.dispose()
  }

  // 场景 2：fake 目录（launcher.json port=3081，空闲）→ 仍复用 3080 实例
  {
    const dir = fakeInstallDir(3081)
    const manager = new LocalServerManager(() => ({}))
    const result = await manager.start(dir)
    check('场景2 launcher 端口不干扰预检', result.reused === true && result.url === 'http://127.0.0.1:3080',
      JSON.stringify(result))
    manager.dispose()
    rmSync(dir, { recursive: true, force: true })
  }

  // 场景 3：stop() 后状态回到 stopped
  {
    const manager = new LocalServerManager(() => ({}))
    await manager.start('D:\\dsh')
    manager.stop()
    check('场景3 stop 后为 stopped', manager.getState().status === 'stopped',
      `status=${manager.getState().status}`)
    manager.dispose()
  }

  console.log(failed === 0 ? 'ALL PASS' : 'SOME FAILED')
  process.exit(failed)
}

main().catch((error) => {
  console.error('ERROR:', error)
  process.exit(1)
})
