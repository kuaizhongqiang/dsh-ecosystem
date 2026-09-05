// electron-main.ts —— Electron 桌面窗口入口。
// 无参数（双击 exe）→ 启动本地 UI 服务 + 打开桌面窗口（frameless，加载 http://127.0.0.1:<port>/）。
// 带 CLI 参数 → 与命令行版一致（install/start/stop/restart/move/status/check-update/connections/profile/pull）。
// M6:托盘常驻(启停/重启/开浏览器/连接切换/检查更新/退出)、关窗=隐藏到托盘(默认,launcher.json
// closeAction:'exit' 保留旧「关窗即停」)。
// #21:桌面模式单实例锁——重复启动只保留一个进程/一个托盘图标,后来者退出并让已有窗口回前台。
// #20:窗口高度随内容自适应(win:autosize,上限=工作区),小屏由 CSS 内滚动兜底,底部操作不再被裁。

import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron';
import { dirname, join } from 'node:path';

import { dispatch } from './cli.js';
import * as config from './config.js';
import * as connections from './connections.js';
import * as consoleWin from './console.js';
import * as launch from './launch.js';
import * as log from './log.js';
import * as registration from './registration.js';
import { DefaultUIPort, lastUpdateState, startServer } from './server.js';
import { trayPng, type TrayState } from './trayIcon.js';
import { readLaunchToken } from './tokenFile.js';
import * as update from './update.js';
import { VERSION } from './version.js';

// esbuild 以 CJS 输出：__dirname 是真实模块目录变量（避免 import.meta.url 在 asar 下失效）
declare const __dirname: string;

// ---------- CLI 命令集合 ----------

const KNOWN_COMMANDS = new Set([
  'install', 'start', 'stop', 'restart', 'move', 'status', 'check-update', 'ui',
  'connections', 'profile', 'pull', 'setup',
  '--help', '-h', 'help', '--version', '-v',
]);

/** 退出语义标志：true 时关闭窗口 = 真退出（UI「退出」按钮 / 托盘退出）。 */
let quitting = false;

/** 桌面窗口内容自适应的高度上限（主屏工作区高度 − 边距；runDesktop 内按实测定）。 */
let desktopMaxH = 720;

/** 清洗 argv：去掉 exe 路径、可能的 app 路径（dev 模式 `electron .`）与 Chromium 开关。 */
function cleanArgs(raw: string[]): string[] {
  const args = raw.slice(1).filter((a) => {
    // Chromium/Electron 开关（--remote-debugging-port 等）会出现在 process.argv 里，
    // 但不是启动器命令，忽略之（保留 --help/-h/--version/-v 等已知命令）。
    return !(a.startsWith('-') && !KNOWN_COMMANDS.has(a));
  });
  if (args.length > 0 && !args[0].startsWith('-') && !KNOWN_COMMANDS.has(args[0])) {
    args.shift(); // dev: `electron . args...` 的 app 路径
  }
  return args;
}

