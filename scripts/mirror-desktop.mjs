// mirror-desktop.mjs —— 镜像上游 DeepSeek Harness 桌面版安装包到伞仓 Release。
//
// 背景(2026-09-28):伞仓自建的 `dsh-desktop/` 已移除 —— 桌面版归上游
// (`deepseek-harness/apps/desktop`,包名 `@deepseek-ai/dsh-desktop`,与 dsh 本体严格同号)。
// 上游产物发在 download.deepseek.com 的 generic feed(channel `nightly`),伞仓只做**镜像/托管**:
//
//   读 feed → 校验 `feed.version` == `scripts/desktop-mirror.json` 的 `version`
//           → 校验产物名/大小/sha512 → (下载) → 落盘供 CI 上传为 Release 资产
//
// `version` 必须与伞仓锁定的子模块 `apps/desktop/package.json` 同号:上游的发布决策是
// 「shell / runtime / 契约作为一个组合一起合格化」,所以 dsh 升级 = desktop 一次发布;
// 版本对不上说明**子模块 bump 了但镜像 pin 没跟上**(或反之),必须同批改,故此处直接失败。
//
// 用法(伞仓根,node >= 18:用 global fetch):
//   node scripts/mirror-desktop.mjs --check                 # 只校验,不下载(preflight/CI 前置门)
//   node scripts/mirror-desktop.mjs --download <目录>        # 校验 + 下载 + 验 sha512 + 写 .sha512 副档
//
// 失败一律 exit 1;无第三方依赖。
//
// 注意:失败**不用 `process.exit()`** —— fetch(undici)在连接池里还有 socket 时强退会踩
// libuv 断言(`UV_HANDLE_CLOSING`,退出码变 0xC0000409),故改写 `process.exitCode` 让进程自然收敛。

import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 业务失败(可预期),由 main 统一转成 exit 1。 */
class MirrorFailure extends Error {}

const fail = (why) => {
  throw new MirrorFailure(why);
};

const mib = (bytes) => `${(bytes / 1048576).toFixed(1)} MiB`;

// ---------- 配置 ----------

const config = JSON.parse(readFileSync(join(root, 'scripts', 'desktop-mirror.json'), 'utf8'));
const pinned = String(config.version ?? '').trim();
if (pinned === '') fail('scripts/desktop-mirror.json 缺 version');
if (config.target !== 'win-x64') fail(`只镜像 win-x64(上游其余目标见 download.deepseek.com),实际: ${config.target}`);
if (config.channel !== 'nightly') fail(`上游 prerelease 只发 nightly 通道,实际: ${config.channel}`);

/** 上游 electron-builder 的 artifactName 模板:`deepseek-harness-${version}-${os}-${arch}.${ext}`。 */
const artifactFilename = `deepseek-harness-${pinned}-${config.target}.exe`;
const feedUrl = `${config.origin}/${config.feedDir}/${config.channel}.yml`;

// ---------- feed 解析(极简:上游 feed 是扁平 YAML,不引 yaml 依赖) ----------

/**
 * 把 feed 文本拍平成 `key/value` 列表,处理 electron-builder 折叠标量(`url: >-` 换行缩进续行)。
 * @param {string} text feed 原文
 * @returns {{indent: number, key: string, value: string}[]} 拍平后的键值序列
 */
function flattenFeed(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (line === '') continue;
    const folded = /^(\s*)(?:-\s+)?([^:\s][^:]*):\s*>-\s*$/.exec(line);
    if (folded) {
      out.push({ indent: folded[1].length, key: folded[2], value: '' });
      continue;
    }
    const last = out[out.length - 1];
    // 折叠标量的续行:有缩进、且不是新的列表项
    if (last && last.value === '' && /^\s+\S/.test(line) && !/^\s*-\s/.test(line)) {
      last.value += line.trim();
      continue;
    }
    const kv = /^(\s*)(?:-\s+)?([^:\s][^:]*):\s*(.*)$/.exec(line);
    if (kv) out.push({ indent: kv[1].length, key: kv[2], value: kv[3].trim() });
  }
  return out;
}

/**
 * 读取并校验上游 feed,返回该 pin 对应的产物信息。
 * @returns {Promise<{version: string, url: string, sha512: string, size: number}>} 产物信息
 */
