// version.ts —— 版本号单一来源（package.json）。
// import attribute（type: json）：Node 直载 TS 源码（verify 脚本）也需要；esbuild 兼容。

import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
