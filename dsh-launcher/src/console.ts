// console.ts —— 让启动器进程持有「隐藏控制台」。
//
// 背景：dsh web（node）内部 spawn 的 pwsh 子进程会继承父进程的控制台。
//   - 父进程无控制台（Electron GUI 默认，或旧版 windowsHide:true 的 node）→
//     每个 pwsh 只能新建一个「可见」控制台窗口 → 每次执行工具都弹 PowerShell 框。
//   - 父进程有控制台（哪怕是隐藏的）→ pwsh 继承同一个控制台 → 不弹窗。
//
// 本模块在启动器（Electron GUI 主进程，无控制台）里分配一个隐藏控制台
// （AllocConsole + ShowWindow(SW_HIDE)），随后 dsh 作为子进程继承它，
// 链路：启动器(隐藏控制台) → dsh(node) → pwsh(继承) ，全程无可见窗口。
// 通过 koffi（FFI）调用 Win32 API；koffi 不可用时降级为「不持有控制台」
// （退回旧行为，仅影响弹窗，不影响启动/停止）。

import * as log from './log.js';

let hidden = false;

/** 当前进程是否已有控制台（CLI/终端场景下为 true）。 */
export function hasConsole(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    // 用 koffi 查 GetConsoleWindow；失败视为无控制台
    const koffi = requireKoffi();
    if (!koffi) return false;
    const kernel32 = koffi.load('kernel32.dll');
    const GetConsoleWindow = kernel32.func('void* GetConsoleWindow()');
    return !!GetConsoleWindow();
  } catch {
    return false;
  }
}

/**
 * 确保本进程持有隐藏控制台（仅 Windows + 当前无控制台时执行）。
 * 返回是否已持有（隐藏）控制台。已有控制台（终端里跑 CLI）时不动它，
 * 直接返回 true —— 子进程继承该控制台同样不弹窗。
 */
export function ensureHiddenConsole(): boolean {
  if (process.platform !== 'win32') return false;
  if (hidden) return true;

  const koffi = requireKoffi();
  if (!koffi) {
    log.warn('koffi 不可用，无法为 dsh 提供隐藏控制台（执行工具时可能弹 PowerShell 窗口）');
    return false;
  }

  try {
    const kernel32 = koffi.load('kernel32.dll');
    const user32 = koffi.load('user32.dll');
    const AllocConsole = kernel32.func('int AllocConsole()');
    const GetConsoleWindow = kernel32.func('void* GetConsoleWindow()');
    const ShowWindow = user32.func('int ShowWindow(void* hWnd, int nCmdShow)');

    // 已有控制台（CLI/终端）：不隐藏用户的终端，直接复用
    if (GetConsoleWindow()) {
      hidden = true;
      return true;
    }
    // GUI 进程无控制台：分配一个隐藏的控制台供子进程继承
    AllocConsole();
    const h = GetConsoleWindow();
    if (h) ShowWindow(h, 0 /* SW_HIDE */);
    hidden = true;
    log.info('已创建隐藏控制台（dsh 及其 pwsh 子进程将继承，不再弹窗）');
    return true;
  } catch (e) {
    log.warn(`创建隐藏控制台失败：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** 加载 koffi（可能因环境不支持而失败，返回 null）。 */
function requireKoffi(): typeof import('koffi') | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('koffi') as typeof import('koffi');
  } catch {
    return null;
  }
}
