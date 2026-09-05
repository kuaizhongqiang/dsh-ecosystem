// scripts/verify-m4.mjs —— M4 自动验证脚本（个人层 profile pack）。
//
// 覆盖(M4 / Phase 4):
//   1. push:白名单文件进 pack + 清单 sha256;sessions/.credentials/launch-token/attachments/
//      stock-daily/node_modules 等噪音不进 pack
//   2. pull:从 pack 恢复到新 DSH_HOME,内容一致、红线永不恢复
//   3. 加密容器:export(魔数头 + AES-256-GCM) → import 恢复;口令错误拒绝
//   4. exclude:额外剔除(如 stock/reports、watchlist)生效
//
// 用法:node scripts/verify-m4.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const profSrc = join(root, 'src', 'profile.ts');

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failures++; console.error(`  FAIL - ${name}`); }
};

/** 造一个有白名单内容 + 噪音的 DSH_HOME。 */
function makeHome(base, tag) {
  const home = mkdtempSync(join(base, `home-${tag}-`));
  const write = (rel, content) => {
    const p = join(home, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  };
  write('settings.yaml', 'settings: 1\n');
  write('profiles/web/cordis.patch.yml', 'patch: 1\n');
  write('profiles/web/plugins/demo/index.js', 'module.exports = 1;\n');
  write('skills/install-x/SKILL.md', '# skill x\n');
  write('stock/watchlist.json', '["600519"]\n');
  write('stock/reports/a.md', '# report\n');
  // 噪音（不得进 pack）
  write('sessions/2026.log', 'noise\n');
  write('.credentials.yaml', 'secret: nope\n');
  write('launch-token.json', '{"token":"t"}\n');
  write('attachments/big.bin', 'noise\n');
  write('stock/daily/2026-09-01.json', 'noise\n');
  write('profiles/node_modules/@x/y/index.js', 'noise\n');
  write('.dsh-memory-autostore-state.x', 'noise\n');
  return home;
}

async function main() {
  const prof = await import(pathToFileURL(profSrc).href);
  const base = mkdtempSync(join(tmpdir(), 'm4-verify-'));
  const homeA = makeHome(base, 'a');

  console.log('1. push:白名单镜像 + 噪音剔除');
  const pack1 = join(base, 'pack1');
  process.env.DSH_HOME = homeA;
  const meta = prof.pushProfilePack(pack1);
  const rels = meta.files.map((f) => f.rel);
  const want = [
    'settings.yaml',
    'profiles/web/cordis.patch.yml',
    'profiles/web/plugins/demo/index.js',
    'skills/install-x/SKILL.md',
    'stock/watchlist.json',
    'stock/reports/a.md',
  ];
  ok(rels.length === want.length && want.every((w) => rels.includes(w)), `1-1 pack 含 ${want.length} 个白名单文件`);
  const banned = ['.credentials.yaml', 'launch-token.json', 'sessions', 'attachments', 'stock/daily', 'node_modules', '.dsh-memory-autostore-state'];
  ok(!rels.some((r) => banned.some((b) => r.includes(b))), '1-2 噪音/红线文件未进 pack');
  ok(existsSync(join(pack1, 'skills/install-x/SKILL.md')), '1-3 pack 目录内容已落盘');
  ok(meta.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)), '1-4 清单含 sha256');

  console.log('2. pull:恢复到新 DSH_HOME');
  const homeB = mkdtempSync(join(base, 'home-b-'));
  process.env.DSH_HOME = homeB;
  const n = prof.pullProfilePack(pack1);
  ok(n === want.length, '2-1 恢复数量正确');
  ok(readFileSync(join(homeB, 'settings.yaml'), 'utf8') === 'settings: 1\n', '2-2 内容一致(settings.yaml)');
  ok(existsSync(join(homeB, 'profiles/web/plugins/demo/index.js')), '2-3 子目录文件恢复');
  ok(!existsSync(join(homeB, '.credentials.yaml')) && !existsSync(join(homeB, 'launch-token.json')), '2-4 红线未恢复');

  console.log('3. 加密容器 export/import');
  const out1 = join(base, 'pack-enc.bin');
  process.env.DSH_HOME = homeA;
  process.env.DSH_LAUNCHER_PROFILE_PASSWORD = 'p@ss-123';
  prof.exportProfilePack(out1);
  const head = readFileSync(out1).subarray(0, 6).toString('utf8');
  ok(head === 'DSHPP1', '3-1 容器魔数头 DSHPP1');
  const homeC = mkdtempSync(join(base, 'home-c-'));
  process.env.DSH_HOME = homeC;
  const m = prof.importProfilePack(out1);
  ok(m === want.length, '3-2 解密恢复数量正确');
  ok(readFileSync(join(homeC, 'stock/watchlist.json'), 'utf8') === '["600519"]\n', '3-3 解密内容一致');
  // 口令错误 → 拒绝
  process.env.DSH_LAUNCHER_PROFILE_PASSWORD = 'wrong-password';
  let threw = false;
  try {
    prof.importProfilePack(out1);
  } catch (e) {
    threw = /口令错误|解密失败/.test(e.message);
  }
  ok(threw, '3-4 口令错误被拒');

  console.log('4. exclude 生效');
  process.env.DSH_HOME = homeA;
  const pack2 = join(base, 'pack2');
  const meta2 = prof.pushProfilePack(pack2, ['stock/reports', 'stock/watchlist.json']);
  const rels2 = meta2.files.map((f) => f.rel);
  ok(rels2.length === 4 && !rels2.some((r) => r.startsWith('stock/')), '4-1 exclude 剔除 stock 条目');

  delete process.env.DSH_HOME;
  delete process.env.DSH_LAUNCHER_PROFILE_PASSWORD;
  rmSync(base, { recursive: true, force: true });
  console.log(`\n结果:${passed} 通过,${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-m4 异常:', e);
  process.exit(1);
});
