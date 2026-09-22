// scripts/verify-image.mjs —— dsh-image 图片生成插件自动验证(generate_image / Doubao Seedream 5.0)。
//
// 覆盖:
//   1. install.ps1:载荷复制 + tool-image-gen patch 条目 + 幂等 + patch 校验器落位
//   2. -Only(含未知 id 报错)与 -Uninstall(载荷删除 + patch 节剥离)
//   3. 载荷直载(临时桩 @deepseek-ai/*)后的纯函数:三模式请求体、组图参数、
//      size 归一、落盘路径、mode 一致性校验、参考图 data URI 化
//   4. 端到端(桩 fetch,不触网):文生图/组图落盘 + 输出契约(无损 JSON);
//      缺凭证与 401 的可读报错
//
// 用法:node scripts/verify-image.mjs(需要 powershell 与 node 在 PATH;纯临时 DSH_HOME)

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = join(root, 'plugins', 'dsh-image-dsh-plugin');
const payload = join(pkg, 'plugins', 'image-gen');

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failures++; console.error(`  FAIL - ${name}`); }
};

function ps(script, args, env) {
  return spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true,
  });
}
function makeHome(base, tag) {
  const home = mkdtempSync(join(base, `home-${tag}-`));
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true });
  return home;
}
const patch = (home) => readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
const count = (text, re) => (text.match(re) || []).length;

/** Recursively collect the paths of every `undefined` value (dsh rejects those). */
function undefinedPaths(value, path = '$', found = []) {
  if (value === undefined) { found.push(path); return found; }
  if (Array.isArray(value)) { value.forEach((item, index) => undefinedPaths(item, `${path}[${index}]`, found)); return found; }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) undefinedPaths(value[key], `${path}.${key}`, found);
  }
  return found;
}

/**
 * Materialize the real payload next to stubbed @deepseek-ai/* packages, so the
 * module can be imported (and exercised) without a dsh install.
 */
