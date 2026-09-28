// scripts/verify-m8.mjs —— M8 自动验证脚本(版本 lock + 回传)。
//
// 覆盖(M8 / Phase 8):
//   1. lock 写入:writeLock → loadLock roundtrip
//   1b. **旧布局 lock 被忽略**(repo 非 dsh-ecosystem → isUsableLock false / loadUsableLock 回退默认, #60)
//   2. pull 默认收敛:无显式清单时使用 lock(不漂移到内嵌默认)
//   3. 确认升级:显式 --manifest + --update-lock → lock 更新为新组合;之后再 pull 收敛到新 lock
//   4. 显式清单不带 --update-lock → 不触碰 lock
//   5. 回传 = profile push/pull(M4 已验);此处验 check-update 提示文案存在(源码级)
//
// 注:夹具 manifest 的 `plugins.source.repo` 必须是**伞仓 repo**(默认 UMBRELLA_REPO)。
//     monorepo 化后 `isUsableLock()` 只认 repo 以 dsh-ecosystem.git 结尾的 lock,
//     用旧布局 repo 造夹具会让随后的 lock 断言全部失真(这正是 #60 里 M8 三条失败的原因)。
//
// 用法:node scripts/verify-m8.mjs(直接载 TS,无需 build)

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

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failures++; console.error(`  FAIL - ${name}`); }
};
const shaHex = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** 伞仓插件源 repo：lock 可用性判定要求 repo 以此结尾（见 ecosystem.isUsableLock，#60）。 */
const UMBRELLA_REPO = 'https://github.com/kuaizhongqiang/dsh-ecosystem.git';
/**
 * 造清单文件（锁给定 commit，sha256 按插件目录现算）。
 * repo 默认伞仓；传旧布局 repo（…/dsh-plugins.git）可造「过期 lock」现场。
 */
function makeManifest(dir, commit, repo = UMBRELLA_REPO) {
  const mf = join(dir, `manifest-${commit.slice(0, 4)}.json`);
  writeFileSync(mf, JSON.stringify({
    version: 1,
    dsh: { source: 'github', version: 'latest' },
    plugins: {
      source: { repo, commit },
      packages: [
        { id: 'pkgA', dir: 'plugins/pkgA-dsh-plugin', sha256: { 'install.ps1': shaHex(join(dir, 'plugins', 'pkgA-dsh-plugin', 'install.ps1')) } },
      ],
    },
  }, null, 2));
  return mf;
}

