// scripts/verify-m9.mjs —— M9 自动验证脚本（上游桌面版：取件 / 校验 / 预检安装），无头 + 免网络。
//
// 背景：desktop 自 2026-09-28 起归上游（deepseek-harness/apps/desktop），伞仓只镜像其 win-x64
// 安装包；launcher 负责「首装 / 升级」。本脚本用**本地夹具安装包 + 同名 .sha512** 把整条链路
// 跑在临时 DSH_HOME 里，不触网、不真装（--dry-run 到"落盘"为止）。
//
// 覆盖：
//   1. help 文案含 desktop 子命令
//   2. `desktop status --from <本地包>`：显式来源解析（版本从文件名推 + 读副档）+ 已装版本探测
//   3. `desktop install --from <包> --dry-run`：取件 → sha512 校验 → 落 <DSH_HOME>/cache/desktop
//   4. 摘要不符 → 非零退出，且**不落最终文件**
//   5. `--version` 与文件名版本不一致 → 非零退出
//   6. 缺 .sha512 副档 → 明示"跳过摘要校验"但仍可用（如实告警，不假装验过）
//   7. 非 Windows：status 明示不支持（安装/升级仅 Windows）
//
// 用法：node scripts/verify-m9.mjs（先 `npm run build`）

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const launcherCli = join(root, 'dist', 'launcher.cjs');
const isWin = process.platform === 'win32';

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
};

/** 跑一次 CLI（dist/launcher.cjs），返回 {status, out}。 */
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

/** 造一个本地夹具安装包（内容任意）+ 可选 .sha512 副档。 */
function makeFixture(dir, version, { sidecar = 'good' } = {}) {
  const name = `deepseek-harness-${version}-win-x64.exe`;
  const file = join(dir, name);
  writeFileSync(file, Buffer.from(`fixture-installer-${version}-`.repeat(64), 'utf8'));
  const hex = createHash('sha512').update(readFileSync(file)).digest('hex');
  if (sidecar === 'good') writeFileSync(`${file}.sha512`, `${hex}  ${basename(file)}\n`, 'utf8');
  if (sidecar === 'bad') writeFileSync(`${file}.sha512`, `${'0'.repeat(128)}  ${basename(file)}\n`, 'utf8');
  return { file, name, hex };
}

async function main() {
  const base = mkdtempSync(join(tmpdir(), 'm9-verify-'));
  const home = join(base, 'dsh-home');
  const cfg = join(base, 'cfg');
  const pkgDir = join(base, 'pkg');
  for (const d of [home, cfg, pkgDir]) mkdirSync(d, { recursive: true });
  // 隔离：临时 DSH_HOME（缓存目录也跟着走）+ 临时 launcher 配置目录
  const env = { DSH_HOME: home, DSH_LAUNCHER_CONFIG_DIR: cfg };
  const cacheDir = join(home, 'cache', 'desktop');

  console.log('1. help 文案');
  {
    const r = await runCli(['--help'], env);
    ok(r.status === 0, '1-1 --help 退出码 0');
    ok(r.out.includes('desktop install'), '1-2 帮助含 desktop install');
    ok(r.out.includes('desktop status'), '1-3 帮助含 desktop status');
  }

  console.log('2. desktop status（显式本地来源）');
  const good = makeFixture(pkgDir, '9.9.9-fixture');
  {
    const r = await runCli(['desktop', 'status', '--from', good.file], env);
    ok(r.status === 0, '2-1 退出码 0');
    ok(r.out.includes('9.9.9-fixture'), '2-2 解析出夹具版本');
    ok(r.out.includes('explicit'), '2-3 来源标为 explicit');
    // 夹具未装：已装版本应为占位（—），且不该崩
    ok(r.out.includes('已装版本'), '2-4 输出已装版本字段');
    ok(isWin ? true : r.out.includes('否'), `2-5 平台支持提示（非 Windows 时明示不支持）`);
  }

  console.log('3. desktop install --dry-run（取件 → 校验 → 落盘，不安装）');
  {
    const r = await runCli(['desktop', 'install', '--from', good.file, '--dry-run'], env);
    ok(r.status === 0, `3-1 退出码 0（${r.status}）${r.status !== 0 ? '\n' + r.out.slice(-400) : ''}`);
    ok(r.out.includes('sha512 ✓'), '3-2 摘要校验通过');
    ok(r.out.includes('dry-run'), '3-3 明示 dry-run 未安装');
    const landed = join(cacheDir, good.name);
    ok(existsSync(landed), '3-4 已落到 <DSH_HOME>/cache/desktop');
    ok(existsSync(landed) && createHash('sha512').update(readFileSync(landed)).digest('hex') === good.hex, '3-5 落盘内容摘要一致');
  }

  console.log('4. 摘要不符 → 非零退出且不落最终文件');
  const bad = makeFixture(pkgDir, '9.9.8-bad', { sidecar: 'bad' });
  {
    const r = await runCli(['desktop', 'install', '--from', bad.file, '--dry-run'], env);
    ok(r.status !== 0, '4-1 退出码非 0');
    ok(r.out.includes('sha512 校验失败'), '4-2 报明确原因');
    ok(!existsSync(join(cacheDir, bad.name)), '4-3 未落最终文件');
  }

  console.log('5. --version 与文件名版本不一致 → 非零退出');
  {
    const r = await runCli(['desktop', 'install', '--from', good.file, '--version', '1.2.3', '--dry-run'], env);
    ok(r.status !== 0, '5-1 退出码非 0');
    ok(r.out.includes('不一致'), '5-2 报版本不一致');
  }

  console.log('6. 缺 .sha512 副档 → 如实告警但仍可用');
  const noSidecar = makeFixture(pkgDir, '9.9.7-nohash', { sidecar: 'none' });
  {
    const r = await runCli(['desktop', 'install', '--from', noSidecar.file, '--dry-run'], env);
    ok(r.status === 0, '6-1 退出码 0');
    ok(r.out.includes('跳过摘要校验'), '6-2 明示未校验（不假装验过）');
  }

  console.log('7. 取件不可用：status 如实报错但不抛；install 必须非零退出');
  {
    const missing = join(base, 'nope.exe');
    const r = await runCli(['desktop', 'status', '--from', missing], env);
    ok(r.status === 0, '7-1 status 不抛错（取件失败走 error 字段）');
    ok(r.out.includes('取件错误'), '7-2 status 明示取件错误原因');
    const r2 = await runCli(['desktop', 'install', '--from', missing, '--dry-run'], env);
    ok(r2.status !== 0, '7-3 install 取件不可用 → 非零退出');
    ok(r2.out.includes('无法') || r2.out.includes('失败'), '7-4 install 给出可读原因');
  }

  rmSync(base, { recursive: true, force: true });
  console.log(`\n结果:${passed} 通过,${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-m9 异常:', e);
  process.exit(1);
});
