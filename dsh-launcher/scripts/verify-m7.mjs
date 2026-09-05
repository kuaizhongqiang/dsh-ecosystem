// scripts/verify-m7.mjs —— M7 自动验证脚本（setup 一条龙,无头 e2e）。
//
// 覆盖(M7 / Phase 7):`setup --manifest --offline --profile-dir --no-start --update-lock`
//   离线 core 安装 → pull(trust 插件目录 + skills 执行 + state)→ 个人层恢复 → 连接(合成默认)
//   → 跳过启动;并写 lock(--update-lock)。
//
// 用法:node scripts/verify-m7.mjs(先 npm run build)

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
const shaHex = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

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
  const base = mkdtempSync(join(tmpdir(), 'm7-verify-'));

  // ---- fixture:离线包(dsh + runtime + plugins) ----
  const bundle = mkdtempSync(join(base, 'offline-'));
  const pkgDir = join(bundle, 'dsh', 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(join(pkgDir, 'lib'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.7.7-fixture' }, null, 2));
  writeFileSync(join(pkgDir, 'lib', 'bin.js'), "console.log('0.7.7-fixture')\n");
  mkdirSync(join(bundle, 'runtime'), { recursive: true });
  writeFileSync(join(bundle, 'runtime', 'node.exe'), 'FAKE\n');
  const mkScript = (m) => `$d=$env:TEST_MARK_DIR\nNew-Item -ItemType Directory -Path $d -Force | Out-Null\nSet-Content -Path (Join-Path $d '${m}.txt') -Value 'ok'\nexit 0\n`;
  mkdirSync(join(bundle, 'plugins', 'plugins', 'pkgA-dsh-plugin'), { recursive: true });
  mkdirSync(join(bundle, 'plugins', 'plugins', 'pkgB-dsh-plugin'), { recursive: true });
  mkdirSync(join(bundle, 'plugins', 'skills'), { recursive: true });
  writeFileSync(join(bundle, 'plugins', 'plugins', 'pkgA-dsh-plugin', 'install.ps1'), mkScript('pkgA'));
  writeFileSync(join(bundle, 'plugins', 'plugins', 'pkgB-dsh-plugin', 'install.ps1'), mkScript('pkgB'));
  writeFileSync(join(bundle, 'plugins', 'skills', 'install-skills.ps1'), mkScript('skills'));

  // ---- fixture:清单(锁 commit + 逐包 sha256) ----
  const mf = join(base, 'manifest.json');
  writeFileSync(mf, JSON.stringify({
    version: 1,
    dsh: { source: 'github', version: 'latest' },
    plugins: {
      source: { repo: 'https://github.com/example/dsh-plugins.git', commit: 'f'.repeat(40) },
      packages: [
        { id: 'pkgA', dir: 'plugins/pkgA-dsh-plugin', sha256: { 'install.ps1': shaHex(join(bundle, 'plugins', 'plugins', 'pkgA-dsh-plugin', 'install.ps1')) } },
        { id: 'pkgB', dir: 'plugins/pkgB-dsh-plugin', sha256: { 'install.ps1': shaHex(join(bundle, 'plugins', 'plugins', 'pkgB-dsh-plugin', 'install.ps1')) } },
      ],
    },
    skills: { script: 'skills/install-skills.ps1', sha256: shaHex(join(bundle, 'plugins', 'skills', 'install-skills.ps1')) },
  }, null, 2));

  // ---- fixture:个人层 pack(来自另一台"机器" homeA) ----
  const profile = await import(pathToFileURL(join(root, 'src', 'profile.ts')).href);
  const homeA = mkdtempSync(join(base, 'homeA-'));
  mkdirSync(dirname(join(homeA, 'settings.yaml')), { recursive: true });
  writeFileSync(join(homeA, 'settings.yaml'), 'from: A\n');
  process.env.DSH_HOME = homeA;
  const pack = join(base, 'pack');
  profile.pushProfilePack(pack);

  // ---- 运行 setup(无头;目标机器 = homeB) ----
  const homeB = mkdtempSync(join(base, 'homeB-'));
  const cfg = mkdtempSync(join(base, 'cfg-'));
  const rt = mkdtempSync(join(base, 'rt-'));
  const mark = mkdtempSync(join(base, 'mark-'));
  delete process.env.DSH_HOME;

  console.log('setup --manifest --offline --profile-dir --no-start --update-lock');
  const r = await runCli(
    ['setup', '--manifest', mf, '--offline', bundle, '--profile-dir', pack, '--no-start', '--update-lock'],
    { DSH_HOME: homeB, DSH_LAUNCHER_CONFIG_DIR: cfg, DSH_LAUNCHER_RUNTIME_DIR: rt, DSH_LAUNCHER_RUNTIME_FAKE: '1', TEST_MARK_DIR: mark },
  );

  ok(r.status === 0, `1-1 setup 退出码 0（${r.status}）${r.status !== 0 ? '\n' + r.out.slice(-600) : ''}`);
  const lj = JSON.parse(readFileSync(join(cfg, 'launcher.json'), 'utf8'));
  ok(lj.source === 'npm' && lj.dshVersion === '0.7.7-fixture', '1-2 core 离线安装并写配置');
  ok(existsSync(join(rt, 'node.exe')), '1-3 便携 runtime 落位');
  const st = JSON.parse(readFileSync(join(cfg, 'ecosystem-state.json'), 'utf8'));
  ok(st.plugins.pkgA?.ok === true && st.plugins.pkgB?.ok === true && st.skills?.ok === true, '1-4 pull:插件+skills ok');
  ok(existsSync(join(mark, 'pkgA.txt')) && existsSync(join(mark, 'skills.txt')), '1-5 插件/技能脚本已执行');
  ok(readFileSync(join(homeB, 'settings.yaml'), 'utf8') === 'from: A\n', '1-6 个人层已恢复');
  const lock = JSON.parse(readFileSync(join(cfg, 'ecosystem-lock.json'), 'utf8'));
  ok(lock.version === 1 && lock.manifest.plugins.source.commit === 'f'.repeat(40), '1-7 lock 已写(--update-lock)');
  ok(typeof st.manifest.label === 'string' && st.manifest.label.endsWith('manifest.json'), '1-8 state 记录清单来源');

  rmSync(base, { recursive: true, force: true });
  console.log(`\n结果:${passed} 通过,${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-m7 异常:', e);
  process.exit(1);
});
