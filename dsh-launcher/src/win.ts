// win.ts —— 跨平台"用默认浏览器打开 URL"（Windows 下不弹控制台黑框）。
// 移植自 Go internal/win.OpenURL（ShellExecuteW）。

import { spawn } from 'node:child_process';

/** 用默认浏览器打开 url。Windows 用 `cmd /c start`（windowsHide 防黑框）。 */
export function openURL(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let cmd: string;
    let args: string[];
    if (process.platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const cp = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    cp.on('error', reject);
    cp.on('spawn', () => {
      cp.unref(); // 不阻塞父进程退出
      resolve();
    });
  });
}
