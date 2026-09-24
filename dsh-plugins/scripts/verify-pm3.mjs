// scripts/verify-pm3.mjs —— PM3 自动验证(dsh-launcher 桥接插件)。
//
// 覆盖:
//   1. install.ps1:载荷复制 + tool-launcher patch 条目(幂等)
//   2. -Uninstall:载荷删除 + patch 节剥离
//   3. index.js 结构:6 个 defineTool、name=tool-launcher、发现链关键词
//   4. 无 dsh 依赖可静态解析(node --check 等价:用 vm/acorn 不可用时降级为正则)
//   5. launcher_status 输出契约:无损 JSON(无 undefined 值)、token 不回显(issue #30 回归)
//   6. launcher_cli:dsh-cli 的安装/更新入口(status/install/update,离线走本地来源)
//
// 用法:node scripts/verify-pm3.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    ok((src.match(/defineTool\(/g) || []).length === 6, '2-1 六个 defineTool(含 dsh-cli 安装/更新入口 launcher_cli)');
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

  console.log('5. launcher_status 输出契约(无损 JSON / 不回显 token —— issue #30 回归)');
  {
    // 载荷 import 依赖 @deepseek-ai/dsh-tools(宿主包),本仓不装依赖 → 在临时目录放桩件后直载真身
    const stub = mkdtempSync(join(base, 'stub-'));
    const depDir = join(stub, 'node_modules', '@deepseek-ai', 'dsh-tools');
    mkdirSync(depDir, { recursive: true });
    writeFileSync(join(depDir, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module', main: 'index.mjs' }), 'utf8');
    writeFileSync(join(depDir, 'index.mjs'), 'export const defineTool = (def) => def;\n', 'utf8');
    writeFileSync(join(stub, 'plugin.mjs'), readFileSync(join(pkg, 'plugins', 'launcher', 'index.js'), 'utf8'), 'utf8');

    // seam 文件刻意留缺:注册缺 launcherExe/api;旧意图缺 byPid;连接带 token(都必须不出现在输出里)
    const home = makeHome(base);
    writeFileSync(join(home, 'connections.json'), JSON.stringify({
      version: 1,
      active: 'local-3080',
      connections: [{ id: 'local-3080', kind: 'local', name: '本机', port: 3080, token: 'super-secret-token' }],
    }), 'utf8');
    writeFileSync(join(home, 'launcher-registration.json'), JSON.stringify({
      updatedAt: new Date().toISOString(), launcherVersion: '0.9.4', pid: process.pid, running: true,
    }), 'utf8');
    writeFileSync(join(home, '.dsh-restart-intent.json'), JSON.stringify({
      version: 1, requestedAt: new Date().toISOString(), reason: '旧意图文件(无 byPid)',
    }), 'utf8');

    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
      const mod = await import(pathToFileURL(join(stub, 'plugin.mjs')).href);
      const tools = [];
      mod.apply({ tools: { register: (t) => tools.push(t) }, get: () => undefined });
      const status = tools.find((t) => t.name === 'launcher_status');
      ok(!!status, '5-1 注册 launcher_status');
      const res = await status.execute({});

      const bad = [];
      const scan = (v, path) => {
        if (v === undefined) { bad.push(path); return; }
        if (Array.isArray(v)) { v.forEach((x, i) => scan(x, `${path}[${i}]`)); return; }
        if (v && typeof v === 'object') Object.keys(v).forEach((k) => scan(v[k], `${path}.${k}`));
      };
      scan(res, '$');
      ok(bad.length === 0, `5-2 输出无 undefined 值(应无损 JSON)${bad.length ? ` —— 发现 ${bad.join(', ')}` : ''}`);
      ok(JSON.stringify(res.detail) === JSON.stringify(JSON.parse(JSON.stringify(res.detail))), '5-3 detail JSON 往返无损');
      ok(!('token' in res.detail.connection.active), '5-4 连接 token 不回显(D2 红线)');
      ok(!('byPid' in res.detail.restartIntent), '5-5 旧意图缺 byPid 时不写该键');
      ok(!('api' in res.detail.launcher), '5-6 注册缺 api 时不写该键');
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    }
  }

  console.log('6. launcher_cli:dsh-cli 安装/更新入口(离线,来源=本地 exe)');
  {
    const stub = mkdtempSync(join(base, 'stub-cli-'));
    const depDir = join(stub, 'node_modules', '@deepseek-ai', 'dsh-tools');
    mkdirSync(depDir, { recursive: true });
    writeFileSync(join(depDir, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module', main: 'index.mjs' }), 'utf8');
    writeFileSync(join(depDir, 'index.mjs'), 'export const defineTool = (def) => def;\n', 'utf8');
    writeFileSync(join(stub, 'plugin.mjs'), readFileSync(join(pkg, 'plugins', 'launcher', 'index.js'), 'utf8'), 'utf8');

    const home = makeHome(base);
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    const results = [];
    try {
      const mod = await import(pathToFileURL(join(stub, 'plugin.mjs')).href);
      const tools = [];
      mod.apply({ tools: { register: (t) => tools.push(t) }, get: () => undefined }, {});
      const tool = tools.find((t) => t.name === 'launcher_cli');
      ok(!!tool, '6-1 注册 launcher_cli');

      const before = await tool.execute({ action: 'status' });
      results.push(before);
      ok(before.installed === false, '6-2 未安装时 status 明说未安装');

      const asset = join(base, 'dshcli-fake.exe');
      writeFileSync(asset, Buffer.alloc(4096, 7));
      const installed = await tool.execute({ action: 'install', version: '0.11.0', from: asset });
      results.push(installed);
      ok(installed.updated === true && installed.version === '0.11.0', `6-3 install 落盘(${installed.summary})`);
      ok(existsSync(join(home, 'bin', 'dshcli.exe')), '6-4 exe 就位 %DSH_HOME%\\bin\\dshcli.exe');

      const after = await tool.execute({ action: 'status' });
      results.push(after);
      ok(after.installed === true && after.version === '0.11.0', '6-5 status 读回版本');

      const again = await tool.execute({ action: 'update', version: '0.11.0', from: asset });
      results.push(again);
      ok(again.updated === false, '6-6 版本相同不重复下载');

      writeFileSync(asset, Buffer.alloc(8192, 9));
      const upgraded = await tool.execute({ action: 'update', version: '0.12.0', from: asset });
      results.push(upgraded);
      ok(upgraded.updated === true && typeof upgraded.backedUp === 'string' && existsSync(upgraded.backedUp), '6-7 升级会备份旧 exe');

      const unknown = await tool.execute({ action: 'nope' });
      results.push(unknown);
      ok(/未知 action/.test(unknown.summary), '6-8 未知 action 不静默');

      try {
        await tool.execute({ action: 'install', from: join(base, 'nope.exe') });
        ok(false, '6-9 不存在的来源应当报错');
      } catch (error) {
        ok(/本地来源不存在/.test(String(error.message)), '6-9 不存在的来源明确报错');
      }

      const bad = [];
      const scan = (v, path) => {
        if (v === undefined) { bad.push(path); return; }
        if (Array.isArray(v)) { v.forEach((x, i) => scan(x, `${path}[${i}]`)); return; }
        if (v && typeof v === 'object') Object.keys(v).forEach((k) => scan(v[k], `${path}.${k}`));
      };
      results.forEach((r, i) => scan(r, `$[${i}]`));
      ok(bad.length === 0, `6-10 launcher_cli 输出无损 JSON${bad.length ? ` —— ${bad.join(', ')}` : ''}`);
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    }
  }

  rmSync(base, { recursive: true, force: true });
  console.log(`\n结果:${passed} 通过,${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-pm3 异常:', e);
  process.exit(1);
});
