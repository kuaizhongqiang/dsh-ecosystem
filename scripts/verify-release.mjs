// verify-release.mjs —— 伞仓发布前校验(monorepo 插件源一致性门)
// 用途:CI(plugins job)与本机发布前跑;确保:
//   1) dsh-launcher/ecosystem.json 插件源 = kuaizhongqiang/dsh-ecosystem;
//   2) 7 包 install.ps1 与 skills 脚本 sha256 与清单一致(dir 前缀 dsh-plugins/);
//   3) src/ecosystem.ts 内嵌默认清单与 ecosystem.json 同步(repo 与 commit)。
// 失败 exit 1。无第三方依赖,node >=18 即可跑(仓库根执行)。

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const fail = (why) => {
  console.error(`[verify-release] FAIL: ${why}`);
  process.exit(1);
};

const sha = (abs) => {
  if (!existsSync(abs)) fail(`文件不存在: ${abs}`);
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
};

const jsonPath = join(root, 'dsh-launcher', 'ecosystem.json');
const manifest = JSON.parse(readFileSync(jsonPath, 'utf8'));
if (manifest.plugins?.source?.repo !== 'https://github.com/kuaizhongqiang/dsh-ecosystem.git') {
  fail(`ecosystem.json plugins.source.repo 应为 dsh-ecosystem, 实际: ${manifest.plugins?.source?.repo}`);
}

for (const pkg of manifest.plugins.packages) {
  const file = join(root, pkg.dir, 'install.ps1');
  const hex = sha(file);
  if (hex !== pkg.sha256['install.ps1']) {
    fail(`${pkg.id}: install.ps1 sha256 不匹配 (清单 ${pkg.sha256['install.ps1']} vs 实际 ${hex})`);
  }
  console.log(`  ✓ ${pkg.id} (${pkg.dir})`);
}
const skills = manifest.skills;
if (skills?.script) {
  const hex = sha(join(root, skills.script));
  if (hex !== skills.sha256) fail(`skills ${skills.script}: sha256 不匹配`);
  console.log(`  ✓ skills ${skills.script}`);
}

// 内嵌默认清单同步检查(src/ecosystem.ts 与 ecosystem.json 的 repo+commit 一致)
const ts = readFileSync(join(root, 'dsh-launcher', 'src', 'ecosystem.ts'), 'utf8');
for (const [label, want, pat] of [
  ['repo', manifest.plugins.source.repo, /repo:\s*'([^']+)'/],
  ['commit', manifest.plugins.source.commit, /commit:\s*'([0-9a-f]{40})'/],
]) {
  const m = pat.exec(ts);
  if (!m || m[1] !== want) fail(`src/ecosystem.ts 内嵌 ${label} 与 ecosystem.json 不同步 (ts=${m?.[1]}, json=${want})`);
  console.log(`  ✓ 内嵌 ${label} 同步 (${want.slice(0, 12)}…)`);
}

console.log('[verify-release] OK — 伞仓插件源清单一致, 可发布');