/** 窗口模式：启动服务 + 创建 frameless 桌面窗口。 */
async function runDesktop(): Promise<void> {
  // 单实例锁（#21，仅桌面窗口模式）：
  // 双击/重复启动时若已有实例持锁，本进程直接退出——否则每个进程都会新建托盘图标、
  // 各自抢占一个 UI 端口，托盘里出现两个 launcher。持锁方收到 second-instance 时把窗口带回前台。
  // CLI 模式（install/start/restart…）不经过这里，不抢锁，可与常驻窗口并存。
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  let mainWin: BrowserWindow | null = null;
  app.on('second-instance', () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  });

  await app.whenReady();
  log.initLog();
  log.setDebug(process.env.DSH_LAUNCHER_DEBUG !== undefined);

  // #20 内容自适应上限：主屏工作区高度 − 边距（小屏留出内滚动兜底空间）
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  desktopMaxH = Math.max(560, workArea.height - 20);

  // 持有隐藏控制台：dsh 作为子进程继承后，其 pwsh 子进程不再弹窗。
  // 必须尽早调用（在 /api/start 真正 spawn 之前）。
  consoleWin.ensureHiddenConsole();

  // 启动器常驻：关闭窗口/退出时自动停止 dsh 子进程
  app.on('before-quit', () => {
    quitting = true;
    launch.stopChildSilently();
    registration.unregisterLauncher();
  });
  process.on('exit', () => {
    launch.stopChildSilently();
  });

  // 端口占用则顺延（最多试 10 个）
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  for (let p = DefaultUIPort; p < DefaultUIPort + 10; p++) {
    try {
      server = await startServer(p);
      break;
    } catch (e) {
      log.warn(`端口 ${p} 不可用（${(e as Error).message}），尝试下一个……`);
    }
  }
  if (!server) {
    log.error('启动本地 UI 服务失败');
    app.exit(1);
    return;
  }
  log.info(`dsh-launcher 桌面窗口已启动：${server.url}`);

  // 便携版提示：electron-builder portable 会把 app 解压到临时目录运行、退出即删，
  // 此时从任务栏固定得到的快捷方式指向临时路径，关闭后会失效（“快捷方式丢失”）。
  // 需要固定到任务栏请使用安装版（NSIS）。
  const exeDir = dirname(process.execPath);
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir && portableDir.toLowerCase() !== exeDir.toLowerCase()) {
    log.warn('便携版运行在临时解压目录，任务栏固定会在退出后失效；如需固定请使用安装版（NSIS）。');
  }

  const win = new BrowserWindow({
    width: 720,
    // 初始 700；渲染就绪后经 win:autosize 按内容自然高度扩窗（≤ desktopMaxH）
    height: Math.min(700, desktopMaxH),
    frame: false, // 无边框：自绘标题栏（与 Go 版一致）
    resizable: false,
    show: false,
    backgroundColor: '#151517',
    webPreferences: {
      preload: join(__dirname, 'electron-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin = win;

  // 外链一律走系统浏览器（不占用窗口）
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // ready-to-show 必须在 loadURL 之前注册：本地 UI 是内嵌内存资源、响应极快，
  // 事件可能在 loadURL 的 Promise resolve 前就已触发，注册晚了窗口永不显示。
  win.once('ready-to-show', () => win.show());

  await win.loadURL(server.url);
  // 兜底：若 ready-to-show 已错过（页面早已渲染完成），直接显示。
  if (!win.isVisible()) win.show();

  // M6:关窗 = 隐藏到托盘（默认；launcher.json closeAction:'exit' 保留旧行为）
  win.on('close', (e) => {
    if (quitting) return;
    const c = config.load();
    if ((c?.closeAction ?? 'tray') === 'tray') {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    mainWin = null;
    app.quit();
  });

  // ---------- 托盘（M6） ----------

  const notify = (title: string, body: string): void => {
    try {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    } catch {
      /* ignore */
    }
  };

  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  const openActiveBrowser = async (): Promise<void> => {
    const cfg = config.load();
    if (!cfg || !config.isInstalled(cfg)) {
      notify('dsh-launcher', 'dsh 未安装：请先运行 install');
      return;
    }
    const { conn } = connections.resolveActive(cfg);
    if (conn.kind === 'remote') {
      await shell.openExternal(connections.buildRemoteTarget(conn));
      return;
    }
    const port = conn.port ?? cfg.port;
    const shared = readLaunchToken();
    const target = shared && shared.port === port && shared.url ? shared.url : `http://127.0.0.1:${port}/`;
    await shell.openExternal(target);
  };

  const trayState = async (): Promise<TrayState> => {
    const cfg = config.load();
    if (!cfg || !config.isInstalled(cfg)) return 'dim';
    const { conn } = connections.resolveActive(cfg);
    if (conn.kind === 'remote') {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);
        try {
          const r = await fetch(conn.url ?? '', { signal: ctrl.signal });
          r.body?.cancel().catch(() => {});
          return r.status >= 200 ? 'green' : 'dim';
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return 'dim';
      }
    }
    const lcfg = conn.port && conn.port !== cfg.port ? { ...cfg, port: conn.port } : cfg;
    if (await launch.isRunning(lcfg)) {
      const us = lastUpdateState();
      return us.dshAvail || us.launcherAvail ? 'yellow' : 'green';
    }
    return 'dim';
  };

  // 托盘图标:透明底状态圆点(16@1x + 32@2x,高分屏不糊);addRepresentation 失败时退回单图。
  const trayImage = (state: TrayState): ReturnType<typeof nativeImage.createEmpty> => {
    try {
      const img = nativeImage.createEmpty();
      img.addRepresentation({ scaleFactor: 1, width: 16, height: 16, buffer: trayPng(state, 16) });
      img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: trayPng(state, 32) });
      return img;
    } catch {
      return nativeImage.createFromBuffer(trayPng(state, 16));
    }
  };

  const tray = new Tray(trayImage('dim'));
  const rebuildTray = async (): Promise<void> => {
    try {
      const cfg = config.load();
      const installed = !!cfg && config.isInstalled(cfg);
      const { conn: active } = connections.resolveActive(cfg);
      const st = await trayState();
      tray.setImage(trayImage(st));
      const tip =
        st === 'green' ? 'dsh 运行中' : st === 'yellow' ? 'dsh 运行中（有更新）' : st === 'red' ? 'dsh 异常' : 'dsh 未运行';
      tray.setToolTip(`dsh-launcher v${VERSION} — ${tip}`);
      const connItems = connections.listConnections(cfg).map((c) => ({
        label: `${c.id === active.id ? '● ' : '○ '}${c.id}（${c.kind}${c.kind === 'local' && c.port ? ':' + c.port : ''}）`,
        click: () => {
          void (async () => {
            try {
              connections.useConnection(c.id);
              await launch.restartActive();
              notify('连接已切换', c.id);
            } catch (e) {
              notify('切换连接失败', errText(e));
            }
            void rebuildTray();
          })();
        },
      }));
      const wrap = (fn: () => Promise<void>, okTitle: string): { click: () => void } => ({
        click: () => {
          void (async () => {
            try {
              await fn();
              notify(okTitle, '激活连接：' + connections.resolveActive(config.load()).conn.id);
            } catch (e) {
              notify('操作失败', errText(e));
            }
            void rebuildTray();
          })();
        },
      });
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '显示窗口', click: () => { win.show(); win.focus(); } },
          { type: 'separator' },
          {
            label: '启动 dsh',
            enabled: installed,
            ...wrap(async () => {
              const c2 = config.load();
              if (!c2 || !config.isInstalled(c2)) throw new Error('dsh 未安装');
              const { conn: cn } = connections.resolveActive(c2);
              await launch.start(c2, false, cn);
            }, 'dsh 已启动'),
          },
          {
            label: '停止 dsh',
            enabled: installed,
            ...wrap(async () => {
              const c2 = config.load();
              if (!c2) throw new Error('dsh 未安装');
              await launch.stop(c2);
            }, 'dsh 已停止'),
          },
          {
            label: '重启 dsh',
            enabled: installed,
            ...wrap(() => launch.restartActive(), 'dsh 已重启'),
          },
          { label: '打开浏览器（激活连接）', enabled: installed, click: () => { void openActiveBrowser().finally(() => void rebuildTray()); } },
          { label: '连接切换', submenu: connItems },
          { type: 'separator' },
          {
            label: '检查更新',
            click: () => {
              void (async () => {
                try {
                  const cfg2 = config.load();
                  const d = cfg2?.dshVersion
                    ? await update.checkDsh(cfg2.dshVersion, {}, { source: cfg2.source, proxy: cfg2.proxy }).catch(() => ({ hasUpdate: false, latest: '' }))
                    : { hasUpdate: false, latest: '' };
                  const la = await update.checkLauncher(VERSION).catch(() => ({ hasUpdate: false, latest: '' }));
                  const parts: string[] = [];
                  if (d.hasUpdate) parts.push('dsh → ' + d.latest);
                  if (la.hasUpdate) parts.push('启动器 → ' + la.latest);
                  notify(parts.length > 0 ? '发现新版本' : '已是最新', parts.join('；') || 'dsh 与启动器均最新');
                } finally {
                  void rebuildTray();
                }
              })();
            },
          },
          { type: 'separator' },
          {
            label: '退出（停止 dsh）',
            click: () => {
              quitting = true;
              tray.destroy();
              app.quit();
            },
          },
        ]),
      );
    } catch (e) {
      log.warn(`托盘菜单刷新失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  void rebuildTray();
  const trayTimer = setInterval(() => void rebuildTray(), 15_000);
  app.on('before-quit', () => clearInterval(trayTimer));
}

/** 窗口控制 IPC（最小化/隐藏/关闭），供 preload 使用。 */
ipcMain.on('win:minimize', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.minimize();
});

/**
 * #20 内容自适应高度：渲染进程量好页面自然高度（标题栏 + 内容）后请求扩窗。
 * 只增不减（避免数据加载/日志增长引起窗口反复跳动），且不超过主屏工作区；
 * 屏幕放不下时保持窗口上限，由 body.desktop .content 内滚动兜底（不再裁掉底部操作）。
 */
ipcMain.handle('win:autosize', (_e, desiredH: unknown) => {
  const h = Math.round(Number(desiredH));
  if (!Number.isFinite(h) || h <= 0) return;
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
  if (!w) return;
  const [cw, ch] = w.getSize();
  const target = Math.min(Math.max(ch, h), desktopMaxH);
  if (target !== ch) w.setSize(cw, target);
});

ipcMain.on('win:hide', (e) => {
  // M6:标题栏 × = 隐藏到托盘(dsh 继续跑)
  BrowserWindow.fromWebContents(e.sender)?.hide();
});

ipcMain.on('win:close', (e) => {
  // UI「退出」按钮:真退出(before-quit 停止 dsh)
  quitting = true;
  BrowserWindow.fromWebContents(e.sender)?.close();
});

// ---------- 入口 ----------

const args = cleanArgs(process.argv);

if (args.length > 0 && args[0] !== 'ui') {
  // CLI 模式：不需要窗口，直接跑命令后退出
  log.initLog();
  log.setDebug(process.env.DSH_LAUNCHER_DEBUG !== undefined);
  // CLI 同样先持有隐藏控制台（start 时 dsh 子进程继承，不弹窗）
  consoleWin.ensureHiddenConsole();
  process.on('exit', () => {
    launch.stopChildSilently();
  });
  void (async () => {
    try {
      await dispatch(args);
    } catch (e) {
      log.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
    app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  })();
} else {
  // 无参数或 `ui` → 桌面窗口
  void runDesktop().catch((e) => {
    log.error(`桌面窗口启动失败：${e instanceof Error ? e.message : String(e)}`);
    app.exit(1);
  });
}
