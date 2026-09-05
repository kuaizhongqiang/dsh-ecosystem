// scripts/verify-m2.mjs —— M2 自动验证脚本（GUI「生态」页后端契约 + 资源注入）。
//
// 覆盖(M2 / Phase 2):
//   1. GET /api/ecosystem:清单(默认内嵌,11 包)+ 状态(无/有 ecosystem-state.json)+ busy
//   2. POST /api/ecosystem/pull:异步触发,dry-run 空选快速结束,busy 回落
//   3. UI 静态资源注入:/ 含生态卡片控件;/app.js 含生态渲染逻辑
//
// 用法:node scripts/verify-m2.mjs（先 npm run build;脚本自行拉起 dist/launcher.cjs ui）

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(root, 'dist', 'launcher.cjs');

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failures++; console.error(`  FAIL - ${name}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await r.text();
  let j = null;
  try { j = JSON.parse(body); } catch { /* ignore */ }
  return { status: r.status, body, json: j };
}
async function postJson(url, payload) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const body = await r.text();
  let j = null;
  try { j = JSON.parse(body); } catch { /* ignore */ }
  return { status: r.status, body, json: j };
}

async function main() {
  if (!existsSync(launcher)) {
    console.error('缺少 dist/launcher.cjs：请先运行 npm run build');
    process.exit(1);
  }
  const cfg = mkdtempSync(join(tmpdir(), 'm2-cfg-'));
  const home = mkdtempSync(join(tmpdir(), 'm2-home-'));
  const port = 31000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;

  console.log('启动 launcher UI 服务（dry 环境）……');
  const cp = spawn(process.execPath, [launcher, 'ui', '--no-browser', '--port', String(port)], {
    env: { ...process.env, DSH_LAUNCHER_CONFIG_DIR: cfg, DSH_HOME: home },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOut = '';
  cp.stdout.on('data', (d) => (childOut += d));
  cp.stderr.on('data', (d) => (childOut += d));
  cp.on('error', (e) => { console.error('launcher 启动失败:', e.message); });

  try {
    // 等就绪
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { const r = await fetch(base + '/api/status'); if (r.status === 200) { ready = true; break; } } catch { /* retry */ }
      await sleep(250);
    }
    ok(ready, 'UI 服务就绪');

    console.log('1. GET /api/ecosystem（无状态）');
    const g1 = await getJson(base + '/api/ecosystem');
    ok(g1.status === 200 && g1.json?.ok === true, '1-1 /api/ecosystem 200 ok');
    ok(Array.isArray(g1.json?.manifest?.packages) && g1.json.manifest.packages.length === 7, '1-2 默认清单 7 包(11→7)');
    ok(g1.json.manifest.skills === true && !!g1.json.label, '1-3 skills=true 且带 label');
    ok(g1.json.state === null, '1-4 无状态时 state=null');
    ok(g1.json.manifest.pluginsCommit === '9f472797785a70cf78de0042f98e01d05ef927cb', '1-5 插件源锁 9f47279');
    ok(typeof g1.json.pluginsDir === 'string' && g1.json.pluginsDir.endsWith('dsh-plugins'), '1-6 pluginsDir 默认 launcher 旁');

    console.log('2. GET /api/ecosystem（有状态）');
    const st = {
      version: 1, updatedAt: new Date().toISOString(),
      core: { installed: true, version: 'dsh-v0.1.2-alpha.1', installDir: 'C:\\tmp\\dsh' },
      plugins: { credentials: { ok: true, installedAt: 'x' }, github: { ok: false, error: '测试失败' } },
      skills: { ok: true },
      manifest: { label: '默认', pluginsCommit: '15ffcfd77d391d6ba5fed8dc6285e6bb5ff0f72c' },
    };
    writeFileSync(join(cfg, 'ecosystem-state.json'), JSON.stringify(st), 'utf8');
    const g2 = await getJson(base + '/api/ecosystem');
    ok(g2.json?.state?.core?.installed === true, '2-1 state.core 读取');
    ok(g2.json.state.plugins.credentials.ok === true && g2.json.state.plugins.github.ok === false, '2-2 state.plugins 读取');

    console.log('3. POST /api/ecosystem/pull（dry-run 空选,应快速完成）');
    const p1 = await postJson(base + '/api/ecosystem/pull', { plugins: [], core: false, skills: false, dryRun: true });
    ok(p1.status === 200 && p1.json?.ok === true, '3-1 pull 启动 ok');
    await sleep(1200);
    const g3 = await getJson(base + '/api/ecosystem');
    ok(g3.json?.busy === false, '3-2 pull 结束后 busy=false');

    console.log('4. UI 资源注入（M2 生态卡片）');
    const html = await (await fetch(base + '/')).text();
    ok(html.includes('id="btnEcoPull"') && html.includes('id="ecoPkgs"'), '4-1 / 含生态卡片控件');
    const js = await (await fetch(base + '/app.js')).text();
    ok(js.includes('refreshEcosystem') && js.includes('onEcoPull'), '4-2 /app.js 含生态逻辑');
  } finally {
    cp.kill();
    await sleep(300);
    rmSync(cfg, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
  console.log(`\n结果:${passed} 通过,${failures} 失败`);
  if (failures > 0) console.log('子进程输出尾部:\n' + childOut.split(/\r?\n/).slice(-15).join('\n'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-m2 异常:', e);
  process.exit(1);
});
