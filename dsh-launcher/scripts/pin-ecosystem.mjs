// pin-ecosystem.mjs —— 发布前把伞仓自声明清单重钉到当前 HEAD（M1/M3 修复的配套工具）。
//
// 背景：monorepo 化后默认清单的单一事实来源是 dsh-launcher/ecosystem.json（src 经构建期内联，
// 见 src/ecosystem.ts）。每次发布若只提交代码而不重钉，插件源 commit 与 sha256 会停留在旧钉点，
// 导致「一键更新」永远走"发布集未变化"分支、用户拿不到新插件。
//
// 用法（在伞仓根目录 dsh-ecosystem/ 下）：
//   node dsh-launcher/scripts/pin-ecosystem.mjs            # 重钉并写回 ecosystem.json
//   node dsh-launcher/scripts/pin-ecosystem.mjs --dry-run  # 只打印将要写入的内容
//
// 前提：dsh-plugins/ 下被清单引用的文件与 .git 提交一致（工作区干净或仅无关改动）——
// 本脚本按**工作区实际内容**计算 sha256，并要求伞仓 HEAD 与清单 commit 一起前进。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url)); // dsh-launcher/scripts
const launcherDir = join(here, '..'); // dsh-launcher
const root = join(launcherDir, '..'); // 伞仓根
const manifestFile = join(launcherDir, 'ecosystem.json');
const dryRun = process.argv.includes('--dry-run');

function sha256(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}
function fail(msg) {
  console.error(`[pin-ecosystem] ${msg}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
if (manifest.version !== 1 || !manifest.plugins?.source || !Array.isArray(manifest.plugins.packages)) {
  fail('ecosystem.json 结构异常（需要 version:1 + plugins.source + plugins.packages）');
}

// 伞仓当前 HEAD（发布重钉以提交此 commit 为插件集锚点）
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
if (!/^[0-9a-f]{40}$/.test(head)) fail(`无法解析伞仓 HEAD：${head}`);

const next = JSON.parse(JSON.stringify(manifest));
next.plugins.source.commit = head;

for (const pkg of next.plugins.packages) {
  const f = join(root, pkg.dir, 'install.ps1');
  if (!existsSync(f)) fail(`清单引用的 install.ps1 不存在：${pkg.dir}/install.ps1（先确保 dsh-plugins 内容已提交）`);
  const hex = sha256(f);
  pkg.sha256 = { 'install.ps1': hex };
  console.log(`  sha256 ✓ ${pkg.dir}/install.ps1 → ${hex.slice(0, 12)}…`);
}
if (next.skills?.script) {
  const f = join(root, next.skills.script);
  if (!existsSync(f)) fail(`清单引用的技能脚本不存在：${next.skills.script}`);
  const hex = sha256(f);
  next.skills.sha256 = hex;
  console.log(`  sha256 ✓ ${next.skills.script} → ${hex.slice(0, 12)}…`);
}

console.log(`\n[pin-ecosystem] plugins.source.commit → ${head.slice(0, 8)}（原 ${manifest.plugins.source.commit.slice(0, 8)}）`);
if (dryRun) {
  console.log('[pin-ecosystem] --dry-run：未写回。以上为将写入 dsh-launcher/ecosystem.json 的内容。');
  process.exit(0);
}
writeFileSync(manifestFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
console.log(`[pin-ecosystem] 已写回 ${manifestFile}\n请提交该文件（连同代码改动）作为发布的一部分。`);
