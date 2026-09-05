// scripts/verify-m1.mjs —— M1 自动验证脚本。
//
// 覆盖(M1 / Phase 1,D3 清单即生态 + P1-7 供应链):
//   1. 默认清单(内嵌)加载与校验、含 11 插件包 + skills sha256
//   2. --manifest 远程强制 HTTPS(拒绝 http)
//   3. 锁 commit:dsh-plugins 检出 HEAD != 清单锁定 commit → 拒绝(不漂移)
//   4. 供应链 sha256:篡改 → 拒绝执行(无任何 marker)
//   5. dry-run:只校验不执行、不写 ecosystem-state.json
//   6. 真实 pull:core 跳过 + 插件 install.ps1 + skills 执行 + ecosystem-state.json 落盘
//
// 用法:node scripts/verify-m1.mjs(需 Node >= 23.6 直载 TS;开发机 Node 24 满足)
// 说明:全部在临时目录进行(fixture dsh-plugins git 检出 + 假 install.ps1 写 marker),不触碰真实环境。

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

// TS 直载:.js → .ts 后缀映射(源码按 bundler 规范写 .js 后缀)
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
const ecoSrc = join(root, 'src', 'ecosystem.ts');

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failures++; console.error(`  FAIL - ${name}`); }
};
const shaHex = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).stdout.trim();

/** 建一个 fixture dsh-plugins 检出(git 仓库,含假 install.ps1)。commitExtra=true 时 HEAD 领先一档。 */
function makeFixtureRepo(base, commitExtra = false) {
  const dir = mkdtempSync(join(base, 'plugins-src-'));
  mkdirSync(join(dir, 'plugins', 'pkgA-dsh-plugin'), { recursive: true });
  mkdirSync(join(dir, 'plugins', 'pkgB-dsh-plugin'), { recursive: true });
  mkdirSync(join(dir, 'skills'), { recursive: true });
  const mkScript = (markerName) =>
    `$markDir = $env:TEST_MARK_DIR\nif (-not $markDir) { Write-Error 'TEST_MARK_DIR missing'; exit 2 }\n` +
    `New-Item -ItemType Directory -Path $markDir -Force | Out-Null\n` +
    `Set-Content -Path (Join-Path $markDir '${markerName}.txt') -Value 'ok'\n` +
    `Write-Host "installed ${markerName}"\nexit 0\n`;
  writeFileSync(join(dir, 'plugins', 'pkgA-dsh-plugin', 'install.ps1'), mkScript('pkgA'));
  writeFileSync(join(dir, 'plugins', 'pkgB-dsh-plugin', 'install.ps1'), mkScript('pkgB'));
  writeFileSync(
    join(dir, 'skills', 'install-skills.ps1'),
    `$markDir = $env:TEST_MARK_DIR\nif (-not $markDir) { Write-Error 'TEST_MARK_DIR missing'; exit 2 }\n` +
      `New-Item -ItemType Directory -Path $markDir -Force | Out-Null\n` +
      `Set-Content -Path (Join-Path $markDir 'skills.txt') -Value 'ok'\nexit 0\n`,
  );
  writeFileSync(join(dir, 'NOTES.txt'), 'fixture\n');
  const g = (args) => spawnSync('git', args, { cwd: dir, windowsHide: true });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'c1']);
  if (commitExtra) {
    writeFileSync(join(dir, 'NOTES.txt'), 'fixture v2\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'c2']);
  }
  return { dir, commit: git(dir, 'rev-parse', 'HEAD') };
}

/** 按 fixture 当前文件内容构造清单(锁定其 commit,sha256 逐包按真实内容)。 */
function buildManifestFor(fixture) {
  return {
    version: 1,
    dsh: { source: 'github', version: 'latest' },
    plugins: {
      source: { repo: 'https://github.com/example/dsh-plugins.git', commit: fixture.commit },
      packages: [
        { id: 'pkgA', dir: 'plugins/pkgA-dsh-plugin', sha256: { 'install.ps1': shaHex(join(fixture.dir, 'plugins', 'pkgA-dsh-plugin', 'install.ps1')) } },
        { id: 'pkgB', dir: 'plugins/pkgB-dsh-plugin', sha256: { 'install.ps1': shaHex(join(fixture.dir, 'plugins', 'pkgB-dsh-plugin', 'install.ps1')) } },
      ],
    },
    skills: { script: 'skills/install-skills.ps1', sha256: shaHex(join(fixture.dir, 'skills', 'install-skills.ps1')) },
  };
}

