// webProfile.ts —— 保证 `profiles/web` 清单里 patchReload 不是 "live"（issue #52）。
//
// 背景：dsh 0.1.2-alpha.4 的 PROFILE_TEMPLATES 里**只有 web 是 `patchReload: "live"`**
// （acp / headless / sdk / sdk-minimal 都是 "startup"）。live 需要 Cordis HMR 服务，
// 纯 npm 安装布局里它起不来 → `watchUserPatches` 抛错并在 app 仍活跃时被重新抛出 →
// **全新 DSH_HOME 上 `dsh web` 启动即崩**（`user patch-layer watching requires the Cordis HMR service`）。
//
// 生产启动不需要 live 热重载，所以 launcher 在 spawn 之前把该字段显式落成 "startup"：
// 上游只在该字段**缺失**时才套模板默认，所以显式值不会被改回去。幂等、可重复调用。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** web profile 的 bundle 组合（与上游模板一致；仅在需要新建清单时写入）。 */
export const WEB_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

/** 上游允许的两个取值之一；我们固定用 startup。 */
export const WEB_PROFILE_PATCH_RELOAD = 'startup';

/** 结果：新建 / 修正 / 本来就对 / 读不出来（容错，不动它）。 */
export type WebProfileSeedResult = 'created' | 'patched' | 'ok' | 'skipped';

interface ProfileManifest {
  dsh?: {
    profile?: {
      bundles?: string[];
      patchReload?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** `%DSH_HOME%\profiles\web\package.json` 路径。 */
export function webProfileManifestPath(home: string): string {
  return join(home, 'profiles', 'web', 'package.json');
}

/**
 * 确保 web profile 清单存在且 `patchReload=startup`。
 * @param home DSH_HOME
 */
export function ensureWebProfileManifest(home: string): WebProfileSeedResult {
  const file = webProfileManifestPath(home);
  if (!existsSync(file)) {
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true });
    const created: ProfileManifest = {
      dsh: { profile: { bundles: [...WEB_PROFILE_BUNDLES], patchReload: WEB_PROFILE_PATCH_RELOAD } },
    };
    writeFileSync(file, `${JSON.stringify(created, null, 2)}\n`, 'utf8');
    return 'created';
  }

  const text = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 清单坏了不猜、不动（dsh 自己会处理/重建），只跳过
    return 'skipped';
  }
  if (parsed === null || typeof parsed !== 'object') return 'skipped';
  const manifest = parsed as ProfileManifest;

  const profile = manifest.dsh?.profile;
  if (profile === undefined) {
    manifest.dsh = {
      ...(manifest.dsh ?? {}),
      profile: { bundles: [...WEB_PROFILE_BUNDLES], patchReload: WEB_PROFILE_PATCH_RELOAD },
    };
  } else if (profile.patchReload !== WEB_PROFILE_PATCH_RELOAD) {
    profile.patchReload = WEB_PROFILE_PATCH_RELOAD;
  } else {
    return 'ok';
  }
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return 'patched';
}
