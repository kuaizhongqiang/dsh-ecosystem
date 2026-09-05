// index.ts —— 入口：初始化日志并分发命令。

import { dispatch } from './cli.js';
import * as launch from './launch.js';
import * as log from './log.js';

async function main(): Promise<void> {
  log.initLog();
  log.setDebug(process.env.DSH_LAUNCHER_DEBUG !== undefined);

  // 纯 Node / SEA 版没有 Electron 的 before-quit 钩子：
  // 进程退出时停止绑定的 dsh 子进程（幂等，重复注册无副作用）
  process.on('exit', () => {
    launch.stopChildSilently();
  });

  try {
    await dispatch(process.argv.slice(2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(msg);
    // install/start/stop/move 等命令失败以退出码 1 结束；
    // UI 模式下的服务常驻错误由服务器内部捕获，不走到这里。
    process.exitCode = 1;
  }
}

void main();
