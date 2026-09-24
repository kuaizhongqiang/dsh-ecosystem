// verify-release.mjs —— 伞仓发布前校验(monorepo 插件源一致性门)
// 用途:CI(plugins job)与本机发布前跑;确保:
//   1) dsh-launcher/ecosystem.json 插件源 = kuaizhongqiang/dsh-ecosystem;
//   2) 各包 install.ps1 与 skills 脚本 sha256 与清单一致(dir 前缀 dsh-plugins/);
//   3) src/ecosystem.ts 内嵌默认清单与 ecosystem.json 同步(repo 与 commit);
//   4) 四处组件版本一致(launcher / vscode / desktop / dsh-cli),给 TAG 时还要与 tag 一致。
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

// 默认清单单一来源检查：src/ecosystem.ts 必须从随包 ecosystem.json 导入（构建期内联），
// 不再存在第二份内嵌副本可漂移；repo/commit/sha256 的唯一事实来源即上方校验过的 ecosystem.json。
const ts = readFileSync(join(root, 'dsh-launcher', 'src', 'ecosystem.ts'), 'utf8');
if (!/import\s+[A-Za-z0-9_$]+\s+from\s+'\.\.\/ecosystem\.json'\s+with\s+\{\s*type:\s*'json'\s*\}/.test(ts)) {
  fail('src/ecosystem.ts 未从 ../ecosystem.json 导入默认清单（单一来源约定被破坏）');
}
console.log('  ✓ src/ecosystem.ts 默认清单单一来源 = ecosystem.json');

// 四处组件版本一致（CI 会逐组件对 tag 断言，这里提前在本机/CI 都拦住漏 bump）：
// launcher / vscode / desktop / dsh-cli 同属伞仓全量 tag，必须同一个版本号。
const components = [
  ['dsh-launcher', join(root, 'dsh-launcher', 'package.json')],
  ['dsh-vscode', join(root, 'dsh-vscode', 'package.json')],
  ['dsh-desktop', join(root, 'dsh-desktop', 'desktop', 'package.json')],
  ['dsh-cli', join(root, 'dsh-cli', 'package.json')],
];
const versions = new Map();
for (const [name, file] of components) {
  if (!existsSync(file)) fail(`组件 package.json 不存在: ${file}`);
  const version = JSON.parse(readFileSync(file, 'utf8')).version;
  versions.set(name, version);
  console.log(`  ✓ ${name} ${version}`);
}
const unique = new Set(versions.values());
if (unique.size !== 1) {
  fail(`四处组件版本不一致: ${[...versions].map(([n, v]) => `${n}=${v}`).join(', ')}`);
}
const tag = String(process.env.TAG ?? process.env.GITHUB_REF_NAME ?? '').replace(/^v/, '');
if (tag !== '' && !unique.has(tag)) {
  fail(`组件版本 ${[...unique].join('/')} 与目标 tag ${tag} 不一致（先 bump 再打 tag）`);
}

console.log('[verify-release] OK — 伞仓插件源清单一致 + 四处组件版本一致, 可发布');
