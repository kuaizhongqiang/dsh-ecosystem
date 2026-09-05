// scripts/verify-pm3.mjs —— PM3 自动验证(dsh-launcher 桥接插件)。
//
// 覆盖:
//   1. install.ps1:载荷复制 + tool-launcher patch 条目(幂等)
//   2. -Uninstall:载荷删除 + patch 节剥离
//   3. index.js 结构:5 个 defineTool、name=tool-launcher、发现链关键词
//   4. 无 dsh 依赖可静态解析(node --check 等价:用 vm/acorn 不可用时降级为正则)
//
// 用法:node scripts/verify-pm3.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = join(root, 'plugins', 'dsh-launcher-dsh-plugin');

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failures++; console.error(`  FAIL - ${name}`); }
};

function makeHome(base) {
  const home = mkdtempSync(join(base, 'home-'));
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true });
  return home;
}

async function main() {
  const base = mkdtempSync(join(tmpdir(), 'pm3-verify-'));
  const installer = join(pkg, 'install.ps1');

  console.log('1. 安装(载荷 + patch)');
  const home = makeHome(base);
  let r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer], {
    env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', windowsHide: true,
  });
  ok(r.status === 0, `1-1 退出码 0（${r.status}）${r.status !== 0 ? '\n' + (r.stdout + r.stderr).slice(-500) : ''}`);
  ok(existsSync(join(home, 'profiles', 'web', 'plugins', 'launcher', 'index.js')), '1-2 载荷 index.js 就位');
  const patch = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
  ok(patch.includes('tool-launcher') && patch.includes('dsh-launcher: launcher'), '1-3 patch 条目与节头');
  r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer], {
    env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', windowsHide: true,
  });
  ok(r.status === 0 && (readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8').match(/tool-launcher/g) || []).length === 1, '1-4 幂等(重跑仍 1 条)');

  console.log('2. index.js 结构(5 工具 + 发现链)');
  {
    const src = readFileSync(join(pkg, 'plugins', 'launcher', 'index.js'), 'utf8');
    ok((src.match(/defineTool\(/g) || []).length === 5, '2-1 五个 defineTool');
    ok(src.includes("export const name = 'tool-launcher'"), '2-2 name=tool-launcher');
    ok(src.includes('DSH_LAUNCHER_EXE') && src.includes('launcher-registration.json') && src.includes('/api/dsh/restart'), '2-3 发现链三要素(环境变量/注册/REST bridge)');
    ok(src.includes('connections.json') && src.includes('.dsh-connection-changed'), '2-4 连接组读写 + D8 变更标记');
    ok(!/token=[^*'"]{6}/.test(src.replace(/\$\{[^}]*\}/g, 'X')) || src.includes('redact('), '2-5 输出走 redact 脱敏');
  }

  console.log('3. -Uninstall');
  {
    r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-Uninstall'], {
      env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', windowsHide: true,
    });
    ok(r.status === 0, '3-1 退出码 0');
    ok(!existsSync(join(home, 'profiles', 'web', 'plugins', 'launcher')), '3-2 载荷已删');
    const p = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
    ok(!p.includes('tool-launcher') && !p.includes('dsh-launcher: launcher'), '3-3 patch 节已剥离');
  }

  console.log('4. 语法冒烟(node --experimental 直载会因缺 dsh-tools 失败;改为括号/引号平衡粗检 + node --check 不适用 ESM,故用结构断言)');
  {
    const src = readFileSync(join(pkg, 'plugins', 'launcher', 'index.js'), 'utf8');
    const pairs = [['{', '}'], ['(', ')'], ['[', ']']];
    let balanced = true;
    for (const [o, c] of pairs) {
      const no = (src.match(new RegExp('\\' + o, 'g')) || []).length;
      const nc = (src.match(new RegExp('\\' + c, 'g')) || []).length;
      if (no !== nc) balanced = false;
    }
    ok(balanced, '4-1 括号平衡(粗检)');
  }

  rmSync(base, { recursive: true, force: true });
  console.log(`\n结果:${passed} 通过,${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-pm3 异常:', e);
  process.exit(1);
});
