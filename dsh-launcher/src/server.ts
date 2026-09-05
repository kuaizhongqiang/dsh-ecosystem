// server.ts —— dsh-launcher 的 Web UI 服务：
//   - 内嵌静态资源（ui/ 下的 HTML/CSS/JS/SVG，esbuild text loader 打包进 exe）
//   - REST bridge：/api/status /api/start /api/stop /api/install /api/move
//     /api/check-update /api/browse /api/exit
//   - SSE：/api/events 推送日志行（日志订阅 → 前端实时显示）
// 只绑定 127.0.0.1（本机），不对外。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import indexHtml from '../ui/index.html';
import tokensCss from '../ui/tokens.css';
import launcherCss from '../ui/launcher.css';
import appJs from '../ui/app.js';
import faviconSvg from '../ui/favicon.svg';

import * as config from './config.js';
import * as connections from './connections.js';
import * as ecosystem from './ecosystem.js';
import * as install from './install.js';
import * as launch from './launch.js';
import * as log from './log.js';
import * as node from './node.js';
import * as registration from './registration.js';
import * as setup from './setup.js';
import * as update from './update.js';
import { VERSION } from './version.js';

/** launcher UI 默认端口（与 dsh 的 3080 错开）。 */
export const DefaultUIPort = 3177;

// ---------- 状态缓存 ----------

interface UpdateState {
  checking: boolean;
  dshAvail: boolean;
  launcherAvail: boolean;
  dshLatest: string;
  launcherLatest: string;
}

const updateState: UpdateState = {
  checking: false,
  dshAvail: false,
  launcherAvail: false,
  dshLatest: '',
  launcherLatest: '',
};

/** 生态拉齐是否正在执行（防并发触发；GET /api/ecosystem 暴露给前端）。 */
let ecoPullBusy = false;

/** M6:REST bridge 随机共享密钥(每次进程启动生成;经 launcher-registration.json 0600 分发)。 */
const bridgeKey = randomBytes(16).toString('hex');

/** restart 是否进行中(防并发)。 */
let restartBusy = false;

/** setup 一键部署是否进行中(防并发)。 */
let setupBusy = false;

/** 托盘图标状态用：最近一次升级检测结果（M6 黄色=有更新）。 */
export function lastUpdateState(): { dshAvail: boolean; launcherAvail: boolean } {
  return { dshAvail: updateState.dshAvail, launcherAvail: updateState.launcherAvail };
}

// ---------- 桥接注入脚本（替换 window.launcherBridge 为真实 API） ----------

const bridgeScript = `<script>
(function () {
  var api = function (path, body) {
    return fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json(); });
  };
  window.launcherVersion = 'v${VERSION}';
  window.launcherBridge = {
    getStatus: function () { return api('/api/status'); },
    start: function () { return api('/api/start', {}); },
    stop: function () { return api('/api/stop', {}); },
    install: function (dir, source, version, proxy) {
      return api('/api/install', { dir: dir, source: source, version: version, proxy: proxy });
    },
    getTags: function () { return api('/api/tags'); },
    move: function (dir) { return api('/api/move', { dir: dir }); },
    checkUpdate: function () { return api('/api/check-update', {}); },
    browse: function () { return api('/api/browse', {}).then(function (r) { return r.dir; }); },
    exit: function () { return api('/api/exit', {}); },
    getEcosystem: function () { return api('/api/ecosystem'); },
    pullEcosystem: function (opts) { return api('/api/ecosystem/pull', opts || {}); },
    getConnections: function () { return api('/api/connections'); },
    useConnection: function (id) { return api('/api/connections/use', { id: id }); },
    restartDsh: function () { return api('/api/dsh/restart?key=${bridgeKey}', {}); },
    setupFlow: function (opts) { return api('/api/setup', opts || {}); },
    defaultDir: ${JSON.stringify(defaultInstallDir())},
  };
  var es = new EventSource('/api/events');
  window.launcherBridge.onLog = function (fn) {
    es.onmessage = function (e) {
      try { var d = JSON.parse(e.data); fn(d.line, d.kind); } catch (err) {}
    };
  };
})();
</script>`;

