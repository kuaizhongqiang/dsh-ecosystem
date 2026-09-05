// scripts/verify-m3.mjs —— M3 自动验证脚本（Node 运行时自持 + 离线包）。
//
// 覆盖(M3 / Phase 3):
//   1. 离线包安装(真实 CLI `install --offline`):offline/dsh 直装、布局自动识别(npm)、
//      launcher.json 写入、offline/runtime 便携 node 落位
//   2. 启动用 node 解析优先级(直载 src/node.ts):DSH_LAUNCHER_NODE_EXE > 便携 runtime > 系统 node
//   3. 便携 runtime 就绪:本地镜像(zip)下载→解压→node.exe 提升(DSH_LAUNCHER_RUNTIME_FAKE 跳过执行校验)
//   4. PATH 注入:便携 runtime 目录插到子进程 PATH 最前
//
// 用法:node scripts/verify-m3.mjs（先 npm run build;场景 1 走 dist/launcher.cjs）

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const nodeSrc = join(root, 'src', 'node.ts');
const launcherCli = join(root, 'dist', 'launcher.cjs');

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failures++; console.error(`  FAIL - ${name}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 建离线包 fixture:offline/dsh(npm 布局,bin.js 打印版本)+ offline/runtime/node.exe(假) */
function makeBundle(base) {
  const bundle = mkdtempSync(join(base, 'offline-'));
  const pkgDir = join(bundle, 'dsh', 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(join(pkgDir, 'lib'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.7.7-fixture', bin: { dsh: 'lib/bin.js' } }, null, 2),
  );
  writeFileSync(join(pkgDir, 'lib', 'bin.js'), "console.log('0.7.7-fixture')\n");
  const rt = join(bundle, 'runtime');
  mkdirSync(rt, { recursive: true });
  writeFileSync(join(rt, 'node.exe'), 'FAKE-NODE-EXE\n');
  return bundle;
}

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
  if (!existsSync(launcherCli)) {
    console.error('缺少 dist/launcher.cjs：请先运行 npm run build');
    process.exit(1);
  }
  const base = mkdtempSync(join(tmpdir(), 'm3-verify-'));

  console.log('1. 离线包安装（CLI install --offline）');
  {
    const bundle = makeBundle(base);
    const cfg = mkdtempSync(join(base, 'cfg1-'));
    const rt = mkdtempSync(join(base, 'rt1-'));
    const inst = join(base, 'inst1');
    const r = await runCli(
      ['install', '--offline', bundle, '--dir', inst],
      { DSH_LAUNCHER_CONFIG_DIR: cfg, DSH_LAUNCHER_RUNTIME_DIR: rt, DSH_LAUNCHER_RUNTIME_FAKE: '1', DSH_HOME: join(base, 'home1') },
    );
    ok(r.status === 0, `1-1 离线安装退出码 0（${r.status}）`);
    ok(existsSync(join(inst, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')), '1-2 dsh 内容已复制');
    const lj = JSON.parse(readFileSync(join(cfg, 'launcher.json'), 'utf8'));
    ok(lj.source === 'npm' && lj.dshVersion === '0.7.7-fixture', '1-3 launcher.json: npm 布局 + 版本');
    ok(lj.dshInstallDir.replace(/\\+$/, '') === inst.replace(/\\+$/, ''), '1-4 launcher.json: 安装目录');
    ok(existsSync(join(rt, 'node.exe')), '1-5 offline/runtime 便携 node 已落位');
  }

  console.log('2. 启动用 node 解析优先级');
  const nodeMod = await import(pathToFileURL(nodeSrc).href);
  {
    const explicit = join(base, 'explicit-node.exe');
    writeFileSync(explicit, 'x');
    const prev = process.env.DSH_LAUNCHER_NODE_EXE;
    process.env.DSH_LAUNCHER_NODE_EXE = explicit;
    try {
      const r1 = await nodeMod.resolveNodeExe();
      ok(r1.cmd === explicit && r1.portable === false, '2-1 DSH_LAUNCHER_NODE_EXE 显式优先');
    } finally {
      if (prev === undefined) delete process.env.DSH_LAUNCHER_NODE_EXE;
      else process.env.DSH_LAUNCHER_NODE_EXE = prev;
    }
    // 便携 runtime 就绪时优先于系统 node
    const rt2 = mkdtempSync(join(base, 'rt2-'));
    writeFileSync(join(rt2, 'node.exe'), 'x');
    const prevR = process.env.DSH_LAUNCHER_RUNTIME_DIR;
    const prevF = process.env.DSH_LAUNCHER_RUNTIME_FAKE;
    process.env.DSH_LAUNCHER_RUNTIME_DIR = rt2;
    process.env.DSH_LAUNCHER_RUNTIME_FAKE = '1';
    try {
      const r2 = await nodeMod.resolveNodeExe();
      ok(r2.cmd === join(rt2, 'node.exe') && r2.portable === true, '2-2 便携 runtime 优先于系统 node');
    } finally {
      if (prevR === undefined) delete process.env.DSH_LAUNCHER_RUNTIME_DIR;
      else process.env.DSH_LAUNCHER_RUNTIME_DIR = prevR;
      if (prevF === undefined) delete process.env.DSH_LAUNCHER_RUNTIME_FAKE;
      else process.env.DSH_LAUNCHER_RUNTIME_FAKE = prevF;
    }
    // 无显式/无 runtime → 系统 node（本机有）
    const r3 = await nodeMod.resolveNodeExe();
    ok(r3.cmd === 'node' && r3.portable === false, '2-3 兜底系统 node');

    const envP = nodeMod.childEnvForNode(join(rt2, 'node.exe'));
    ok(typeof envP.PATH === 'string' && envP.PATH.startsWith(rt2 + ';'), '4-1 便携 PATH 注入(runtime 目录最前)');
    const envS = nodeMod.childEnvForNode('node');
    ok(envS.PATH === process.env.PATH, '4-2 系统 node 不注入 PATH');
  }

  console.log('3. 便携 runtime 就绪(本地镜像 zip → 解压提升)');
  {
    const rt3 = mkdtempSync(join(base, 'rt3-'));
    const mirror = mkdtempSync(join(base, 'mirror-'));
    const ver = '99.0.0';
    const inner = join(mirror, `node-v${ver}-win-x64`);
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'node.exe'), 'FAKE-NODE-ZIP\n');
    // 用系统 tar/powershell 造 zip:Compress-Archive 需把 inner 目录打成 zip,zip 内顶层为 node-v99.0.0-win-x64
    const mk = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Path '${inner}' -DestinationPath '${join(mirror, `node-v${ver}-win-x64.zip`)}' -Force`],
      { windowsHide: true, encoding: 'utf8' },
    );
    ok(mk.status === 0, '3-0 已生成 fixture zip');
    const prevV = process.env.DSH_LAUNCHER_NODE_VERSION;
    const prevM = process.env.DSH_LAUNCHER_NODE_MIRROR;
    const prevR = process.env.DSH_LAUNCHER_RUNTIME_DIR;
    const prevF = process.env.DSH_LAUNCHER_RUNTIME_FAKE;
    process.env.DSH_LAUNCHER_NODE_VERSION = ver;
    process.env.DSH_LAUNCHER_NODE_MIRROR = mirror; // 本地路径镜像
    process.env.DSH_LAUNCHER_RUNTIME_DIR = rt3;
    process.env.DSH_LAUNCHER_RUNTIME_FAKE = '1';
    try {
      const exe = await nodeMod.ensureRuntimeNode();
      ok(existsSync(exe) && readFileSync(exe, 'utf8').includes('FAKE-NODE-ZIP'), '3-1 本地镜像 zip 解压提升 node.exe');
      ok(!readFileSync(exe, 'utf8').includes('FAKE-NODE-EXE'), '3-2 无旧 runtime 残留');
      const entries = readdirSync(rt3);
      ok(!entries.some((e) => e.startsWith('.stage-')), '3-3 解压临时目录已清理');
    } finally {
      if (prevV === undefined) delete process.env.DSH_LAUNCHER_NODE_VERSION;
      else process.env.DSH_LAUNCHER_NODE_VERSION = prevV;
      if (prevM === undefined) delete process.env.DSH_LAUNCHER_NODE_MIRROR;
      else process.env.DSH_LAUNCHER_NODE_MIRROR = prevM;
      if (prevR === undefined) delete process.env.DSH_LAUNCHER_RUNTIME_DIR;
      else process.env.DSH_LAUNCHER_RUNTIME_DIR = prevR;
      if (prevF === undefined) delete process.env.DSH_LAUNCHER_RUNTIME_FAKE;
      else process.env.DSH_LAUNCHER_RUNTIME_FAKE = prevF;
    }
  }

  rmSync(base, { recursive: true, force: true });
  console.log(`\n结果:${passed} 通过,${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-m3 异常:', e);
  process.exit(1);
});
