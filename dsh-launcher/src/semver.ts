// semver.ts —— 语义化版本比较（支持 v/V/dsh-v 前缀与 -prerelease，忽略 +build）。
// 供 node.ts（GitHub tag 排序）与 update.ts（升级检测）共用，避免循环依赖。

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string[]; // 预发布标识符（空 = 正式版）
}

/** 解析语义化版本：可选 dsh-v/v/V 前缀、major.minor.patch、可选 -prerelease，忽略 +build。 */
export function parseSemver(s: string): Semver | null {
  let v = s.trim();
  if (v.startsWith('dsh-')) v = v.slice(4);
  if (v.startsWith('v') || v.startsWith('V')) v = v.slice(1);
  const plus = v.indexOf('+');
  if (plus >= 0) v = v.slice(0, plus);
  const dash = v.indexOf('-');
  const main = dash >= 0 ? v.slice(0, dash) : v;
  const preStr = dash >= 0 ? v.slice(dash + 1) : '';
  const parts = main.split('.');
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  const pre = preStr ? preStr.split('.') : [];
  if (pre.some((id) => id === '')) return null;
  return { major: nums[0], minor: nums[1], patch: nums[2], pre };
}

/** 按 semver 规范比较：返回 -1（a<b）、0（a==b）、1（a>b）。正式版 > 预发布版。 */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return sign(a.major - b.major);
  if (a.minor !== b.minor) return sign(a.minor - b.minor);
  if (a.patch !== b.patch) return sign(a.patch - b.patch);
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const c = comparePreID(a.pre[i], b.pre[i]);
    if (c !== 0) return c;
  }
  return sign(a.pre.length - b.pre.length);
}

function sign(n: number): number {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

/** 比较两个预发布标识符：数字按数值、字母按 ASCII；数字 < 字母。 */
function comparePreID(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  const aIsNum = Number.isInteger(an) && /^\d+$/.test(a);
  const bIsNum = Number.isInteger(bn) && /^\d+$/.test(b);
  if (aIsNum && bIsNum) return sign(an - bn);
  if (aIsNum) return -1; // 数字 < 字母
  if (bIsNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