async function main() {
  const eco = await import(pathToFileURL(ecoSrc).href);
  const base = mkdtempSync(join(tmpdir(), 'm1-verify-'));

  console.log('1. 默认清单加载与校验');
  try {
    const { manifest, label } = await eco.loadManifest();
    ok(label.includes('默认'), '1-1 默认清单来源 = 内嵌');
    ok(manifest.plugins.packages.length === 7, '1-2 默认清单含 7 个插件包(11→7)');
    ok(manifest.plugins.source.commit === '9f472797785a70cf78de0042f98e01d05ef927cb', '1-3 插件源锁 9f47279');
    ok(!!manifest.skills?.sha256, '1-4 skills 声明 sha256');
  } catch (e) {
    ok(false, `1-x 默认清单加载异常:${e.message}`);
  }

  console.log('2. 远程清单强制 HTTPS');
  try {
    await eco.loadManifest('http://example.com/ecosystem.json');
    ok(false, '2-1 http 清单应被拒绝');
  } catch (e) {
    ok(/强制 HTTPS/.test(e.message), '2-1 http 清单被拒(强制 HTTPS)');
  }

  const fixture = makeFixtureRepo(base);
  const stale = makeFixtureRepo(base, true); // HEAD=c2,与清单锁定 commit(c1) 不同

  const mkScene = (name) => {
    const cfg = mkdtempSync(join(base, `cfg-${name}-`));
    const mark = mkdtempSync(join(base, `mark-${name}-`));
    return { cfg, mark };
  };

  console.log('3. 锁 commit:HEAD 漂移 → 拒绝');
  {
    const { cfg } = mkScene('commitlock');
    process.env.DSH_LAUNCHER_CONFIG_DIR = cfg;
    const mf = join(cfg, 'manifest.json');
    writeFileSync(mf, JSON.stringify(buildManifestFor(fixture)));
    try {
      await eco.runPull({ core: false, manifest: mf, pluginsDir: stale.dir, dryRun: true });
      ok(false, '3-1 HEAD 漂移应被拒绝');
    } catch (e) {
      ok(/锁 commit|锁定/.test(e.message), `3-1 HEAD 漂移被拒:${e.message.slice(0, 60)}`);
    }
  }

  console.log('4. 供应链 sha256:篡改 → 拒绝执行');
  {
    const { cfg, mark } = mkScene('tamper');
    process.env.DSH_LAUNCHER_CONFIG_DIR = cfg;
    process.env.TEST_MARK_DIR = mark;
    const tampered = join(base, 'plugins-tampered');
    cpSync(fixture.dir, tampered, { recursive: true });
    const f = join(tampered, 'plugins', 'pkgA-dsh-plugin', 'install.ps1');
    writeFileSync(f, readFileSync(f, 'utf8') + '\n# tampered\n');
    const mf = join(cfg, 'manifest.json');
    writeFileSync(mf, JSON.stringify(buildManifestFor(fixture)));
    try {
      await eco.runPull({ core: false, manifest: mf, pluginsDir: tampered });
      ok(false, '4-1 篡改应被拒绝');
    } catch (e) {
      ok(/sha256 不匹配|供应链校验失败/.test(e.message), `4-1 篡改被拒:${e.message.slice(0, 60)}`);
    }
    ok(!existsSync(join(mark, 'pkgA.txt')), '4-2 篡改后未执行任何 install');
  }

  console.log('5. dry-run:只校验不执行、不写状态');
  {
    const { cfg, mark } = mkScene('dryrun');
    process.env.DSH_LAUNCHER_CONFIG_DIR = cfg;
    process.env.TEST_MARK_DIR = mark;
    const mf = join(cfg, 'manifest.json');
    writeFileSync(mf, JSON.stringify(buildManifestFor(fixture)));
    await eco.runPull({ core: false, manifest: mf, pluginsDir: fixture.dir, dryRun: true });
    ok(!existsSync(join(mark, 'pkgA.txt')) && !existsSync(join(mark, 'skills.txt')), '5-1 dry-run 未执行脚本');
    ok(!existsSync(join(cfg, 'ecosystem-state.json')), '5-2 dry-run 未写 ecosystem-state.json');
  }

  console.log('6. 真实 pull:插件 + skills 执行 + 状态落盘');
  {
    const { cfg, mark } = mkScene('exec');
    process.env.DSH_LAUNCHER_CONFIG_DIR = cfg;
    process.env.TEST_MARK_DIR = mark;
    const mf = join(cfg, 'manifest.json');
    writeFileSync(mf, JSON.stringify(buildManifestFor(fixture)));
    await eco.runPull({ core: false, manifest: mf, plugins: ['pkgA', 'pkgB'], pluginsDir: fixture.dir });
    ok(existsSync(join(mark, 'pkgA.txt')) && existsSync(join(mark, 'pkgB.txt')), '6-1 插件 install.ps1 已执行');
    ok(existsSync(join(mark, 'skills.txt')), '6-2 skills install-skills.ps1 已执行');
    const statePath = join(cfg, 'ecosystem-state.json');
    ok(existsSync(statePath), '6-3 ecosystem-state.json 已写入');
    const st = JSON.parse(readFileSync(statePath, 'utf8'));
    ok(st.version === 1 && st.plugins.pkgA?.ok === true && st.skills?.ok === true, '6-4 状态记录插件与技能 ok');
    ok(st.manifest.pluginsCommit === fixture.commit, '6-5 状态记录清单锁定 commit');
  }

  rmSync(base, { recursive: true, force: true });
  console.log(`\n结果:${passed} 通过,${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-m1 异常:', e);
  process.exit(1);
});
