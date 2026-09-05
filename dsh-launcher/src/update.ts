// update.ts —— 升级检测，覆盖两条独立的分发渠道：
//   - dsh 本体：GitHub 源码源查仓库最新 tag（source='github'，默认）；
//     或 npm registry 查 latest dist-tag（source='npm'）。
//   - dsh-launcher 走 GitHub Release，检测仓库最新 tag。
// 本模块只做"检测"，不执行升级。移植自 Go internal/update。

import { compareSemver, parseSemver } from './semver.js';
import * as node from './node.js';

/** 启动器 GitHub Release 最新版页面（升级启动器时打开）。 */
export const LauncherReleaseURL = 'https://github.com/kuaizhongqiang/dsh-launcher/releases/latest';
const launcherAPI = 'https://api.github.com/repos/kuaizhongqiang/dsh-launcher/releases/latest';
const httpTimeoutMs = 10_000;

// ---------- 检测 ----------

/** 检测启动器自身（GitHub Release 最新 tag）是否有新版。current 为 dev 时跳过。 */
export async function checkLauncher(current: string): Promise<{ latest: string; hasUpdate: boolean }> {
  if (!current || current === 'dev') {
    throw new Error('当前为 dev 构建，跳过启动器升级检测');
  }
  const cur = parseSemver(current);
  if (!cur) throw new Error(`当前版本 "${current}" 无法解析`);
  const rel = await getJSON<{ tag_name?: string; html_url?: string }>(launcherAPI);
  const tag = rel.tag_name ?? '';
  const lat = parseSemver(tag);
  if (!lat) throw new Error(`最新 Release 版本 "${tag}" 无法解析`);
  return { latest: tag, hasUpdate: compareSemver(lat, cur) > 0 };
}

/** 检测 dsh 是否有新版：github 源查仓库最新 tag（默认）；npm 源查 registry latest。 */
export async function checkDsh(
  current: string,
  spec: node.RegistrySpec,
  opts: { source?: node.DshSource; proxy?: string } = {},
): Promise<{ latest: string; hasUpdate: boolean }> {
  const cur = parseSemver(current);
  if (!cur) throw new Error(`当前版本 "${current}" 无法解析`);

  // GitHub 源码源：git ls-remote 取最新 dsh tag（走 git 代理）
  if (opts.source === 'github') {
    const latest = await node.latestDshTag(opts.proxy);
    const lat = parseSemver(latest);
    if (!lat) throw new Error(`最新 tag "${latest}" 无法解析`);
    return { latest, hasUpdate: compareSemver(lat, cur) > 0 };
  }

  // npm registry 源
  const { primary, mirror } = node.specEffective(spec);
  const registries = [primary];
  if (!spec.preferMirror && !spec.disableAutoSwitch && mirror !== primary) {
    registries.push(mirror);
  }
  let firstErr: Error | null = null;
  let lastErr: Error | null = null;
  for (const reg of registries) {
    try {
      const v = await dshLatest(reg);
      const lat = parseSemver(v);
      if (!lat) throw new Error(`最新版本 "${v}" 无法解析`);
      return { latest: v, hasUpdate: compareSemver(lat, cur) > 0 };
    } catch (e) {
      if (!firstErr) firstErr = e as Error;
      lastErr = e as Error;
    }
  }
  if (firstErr && lastErr && firstErr !== lastErr) {
    throw new Error(`主源与镜像均查询失败：主源 ${firstErr.message}；镜像 ${lastErr.message}`);
  }
  throw lastErr ?? new Error('查询失败');
}

/** 查询某个 registry 上 @deepseek-ai/dsh 的 latest dist-tag 版本。 */
async function dshLatest(registry: string): Promise<string> {
  const base = registry.replace(/\/+$/, '');
  const url = `${base}/@deepseek-ai/dsh/latest`;
  const p = await getJSON<{ version?: string }>(url);
  if (!p.version) throw new Error(`${url} 未返回 version 字段`);
  return p.version;
}

/** 请求 JSON 接口并解码。GitHub API 拒绝无 User-Agent 的请求（403）。 */
async function getJSON<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), httpTimeoutMs);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'dsh-launcher/update-check', Accept: 'application/json' },
    });
    if (resp.status !== 200) {
      throw new Error(`HTTP ${resp.status}（${url}）`);
    }
    return (await resp.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
