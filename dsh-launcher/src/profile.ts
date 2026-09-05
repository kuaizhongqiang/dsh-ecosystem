// profile.ts —— 个人层漫游（M4 / Phase 4）：`profile push|pull|export|import`。
//
// 设计落点（ECOSYSTEM-PLAN Phase 4）：
//   - 白名单同步（实测 ~0.21 MB）：settings.yaml、profiles/web/cordis.patch.yml、
//     profiles/web/plugins/、skills/、stock/watchlist.json、stock/reports/（可选但默认包含）
//   - 显式排除（可重建/机器绑定/敏感）：sessions/、profiles/node_modules/、
//     .dsh-module-fallback/、.dsh-memory-autostore-state.*、attachments/、storages/、
//     llm-deepseek/、.anonymous-user-id、stock/daily/、stock/kline-cache.json
//   - 红线（D2，永不进任何同步）：.credentials.yaml、launch-token.json、connections.json 及一切凭证 token 文件
//   - 加密三选一之 b：内置 AES-256-GCM + scrypt 口令加密容器（免外部 age 依赖），口令走
//     DSH_LAUNCHER_PROFILE_PASSWORD（或 --password）；默认形态 a：明文目录 pack（新机手填最安全）。

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { join, relative, resolve, dirname } from 'node:path';

import * as log from './log.js';
import { dshHome } from './tokenFile.js';

/** pack 格式版本。 */
export const PROFILE_PACK_FORMAT = 1;

/** 白名单条目：file=单个文件；dir=递归目录。 */
const ALLOW: Array<{ rel: string; file: boolean }> = [
  { rel: 'settings.yaml', file: true },
  { rel: 'profiles/web/cordis.patch.yml', file: true },
  { rel: 'profiles/web/plugins', file: false },
  { rel: 'skills', file: false },
  { rel: 'stock/watchlist.json', file: true },
  { rel: 'stock/reports', file: false },
];

/** 文件名红线（任一匹配即拒，D2 / 运行时文件）。 */
const DENY_NAMES = ['.credentials.yaml', 'launch-token.json', 'connections.json', '.anonymous-user-id'];

/** 目录/前缀红线（即使落在白名单目录内也剔除；可重建或机器绑定）。 */
const DENY_SEGMENTS = [
  'sessions',
  'attachments',
  'storages',
  'llm-deepseek',
  'node_modules',
  '.git',
  '.dsh-module-fallback',
  'daily',
];

const DENY_PREFIXES = ['.dsh-memory-autostore-state', 'kline-cache'];

/** pack 内元数据文件。 */
export const ProfileManifestName = 'profile-pack.json';

interface PackFile {
  rel: string;
  sha256: string;
  size: number;
}

export interface ProfilePackMeta {
  format: typeof PROFILE_PACK_FORMAT;
  createdAt: string;
  files: PackFile[];
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function isDeniedRel(rel: string): boolean {
  const segs = rel.split(/[\\/]/);
  const base = segs[segs.length - 1];
  if (DENY_NAMES.includes(base)) return true;
  for (const s of segs) if (DENY_SEGMENTS.includes(s)) return true;
  if (DENY_PREFIXES.some((p) => base.startsWith(p))) return true;
  return false;
}

function walkDir(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkDir(p, out);
    else if (e.isFile()) out.push(p);
  }
}