async function readFeed() {
  let text;
  try {
    const res = await fetch(feedUrl, { redirect: 'follow' });
    if (!res.ok) fail(`feed 取不到(${res.status} ${res.statusText}): ${feedUrl}`);
    text = await res.text();
  } catch (e) {
    if (e instanceof MirrorFailure) throw e;
    fail(`feed 请求失败: ${feedUrl} (${e instanceof Error ? e.message : String(e)})`);
  }
  const flat = flattenFeed(text);
  const pick = (key, indent) =>
    flat.find((entry) => entry.key === key && (indent === undefined || entry.indent === indent))?.value;

  const feedVersion = pick('version', 0) ?? '';
  const url = pick('path', 0) ?? pick('url') ?? '';
  const sha512 = pick('sha512') ?? '';
  const size = Number(pick('size') ?? '0');

  if (feedVersion === '') fail(`feed 无 version 字段: ${feedUrl}`);
  if (feedVersion !== pinned) {
    fail(
      `镜像 pin 与上游 feed 不一致: pin=${pinned} feed=${feedVersion}\n` +
        '  → 上游已推进:把子模块 bump 到对应 tag,并同批把 scripts/desktop-mirror.json 的 version 改成新号;' +
        '若上游回退/重建了该版本产物,则以 feed 为准修正 pin。',
    );
  }
  if (url === '' || sha512 === '' || !Number.isFinite(size) || size <= 0) {
    fail(`feed 缺 path/sha512/size: ${feedUrl}`);
  }
  if (basename(url) !== artifactFilename) {
    fail(
      `上游产物名与预期不符: 期望 ${artifactFilename}, feed 给的是 ${basename(url)}\n` +
        '  → 上游改过 artifactName 模板时需同步 scripts/desktop-mirror.json 的 target 与脚本命名规则。',
    );
  }
  if (sha512.length !== 88) fail(`sha512 形状不对(应为 64B 的 base64 = 88 字符): ${sha512}`);
  return { version: feedVersion, url, sha512, size };
}

// ---------- 下载 ----------

/**
 * 流式下载并同步算 sha512,核对上游给的 base64 摘要与字节数,最后写 `.sha512` 副档(hex,sha512sum 格式)。
 * @param {{url: string, sha512: string, size: number}} artifact 上游 feed 声明的产物
 * @param {string} outDir 落盘目录
 */
async function downloadFeedArtifact(artifact, outDir) {
  await mkdir(outDir, { recursive: true });
  const dest = join(outDir, artifactFilename);
  console.log(`[mirror-desktop] 下载: ${artifact.url} → ${dest} (${mib(artifact.size)})`);

  const hash = createHash('sha512');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  try {
    const res = await fetch(artifact.url, { redirect: 'follow' });
    if (!res.ok || res.body === null) fail(`产物下载失败(${res.status} ${res.statusText}): ${artifact.url}`);
    await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(dest));
  } catch (e) {
    if (e instanceof MirrorFailure) throw e;
    fail(`产物下载中断: ${artifact.url} (${e instanceof Error ? e.message : String(e)})`);
  }

  const hex = hash.digest('hex');
  const expectedHex = Buffer.from(artifact.sha512, 'base64').toString('hex');
  if (bytes !== artifact.size) fail(`字节数不符: feed ${artifact.size} vs 落盘 ${bytes}(${dest})`);
  if (hex !== expectedHex) fail(`sha512 不符: feed ${expectedHex} vs 实际 ${hex}(${dest})`);
  console.log(`[mirror-desktop] sha512 ✓ ${hex}`);

  const sidecar = `${dest}.sha512`;
  await writeFile(sidecar, `${hex}  ${basename(dest)}\n`, 'utf8');
  console.log(`[mirror-desktop] 副档 → ${sidecar}`);
}

// ---------- 入口 ----------

/** 解析 argv 并执行;业务失败由外层转 exit 1。 */
async function main() {
  const argv = process.argv.slice(2);
  const downloadAt = argv.indexOf('--download');
  const wantsDownload = downloadAt !== -1;
  const outArg = wantsDownload ? (argv[downloadAt + 1] ?? '').trim() : '';
  if (wantsDownload && outArg === '') fail('用法: node scripts/mirror-desktop.mjs --download <输出目录>');

  console.log(`[mirror-desktop] pin=${pinned} target=${config.target} channel=${config.channel}`);
  const artifact = await readFeed();
  console.log(`[mirror-desktop] feed ✓ ${artifact.version} / ${basename(artifact.url)} (${mib(artifact.size)})`);

  if (!wantsDownload) {
    console.log('[mirror-desktop] OK — pin 与上游 feed 一致(未下载;要落盘加 --download <目录>)');
    return;
  }
  await downloadFeedArtifact(artifact, resolve(root, outArg));
  console.log('[mirror-desktop] OK — 镜像产物已就绪,可上传为 Release 资产');
}

try {
  await main();
} catch (e) {
  if (e instanceof MirrorFailure) {
    console.error(`[mirror-desktop] FAIL: ${e.message}`);
    process.exitCode = 1;
  } else {
    throw e;
  }
}
