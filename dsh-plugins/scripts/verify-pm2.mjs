// scripts/verify-pm2.mjs —— PM2 自动验证(dsh-media / dsh-deepseek 合并包 + uninstall-old 迁移)。
//
// 覆盖:
//   1. dsh-media 全量安装(5 服务载荷 + 5 个 patch 条目)且幂等(重跑不重复)
//   2. -Only 子集安装(仅 2 服务)
//   3. -Uninstall(载荷删除 + patch 节剥离)
//   4. dsh-deepseek 全量(2 服务)
//   5. uninstall-old.ps1:旧包载荷/patch 节清理(先装旧 audio-read 再迁移)
//
// 用法:node scripts/verify-pm2.mjs(需要 powershell 与 node 在 PATH;纯临时 DSH_HOME)

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginsDir = join(root, 'plugins');

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failures++; console.error(`  FAIL - ${name}`); }
};

function ps(script, args, env) {
  return spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    windowsHide: true,
  });
}
function makeHome(base, tag) {
  const home = mkdtempSync(join(base, `home-${tag}-`));
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true });
  return home;
}
const patch = (home) => readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
const count = (text, re) => (text.match(re) || []).length;
const MEDIA = ['audio-read', 'audio-speak', 'describe-image', 'video-read', 'document-read'];

async function main() {
  const base = mkdtempSync(join(tmpdir(), 'pm2-verify-'));
  const media = join(pluginsDir, 'dsh-media-dsh-plugin', 'install.ps1');
  const deep = join(pluginsDir, 'dsh-deepseek-dsh-plugin', 'install.ps1');
  const oldUn = join(root, 'uninstall-old.ps1');

  console.log('1. dsh-media 全量安装 + 幂等');
  {
    const home = makeHome(base, 'media');
    let r = ps(media, [], { DSH_HOME: home });
    ok(r.status === 0, `1-1 退出码 0（${r.status}）${r.status !== 0 ? '\n' + (r.stdout + r.stderr).slice(-500) : ''}`);
    ok(MEDIA.every((s) => existsSync(join(home, 'profiles', 'web', 'plugins', s, 'index.js'))), '1-2 五个服务载荷就位');
    const p1 = patch(home);
    ok(count(p1, /tool-(audio-read|audio-speak|describe-image|video-read|document-read)/g) === 5, '1-3 五个 patch 条目');
    ok(count(p1, /# --- dsh-media: /g) === 5, '1-4 五个 dsh-media 节头');
    r = ps(media, [], { DSH_HOME: home });
    ok(r.status === 0, '1-5 重跑退出码 0');
    ok(count(patch(home), /tool-/g) === 5, '1-6 幂等:重跑后仍 5 条(判重跳过)');
    ok(existsSync(join(home, 'profiles', 'web', 'patch-apiproxy.mjs')), '1-7 describe-image apiproxy 补丁脚本已复制');
  }

  console.log('2. -Only 子集');
  {
    const home = makeHome(base, 'only');
    const r = ps(media, ['-Only', 'audio-read,video-read'], { DSH_HOME: home });
    ok(r.status === 0, '2-1 退出码 0');
    ok(existsSync(join(home, 'profiles', 'web', 'plugins', 'audio-read', 'index.js')) && existsSync(join(home, 'profiles', 'web', 'plugins', 'video-read', 'index.js')), '2-2 选中服务已装');
    ok(!existsSync(join(home, 'profiles', 'web', 'plugins', 'audio-speak')), '2-3 未选中服务未装');
    const p = patch(home);
    ok(count(p, /tool-/g) === 2 && p.includes('tool-audio-read') && p.includes('tool-video-read'), '2-4 仅 2 个 patch 条目');
  }

  console.log('3. -Uninstall');
  {
    const home = makeHome(base, 'un');
    ps(media, [], { DSH_HOME: home });
    const r = ps(media, ['-Uninstall', '-Only', 'audio-read,video-read'], { DSH_HOME: home });
    ok(r.status === 0, '3-1 退出码 0');
    ok(!existsSync(join(home, 'profiles', 'web', 'plugins', 'audio-read')) && !existsSync(join(home, 'profiles', 'web', 'plugins', 'video-read')), '3-2 载荷已删');
    const p = patch(home);
    ok(!p.includes('tool-audio-read') && !p.includes('tool-video-read') && count(p, /tool-/g) === 3, '3-3 对应节已剥离(剩 3)');
  }

  console.log('4. dsh-deepseek 全量');
  {
    const home = makeHome(base, 'deep');
    const r = ps(deep, [], { DSH_HOME: home });
    ok(r.status === 0, '4-1 退出码 0');
    ok(existsSync(join(home, 'profiles', 'web', 'plugins', 'deepseek-balance', 'index.js')) && existsSync(join(home, 'profiles', 'web', 'plugins', 'deepseek-recharge', 'index.js')), '4-2 两个服务载荷');
    ok(count(patch(home), /tool-deepseek-(balance|recharge)/g) === 2, '4-3 两个 patch 条目');
  }

  console.log('5. uninstall-old.ps1 迁移(旧 audio-read → 清理)');
  {
    const home = makeHome(base, 'mig');
    // 先用旧包安装器装出旧节头
    const oldInstaller = join(pluginsDir, 'audio-read-dsh-plugin', 'install.ps1');
    let r = ps(oldInstaller, [], { DSH_HOME: home });
    ok(r.status === 0, '5-1 旧包安装成功(旧节头写入)');
    ok(patch(home).includes('# --- audio reading tools (native dsh) ---'), '5-2 旧节头存在');
    r = ps(oldUn, [], { DSH_HOME: home });
    ok(r.status === 0, '5-3 uninstall-old 退出码 0');
    ok(!existsSync(join(home, 'profiles', 'web', 'plugins', 'audio-read')), '5-4 旧载荷已删');
    const p = patch(home);
    ok(!p.includes('audio reading tools') && !p.includes('tool-audio-read'), '5-5 旧节已剥离');
    // 再装新合并包,patch 正常追加(迁移闭环)
    r = ps(join(pluginsDir, 'dsh-media-dsh-plugin', 'install.ps1'), ['-Only', 'audio-read'], { DSH_HOME: home });
    ok(r.status === 0 && patch(home).includes('tool-audio-read'), '5-6 新包接管同服务');
  }

  rmSync(base, { recursive: true, force: true });
  console.log(`\n结果:${passed} 通过,${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-pm2 异常:', e);
  process.exit(1);
});
