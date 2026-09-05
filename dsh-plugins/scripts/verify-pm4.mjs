// scripts/verify-pm4.mjs —— PM4 自动验证(skills 11→7 + install-skills 联动)。
//
// 覆盖:
//   1. skills 目录恰为 7 个新集合(install-media/deepseek/launcher/credentials/github/stock/unity-mcp)
//   2. install-skills.ps1 -DryRun 自动发现 7 个且不含旧名
//   3. 真实安装到临时 DSH_HOME 后技能目录落位
//   4. 仓库根 README/spec 引用一致(源码级)
//
// 用法:node scripts/verify-pm4.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failures++; console.error(`  FAIL - ${name}`); }
};

async function main() {
  const base = mkdtempSync(join(tmpdir(), 'pm4-verify-'));
  const home = mkdtempSync(join(base, 'home-'));
  const skillsDir = join(root, 'skills');

  const EXPECT = ['install-media', 'install-deepseek', 'install-launcher', 'install-credentials', 'install-github', 'install-stock', 'install-unity-mcp'].sort();
  const OLD = ['install-audio-read', 'install-audio-speak', 'install-describe-image', 'install-video-read', 'install-document-read', 'install-deepseek-balance', 'install-deepseek-recharge'];

  console.log('1. skills 目录 = 7 个新集合');
  {
    const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(skillsDir, d.name, 'SKILL.md'))).map((d) => d.name).sort();
    ok(JSON.stringify(dirs) === JSON.stringify(EXPECT), `1-1 目录恰为 7(${dirs.join(', ')})`);
  }

  console.log('2. install-skills.ps1 自动发现(-DryRun)');
  {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(skillsDir, 'install-skills.ps1'), '-DryRun'], {
      env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', windowsHide: true,
    });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    ok(r.status === 0, '2-1 退出码 0');
    ok(EXPECT.every((s) => out.includes(s)), '2-2 发现全部 7 个');
    ok(!OLD.some((s) => out.includes(s)), '2-3 不含旧技能名');
  }

  console.log('3. 真实安装到临时 DSH_HOME');
  {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(skillsDir, 'install-skills.ps1')], {
      env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', windowsHide: true,
    });
    ok(r.status === 0, '3-1 退出码 0');
    const got = readdirSync(join(home, 'skills')).sort();
    ok(JSON.stringify(got) === JSON.stringify(EXPECT), '3-2 %DSH_HOME%\\skills 落位 7 个');
  }

  console.log('4. 源码级一致性');
  {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    ok(readme.includes('dsh-media-dsh-plugin') && readme.includes('dsh-launcher-dsh-plugin'), '4-1 README 含新合并包');
    const spec = readFileSync(join(root, 'docs', 'PLUGIN-SPEC.md'), 'utf8');
    ok(spec.includes('dsh-launcher') && spec.includes('准入三问'), '4-2 规范覆盖 launcher 桥接层');
  }

  rmSync(base, { recursive: true, force: true });
  console.log(`\n结果:${passed} 通过,${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-pm4 异常:', e);
  process.exit(1);
});