/** 收集本机 DSH_HOME 中待同步文件（白名单 ∩ 非排除）。exclude 为额外相对前缀剔除（如 stock/reports）。 */
export function collectProfileFiles(home: string, exclude: string[] = []): Array<{ rel: string; abs: string }> {
  const out: Array<{ rel: string; abs: string }> = [];
  for (const allow of ALLOW) {
    const abs = join(home, allow.rel);
    if (!existsSync(abs)) continue;
    if (allow.file) {
      if (!statSync(abs).isFile()) continue;
      const rel = relative(home, abs).replace(/\\/g, '/');
      if (!isDeniedRel(rel) && !exclude.some((x) => rel === x || rel.startsWith(x + '/'))) out.push({ rel, abs });
      continue;
    }
    const found: string[] = [];
    walkDir(abs, found);
    for (const p of found) {
      const rel = relative(home, p).replace(/\\/g, '/');
      if (!isDeniedRel(rel) && !exclude.some((x) => rel === x || rel.startsWith(x + '/'))) out.push({ rel, abs: p });
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

function readManifest(dir: string): ProfilePackMeta | undefined {
  try {
    const m = JSON.parse(readFileSync(join(dir, ProfileManifestName), 'utf8')) as ProfilePackMeta;
    return m.format === PROFILE_PACK_FORMAT ? m : undefined;
  } catch {
    return undefined;
  }
}

function writeManifest(dir: string, files: PackFile[]): void {
  const meta: ProfilePackMeta = { format: PROFILE_PACK_FORMAT, createdAt: new Date().toISOString(), files };
  writeFileSync(join(dir, ProfileManifestName), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

/**
 * `profile push`：把白名单文件镜像到 pack 目录（覆盖旧 pack 中已失效条目），
 * 并写 profile-pack.json（含每文件 sha256，供完整性核对）。
 */
export function pushProfilePack(packDir: string, exclude: string[] = []): ProfilePackMeta {
  const home = dshHome();
  if (!existsSync(home)) throw new Error(`DSH_HOME 不存在：${home}`);
  mkdirSync(packDir, { recursive: true });
  const files = collectProfileFiles(home, exclude);
  const old = readManifest(packDir);
  // 清理旧 pack 中本次未同步的条目（replace 语义）
  const newRels = new Set(files.map((f) => f.rel));
  for (const ofile of old?.files ?? []) {
    if (!newRels.has(ofile.rel)) rmSync(join(packDir, ofile.rel), { force: true });
  }
  const metaFiles: PackFile[] = [];
  for (const f of files) {
    const buf = readFileSync(f.abs);
    const dest = join(packDir, f.rel);
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFileSync(f.abs, dest);
    metaFiles.push({ rel: f.rel, sha256: sha256Hex(buf), size: buf.length });
  }
  writeManifest(packDir, metaFiles);
  log.info(`profile push：${files.length} 个文件 → ${packDir}（DSH_HOME=${home}）`);
  return readManifest(packDir)!;
}

/**
 * `profile pull`：按 pack 清单恢复到本机 DSH_HOME（红线文件即便出现在 pack 中也拒绝）。
 * 不清除本机多余文件（安全合并语义）。
 */
export function pullProfilePack(packDir: string): number {
  const home = dshHome();
  mkdirSync(home, { recursive: true });
  const meta = readManifest(packDir);
  if (!meta) throw new Error(`pack 目录缺少有效 ${ProfileManifestName}（先运行 profile push）`);
  let restored = 0;
  for (const f of meta.files) {
    if (isDeniedRel(f.rel)) {
      log.warn(`profile pull：跳过红线文件 ${f.rel}（D2）`);
      continue;
    }
    const src = join(packDir, f.rel);
    if (!existsSync(src)) {
      log.warn(`profile pull：pack 缺文件 ${f.rel}，跳过`);
      continue;
    }
    const buf = readFileSync(src);
    if (sha256Hex(buf) !== f.sha256) {
      throw new Error(`profile pull：${f.rel} sha256 与 pack 清单不符（pack 可能被篡改），中止`);
    }
    const dest = join(home, f.rel);
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFileSync(src, dest);
    restored++;
  }
  log.info(`profile pull：恢复 ${restored} 个文件 → ${home}`);
  return restored;
}

// ---------- 加密容器（AES-256-GCM + scrypt；免外部 age 依赖） ----------

const MAGIC = Buffer.from('DSHPP1', 'utf8'); // 6 字节魔数
const KDF_SALT = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32);
}

interface EncryptedEntry {
  rel: string;
  data: string; // base64
}

interface EncryptedBody {
  format: typeof PROFILE_PACK_FORMAT;
  createdAt: string;
  files: EncryptedEntry[];
}

/** 口令解析：--password > 环境变量；缺则抛错。 */
function resolvePassword(cliPassword?: string): string {
  const p = cliPassword ?? process.env.DSH_LAUNCHER_PROFILE_PASSWORD;
  if (!p) {
    throw new Error('缺少口令：请用 --password 或环境变量 DSH_LAUNCHER_PROFILE_PASSWORD（D2 红线：口令勿写进仓库/脚本）');
  }
  return p;
}

/**
 * `profile export`：白名单 → 加密单文件容器（AES-256-GCM，scrypt 派生密钥）。
 * 文件头：魔数 | salt(16) | iv(12) | authTag(16) | ciphertext。
 */
export function exportProfilePack(outFile: string, cliPassword?: string): void {
  const home = dshHome();
  const files = collectProfileFiles(home);
  const body: EncryptedBody = {
    format: PROFILE_PACK_FORMAT,
    createdAt: new Date().toISOString(),
    files: files.map((f) => ({ rel: f.rel, data: readFileSync(f.abs).toString('base64') })),
  };
  const password = resolvePassword(cliPassword);
  const salt = randomBytes(KDF_SALT);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(body), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([MAGIC, salt, iv, tag, ciphertext]);
  const outAbs = resolve(outFile);
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, out);
  log.info(`profile export：${files.length} 个文件已加密 → ${outAbs}`);
}

/**
 * `profile import`：解密容器并按清单恢复（红线校验与 pull 一致）。
 */
export function importProfilePack(inFile: string, cliPassword?: string): number {
  const buf = readFileSync(resolve(inFile));
  if (buf.length < MAGIC.length + KDF_SALT + IV_LEN + TAG_LEN || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(`${inFile} 不是 dsh profile 加密容器（魔数不符）`);
  }
  const password = resolvePassword(cliPassword);
  const salt = buf.subarray(MAGIC.length, MAGIC.length + KDF_SALT);
  const iv = buf.subarray(MAGIC.length + KDF_SALT, MAGIC.length + KDF_SALT + IV_LEN);
  const tag = buf.subarray(MAGIC.length + KDF_SALT + IV_LEN, MAGIC.length + KDF_SALT + IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(MAGIC.length + KDF_SALT + IV_LEN + TAG_LEN);
  const key = deriveKey(password, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('解密失败：口令错误或文件损坏');
  }
  const body = JSON.parse(plain.toString('utf8')) as EncryptedBody;
  if (body.format !== PROFILE_PACK_FORMAT) throw new Error(`加密容器格式不符：${body.format}`);
  const home = dshHome();
  mkdirSync(home, { recursive: true });
  let restored = 0;
  for (const f of body.files) {
    if (isDeniedRel(f.rel)) {
      log.warn(`profile import：跳过红线文件 ${f.rel}（D2）`);
      continue;
    }
    const dest = join(home, f.rel);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, Buffer.from(f.data, 'base64'));
    restored++;
  }
  log.info(`profile import：恢复 ${restored} 个文件 → ${home}`);
  return restored;
}