function defaultInstallDir(): string {
  return process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'dsh')
    : join(homedir(), 'AppData', 'Local', 'dsh');
}

// ---------- 静态资源 ----------

interface Asset {
  type: string;
  content: string;
}

const assets: Record<string, Asset> = {
  // 桥接脚本必须注入在 </head> 前（而非 </body> 前）：index.html 的 app.js 是同步
  // script，若桥接注入到其后，app.js 执行时 window.launcherBridge 尚未定义，会回退到 mock。
  '/': { type: 'text/html; charset=utf-8', content: indexHtml.replace('</head>', bridgeScript + '</head>') },
  '/index.html': { type: 'text/html; charset=utf-8', content: '' },
  '/tokens.css': { type: 'text/css; charset=utf-8', content: tokensCss },
  '/launcher.css': { type: 'text/css; charset=utf-8', content: launcherCss },
  '/app.js': { type: 'text/javascript; charset=utf-8', content: appJs },
  '/favicon.svg': { type: 'image/svg+xml', content: faviconSvg },
  '/favicon.ico': { type: 'image/svg+xml', content: faviconSvg },
};
assets['/index.html'] = assets['/'];

// ---------- HTTP 辅助 ----------

function json(res: ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------- 状态 ----------

async function safeDetect(): Promise<{ present: boolean; version: string }> {
  try {
    const ni = await node.detect();
    return { present: true, version: node.versionString(ni.nodeVer) };
  } catch (e) {
    log.warn(`环境探测失败：${errMessage(e)}`);
    return { present: false, version: '' };
  }
}

async function safeNpm(): Promise<{ present: boolean; version: string }> {
  try {
    const ni = await node.detect();
    return { present: true, version: ni.npmVer };
  } catch (e) {
    log.warn(`npm 探测失败：${errMessage(e)}`);
    return { present: false, version: '' };
  }
}

async function statusPayload(): Promise<Record<string, unknown>> {
  const cfg = config.load();
  const installed = cfg !== null && config.isInstalled(cfg) && launch.installDirExists(cfg);
  let dshVer = cfg?.dshVersion ?? '';
  if (installed && !dshVer && cfg) {
    try {
      dshVer = node.dshVersionFromPackage(cfg.dshInstallDir, cfg.source);
    } catch {
      /* ignore */
    }
  }
  // M5：运行/状态语义跟随激活连接（remote = HTTP ping，不 spawn）
  const { conn } = connections.resolveActive(cfg);
  let running = false;
  if (conn.kind === 'remote' && conn.url) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      try {
        const r = await fetch(conn.url, { signal: ctrl.signal });
        running = r.status >= 200;
        r.body?.cancel().catch(() => {});
      } finally {
        clearTimeout(timer);
      }
    } catch {
      running = false;
    }
  } else {
    running = cfg ? await launch.isRunning(cfg) : false;
  }
  return {
    node: await safeDetect(),
    npm: await safeNpm(),
    dsh: { installed, version: dshVer ? 'v' + dshVer.replace(/^dsh-/, '').replace(/^v/, '') : '' },
    port: { number: conn.kind === 'local' ? conn.port ?? cfg?.port ?? config.DefaultPort : cfg?.port ?? config.DefaultPort, running },
    connection: { id: conn.id, kind: conn.kind, name: conn.name ?? conn.id, port: conn.port, url: conn.url },
    update: { ...updateState },
    defaultDir: defaultInstallDir(),
    installedDir: installed && cfg ? cfg.dshInstallDir : '',
  };
}

// ---------- 目录选择（Windows 原生对话框） ----------

function browseFolder(): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null);
      return;
    }
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$f.Description = "选择目录"',
      'if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }',
    ].join('; ');
    execFile(
      'powershell',
      ['-NoProfile', '-STA', '-Command', ps],
      { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          log.warn(`目录选择框失败：${errMessage(err)}`);
          resolve(null);
          return;
        }
        const p = stdout.trim();
        resolve(p || null);
      },
    );
  });
}

// ---------- SSE 日志推送 ----------

function lineKind(line: string): string {
  if (line.includes('[ERROR]')) return 'err';
  if (line.includes('[WARN]')) return 'warn';
  if (line.includes('[DEBUG]')) return '';
  return '';
}

