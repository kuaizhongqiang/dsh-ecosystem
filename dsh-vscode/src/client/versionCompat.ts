/**
 * Embed seam version compatibility matrix (milestone #2 issue #23).
 *
 * The extension enables iframe embedding only against a server that advertises
 * the embed seam (`GET /api/embed/capability`). That advertisement carries the
 * seam protocol version; this module turns it into a compatibility verdict so a
 * version skew degrades with an explicit message instead of a broken panel.
 */

/** Lowest embed-seam protocol version this extension implements. */
export const MIN_EMBED_SEAM_VERSION = 1

/** Highest embed-seam protocol version verified against this extension. */
export const MAX_TESTED_EMBED_SEAM_VERSION = 1

export type EmbedCompatLevel = 'ok' | 'warn' | 'unsupported'

export interface EmbedCompatResult {
  level: EmbedCompatLevel
  message: string
}

export function checkEmbedCompat(seamVersion: number | undefined): EmbedCompatResult {
  if (seamVersion === undefined) {
    return { level: 'warn', message: '服务器声明了 embed seam 但未给出协议版本，按最低兼容处理' }
  }
  if (!Number.isFinite(seamVersion) || seamVersion < MIN_EMBED_SEAM_VERSION) {
    return {
      level: 'unsupported',
      message: `服务器 embed seam 版本 ${String(seamVersion)} 低于扩展支持的最低版本 ${String(MIN_EMBED_SEAM_VERSION)}：内嵌不可用，已降级为浏览器打开`,
    }
  }
  if (seamVersion > MAX_TESTED_EMBED_SEAM_VERSION) {
    return {
      level: 'warn',
      message: `服务器 embed seam 版本 ${String(seamVersion)} 高于本扩展已验证的 ${String(MAX_TESTED_EMBED_SEAM_VERSION)}：功能应可用，如遇异常请升级扩展`,
    }
  }
  return { level: 'ok', message: `embed seam v${String(seamVersion)} 与扩展兼容` }
}
