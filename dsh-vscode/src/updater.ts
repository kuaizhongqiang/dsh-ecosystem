/**
 * dsh-vscode 优雅升级：查询 Open VSX 最新版本、比较版本、下载 vsix。
 *
 * 插件发布在 Open VSX（CI release 自动同步，见 package.json scripts.release），
 * Open VSX REST API 无需鉴权即可拿到最新版本与 vsix 直链：
 *   - 元数据：GET https://open-vsx.org/api/{publisher}.{name}
 *   - vsix 直链：GET https://open-vsx.org/api/{publisher}.{name}/{version}/file/{publisher}.{name}-{version}.vsix
 */

import { writeFile } from 'node:fs/promises'

export const OPEN_VSX_EXTENSION_ID = 'kuaizhongqiang.dsh-vscode'

/** Open VSX 扩展页（自动升级失败时的人工兜底下载入口）。 */
export const OPEN_VSX_EXTENSION_URL = 'https://open-vsx.org/extension/kuaizhongqiang.dsh-vscode'

export interface UpdateInfo {
  /** Open VSX 上的最新版本号。 */
  latest: string
  /** 对应版本的 vsix 下载直链。 */
  downloadUrl: string
}

/** 拼出某个版本的 Open VSX vsix 直链。 */
export function vsixDownloadUrl(version: string): string {
  return `https://open-vsx.org/api/${OPEN_VSX_EXTENSION_ID}/${encodeURIComponent(version)}/file/${OPEN_VSX_EXTENSION_ID}-${version}.vsix`
}

/** 查询 Open VSX 拿到最新版本与下载直链。网络失败 / 非 2xx / 缺 version 时抛错。 */
export async function fetchLatestFromOpenVsx(): Promise<UpdateInfo> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`https://open-vsx.org/api/${OPEN_VSX_EXTENSION_ID}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Open VSX 响应异常（HTTP ${response.status}）`)
    const json = (await response.json()) as { version?: string }
    const latest = json.version
    if (!latest) throw new Error('Open VSX 响应缺少 version 字段')
    return { latest, downloadUrl: vsixDownloadUrl(latest) }
  } finally {
    clearTimeout(timer)
  }
}

/** 语义化版本比较：a<b→-1、相等→0、a>b→1。忽略前导 v 与 prerelease/build 元数据。 */
export function compareVersions(a: string, b: string): number {
  const toParts = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((s) => Number.parseInt(s, 10) || 0)
  const pa = toParts(a)
  const pb = toParts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** 把远程 vsix 下载到本地路径 dest。 */
export async function downloadTo(url: string, dest: string): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`)
    const buffer = Buffer.from(await response.arrayBuffer())
    await writeFile(dest, buffer)
  } finally {
    clearTimeout(timer)
  }
}
