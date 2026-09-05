// build-sea.mjs —— Node SEA 单文件 exe：
//   esbuild 打包 → node --experimental-sea-config 生成 blob → 复制 node.exe →
//   postject 注入 → （默认）PE 子系统补丁为 GUI（双击不闪黑框）。
// 用法：
//   node scripts/build-sea.mjs              # dsh-launcher.exe（GUI 子系统）
//   node scripts/build-sea.mjs --console    # dsh-launcher-console.exe（保留控制台，CI 冒烟用）
// 先运行 node scripts/build.mjs 或直接跑本脚本（内部也会重新打包）。

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postject from 'postject';
import * as ResEdit from 'resedit';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gui = !process.argv.slice(2).includes('--console');
const outName = gui ? 'dsh-launcher.exe' : 'dsh-launcher-console.exe';

// SEA 产物独立目录（不混入 dist/，避免被 electron-builder 打进 app.asar）
const seaDir = join(root, 'dist-sea');
mkdirSync(seaDir, { recursive: true });
mkdirSync(join(root, 'dist'), { recursive: true });

console.log('==> 1/5 esbuild 打包（SEA 压缩版）');
await build({
  entryPoints: [join(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: join(seaDir, 'launcher.cjs'),
  minify: true,
  loader: { '.html': 'text', '.css': 'text', '.svg': 'text', '.js': 'text' },
  logLevel: 'info',
});

console.log('==> 2/5 生成 sea-config.json');
const seaConfig = join(seaDir, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: 'dist-sea/launcher.cjs',
      output: 'dist-sea/sea-prep.blob',
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
);

console.log('==> 3/5 生成 SEA blob（node --experimental-sea-config）');
// config 的 main/output 相对 cwd（仓库根）解析；--experimental-sea-config 传相对路径
const r = spawnSync(
  process.execPath,
  ['--experimental-sea-config', 'dist-sea/sea-config.json'],
  { cwd: root, stdio: 'inherit' },
);
if (r.status !== 0) {
  console.error('sea-config 失败');
  process.exit(1);
}

console.log(`==> 4/5 复制 node.exe → dist/${outName} 并注入 blob`);
const outPath = join(root, 'dist', outName);
copyFileSync(process.execPath, outPath);

// 4.1 打上鲸鱼图标 + 版本信息（resedit，纯 JS PE 资源编辑）
try {
  applyResources(outPath);
} catch (e) {
  console.warn(`跳过资源注入（${e.message}）`);
}

const blobPath = join(seaDir, 'sea-prep.blob');
const blobData = readFileSync(blobPath);
await postject.inject(outPath, 'NODE_SEA_BLOB', blobData, {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  machoSegmentName: 'NODE_SEA',
});

if (gui) {
  console.log('==> 5/5 PE 子系统补丁 → WINDOWS_GUI（双击不闪黑框）');
  patchSubsystem(outPath);
} else {
  console.log('==> 5/5 保留控制台子系统（CLI 冒烟用）');
}

console.log(`完成：${outPath}`);

// IMAGE_OPTIONAL_HEADER64.Subsystem 置为 2（WINDOWS_GUI），3 是 CONSOLE。
function patchSubsystem(exePath) {
  const buf = readFileSync(exePath);
  const eLfanew = buf.readUInt32LE(0x3c);
  const optOffset = eLfanew + 4 + 20; // PE 签名 + COFF 头
  const magic = buf.readUInt16LE(optOffset);
  if (magic !== 0x20b) {
    console.warn(`非 PE32+（magic=0x${magic.toString(16)}），跳过子系统补丁`);
    return;
  }
  const subsystemOffset = optOffset + 0x44;
  const cur = buf.readUInt16LE(subsystemOffset);
  if (cur === 2) {
    console.log('已是 GUI 子系统');
    return;
  }
  buf.writeUInt16LE(2, subsystemOffset);
  writeFileSync(exePath, buf);
  console.log(`子系统 ${cur} → 2（WINDOWS_GUI）`);
}

/** 用 resedit 给 exe 打鲸鱼图标 + 版本信息（SEA 版没有 Electron 的资源处理）。 */
function applyResources(exePath) {
  const iconPath = join(root, 'icon.ico');
  const version = readJson(root, 'package.json').version ?? '0.2.0';
  const exeData = readFileSync(exePath);
  const exe = ResEdit.NtExecutable.from(exeData);
  const res = ResEdit.NtExecutableResource.from(exe);

  if (existsSync(iconPath)) {
    const iconFile = ResEdit.Data.IconFile.from(readFileSync(iconPath));
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res,
      1,
      1033,
      iconFile.icons.map((i) => i.data),
    );
  }

  const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (viList.length > 0) {
    const vi = viList[0];
    vi.setStringValues(
      { lang: 1033, codepage: 1200 },
      {
        CompanyName: 'dsh-launcher',
        FileDescription: 'dsh-launcher — dsh 安装/启动引导器',
        FileVersion: version,
        ProductName: 'dsh-launcher',
        ProductVersion: version,
      },
    );
    vi.outputToResourceEntries();
  }

  res.end();
  res.outputResource(exe);
  writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`已注入图标（${iconPath}）与版本 ${version}`);
}

function readJson(rootDir, name) {
  try {
    return JSON.parse(readFileSync(join(rootDir, name), 'utf8'));
  } catch {
    return {};
  }
}
