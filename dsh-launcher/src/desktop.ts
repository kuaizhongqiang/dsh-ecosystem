// desktop.ts —— 上游 DeepSeek Harness 桌面版（Electron）的安装 / 升级入口。
//
// 背景（2026-09-28）：桌面版**归上游**（`deepseek-harness/apps/desktop`，包名
// `@deepseek-ai/dsh-desktop`，与 dsh 本体严格同号），伞仓不再自建，只在 Release 里
// **镜像**其 win-x64 安装包。因此 launcher 在这里只负责「首装 / 升级到有桌面版」：
//   - **不替代**上游自带的 electron-updater（装完由桌面版自己升级）；
//   - **不改名 / 不重打包**上游产物，只下载 + 校验 + 拉起安装；
//   - 仅 Windows（我们只镜像 win-x64；mac 用户走上游官方通道）。
//
// 取件策略（feed 优先 + 镜像兜底，2026-09-28 定）：
//   1) 上游 feed：`https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml`
//      —— 腾讯 CDN，带 version / sha512(base64) / size；上游当前只有 **nightly** 通道
//      （版本全是 prerelease，故稳定别名 latest.yml 不出现）。
//   2) 伞仓 Release 镜像资产：`deepseek-harness-<ver>-win-x64.exe`（+.sha512 副档，hex）。
//   3) 显式 `from`（http(s) 或本地路径）可强制指定：离线 / 自测用；有同名 `.sha512`
//      副档才校验，否则如实标记 `verified: false` 并告警。
//
// 安装形态：上游是 electron-builder assisted NSIS
// （`oneClick:false` / `perMachine:false` / `allowElevation:false`）→ **按用户安装、
// 不需要管理员**；2026-09-28 实测 `安装包 /S` 静默成功（0.1.7-rc.2，exit 0，无 UI），
// 装完在 HKCU 卸载注册项写 `DisplayName` / `DisplayVersion` / `InstallLocation`。
//
// 注册项口径（2026-09-28 真机校正）：上游 NSIS 模板的 `Name` 是
// `${productName} ${version}`，故 **DisplayName 实测带版本后缀**：
// `DisplayName = DeepSeek Harness 0.1.7-rc.2`。旧实现要求它**精确等于** `DeepSeek Harness`，
// 结果永远读不到版本（UI 显示「未确认」）—— 匹配口径见 `parseUninstallDump()`。

import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

import * as log from './log.js';
import { compareSemver, parseSemver } from './semver.js';
import { dshHome } from './tokenFile.js';

/** 上游桌面版分发 origin（腾讯 CDN；测试环境另有 origin，这里只走生产）。 */
export const FEED_ORIGIN = 'https://download.deepseek.com';
/** 上游 feed 目录（win-x64 目标）。 */
export const FEED_DIR = 'dsh-desk/feeds/win-x64';
/** 上游产物目录（win-x64 目标）。 */
export const BIN_DIR = 'dsh-desk/bin/win-x64';
/** 上游通道：目前只有 nightly（版本全是 prerelease）。 */
export const FEED_CHANNEL = 'nightly';
/** 上游桌面版在 Windows 卸载注册项里的产品名（用于识别「已装」）。 */
export const DESKTOP_PRODUCT_NAME = 'DeepSeek Harness';

/** 产品名的正则安全形式（名字里带空格，直接插进正则不安全）。 */
const DESKTOP_PRODUCT_RE = DESKTOP_PRODUCT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const mirrorRepo = 'kuaizhongqiang/dsh-ecosystem';
const mirrorAPI = `https://api.github.com/repos/${mirrorRepo}/releases/latest`;
const httpTimeoutMs = 20_000;

/** 产物来源：上游 feed / 伞仓镜像 / 显式指定。 */
export type DesktopSource = 'upstream-feed' | 'mirror' | 'explicit';

/** 一个可安装的桌面版产物。 */
export interface DesktopRelease {
  version: string;
  url: string;
  /** sha512：上游 feed 给 base64（88 字符），伞仓 `.sha512` 副档给 hex（128 字符）。 */
  sha512: string;
  /** 字节数；0 = 上游未声明（此时只校验摘要）。 */
  size: number;
  source: DesktopSource;
  /** 是否做了摘要校验（显式 from 且无副档时为 false）。 */
  verified: boolean;
}

