/**
 * 多帧 zstd 读取器。
 *
 * dsh 的会话日志是**多帧** zstd（每批 append/flush 一个独立帧，实测一个 5MB 日志 = 15,839 帧）。
 * Node 的 `zlib.zstdDecompress*` 只解第一帧，所以这里先按 RFC 8878 的帧结构**遍历出帧边界**，
 * 再逐帧解码，做到「一行不丢」。
 *
 * 帧结构：magic(4) → Frame_Header_Descriptor(1) → [Window_Descriptor(1)] →
 * [Dictionary_ID(0/1/2/4)] → [Frame_Content_Size(0/1/2/4/8)] → blocks... → [checksum(4)]
 */

import { zstdDecompressSync } from 'node:zlib'

const MAGIC = 0xfd2fb528 // 0x28 B5 2F FD（小端）
const DICT_ID_BYTES = [0, 1, 2, 4]
const FCS_BYTES = [0, 2, 4, 8]

/**
 * 遍历一个多帧 zstd buffer 的帧边界（不解码）。
 * @param buffer 整个文件内容
 * @returns `{ start, end, contentSize }[]`
 */
export function walkFrames(buffer) {
  const frames = []
  let p = 0
  while (p + 4 <= buffer.length) {
    if (buffer.readUInt32LE(p) !== MAGIC) {
      throw new Error(`zstd: 第 ${p} 字节不是帧头（${buffer.subarray(p, p + 4).toString('hex')}）`)
    }
    const start = p
    p += 4
    const descriptor = buffer[p]
    p += 1
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    if (!singleSegment) p += 1 // Window_Descriptor
    p += DICT_ID_BYTES[descriptor & 3]
    const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : FCS_BYTES[fcsFlag]
    let contentSize = 0
    if (fcsSize === 1) contentSize = buffer[p] + 256
    else if (fcsSize === 2) contentSize = buffer.readUInt16LE(p) + 256
    else if (fcsSize === 4) contentSize = buffer.readUInt32LE(p)
    else if (fcsSize === 8) contentSize = Number(buffer.readBigUInt64LE(p))
    p += fcsSize

    let last = false
    while (!last) {
      const header = buffer.readUIntLE(p, 3)
      p += 3
      last = (header & 1) === 1
      const blockType = (header >> 1) & 3
      const blockSize = header >> 3
      if (blockType === 0 || blockType === 2) p += blockSize // Raw / Compressed
      else if (blockType === 1) p += 1 // RLE：只有 1 字节内容
      else throw new Error(`zstd: 第 ${p} 字节处是保留块类型`)
    }
    if (checksum) p += 4
    frames.push({ start, end: p, contentSize })
  }
  if (p !== buffer.length) throw new Error(`zstd: 最后一帧之后还有 ${buffer.length - p} 字节`)
  return frames
}

/**
 * 解出一个多帧 zstd buffer 的明文（逐帧解码后拼接）。
 * @param buffer 整个文件内容
 * @returns 明文 buffer
 */
export function decompressFrames(buffer) {
  const frames = walkFrames(buffer)
  const parts = []
  for (const frame of frames) {
    parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(parts)
}

/**
 * 按帧边界切出「从第 N 帧起」的尾部内容 —— 增量读的锚点（帧天然就是检查点）。
 * @param buffer 整个文件内容
 * @param fromFrame 起始帧下标
 * @returns `{ text, nextFrame }`：从该帧起的明文，以及下一帧下标
 */
export function decompressFramesFrom(buffer, fromFrame) {
  const frames = walkFrames(buffer)
  const parts = []
  for (let index = fromFrame; index < frames.length; index += 1) {
    const frame = frames[index]
    parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
  }
  return { text: Buffer.concat(parts).toString('utf8'), nextFrame: frames.length, frameCount: frames.length }
}
