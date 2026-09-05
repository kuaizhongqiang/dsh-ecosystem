// scripts/verify-m6.mjs —— M6 自动验证脚本（托盘 + 重启 seam）。
//
// 覆盖(M6 / Phase 6):
//   1. trayIcon:运行时生成 4 态 16×16 RGBA PNG(签名/IHDR/IDAT inflate 尺寸)
//   2. registration:注册/补写/心跳/注销(owned 保护)、isFresh、setBridge 合并
//   3. launch-token managedBy 字段 roundtrip(读取方忽略未知字段,向后兼容)
//   4. restart seam e2e:UI 服务就绪后,launcher-registration.json 获得 api/bridgeKey;
//      POST /api/dsh/restart 错 key=403、对 key=202
//   5. CLI restart 兜底:无 launcher.json → 优雅失败(exit 1)
//   6. 源码级断言:launch.ts 注入 DSH_LAUNCHER_EXE/PID/CONNECTION + restartActive
//
// 用法:node scripts/verify-m6.mjs(先 npm run build;场景 4/5 走 dist/launcher.cjs)

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); }
  catch (e) {
    if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
    throw e;
  }
}`),
  import.meta.url,
);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const launcherCli = join(root, 'dist', 'launcher.cjs');

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failures++; console.error(`  FAIL - ${name}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pngChunks(buf) {
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return chunks;
}