/** 桌面版状态（供 UI / CLI 展示）。 */
export interface DesktopStatus {
  /** 当前平台是否支持（仅 win32）。 */
  supported: boolean;
  /** 已装版本；未装 = ''。 */
  installed: string;
  /** 可取到的最新版本；取不到 = ''。 */
  latest: string;
  hasUpdate: boolean;
  release?: DesktopRelease;
  /** 取件失败原因（如实暴露，不吞）。 */
  error?: string;
}

/** feed 清单地址。 */
export function feedUrl(): string {
  return `${FEED_ORIGIN}/${FEED_DIR}/${FEED_CHANNEL}.yml`;
}

/** 上游产物文件名（= 上游 electron-builder 的 artifactName 模板）。 */
export function desktopInstallerName(version: string): string {
  return `deepseek-harness-${version}-win-x64.exe`;
}

/** 安装包缓存目录（DSH_HOME 下，故测试可用 DSH_HOME 隔离）。 */
export function desktopCacheDir(): string {
  return join(dshHome(), 'cache', 'desktop');
}

// ---------- 已装版本（上游安装登记） ----------

/**
 * 从 `reg query <Uninstall 键> /s` 的转储里解析上游桌面版已装版本（多条取最高；读不到 = ''）。
 *
 * 匹配口径（2026-09-28 真机校正，**修 P0**）：
 *   - `DisplayName` 取「产品名前缀 + 可选版本后缀」—— 上游 NSIS 的 `Name` 是
 *     `${productName} ${version}`，实测 `DeepSeek Harness 0.1.7-rc.2`；
 *     只认不带后缀的精确匹配会**永远读不到版本**（UI 卡在「未确认」）。
 *   - 版本优先取 `DisplayVersion`；该值缺失时退回 `DisplayName` 里的版本后缀。
 *   - 按块匹配（`DisplayName` 与 `DisplayVersion` 必在同一注册项块内），
 *     不会误匹配旧自建桌面版（`dsh-desktop 0.9.4`）等无关项。
 * 纯函数（无 IO），供 `verify-m9` 直接单测。
 */
export function parseUninstallDump(dump: string): string {
  let found = '';
  const nameRe = new RegExp(`^\\s*DisplayName\\s+REG_SZ\\s+${DESKTOP_PRODUCT_RE}(?:\\s+(\\S+))?\\s*$`, 'im');
  for (const block of dump.split(/\r?\n(?=HKEY_)/)) {
    const name = nameRe.exec(block);
    if (!name) continue;
    const declared = /^\s*DisplayVersion\s+REG_SZ\s+(\S+)\s*$/im.exec(block);
    const candidate = declared?.[1] ?? name[1] ?? '';
    if (candidate !== '' && (found === '' || compare(candidate, found) > 0)) found = candidate;
  }
  return found;
}

/**
 * 读上游桌面版的已装版本：枚举 Windows 卸载注册项（HKCU 用户级 + HKLM 机器级 + WOW6432Node，
 * 注册项 GUID 不稳定，**不能硬编码**），解析口径见 `parseUninstallDump()`。
 * 非 Windows / 未装 / 读取失败一律返回 ''，绝不抛错。
 */
