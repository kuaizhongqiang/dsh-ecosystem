// scripts/verify-m5.mjs —— M5 自动验证脚本（多连接启动项）。
//
// 覆盖(M5 / Phase 5,决策 D5 + D8):
//   1. connections 单元:默认合成(无文件)、add/use/remove、校验拒绝(重复 id/remote 缺 url/未知 use)、
//      原子写无 .tmp 残留、.dsh-connection-changed 标记
//   2. D8 端口锁:他组活跃 PID 拒绝、自身 pid 放行、陈旧锁放行、清理
//   3. remote target 构造:token 追加(?/&)
//   4. CLI e2e(dist):connections add/list/use、损坏文件降级
//   5. UI e2e:GET /api/connections(token 不泄漏)、POST use、/api/status 带 connection
//
// 用法:node scripts/verify-m5.mjs(先 npm run build;场景 4/5 走 dist/launcher.cjs)

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const connSrc = join(root, 'src', 'connections.ts');
const launcherCli = join(root, 'dist', 'launcher.cjs');

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failures++; console.error(`  FAIL - ${name}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCli(args, env) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [launcherCli, ...args], {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    cp.stdout.on('data', (d) => (out += d));
    cp.stderr.on('data', (d) => (out += d));
    cp.on('close', (status) => resolve({ status, out }));
    cp.on('error', (e) => resolve({ status: -1, out: String(e) }));
  });
}

async function main() {
  const conn = await import(pathToFileURL(connSrc).href);
  const base = mkdtempSync(join(tmpdir(), 'm5-verify-'));

  console.log('1. connections 单元');
  {
    const home = mkdtempSync(join(base, 'home1-'));
    process.env.DSH_HOME = home;
    // 默认合成
    const r1 = conn.resolveActive(null);
    ok(r1.conn.kind === 'local' && r1.conn.port === 3080 && r1.conn.id === 'local-3080', '1-1 无文件 → 合成 local-3080');
    ok(!existsSync(conn.connectionsPath()), '1-2 合成默认不落盘');
    // add local + remote
    conn.addConnection({ id: 'local2', kind: 'local', port: 3081 });
    conn.addConnection({ id: 'wan', kind: 'remote', url: 'https://dsh.example.com', token: 't0ken' });
    ok(existsSync(conn.connectionsPath()), '1-3 add 后 connections.json 落盘');
    const f = JSON.parse(readFileSync(conn.connectionsPath(), 'utf8'));
    ok(f.version === 1 && f.connections.length === 2, '1-4 文件结构 v1/2 连接');
    const tmps = readdirSync(home).filter((n) => n.includes('.tmp-'));
    ok(tmps.length === 0, '1-5 原子写无 .tmp 残留');
    // 校验拒绝
    let threw = 0;
    try { conn.addConnection({ id: 'local2', kind: 'local', port: 1 }); } catch { threw++; }
    try { conn.addConnection({ id: 'badr', kind: 'remote' }); } catch { threw++; }
    try { conn.useConnection('nope'); } catch { threw++; }
    ok(threw === 3, '1-6 重复 id / remote 缺 url / 未知 use 均被拒');
    // use + 标记
    conn.useConnection('wan');
    const f2 = JSON.parse(readFileSync(conn.connectionsPath(), 'utf8'));
    ok(f2.active === 'wan', '1-7 use 切换 active');
    const marker = JSON.parse(readFileSync(conn.changedMarkerPath(), 'utf8'));
    ok(marker.active === 'wan', '1-8 .dsh-connection-changed 标记写入');
    // remove active → 回退
    conn.removeConnection('wan');
    const f3 = JSON.parse(readFileSync(conn.connectionsPath(), 'utf8'));
    ok(f3.active === 'local2' && f3.connections.length === 1, '1-9 删除 active 回退第一个');
  }

  console.log('2. D8 端口锁');
  {
    const home = mkdtempSync(join(base, 'home2-'));
    process.env.DSH_HOME = home;
    conn.writePortLock(4001, process.pid);
    let threw = false;
    try { conn.checkPortLock(4001, process.pid + 1); } catch { threw = true; }
    ok(threw, '2-1 他组活跃 PID 持锁 → 拒绝');
    conn.checkPortLock(4001, process.pid); // 自身放行(不抛即过)
    ok(true, '2-2 自身 pid 放行');
    // 陈旧锁:写入一个必然不存在的 pid
    const lockFile = conn.portLockPath(4002);
    writeFileSync(lockFile, JSON.stringify({ pid: 4123659999, source: 'test', startedAt: 'x' }), 'utf8');
    let staleOk = true;
    try { conn.checkPortLock(4002, process.pid); } catch { staleOk = false; }
    ok(staleOk, '2-3 陈旧锁(进程已死)放行');
    conn.clearPortLock(4001);
    conn.clearPortLock(4002);
    ok(!existsSync(conn.portLockPath(4001)) && !existsSync(conn.portLockPath(4002)), '2-4 clearPortLock 清理');
  }

  console.log('3. remote target 构造');
  {
    const t1 = conn.buildRemoteTarget({ id: 'a', kind: 'remote', url: 'https://x.dev', token: 'abc' });
    ok(t1 === 'https://x.dev?token=abc', '3-1 无 query 追加 ?token=');
    const t2 = conn.buildRemoteTarget({ id: 'a', kind: 'remote', url: 'https://x.dev/?a=1', token: 'abc' });
    ok(t2 === 'https://x.dev/?a=1&token=abc', '3-2 已有 query 追加 &token=');
    const t3 = conn.buildRemoteTarget({ id: 'a', kind: 'remote', url: 'https://x.dev' });
    ok(t3 === 'https://x.dev', '3-3 无 token 原样(交由外部认证)');
  }

  const homeE = mkdtempSync(join(base, 'home-e2e-'));
  const cfgE = mkdtempSync(join(base, 'cfg-e2e-'));
  const cliEnv = { DSH_HOME: homeE, DSH_LAUNCHER_CONFIG_DIR: cfgE };

  console.log('4. CLI e2e(connections)');
  {
    let r = await runCli(['connections', 'add', '--id', 'wan', '--kind', 'remote', '--url', 'https://dsh.example.com', '--token', 'sekrit'], cliEnv);
    ok(r.status === 0, '4-1 add remote(wan) 退出码 0');
    r = await runCli(['connections', 'add', '--id', 'local2', '--kind', 'local', '--port', '3081'], cliEnv);
    ok(r.status === 0, '4-2 add local(local2) 退出码 0');
    r = await runCli(['connections', 'list'], cliEnv);
    ok(r.status === 0 && r.out.includes('wan') && r.out.includes('local2'), '4-3 list 显示两条连接');
    r = await runCli(['connections', 'use', 'local2'], cliEnv);
    ok(r.status === 0, '4-4 use local2 退出码 0');
    const f = JSON.parse(readFileSync(join(homeE, 'connections.json'), 'utf8'));
    ok(f.active === 'local2', '4-5 文件 active=local2');
    // 损坏文件降级
    writeFileSync(join(homeE, 'connections.json'), '{broken', 'utf8');
    r = await runCli(['connections', 'list'], cliEnv);
    ok(r.status === 0 && r.out.includes('local-3080'), '4-6 损坏文件 → 告警 + 合成默认,不崩溃');
  }

  console.log('5. UI e2e(/api/connections + status)');
  {
    // 重建有效文件(wan + local2,active=wan;场景 4 末尾故意写坏了文件,add 会重建)
    process.env.DSH_HOME = homeE;
    conn.addConnection({ id: 'local2', kind: 'local', port: 3081 });
    conn.addConnection({ id: 'wan', kind: 'remote', url: 'https://dsh.example.com', token: 'sekrit' });
    conn.useConnection('wan');
    const port = 32000 + Math.floor(Math.random() * 1000);
    const b = `http://127.0.0.1:${port}`;
    const cp = spawn(process.execPath, [launcherCli, 'ui', '--no-browser', '--port', String(port)], {
      env: { ...process.env, DSH_HOME: homeE, DSH_LAUNCHER_CONFIG_DIR: cfgE },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let ready = false;
      for (let i = 0; i < 80; i++) {
        try { const r = await fetch(b + '/api/status'); if (r.status === 200) { ready = true; break; } } catch { /* retry */ }
        await sleep(250);
      }
      ok(ready, '5-1 UI 服务就绪');
      const g = await (await fetch(b + '/api/connections')).json();
      ok(g.ok === true && g.active === 'wan' && g.list.length === 2, '5-2 /api/connections 列表与 active');
      ok(g.list.find((c) => c.id === 'wan')?.hasToken === true, '5-3 hasToken=true');
      const raw = JSON.stringify(g);
      ok(!raw.includes('sekrit'), '5-4 token 值不出后端');
      const u = await (await fetch(b + '/api/connections/use', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'local2' }) })).json();
      ok(u.ok === true, '5-5 POST use 切换成功');
      const s = await (await fetch(b + '/api/status')).json();
      ok(s.connection && s.connection.id === 'local2' && s.connection.kind === 'local', '5-6 /api/status 带激活连接');
      const html = await (await fetch(b + '/')).text();
      ok(html.includes('id="connSelect"'), '5-7 UI 含连接切换器');
    } finally {
      cp.kill();
      await sleep(300);
      delete process.env.DSH_HOME;
    }
  }

  rmSync(base, { recursive: true, force: true });
  console.log(`\n结果:${passed} 通过,${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-m5 异常:', e);
  process.exit(1);
});
