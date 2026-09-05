// scripts/verify-m0.mjs —— M0 自动验证脚本。
//
// 覆盖(M0 三项,见伞仓 ECOSYSTEM-PLAN §6 / 决策 D8):
//   A. clearLaunchToken 原子化(source+pid 双匹配 + 删除前复读确认,修 P0-4)
//      - 单进程归属用例(同 source 同 pid 删 / 异 pid 不删 / 异 source 不删 / 旧版无 pid 记录)
//      - 多进程并发压力(非属主并发清理不得误删;属主并发清理收敛到删除)
//   B. 日志 token 脱敏(P1-6):redactTokenUrl 纯函数 + log.ts 中央出口掩码
//   C. child log 自 %TEMP% 迁至 %DSH_HOME%/logs(源码级断言 + 目录创建)
//
// 用法:node scripts/verify-m0.mjs
// 说明:直接以 Node type-stripping 加载 src/*.ts(需 Node >= 23.6;开发机 Node 24 满足),
//       在独立临时 DSH_HOME 中运行,不触碰真实 %USERPROFILE%\.dsh。

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

// Node type-stripping 直载 .ts 源码时,把相对导入 `./x.js` 映射到 `./x.ts`
// (源码按 esbuild/bundler 规范写 .js 后缀;脚本在运行时做后缀映射)。
register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (e) {
    if (specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    throw e;
  }
}`),
  import.meta.url
);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tokenSrc = join(root, 'src', 'tokenFile.ts');
const logSrc = join(root, 'src', 'log.ts');
const launchSrc = join(root, 'src', 'launch.ts');

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failures++; console.error(`  FAIL - ${name}`); }
};

/** 独立临时 DSH_HOME,跑完即清。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'm0-verify-'));
  process.env.DSH_HOME = home;
  return home;
}
function rmHome(home) { rmSync(home, { recursive: true, force: true }); }

/** 主进程内同步加载 TS 源码(独立进程缓存,须在设置 DSH_HOME 之后 import)。 */
const tokenMod = () => import(pathToFileURL(tokenSrc).href);
const logMod = () => import(pathToFileURL(logSrc).href);

function spawnWorker(home, source, pid) {
  return new Promise((resolve) => {
    const code =
      `import { clearLaunchToken } from ${JSON.stringify(pathToFileURL(tokenSrc).href)};\n` +
      `clearLaunchToken(${JSON.stringify(source)}, ${pid});\n`;
    const cp = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, DSH_HOME: home },
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

const recordJson = (source, pid, token = 't' + Date.now()) => {
  const rec = {
    version: 1,
    token,
    port: 3080,
    url: `http://127.0.0.1:3080/?token=${token}`,
    writtenAt: new Date().toISOString(),
    source,
  };
  if (pid !== undefined) rec.pid = pid;
  return rec;
};
const writeRecord = (home, rec) => {
  const dir = join(home, 'logs');
  const file = join(dir, '..', 'launch-token.json');
  writeFileSync(join(home, 'launch-token.json'), JSON.stringify(rec, null, 2) + '\n', 'utf8');
};

