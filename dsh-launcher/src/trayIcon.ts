// trayIcon.ts —— 托盘状态图标(M6):运行时生成透明底状态圆点 PNG,免随包资源文件。
// 状态语义与 GUI 状态点一致:dim=未运行 / green=运行中 / yellow=有更新 / red=异常。
//
// 视觉:实心色块在 Windows 托盘上易被误认「无图标/占位方块」(issue #21 附带反馈)。
// 改为 1px 透明边距 + 抗锯齿圆点(带 @2x 大图供高分屏),观感与 dsh 状态点一致。
//
// 契约:默认 16×16 RGBA PNG(verify-m6 校验 16×16/IHDR/raw 尺寸);size 可传 32 等。

import { deflateSync } from 'node:zlib';

export type TrayState = 'dim' | 'green' | 'yellow' | 'red';

const COLORS: Record<TrayState, [number, number, number]> = {
  dim: [140, 140, 140],
  green: [46, 204, 113],
  yellow: [241, 196, 15],
  red: [231, 76, 60],
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------- CRC32(PNG chunk 用) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * 圆点覆盖率(0..1):像素中心到圆心距离 < r-0.5 → 1,> r+0.5 → 0,中间线性过渡(≈1px 抗锯齿)。
 */
function coverage(px: number, py: number, cx: number, cy: number, r: number): number {
  const dx = px + 0.5 - cx;
  const dy = py + 0.5 - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  return Math.min(1, Math.max(0, r + 0.5 - d));
}

/** 生成 N×N RGBA PNG:透明底 + 居中抗锯齿状态圆点(1px 边距,免 8×8 以下糊成一团)。 */
export function trayPng(state: TrayState, size = 16): Buffer {
  const [r, g, b] = COLORS[state];
  const cx = size / 2;
  const cy = size / 2;
  // 边距 1px(小图标至少留白 1px,否则贴边发糊);极端小尺寸按比例收
  const margin = size >= 12 ? 1 : Math.max(0, Math.floor(size * 0.08));
  const radius = size / 2 - margin - 0.5;

  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const a = Math.round(coverage(x, y, cx, cy, radius) * 255);
      const o = rowStart + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