async function main() {
  const base = mkdtempSync(join(tmpdir(), 'm6-verify-'));

  console.log('1. trayIcon 运行时 PNG');
  {
    const { trayPng } = await import(pathToFileURL(join(root, 'src', 'trayIcon.ts')).href);
    for (const st of ['dim', 'green', 'yellow', 'red']) {
      const png = trayPng(st);
      const chunks = pngChunks(png);
      const ihdr = chunks.find((c) => c.type === 'IHDR');
      const idat = chunks.find((c) => c.type === 'IDAT');
      const raw = inflateSync(idat.data);
      ok(
        png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
          ihdr.data.readUInt32BE(0) === 16 && ihdr.data.readUInt32BE(4) === 16 &&
          raw.length === 16 * (1 + 16 * 4),
        `1-${['dim', 'green', 'yellow', 'red'].indexOf(st) + 1} ${st} PNG 16×16 RGBA 合法`,
      );
    }
  }

  console.log('2. registration 注册/心跳/注销');
  {
    const home = mkdtempSync(join(base, 'home2-'));
    const portable = mkdtempSync(join(base, 'portable-'));
    process.env.DSH_HOME = home;
    process.env.PORTABLE_EXECUTABLE_DIR = portable;
    const reg = await import(pathToFileURL(join(root, 'src', 'registration.ts')).href);
    ok(reg.launcherExePath() === join(portable, 'dsh-launcher.exe'), '2-1 便携版 exe 原始路径解析');
    reg.registerLauncher('C:\\dsh', { pid: process.pid, running: true });
    const f = JSON.parse(readFileSync(reg.registrationPath(), 'utf8'));
    ok(f.version === 1 && f.running === true && f.pid === process.pid && f.dshInstallDir === 'C:\\dsh', '2-2 注册字段');
    ok(reg.isFresh(reg.readRegistration()), '2-3 注册新鲜');
    reg.setBridge('http://127.0.0.1:3177', 'k-of-bridge');
    const f2 = JSON.parse(readFileSync(reg.registrationPath(), 'utf8'));
    ok(f2.api === 'http://127.0.0.1:3177' && f2.bridgeKey === 'k-of-bridge', '2-4 setBridge 补写 api/bridgeKey');
    reg.startHeartbeat(() => ({ pid: process.pid, running: true }));
    reg.stopHeartbeat();
    const f3 = JSON.parse(readFileSync(reg.registrationPath(), 'utf8'));
    ok(f3.running === true && f3.pid === process.pid, '2-5 心跳立即刷新');
    reg.unregisterLauncher();
    ok(!existsSync(reg.registrationPath()), '2-6 拥有者注销删除文件');
    // 非拥有者注销不误删
    writeFileSync(reg.registrationPath(), JSON.stringify({ version: 1, launcherExe: 'x', launcherVersion: '0', dshInstallDir: 'y', running: false, registeredAt: 'a', updatedAt: new Date().toISOString() }), 'utf8');
    reg.unregisterLauncher();
    ok(existsSync(reg.registrationPath()), '2-7 非拥有者注销不误删他人注册');
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  }

  console.log('3. launch-token managedBy');
  {
    const home = mkdtempSync(join(base, 'home3-'));
    process.env.DSH_HOME = home;
    const tf = await import(pathToFileURL(join(root, 'src', 'tokenFile.ts')).href);
    tf.writeLaunchToken({ token: 't', url: 'http://127.0.0.1:3080/?token=t', port: 3080, source: 'dsh-launcher', managedBy: 'dsh-launcher' });
    const rec = tf.readLaunchToken();
    ok(rec && rec.managedBy === 'dsh-launcher', '3-1 managedBy 写入并可读');
  }

  const cfg4 = mkdtempSync(join(base, 'cfg4-'));
  const home4 = mkdtempSync(join(base, 'home4-'));
  console.log('4. restart seam e2e');
  {
    process.env.DSH_HOME = home4;
    process.env.PORTABLE_EXECUTABLE_DIR = join(base, 'portable4-');
    const reg = await import(pathToFileURL(join(root, 'src', 'registration.ts')).href);
    reg.registerLauncher('C:\\dsh', { pid: process.pid, running: false });
    const port = 33000 + Math.floor(Math.random() * 1000);
    const b = `http://127.0.0.1:${port}`;
    const cp = spawn(process.execPath, [launcherCli, 'ui', '--no-browser', '--port', String(port)], {
      env: { ...process.env, DSH_LAUNCHER_CONFIG_DIR: cfg4 },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let ready = false;
      for (let i = 0; i < 80; i++) {
        try { const r = await fetch(b + '/api/status'); if (r.status === 200) { ready = true; break; } } catch { /* retry */ }
        await sleep(250);
      }
      ok(ready, '4-1 UI 服务就绪');
      const regFile = JSON.parse(readFileSync(reg.registrationPath(), 'utf8'));
      ok(!!regFile.bridgeKey && regFile.api === b, '4-2 注册文件获得 api/bridgeKey(server 补写)');
      const bad = await fetch(`${b}/api/dsh/restart?key=wrong`, { method: 'POST' });
      ok(bad.status === 403, '4-3 错 key → 403');
      const good = await fetch(`${b}/api/dsh/restart?key=${encodeURIComponent(regFile.bridgeKey)}`, { method: 'POST' });
      ok(good.status === 202, '4-4 对 key → 202(异步 restart;无 dsh 安装时仅日志报错)');
      const s = await (await fetch(b + '/api/status')).json();
      ok(s.connection && s.connection.id, '4-5 /api/status 带连接信息');
    } finally {
      cp.kill();
      await sleep(300);
      delete process.env.PORTABLE_EXECUTABLE_DIR;
      delete process.env.DSH_HOME;
    }
  }

  console.log('5. CLI restart 兜底(无安装 → 优雅失败)');
  {
    const cfg5 = mkdtempSync(join(base, 'cfg5-'));
    const r = await new Promise((resolve) => {
      const cp = spawn(process.execPath, [launcherCli, 'restart'], {
        env: { ...process.env, DSH_LAUNCHER_CONFIG_DIR: cfg5, DSH_HOME: join(base, 'home5') },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      cp.stdout.on('data', (d) => (out += d));
      cp.stderr.on('data', (d) => (out += d));
      cp.on('close', (status) => resolve({ status, out }));
    });
    ok(r.status === 1 && /launcher\.json/.test(r.out), `5-1 退出码 1 + 提示(${r.status})`);
  }

  console.log('6. 源码级断言(重启 seam 注入)');
  {
    const launchSrc = readFileSync(join(root, 'src', 'launch.ts'), 'utf8');
    ok(launchSrc.includes('DSH_LAUNCHER_EXE') && launchSrc.includes('DSH_LAUNCHER_PID') && launchSrc.includes('DSH_LAUNCHER_CONNECTION'), '6-1 发现链环境变量注入');
    ok(launchSrc.includes('export async function restartActive'), '6-2 restartActive 落点');
    const tokenSrc = readFileSync(join(root, 'src', 'tokenFile.ts'), 'utf8');
    ok(tokenSrc.includes("managedBy?: 'dsh-launcher'"), '6-3 launch-token 兼容字段');
  }

  rmSync(base, { recursive: true, force: true });
  console.log(`\n结果:${passed} 通过,${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-m6 异常:', e);
  process.exit(1);
});