// ---------------------------------------------------------------- A. tokenFile
async function partA() {
  console.log('A. clearLaunchToken 原子化');
  const home = makeHome();
  try {
    // A1 同 source + 同 pid:删除
    writeRecord(home, recordJson('dsh-launcher', 111));
    (await tokenMod()).clearLaunchToken('dsh-launcher', 111);
    ok(!existsSync(join(home, 'launch-token.json')), 'A1 同 source 同 pid -> 删除');

    // A2 同 source + 异 pid:不删
    writeRecord(home, recordJson('dsh-launcher', 111));
    (await tokenMod()).clearLaunchToken('dsh-launcher', 222);
    ok(existsSync(join(home, 'launch-token.json')), 'A2 同 source 异 pid -> 保留');

    // A3 异 source + 同 pid:不删
    writeRecord(home, recordJson('dsh-vscode', 111));
    (await tokenMod()).clearLaunchToken('dsh-launcher', 111);
    ok(existsSync(join(home, 'launch-token.json')), 'A3 异 source -> 保留');

    // A4 异 source + 异 pid:不删
    (await tokenMod()).clearLaunchToken('dsh-vscode', 333);
    ok(existsSync(join(home, 'launch-token.json')), 'A4 异 source 异 pid -> 保留');

    // A5 旧版无 pid 记录(source 归属):launcher 清
    writeRecord(home, recordJson('dsh-launcher', undefined));
    (await tokenMod()).clearLaunchToken('dsh-launcher');
    ok(!existsSync(join(home, 'launch-token.json')), 'A5 无 pid 记录 同 source -> 删除');

    // A6 空文件/损坏:静默无异常
    writeFileSync(join(home, 'launch-token.json'), 'not-json', 'utf8');
    (await tokenMod()).clearLaunchToken('dsh-launcher', 1);
    ok(existsSync(join(home, 'launch-token.json')), 'A6 损坏文件 -> 保留且不抛');

    // A7 并发压力 S1:属主(launcher/502)×6 vs 非属主(launcher/503)×3 与 (vscode/502)×3 -> 文件最终删除
    writeRecord(home, recordJson('dsh-launcher', 502, 'S1TOKEN'));
    const s1 = [];
    for (let i = 0; i < 6; i++) s1.push(spawnWorker(home, 'dsh-launcher', 502));
    for (let i = 0; i < 3; i++) s1.push(spawnWorker(home, 'dsh-launcher', 503));
    for (let i = 0; i < 3; i++) s1.push(spawnWorker(home, 'dsh-vscode', 502));
    const s1res = await Promise.all(s1);
    ok(s1res.every((r) => r.status === 0), 'A7-1 并发 worker 均正常退出');
    ok(!existsSync(join(home, 'launch-token.json')), 'A7-2 属主并发清理 -> 文件删除');

    // A8 并发压力 S2:仅非属主(launcher/503 ×3 与 vscode/502 ×3)→ 文件必须原样保留
    writeRecord(home, recordJson('dsh-launcher', 502, 'S2TOKEN'));
    const s2 = [];
    for (let i = 0; i < 3; i++) s2.push(spawnWorker(home, 'dsh-launcher', 503));
    for (let i = 0; i < 3; i++) s2.push(spawnWorker(home, 'dsh-vscode', 502));
    const s2res = await Promise.all(s2);
    ok(s2res.every((r) => r.status === 0), 'A8-1 并发 worker 均正常退出');
    ok(existsSync(join(home, 'launch-token.json')), 'A8-2 非属主并发 -> 文件保留');
    const kept = JSON.parse(readFileSync(join(home, 'launch-token.json'), 'utf8'));
    ok(kept.pid === 502 && kept.source === 'dsh-launcher' && kept.token === 'S2TOKEN', 'A8-3 文件内容未被非属主改写');
  } finally {
    rmHome(home);
  }
}

// ---------------------------------------------------------------- B. 日志脱敏
async function partB() {
  console.log('B. 日志 token 脱敏');
  const home = makeHome();
  try {
    const tf = await tokenMod();
    const red = tf.redactTokenUrl('http://127.0.0.1:3080/?token=SECRET123');
    ok(!red.includes('SECRET123') && red.includes('token=***'), 'B1 redactTokenUrl 掩码 query token');
    ok(tf.redactTokenUrl('http://127.0.0.1:3080/') === 'http://127.0.0.1:3080/', 'B2 无 token URL 原样返回');
    ok(
      tf.redactTokenUrl('a=1&token=xyz&b=2').includes('token=***&b=2'),
      'B3 多参数 &token= 也被掩码'
    );

    const lm = await logMod();
    const captured = [];
    const unsub = lm.subscribe((line) => captured.push(line));
    lm.info(`打开地址 http://127.0.0.1:3080/?token=LEAKTOKEN1 (自动登录)`);
    lm.error(`无效地址 http://127.0.0.1:3080/?token=LEAKTOKEN2`);
    unsub();
    const joined = captured.join('');
    ok(!joined.includes('LEAKTOKEN1') && !joined.includes('LEAKTOKEN2'), 'B4 emit 输出(含订阅者)无明文 token');
    ok(joined.includes('token=***'), 'B5 emit 输出已含掩码 token=***');
  } finally {
    rmHome(home);
  }
}

// ---------------------------------------------------------------- C. child log 迁址
async function partC() {
  console.log('C. child log 迁出 %TEMP%');
  const src = readFileSync(launchSrc, 'utf8');
  ok(!src.includes("join(tmpdir(), 'dsh-launcher-child.log')"), 'C1 launch.ts 不再指向 %TEMP% child log');
  ok(src.includes("join(dshHome(), 'logs', 'dsh-launcher-child.log')"), 'C2 child log 指向 %DSH_HOME%/logs');
  ok(src.includes('ensureChildLogDir()'), 'C3 启动前创建日志目录(ensureChildLogDir)');
}

console.log('verify-m0 — M0 自动验证\n');
await partA();
await partB();
partC();

console.log(`\n结果:${passed} 通过,${failures} 失败`);
process.exit(failures === 0 ? 0 : 1);