function handleEvents(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const unsub = log.subscribe((line) => {
    res.write(`data: ${JSON.stringify({ line: line.trimEnd(), kind: lineKind(line) })}\n\n`);
  });
  const ping = setInterval(() => {
    res.write(': ping\n\n');
  }, 15_000);
  reqOnClose(res, () => {
    clearInterval(ping);
    unsub();
  });
}

function reqOnClose(res: ServerResponse, fn: () => void): void {
  res.on('close', fn);
}

// ---------- 路由 ----------

async function handleApi(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  switch (path) {
    case '/api/status': {
      json(res, 200, await statusPayload());
      return;
    }
    case '/api/start': {
      const cfg = config.load();
      if (!cfg || !config.isInstalled(cfg)) {
        json(res, 400, { ok: false, message: '未检测到已安装的 dsh：请先安装' });
        return;
      }
      try {
        const already = await launch.start(cfg, false);
        json(res, 200, { ok: true, already });
      } catch (e) {
        // 启动失败（含就绪超时）必须落日志，便于排查
        log.error(`启动失败：${errMessage(e)}`);
        json(res, 500, { ok: false, message: errMessage(e) });
      }
      return;
    }
    case '/api/stop': {
      const cfg = config.load();
      if (!cfg || !config.isInstalled(cfg)) {
        json(res, 400, { ok: false, message: '尚未安装 dsh' });
        return;
      }
      try {
        await launch.stop(cfg);
        json(res, 200, { ok: true });
      } catch (e) {
        log.error(`停止失败：${errMessage(e)}`);
        json(res, 500, { ok: false, message: errMessage(e) });
      }
      return;
    }
    case '/api/install': {
      const body = await readBody(req);
      const dir = typeof body.dir === 'string' ? body.dir : '';
      const source = body.source === 'npm' ? 'npm' : 'github';
      const version = typeof body.version === 'string' ? body.version : '';
      const proxy = typeof body.proxy === 'string' ? body.proxy : '';
      try {
        await install.run(dir, install.registrySpecFromConfig(config.load()), { source, version, proxy });
        json(res, 200, { ok: true });
      } catch (e) {
        json(res, 500, { ok: false, message: errMessage(e) });
      }
      return;
    }
    case '/api/tags': {
      // GitHub 源的可选 dsh 版本列表（供 UI 下拉选择）
      try {
        const cfg = config.load();
        const tags = await node.listDshTags(cfg?.proxy);
        json(res, 200, { ok: true, tags });
      } catch (e) {
        json(res, 200, { ok: false, tags: [], message: errMessage(e) });
      }
      return;
    }
    case '/api/move': {
      const body = await readBody(req);
      const dir = typeof body.dir === 'string' ? body.dir : '';
      if (!dir) {
        json(res, 400, { ok: false, message: '缺少目标目录' });
        return;
      }
      try {
        await install.move(dir);
        json(res, 200, { ok: true });
      } catch (e) {
        json(res, 500, { ok: false, message: errMessage(e) });
      }
      return;
    }
    case '/api/check-update': {
      if (updateState.checking) {
        json(res, 200, { ...updateState });
        return;
      }
      updateState.checking = true;
      const cfg = config.load();
      const dshCur = cfg && config.isInstalled(cfg) ? cfg.dshVersion : '';
      const spec = install.registrySpecFromConfig(cfg);
      try {
        const [d, la] = await Promise.all([
          dshCur
            ? update.checkDsh(dshCur, spec, { source: cfg?.source, proxy: cfg?.proxy }).catch((e) => {
                log.warn(`升级检测：dsh ${errMessage(e)}`);
                return { latest: '', hasUpdate: false };
              })
            : Promise.resolve({ latest: '', hasUpdate: false }),
          update.checkLauncher(VERSION).catch((e) => {
            log.warn(`升级检测：启动器 ${errMessage(e)}`);
            return { latest: '', hasUpdate: false };
          }),
        ]);
        updateState.dshAvail = d.hasUpdate;
        updateState.launcherAvail = la.hasUpdate;
        updateState.dshLatest = d.latest;
        updateState.launcherLatest = la.latest;
        if (d.hasUpdate) log.info(`升级检测：dsh 当前 ${dshCur} → 最新 ${d.latest}（可升级）`);
        else if (dshCur) log.info(`升级检测：dsh 当前 ${dshCur} 已是最新。`);
        if (la.hasUpdate) log.info(`升级检测：启动器 当前 ${VERSION} → 最新 ${la.latest}（可升级，下载页 ${update.LauncherReleaseURL}）`);
        json(res, 200, { ...updateState });
      } finally {
        updateState.checking = false;
      }
      return;
    }
    case '/api/connections': {
      // M5：连接组列表（token 不出后端，只回 hasToken）
      const cfg = config.load();
      const { conn: active } = connections.resolveActive(cfg);
      const list = connections.listConnections(cfg).map((c) => ({
        id: c.id,
        kind: c.kind,
        name: c.name ?? c.id,
        port: c.port,
        url: c.url,
        hasToken: !!c.token,
      }));
      json(res, 200, { ok: true, active: active.id, list, fromFile: connections.loadConnections() !== undefined });
      return;
    }
    case '/api/connections/use': {
      const body = await readBody(req);
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) {
        json(res, 400, { ok: false, message: '缺少 id' });
        return;
      }
      try {
        connections.useConnection(id);
        log.info(`激活连接 → ${id}（GUI 切换，已写变更标记）`);
        json(res, 200, { ok: true, active: id });
      } catch (e) {
        json(res, 400, { ok: false, message: errMessage(e) });
      }
      return;
    }
    case '/api/connections/add': {
      const body = await readBody(req);
      const id = typeof body.id === 'string' ? body.id : '';
      const name = typeof body.name === 'string' ? body.name : undefined;
      try {
        if (body.kind === 'local') {
          connections.addConnection({ id, kind: 'local', name, port: Number(body.port) });
        } else if (body.kind === 'remote') {
          connections.addConnection({
            id,
            kind: 'remote',
            name,
            url: typeof body.url === 'string' ? body.url : undefined,
            token: typeof body.token === 'string' ? body.token : undefined,
          });
        } else {
          json(res, 400, { ok: false, message: 'kind 必须为 local|remote' });
          return;
        }
        json(res, 200, { ok: true });
      } catch (e) {
        json(res, 400, { ok: false, message: errMessage(e) });
      }
      return;
    }
    case '/api/connections/remove': {
      const body = await readBody(req);
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) {
        json(res, 400, { ok: false, message: '缺少 id' });
        return;
      }
      try {
        connections.removeConnection(id);
        json(res, 200, { ok: true });
      } catch (e) {
        json(res, 400, { ok: false, message: errMessage(e) });
      }
      return;
    }
    case '/api/ecosystem': {
      // M2：生态页数据 = 当前清单（默认内嵌）+ ecosystem-state.json + 忙碌状态
      try {
        const { manifest, label } = await ecosystem.loadManifest();
        let state: unknown = null;
        try {
          state = JSON.parse(readFileSync(ecosystem.ecosystemStatePath(), 'utf8'));
        } catch {
          state = null;
        }
        json(res, 200, {
          ok: true,
          busy: ecoPullBusy,
          label,
          manifest: {
            dsh: manifest.dsh,
            pluginsCommit: manifest.plugins.source.commit,
            packages: manifest.plugins.packages.map((p) => ({ id: p.id, dir: p.dir })),
            skills: !!manifest.skills,
          },
          state,
          pluginsDir: ecosystem.pluginsRootDir(),
        });
      } catch (e) {
        json(res, 500, { ok: false, message: errMessage(e) });
      }
      return;
    }
    case '/api/ecosystem/pull': {
      // M2：触发生态拉齐（异步执行，进度经 /api/events SSE 推送；busy 期间 409）
      if (ecoPullBusy) {
        json(res, 409, { ok: false, message: '生态拉齐正在进行中，请稍候' });
        return;
      }
      const body = await readBody(req);
      const rawPlugins = body.plugins;
      const plugins =
        Array.isArray(rawPlugins) ? (rawPlugins as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;
      const opts: ecosystem.PullOptions = {
        plugins,
        skills: body.skills !== false,
        core: body.core !== false,
        dryRun: body.dryRun === true,
      };
      ecoPullBusy = true;
      json(res, 200, { ok: true, message: '生态拉齐已开始（进度见下方日志）' });
      void (async () => {
        try {
          log.info('生态拉齐开始（GUI 触发）……');
          await ecosystem.runPull(opts);
          log.info('生态拉齐完成。');
        } catch (e) {
          log.error(`生态拉齐失败：${errMessage(e)}`);
        } finally {
          ecoPullBusy = false;
        }
      })();
      return;
    }
    case '/api/browse': {
      const dir = await browseFolder();
      json(res, 200, { dir });
      return;
    }
    case '/api/dsh/restart': {
      // M6 重启 seam:仅绑 127.0.0.1 + 随机共享密钥(经 launcher-registration.json 0600 分发给 dsh 侧/CLI)
      const u2 = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u2.searchParams.get('key') !== bridgeKey) {
        log.warn('restart 拒绝：bridgeKey 校验失败');
        json(res, 403, { ok: false, message: 'bridgeKey 校验失败' });
        return;
      }
      if (restartBusy) {
        json(res, 409, { ok: false, message: 'restart 进行中' });
        return;
      }
      restartBusy = true;
      json(res, 202, { ok: true, message: 'restart 已开始（进度见日志）' });
      void (async () => {
        try {
          log.info('restart（REST bridge 触发）……');
          await launch.restartActive();
          log.info('restart 完成。');
        } catch (e) {
          log.error(`restart 失败：${errMessage(e)}`);
        } finally {
          restartBusy = false;
        }
      })();
      return;
    }
    case '/api/setup': {
      // M7:一键部署(异步;core→pull→个人层→连接→start;进度走 SSE)
      if (setupBusy) {
        json(res, 409, { ok: false, message: '一键部署进行中' });
        return;
      }
      const body = await readBody(req);
      const str = (k: string): string | undefined => (typeof body[k] === 'string' && (body[k] as string).length > 0 ? (body[k] as string) : undefined);
      const rawPlugins = body.plugins;
      const opts: setup.SetupOptions = {
        manifest: str('manifest'),
        offlineDir: str('offlineDir'),
        profileDir: str('profileDir'),
        profileIn: str('profileIn'),
        password: str('password'),
        connection: str('connection'),
        plugins: Array.isArray(rawPlugins) ? (rawPlugins as unknown[]).filter((x): x is string => typeof x === 'string') : undefined,
        noStart: body.noStart === true,
      };
      setupBusy = true;
      json(res, 202, { ok: true, message: '一键部署已开始（进度见日志）' });
      void (async () => {
        try {
          log.info('一键部署开始（GUI 触发）……');
          await setup.runSetup(opts);
          log.info('一键部署完成。');
        } catch (e) {
          log.error(`一键部署失败：${errMessage(e)}`);
        } finally {
          setupBusy = false;
        }
      })();
      return;
    }
    case '/api/exit': {
      json(res, 200, { ok: true });
      // 退出前停止绑定的 dsh 子进程（启动器常驻 = dsh 随启动器停）
      launch.stopChildSilently();
      setTimeout(() => process.exit(0), 50);
      return;
    }
    default:
      json(res, 404, { ok: false, message: 'not found' });
  }
}

// ---------- 启动 ----------

export function startServer(port: number): Promise<{ port: number; url: string }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = u.pathname;

    if (path === '/api/events') {
      handleEvents(res);
      return;
    }
    if (path.startsWith('/api/')) {
      void handleApi(path, req, res);
      return;
    }
    const asset = assets[path] ?? assets['/'];
    res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': Buffer.byteLength(asset.content) });
    res.end(asset.content);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      log.info(`launcher UI 服务已启动：http://127.0.0.1:${actualPort}/`);
      // M6:把 api/bridgeKey 补写进 launcher-registration.json(0600;dsh 侧/CLI restart 经此发现)
      registration.setBridge(`http://127.0.0.1:${actualPort}`, bridgeKey);
      resolve({ port: actualPort, url: `http://127.0.0.1:${actualPort}/` });
    });
  });
}