export function installedDesktopVersion(): string {
  if (process.platform !== 'win32') return '';
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  let found = '';
  for (const root of roots) {
    let dump = '';
    try {
      dump = execFileSync('reg', ['query', root, '/s'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    } catch {
      continue; // 键不存在 / 无权限：跳过
    }
    const v = parseUninstallDump(dump);
    if (v !== '' && (found === '' || compare(v, found) > 0)) found = v;
  }
  return found;
}

/** 宽松比较两个版本串（解析失败则按字符串比），供「取最高已装版本」用。 */
function compare(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa && pb) return compareSemver(pa, pb);
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------- 取件：上游 feed ----------

/** 请求文本（带超时与 User-Agent）。 */
async function getText(url: string, timeoutMs = httpTimeoutMs): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'dsh-launcher/desktop', Accept: '*/*' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}（${url}）`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把上游 feed 拍平成键值序列（electron-builder 的折叠标量 `url: >-` 需续行拼接）。
 * @param text feed 原文
 */
function flattenFeed(text: string): Array<{ indent: number; key: string; value: string }> {
  const out: Array<{ indent: number; key: string; value: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (line === '') continue;
    const folded = /^(\s*)(?:-\s+)?([^:\s][^:]*):\s*>-\s*$/.exec(line);
    if (folded) {
      out.push({ indent: folded[1].length, key: folded[2], value: '' });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.value === '' && /^\s+\S/.test(line) && !/^\s*-\s/.test(line)) {
      last.value += line.trim();
      continue;
    }
    const kv = /^(\s*)(?:-\s+)?([^:\s][^:]*):\s*(.*)$/.exec(line);
    if (kv) out.push({ indent: kv[1].length, key: kv[2], value: kv[3].trim() });
  }
  return out;
}

/** 读上游 feed（权威：版本 + 摘要 + 字节数 + 产物 URL 都自带）。 */
export async function readUpstreamFeed(): Promise<DesktopRelease> {
  const url = feedUrl();
  const flat = flattenFeed(await getText(url));
  const pick = (key: string, indent?: number): string =>
    flat.find((e) => e.key === key && (indent === undefined || e.indent === indent))?.value ?? '';
  const version = pick('version', 0);
  const artifact = pick('path', 0) || pick('url');
  const sha512 = pick('sha512');
  const size = Number(pick('size') || '0');
  if (version === '') throw new Error(`上游 feed 无 version 字段：${url}`);
  if (artifact === '') throw new Error(`上游 feed 无 path/url 字段：${url}`);
  if (sha512 === '') throw new Error(`上游 feed 无 sha512 字段：${url}`);
  const expect = desktopInstallerName(version);
  const actual = artifact.split('/').pop() ?? '';
  if (actual !== expect) {
    throw new Error(`上游产物名与预期不符：期望 ${expect}，feed 给的是 ${actual}`);
  }
  return { version, url: artifact, sha512, size: Number.isFinite(size) ? size : 0, source: 'upstream-feed', verified: true };
}

// ---------- 取件：伞仓镜像兜底 ----------

/** 读伞仓 Release 的镜像资产（版本可能滞后于上游，但 GitHub 国内可达性/可追溯性更好）。 */
export async function readMirrorRelease(): Promise<DesktopRelease> {
  const rel = JSON.parse(await getText(mirrorAPI)) as {
    assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>;
  };
  const assets = rel.assets ?? [];
  const exeRe = /^deepseek-harness-(.+)-win-x64\.exe$/;
  const asset = assets.find((a) => typeof a.name === 'string' && exeRe.test(a.name));
  if (!asset?.name || !asset.browser_download_url) {
    throw new Error(`伞仓最新 Release 里没有镜像的桌面版安装包（${mirrorRepo}）`);
  }
  const version = exeRe.exec(asset.name)?.[1] ?? '';
  const sidecar = assets.find((a) => a.name === `${asset.name}.sha512`);
  if (!sidecar?.browser_download_url) {
    throw new Error(`镜像资产缺少 .sha512 副档：${asset.name}`);
  }
  const digest = (await getText(sidecar.browser_download_url)).trim().split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{128}$/i.test(digest)) throw new Error(`.sha512 副档格式不对：${digest.slice(0, 24)}…`);
  return {
    version,
    url: asset.browser_download_url,
    sha512: digest.toLowerCase(),
    size: typeof asset.size === 'number' ? asset.size : 0,
    source: 'mirror',
    verified: true,
  };
}

/**
 * 解析要安装的产物：`from` > 上游 feed > 伞仓镜像。
 * @param opts.from 显式来源（http(s) 或本地路径）
 * @param opts.version 期望版本；与取到的版本不符时报错（避免"以为装了新版")
 * @param opts.preferMirror 跳过上游 feed，直接走伞仓镜像
 */
export async function resolveDesktopRelease(
  opts: { from?: string; version?: string; preferMirror?: boolean } = {},
): Promise<DesktopRelease> {
  let rel: DesktopRelease;
  if (opts.from) {
    rel = await explicitRelease(opts.from, opts.version);
  } else if (opts.preferMirror) {
    rel = await readMirrorRelease();
  } else {
    try {
      rel = await readUpstreamFeed();
    } catch (e) {
      log.warn(`上游 feed 取件失败（${e instanceof Error ? e.message : String(e)}），回退伞仓镜像`);
      rel = await readMirrorRelease();
    }
  }
  if (opts.version && rel.version !== opts.version) {
    throw new Error(`取到的版本 ${rel.version} 与指定版本 ${opts.version} 不一致（来源 ${rel.source}）`);
  }
  return rel;
}

/** 显式来源：本地文件或有/无同名 `.sha512` 副档的 URL。 */
async function explicitRelease(from: string, version?: string): Promise<DesktopRelease> {
  const isURL = /^https?:\/\//i.test(from);
  let sha512 = '';
  if (!isURL) {
    const sidecar = `${from}.sha512`;
    if (existsSync(sidecar)) sha512 = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] ?? '';
  } else {
    try {
      sha512 = (await getText(`${from}.sha512`)).trim().split(/\s+/)[0] ?? '';
    } catch {
      sha512 = '';
    }
  }
  const name = from.split(/[\\/]/).pop() ?? '';
  const guessed = /^deepseek-harness-(.+)-win-x64\.exe$/.exec(name)?.[1] ?? '';
  if (version && guessed && version !== guessed) {
    throw new Error(`--version ${version} 与文件名推断的版本 ${guessed} 不一致（${name}）`);
  }
  const resolved = version ?? guessed;
  if (resolved === '') throw new Error(`无法从 ${name} 推断版本，请显式给 --version`);
  if (!/^[0-9a-f]{128}$/i.test(sha512) && !/^[A-Za-z0-9+/]{86}==$/.test(sha512)) {
    log.warn(`显式来源 ${name} 没有可用的 sha512 副档：跳过摘要校验（verified=false）`);
    return { version: resolved, url: from, sha512: '', size: 0, source: 'explicit', verified: false };
  }
  return { version: resolved, url: from, sha512, size: 0, source: 'explicit', verified: true };
}

// ---------- 下载 + 校验 ----------

/**
 * 下载安装包到缓存目录并校验摘要/字节数（流式，边下边算）。
 * @param rel 已解析的产物
 * @param onLog 进度输出（GUI/CLI 共用）
 * @returns 落盘后的绝对路径
 */
export async function downloadInstaller(rel: DesktopRelease, onLog?: (line: string) => void): Promise<string> {
  const dir = desktopCacheDir();
  mkdirSync(dir, { recursive: true });
  const name = desktopInstallerName(rel.version);
  const dest = join(dir, name);
  const staging = `${dest}.download-${Date.now()}`;
  const out = onLog ?? log.info;
  out(`桌面版 ${rel.version} ← ${rel.source}：${rel.url}`);

  const hash = createHash('sha512');
  let bytes = 0;
  try {
    // 流式计量：边下边算 sha512 与字节数（不把 ~275MB 读进内存）
    const counting = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        bytes += chunk.length;
        cb(null, chunk);
      },
    });
    if (/^https?:\/\//i.test(rel.url)) {
      const resp = await fetch(rel.url, { redirect: 'follow', headers: { 'User-Agent': 'dsh-launcher/desktop' } });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
      const body = resp.body as unknown as import('node:stream/web').ReadableStream;
      await pipeline(Readable.fromWeb(body), counting, createWriteStream(staging));
    } else {
      // 本地文件来源（离线 / 预置包 / 质量门）
      await pipeline(createReadStream(rel.url), counting, createWriteStream(staging));
    }
  } catch (e) {
    rmSync(staging, { force: true });
    throw new Error(`取件失败：${e instanceof Error ? e.message : String(e)}`);
  }

  const hex = hash.digest('hex');
  if (rel.sha512) {
    const expectHex = rel.sha512.length === 128
      ? rel.sha512.toLowerCase()
      : Buffer.from(rel.sha512, 'base64').toString('hex');
    if (hex !== expectHex) {
      rmSync(staging, { force: true });
      throw new Error(`sha512 校验失败（来源 ${rel.source}）：期望 ${expectHex} 实际 ${hex}`);
    }
    out(`sha512 ✓ ${hex}`);
  } else {
    out(`未校验摘要（显式来源无副档）：${desktopInstallerName(rel.version)} / ${bytes} 字节`);
  }
  if (rel.size > 0 && bytes !== rel.size) {
    rmSync(staging, { force: true });
    throw new Error(`字节数不符：声明 ${rel.size} 实际 ${bytes}`);
  }
  renameSync(staging, dest);
  out(`已就绪：${dest}`);
  return dest;
}

// ---------- 安装 ----------

/**
 * 拉起安装包：`silent` 时加 `/S`（assisted NSIS 静默，per-user 无需管理员；已实测）。
 * 非静默则**不等待**（交给向导，用户自己点）。
 * @returns 退出码；非静默返回 -1
 */
export async function runInstaller(exePath: string, opts: { silent: boolean } = { silent: true }): Promise<number> {
  if (process.platform !== 'win32') throw new Error('桌面版安装仅支持 Windows（上游只发 win-x64）');
  if (!existsSync(exePath)) throw new Error(`安装包不存在：${exePath}`);
  const args = opts.silent ? ['/S'] : [];
  if (!opts.silent) {
    const child = spawn(exePath, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return -1;
  }
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(exePath, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => reject(new Error(`拉起安装包失败：${e.message}`)));
    child.on('exit', (code) => resolve(code ?? -1));
  });
}

/** 安装后轮询注册项，等上游把 DisplayVersion 写上（最多 waitMs）。 */
async function waitInstalledVersion(expect: string, waitMs: number): Promise<string> {
  const stepMs = 2_000;
  for (let waited = 0; waited <= waitMs; waited += stepMs) {
    const v = installedDesktopVersion();
    if (v !== '' && (expect === '' || compare(v, expect) >= 0)) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return installedDesktopVersion();
}

/** 静默安装的整体上限（真机实测 20s~3min；这里只防「彻底卡死」）。 */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
/** 注册项已回报目标版本后，仍等安装包进程收尾的时间；超时即按「已装」结论走。 */
const INSTALL_SETTLE_MS = 60_000;
/** 轮询注册项 / 安装包退出的间隔。 */
const INSTALL_POLL_MS = 2_000;
/** 静默安装期间的心跳日志间隔（避免几分钟静默像卡死）。 */
const INSTALL_NOTE_MS = 30_000;

/**
 * 静默安装，并等一个**可确认的结果**（不再只看安装包退出码）。
 *
 * 真机实测（2026-09-28，`0.1.7-rc.2`）：`/S` 装完后安装包进程还会**驻留约 2~3 分钟**
 * 才退出 —— 旧实现「干等进程退出 → 再轮询注册项 120s」于是白等 4 分半，还在注册项口径
 * 有 bug 时误报「未确认」。现改为并行看两个信号：
 *   - 注册项回报 ≥ 目标版本 → 最多再等 {@link INSTALL_SETTLE_MS} 收尾，到点即判成功；
 *   - 安装包退出 → 按退出码判（非 0 返回该码，由调用方抛错）；
 *   - 全程超 {@link INSTALL_TIMEOUT_MS} 且注册项始终没回报 → 抛超时。
 * 期间每 {@link INSTALL_NOTE_MS} 打一次心跳日志。
 * @param exePath 已下载并校验过的安装包
 * @param expect 目标版本（注册项报告 ≥ 它才算装好）
 * @param out 日志输出
 * @returns 退出码（因滞留提前判成功时为 0）与读到的已装版本（可能为 ''）
 */
async function runSilentInstaller(
  exePath: string,
  expect: string,
  out: (line: string) => void,
): Promise<{ code: number; installed: string }> {
  const child = spawn(exePath, ['/S'], { stdio: 'ignore', windowsHide: true });
  child.unref(); // 安装包自行收尾，不拖住 launcher 退出
  let exited = false;
  let code = 0;
  let spawnError: Error | null = null;
  child.on('error', (e) => {
    spawnError = new Error(`拉起安装包失败：${e.message}`);
    exited = true;
  });
  child.on('exit', (c) => {
    exited = true;
    code = c ?? -1;
  });

  const start = Date.now();
  let confirmed = '';
  let confirmedAt = 0;
  let lastNote = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, INSTALL_POLL_MS));
    if (spawnError) throw spawnError;
    const v = installedDesktopVersion();
    if (v !== '' && (expect === '' || compare(v, expect) >= 0)) {
      confirmed = v;
      if (confirmedAt === 0) {
        confirmedAt = Date.now();
        out(`注册项已回报已装版本 ${v}${exited ? '' : `（安装包仍在收尾，最多再等 ${INSTALL_SETTLE_MS / 1000}s）`}`);
      }
    }
    const waited = Date.now() - start;
    if (exited) {
      if (code !== 0) return { code, installed: confirmed };
      // 退出码 0：若注册项还没回报，给它 30s 落定（安装收尾 / 卸载重写注册项）
      return { code: 0, installed: confirmed !== '' ? confirmed : await waitInstalledVersion(expect, 30_000) };
    }
    if (confirmedAt !== 0 && Date.now() - confirmedAt >= INSTALL_SETTLE_MS) {
      out('注册项已确认装好；安装包进程仍在后台收尾，按成功处理');
      return { code: 0, installed: confirmed };
    }
    if (waited >= INSTALL_TIMEOUT_MS) {
      if (confirmed !== '') return { code: 0, installed: confirmed };
      throw new Error(`安装包超过 ${INSTALL_TIMEOUT_MS / 60_000} 分钟仍未装好（注册项未回报版本）`);
    }
    if (waited - lastNote >= INSTALL_NOTE_MS) {
      lastNote = waited;
      out(`安装包仍在处理（已等 ${Math.round(waited / 1000)}s）……`);
    }
  }
}

/** installDesktop 的选项（GUI / CLI 共用）。 */
export interface InstallOptions {
  /** 显式来源：http(s) 或本地路径（离线 / 自测 / 预置包）。 */
  from?: string;
  /** 期望版本；与取到的不符即报错。 */
  version?: string;
  /** 跳过上游 feed，直接走伞仓镜像资产。 */
  preferMirror?: boolean;
  /** 静默安装（默认 true；上游 assisted NSIS 的 `/S`，2026-09-28 实测可用）。 */
  silent?: boolean;
  /** 只下载 + 校验，不安装（预检 / 质量门用）。 */
  dryRun?: boolean;
}

/**
 * 一步到位：解析 → 下载校验 → 安装 → 回读版本。
 * @param opts 见 InstallOptions
 * @param onLog 进度输出（默认走 launcher 日志 → SSE / 控制台）
 */
export async function installDesktop(
  opts: InstallOptions = {},
  onLog?: (line: string) => void,
): Promise<{ release: DesktopRelease; installer: string; installed: string }> {
  const out = onLog ?? log.info;
  const release = await resolveDesktopRelease(opts);
  const installer = await downloadInstaller(release, out);
  if (opts.dryRun) {
    out('dry-run：已下载校验，跳过安装');
    return { release, installer, installed: installedDesktopVersion() };
  }
  const silent = opts.silent !== false;
  out(`拉起安装包（${silent ? '/S 静默' : '向导'}）：${installer}`);
  if (!silent) {
    await runInstaller(installer, { silent: false });
    out('已打开安装向导，请在窗口中完成安装');
    return { release, installer, installed: installedDesktopVersion() };
  }
  const r = await runSilentInstaller(installer, release.version, out);
  if (r.code !== 0) throw new Error(`安装包退出码 ${r.code}`);
  const installed = r.installed !== '' ? r.installed : await waitInstalledVersion(release.version, 30_000);
  if (installed === '') {
    out(`安装包已结束，但卸载注册项里读不到 ${DESKTOP_PRODUCT_NAME} 的版本：请用「系统设置 → 应用」确认安装结果`);
  } else if (compare(installed, release.version) < 0) {
    out(`已装桌面版：${installed}（低于取件版本 ${release.version}，可能未完成覆盖安装）`);
  } else {
    out(`已装桌面版：${installed}`);
  }
  return { release, installer, installed };
}

/** desktopStatus 的选项。 */
export interface StatusOptions {
  /** 显式来源（http(s) 或本地路径）：用于校验预置包 / 离线场景。 */
  from?: string;
  /** 跳过上游 feed，直接走伞仓镜像资产。 */
  preferMirror?: boolean;
}

/** 汇总状态（UI chip / CLI status 用；取件失败不抛，走 error 字段）。 */
export async function desktopStatus(opts: StatusOptions = {}): Promise<DesktopStatus> {
  const supported = process.platform === 'win32';
  const installed = installedDesktopVersion();
  if (!supported) {
    return { supported: false, installed, latest: '', hasUpdate: false };
  }
  try {
    const release = await resolveDesktopRelease(opts);
    const pi = parseSemver(installed);
    const pl = parseSemver(release.version);
    return {
      supported,
      installed,
      latest: release.version,
      hasUpdate: pl ? (pi ? compareSemver(pl, pi) > 0 : true) : false,
      release,
    };
  } catch (e) {
    return { supported, installed, latest: '', hasUpdate: false, error: e instanceof Error ? e.message : String(e) };
  }
}