async function main() {
  const eco = await import(pathToFileURL(join(root, 'src', 'ecosystem.ts')).href);
  const base = mkdtempSync(join(tmpdir(), 'm8-verify-'));
  const home = mkdtempSync(join(base, 'home-'));
  const cfg = mkdtempSync(join(base, 'cfg-'));
  const mark = mkdtempSync(join(base, 'mark-'));
  process.env.DSH_HOME = home;
  process.env.DSH_LAUNCHER_CONFIG_DIR = cfg;
  process.env.TEST_MARK_DIR = mark;

  // fixture:信任插件目录(plain,无 git)+ 脚本
  const pluginsDir = mkdtempSync(join(base, 'plugins-'));
  mkdirSync(join(pluginsDir, 'plugins', 'pkgA-dsh-plugin'), { recursive: true });
  writeFileSync(join(pluginsDir, 'plugins', 'pkgA-dsh-plugin', 'install.ps1'), "$d=$env:TEST_MARK_DIR\nNew-Item -ItemType Directory -Path $d -Force | Out-Null\nSet-Content -Path (Join-Path $d 'pkgA.txt') -Value 'ok'\nexit 0\n");

  const mfA = makeManifest(pluginsDir, 'a'.repeat(40));
  const mfB = makeManifest(pluginsDir, 'b'.repeat(40));

  console.log('1. lock 写入/读取');
  {
    const { manifest } = await eco.loadManifest(mfA);
    eco.writeLock(manifest, mfA);
    const lock = eco.loadLock();
    ok(lock && lock.version === 1 && lock.manifest.plugins.source.commit === 'a'.repeat(40), '1-1 writeLock/loadLock roundtrip');
  }

  console.log('1b. 旧布局 lock 被忽略（monorepo 后规则，避免旧 repo 的 lock 拖住升级）');
  {
    const legacy = makeManifest(pluginsDir, 'c'.repeat(40), 'https://github.com/example/dsh-plugins.git');
    const { manifest } = await eco.loadManifest(legacy);
    eco.writeLock(manifest, 'legacy-fixture');
    ok(eco.loadLock() !== undefined, '1b-1 原始 lock 读得到（loadLock 不做可用性判断）');
    ok(eco.isUsableLock(eco.loadLock()) === false, '1b-2 isUsableLock 判定不可用（repo 非 dsh-ecosystem）');
    ok(eco.loadUsableLock() === undefined, '1b-3 loadUsableLock 忽略它并回退默认清单');
    // 复原为伞仓 lock，后续用例继续走「可用 lock」路径
    const { manifest: usable } = await eco.loadManifest(mfA);
    eco.writeLock(usable, mfA);
  }

  console.log('2. pull 默认收敛到 lock');
  {
    await eco.runPull({ plugins: ['pkgA'], skills: false, core: false, pluginsDir, trustPluginsDir: true });
    const st = JSON.parse(readFileSync(join(cfg, 'ecosystem-state.json'), 'utf8'));
    ok(st.manifest.pluginsCommit === 'a'.repeat(40) && st.manifest.label.includes('lock'), '2-1 无显式清单 → 使用 lock(不漂移)');
  }

  console.log('3. 显式清单不带 --update-lock → lock 不变');
  {
    await eco.runPull({ manifest: mfB, plugins: ['pkgA'], skills: false, core: false, pluginsDir, trustPluginsDir: true });
    const st = JSON.parse(readFileSync(join(cfg, 'ecosystem-state.json'), 'utf8'));
    ok(st.manifest.pluginsCommit === 'b'.repeat(40) && !st.manifest.label.includes('lock'), '3-1 本次按显式清单执行');
    const lock = eco.loadLock();
    ok(lock.manifest.plugins.source.commit === 'a'.repeat(40), '3-2 lock 未被触碰');
  }

  console.log('4. 确认升级(--update-lock)→ lock 更新;再 pull 收敛新 lock');
  {
    await eco.runPull({ manifest: mfB, plugins: ['pkgA'], skills: false, core: false, pluginsDir, trustPluginsDir: true, updateLock: true });
    const lock = eco.loadLock();
    ok(lock.manifest.plugins.source.commit === 'b'.repeat(40), '4-1 lock 更新为 b*40');
    await eco.runPull({ plugins: ['pkgA'], skills: false, core: false, pluginsDir, trustPluginsDir: true });
    const st = JSON.parse(readFileSync(join(cfg, 'ecosystem-state.json'), 'utf8'));
    ok(st.manifest.pluginsCommit === 'b'.repeat(40) && st.manifest.label.includes('lock'), '4-2 再 pull 收敛到新 lock');
  }

  console.log('5. 回传与提示(源码级)');
  {
    const cliSrc = readFileSync(join(root, 'src', 'cli.ts'), 'utf8');
    ok(cliSrc.includes('pull --update-lock'), '5-1 check-update 含确认升级提示');
    const profSrc = readFileSync(join(root, 'src', 'profile.ts'), 'utf8');
    ok(profSrc.includes('pushProfilePack') && profSrc.includes('pullProfilePack'), '5-2 回传通道 = profile push/pull(M4)');
  }

  delete process.env.DSH_HOME;
  delete process.env.DSH_LAUNCHER_CONFIG_DIR;
  rmSync(base, { recursive: true, force: true });
  console.log(`\n结果:${passed} 通过,${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-m8 异常:', e);
  process.exit(1);
});