function loadPayload(base) {
  const stub = join(base, 'stub');
  const scope = join(stub, 'node_modules', '@deepseek-ai');
  const write = (name, body, main = 'index.mjs') => {
    const dir = join(scope, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.0.0', type: 'module', main }), 'utf8');
    writeFileSync(join(dir, main), body, 'utf8');
  };
  write('dsh-tools', 'export const defineTool = (def) => def;\n');
  write('dsh-credentials', 'export const credentialRef = (name) => ({ name });\n');
  write('schemastery', [
    'const chain = () => { const node = {}; node.role = () => node; node.default = () => node; return node };',
    'export default { object: (spec) => spec, string: chain, natural: chain, boolean: chain, array: chain };',
    '',
  ].join('\n'));
  writeFileSync(join(stub, 'index.mjs'), readFileSync(join(payload, 'index.js'), 'utf8'), 'utf8');
  writeFileSync(join(stub, 'package.json'), readFileSync(join(payload, 'package.json'), 'utf8'), 'utf8');
  return import(pathToFileURL(join(stub, 'index.mjs')).href);
}

async function main() {
  const base = mkdtempSync(join(tmpdir(), 'image-verify-'));
  const installer = join(pkg, 'install.ps1');

  console.log('1. 安装(载荷 + patch)');
  let home;
  {
    home = makeHome(base, 'install');
    let r = ps(installer, [], { DSH_HOME: home });
    ok(r.status === 0, `1-1 退出码 0（${r.status}）${r.status !== 0 ? '\n' + (r.stdout + r.stderr).slice(-500) : ''}`);
    ok(existsSync(join(home, 'profiles', 'web', 'plugins', 'image-gen', 'index.js')), '1-2 载荷 index.js 就位');
    ok(existsSync(join(home, 'profiles', 'web', 'plugins', 'image-gen', 'package.json')), '1-3 载荷 package.json 就位');
    const p = patch(home);
    ok(p.includes('tool-image-gen') && p.includes('# --- dsh-image: image-gen (native dsh) ---'), '1-4 patch 条目与节头');
    ok(existsSync(join(home, 'profiles', 'web', 'validate-patch.mjs')), '1-5 patch 校验器已复制');
    r = ps(installer, [], { DSH_HOME: home });
    ok(r.status === 0 && count(patch(home), /tool-image-gen/g) === 1, '1-6 幂等(重跑仍 1 条)');
  }

  console.log('2. -Only / -Uninstall');
  {
    const fresh = makeHome(base, 'only');
    let r = ps(installer, ['-Only', 'nope'], { DSH_HOME: fresh });
    ok(r.status !== 0, '2-1 未知服务 id 报错退出');
    r = ps(installer, ['-Only', 'image-gen'], { DSH_HOME: fresh });
    ok(r.status === 0 && patch(fresh).includes('tool-image-gen'), '2-2 -Only image-gen 正常安装');
    r = ps(installer, ['-Uninstall'], { DSH_HOME: home });
    ok(r.status === 0, '2-3 卸载退出码 0');
    ok(!existsSync(join(home, 'profiles', 'web', 'plugins', 'image-gen')), '2-4 载荷已删');
    const p = patch(home);
    ok(!p.includes('tool-image-gen') && !p.includes('dsh-image: image-gen'), '2-5 patch 节已剥离');
  }

  console.log('3. 载荷纯函数(三模式 / 组图 / size / 路径 / 参考图)');
  let mod;
  {
    mod = await loadPayload(base);
    ok(mod.name === 'tool-image-gen' && typeof mod.version === 'string', '3-1 导出 name/version');
    ok(typeof mod.buildRequestBody === 'function' && typeof mod.resolveOutputPaths === 'function' && typeof mod.materializeReference === 'function', '3-2 纯函数已导出');

    const text = mod.buildRequestBody({ model: 'm', prompt: 'p', references: [], mode: 'text2image', count: 1, watermark: false, outputFormat: 'jpeg', imageField: 'image' });
    ok(!('image' in text) && text.sequential_image_generation === 'disabled', '3-3 文生图:无 image 字段 + 单图');

    const one = mod.buildRequestBody({ model: 'm', prompt: 'p', references: ['https://x/a.jpg'], mode: 'image2image', count: 1, watermark: false, outputFormat: 'jpeg', imageField: 'image' });
    ok(typeof one.image === 'string', '3-4 图生图:image 为字符串(方舟原生)');

    const many = mod.buildRequestBody({ model: 'm', prompt: 'p', references: ['https://x/a.jpg', 'https://x/b.jpg'], mode: 'multi_image_fusion', count: 3, watermark: false, outputFormat: 'png', webSearch: true, seed: 7, imageField: 'image' });
    ok(Array.isArray(many.image) && many.image.length === 2, '3-5 多图融合:image 为数组');
    ok(many.sequential_image_generation === 'auto' && many.sequential_image_generation_options.max_images === 3, '3-6 组图参数(auto + max_images)');
    ok(many.watermark === false && many.response_format === 'url' && many.output_format === 'png', '3-7 watermark/response_format/output_format');
    ok(Array.isArray(many.tools) && many.tools[0].type === 'web_search' && many.seed === 7, '3-8 web_search 工具 + seed');

    const gateway = mod.buildRequestBody({ model: 'm', prompt: 'p', references: ['https://x/a.jpg'], mode: 'image2image', count: 1, imageField: 'images' });
    ok(Array.isArray(gateway.images) && gateway.image === undefined, '3-9 网关模式:imageField=images 走数组字段');

    ok(mod.normalizeSize('square') === '2048x2048' && mod.normalizeSize('4K') === '4K' && mod.normalizeSize('2048x1152') === '2048x1152', '3-10 size:预设/档位/像素');
    ok(mod.normalizeSize(undefined) === undefined, '3-11 size 缺省不下发');
    try { mod.normalizeSize('huge'); ok(false, '3-12 非法 size 报错'); } catch { ok(true, '3-12 非法 size 报错'); }

    ok(mod.resolveMode('auto', 0) === 'text2image' && mod.resolveMode(undefined, 1) === 'image2image' && mod.resolveMode(undefined, 2) === 'multi_image_fusion', '3-13 mode 由参考图张数推断');
    try { mod.resolveMode('text2image', 1); ok(false, '3-14 mode 与参考图不一致报错'); } catch { ok(true, '3-14 mode 与参考图不一致报错'); }

    const single = mod.resolveOutputPaths({ extension: '.jpg', total: 1, defaultOutputDir: 'D:/out' });
    const group = mod.resolveOutputPaths({ outputPath: 'D:/out/gen.png', extension: '.png', total: 3, defaultOutputDir: 'D:/out' });
    ok(single.length === 1 && single[0].endsWith('.jpg'), '3-15 单图路径');
    ok(group.length === 3 && group[1] === 'D:/out/gen-2.png', '3-16 组图路径加 -N 后缀');
    try { mod.resolveOutputPaths({ outputPath: 'D:/out/gen.png', extension: '.jpg', total: 1, defaultOutputDir: 'D:/out' }); ok(false, '3-17 扩展名与格式不符报错'); } catch { ok(true, '3-17 扩展名与格式不符报错'); }

    const refFile = join(base, 'ref.png');
    writeFileSync(refFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const inlined = await mod.materializeReference(refFile);
    ok(inlined.startsWith('data:image/png;base64,') && inlined.endsWith('iVBORw=='), '3-18 本地参考图转 data URI');
    ok(await mod.materializeReference('https://x/a.jpg') === 'https://x/a.jpg', '3-19 公网 URL 原样透传');
    try { await mod.materializeReference(join(base, 'missing.png')); ok(false, '3-20 参考图不存在报错'); } catch { ok(true, '3-20 参考图不存在报错'); }
    try { await mod.materializeReference(join(base, 'ref.tiff')); ok(false, '3-21 不支持的扩展名报错'); } catch { ok(true, '3-21 不支持的扩展名报错'); }
  }

  console.log('4. 端到端(桩 fetch,不触网)与输出契约');
  {
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const target = String(url);
      if (target.endsWith('/images/generations')) {
        const body = JSON.parse(init.body);
        calls.push({ url: target, headers: init.headers, body });
        const n = body.sequential_image_generation === 'auto' ? (body.sequential_image_generation_options?.max_images ?? 1) : 1;
        const data = Array.from({ length: n }, (_unused, index) => ({ url: `https://cdn.example/img-${index}.jpg`, size: '2048x2048' }));
        return new Response(JSON.stringify({ model: body.model, created: 1, data, usage: { generated_images: n, output_tokens: 16384, total_tokens: 16384 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 });
    };
    const prevKey = process.env.ARK_API_KEY;
    try {
      const tools = [];
      mod.apply({ tools: { register: (tool) => tools.push(tool) }, get: () => undefined }, {});
      const tool = tools.find((entry) => entry.name === 'generate_image');
      ok(!!tool, '4-1 注册 generate_image');
      const outDir = join(base, 'out');
      const exec = { signal: new AbortController().signal };

      process.env.ARK_API_KEY = 'test-key';
      const one = await tool.execute({ prompt: '一只机械鸟', output_dir: outDir, size: 'landscape' }, exec);
      ok(one.paths.length === 1 && existsSync(one.paths[0]) && readFileSync(one.paths[0]).length === 3, '4-2 文生图落盘(URL 下载)');
      ok(one.mode === 'text2image' && one.references === 0 && one.grouped === false, '4-3 文生图元信息');
      ok(calls[0].body.size === '2304x1728' && calls[0].headers.authorization === 'Bearer test-key', '4-4 请求体 size 与 Bearer 头');
      ok(undefinedPaths(one).length === 0, `4-5 输出无损 JSON(无 undefined)${undefinedPaths(one).length ? ` —— ${undefinedPaths(one).join(', ')}` : ''}`);

      const group = await tool.execute({ prompt: '三张连续场景', count: 3, output_dir: outDir, output_format: 'png' }, exec);
      ok(group.paths.length === 3 && group.paths.every((p) => existsSync(p)) && group.paths[2].endsWith('-3.png'), '4-6 组图 3 张落盘且带 -N 后缀');
      ok(group.grouped === true && group.urls.length === 3 && undefinedPaths(group).length === 0, '4-7 组图元信息 + 无损 JSON');

      delete process.env.ARK_API_KEY;
      try { await tool.execute({ prompt: 'x', output_dir: outDir }, exec); ok(false, '4-8 缺凭证给出可读报错'); }
      catch (error) { ok(/no credential for ARK_API_KEY/.test(String(error.message)), '4-8 缺凭证给出可读报错'); }

      process.env.ARK_API_KEY = 'test-key';
      globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'AuthenticationError', message: 'invalid key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
      try { await tool.execute({ prompt: 'x', output_dir: outDir }, exec); ok(false, '4-9 401 报错带诊断'); }
      catch (error) { ok(/401/.test(String(error.message)) && /credentials seam/.test(String(error.message)), '4-9 401 报错带诊断'); }

      try { await tool.execute({ prompt: 'x', output_dir: outDir, extra: 'nope' }, exec); ok(false, '4-10 extra 非对象报错'); }
      catch (error) { ok(/extra must be a JSON object/.test(String(error.message)), '4-10 extra 非对象报错'); }
    } finally {
      globalThis.fetch = realFetch;
      if (prevKey === undefined) delete process.env.ARK_API_KEY; else process.env.ARK_API_KEY = prevKey;
    }
  }

  rmSync(base, { recursive: true, force: true });
  console.log(`\n结果:${passed} 通过,${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('verify-image 异常:', error);
  process.exit(1);
});
