// build.mjs —— esbuild 打包：
//   dist/launcher.cjs            纯 Node CLI（无窗口，npm bin / SEA 用）
//   dist/electron-main.cjs       Electron 主进程（桌面窗口 + CLI）
//   dist/electron-preload.cjs    Electron 预加载（窗口控制桥）
//   dist/sea/launcher.cjs        SEA 压缩版（体积敏感备选）
// UI 文本资源（html/css/svg/js）经 text loader 直接嵌入。

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** UI 文本资源经 text loader 直接嵌入 bundle。 */
const loader = { '.html': 'text', '.css': 'text', '.svg': 'text', '.js': 'text' };

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  loader,
  logLevel: 'info',
};

mkdirSync(join(root, 'dist'), { recursive: true });
mkdirSync(join(root, 'dist-sea'), { recursive: true });

// 1. 纯 Node CLI（dev / npm bin / SEA 共用逻辑）
await build({
  ...common,
  entryPoints: [join(root, 'src/index.ts')],
  format: 'cjs',
  outfile: join(root, 'dist/launcher.cjs'),
  banner: { js: '#!/usr/bin/env node' },
  // koffi 是 native FFI：外部依赖（SEA 单文件版无 node_modules，运行时 require 失败即降级）
  external: ['koffi'],
  minify: false,
});

// 2. Electron 主进程
await build({
  ...common,
  entryPoints: [join(root, 'src/electron-main.ts')],
  format: 'cjs',
  outfile: join(root, 'dist/electron-main.cjs'),
  // electron 与 koffi（native FFI）都是运行时外部依赖，不打进 bundle
  external: ['electron', 'koffi'],
  minify: false,
});

// 3. Electron 预加载
await build({
  ...common,
  entryPoints: [join(root, 'src/electron-preload.ts')],
  format: 'cjs',
  outfile: join(root, 'dist/electron-preload.cjs'),
  external: ['electron'],
  minify: false,
});

// 4. SEA 压缩版（体积敏感备选，输出到 dist-sea/ 避免混入 Electron 打包）
await build({
  ...common,
  entryPoints: [join(root, 'src/index.ts')],
  format: 'cjs',
  outfile: join(root, 'dist-sea/launcher.cjs'),
  external: ['koffi'], // SEA 单文件无 node_modules，运行时 require 失败即降级
  minify: true,
});

console.log('构建完成：launcher.cjs + electron-main.cjs + electron-preload.cjs + sea/launcher.cjs');
