// log.ts —— 统一日志：控制台 + %TEMP%\dsh-launcher.log + 订阅者（UI 推送）。
// 移植自 Go internal/log。日志行格式与 Go 版一致：`2026-08-21 12:00:00.000 [INFO] msg`。

import { openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { redactTokenUrl } from './tokenFile.js';

const subscribers: Array<(line: string) => void> = [];
let logFile: number | null = null;
let debugEnabled = false;

/** 日志文件路径：%TEMP%\dsh-launcher.log */
export function logPath(): string {
  return join(tmpdir(), 'dsh-launcher.log');
}

/** 以追加方式打开日志文件；失败仅降级为控制台输出。 */
export function initLog(): void {
  try {
    logFile = openSync(logPath(), 'a');
  } catch {
    logFile = null;
  }
}

export function setDebug(b: boolean): void {
  debugEnabled = b;
}

/** 注册日志行回调（每行含时间戳前缀与换行）。返回取消订阅函数。回调须非阻塞。 */
export function subscribe(fn: (line: string) => void): () => void {
  subscribers.push(fn);
  const i = subscribers.length - 1;
  return () => {
    subscribers.splice(i, 1);
  };
}

/** 无时间戳原样写入（--help 用）。 */
export function raw(text: string): void {
  try {
    process.stdout.write(text);
  } catch {
    /* GUI 子系统无控制台，忽略 */
  }
  if (logFile !== null) {
    try {
      writeSync(logFile, text);
    } catch {
      /* ignore */
    }
  }
}

function ts(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

function emit(level: string, msg: string): void {
  // M0/P1-6 日志脱敏:输出前统一替换 token 值(控制台/文件/UI 订阅者同源生效)
  const full = `${ts()} [${level}] ${redactTokenUrl(msg)}\n`;
  try {
    process.stdout.write(full);
  } catch {
    /* GUI 子系统无控制台 */
  }
  if (logFile !== null) {
    try {
      writeSync(logFile, full);
    } catch {
      /* ignore */
    }
  }
  // 锁外回调，避免与 subscribe 互相干扰
  for (const s of [...subscribers]) {
    try {
      s(full);
    } catch {
      /* 订阅者异常不影响日志 */
    }
  }
}

export function info(msg: string): void {
  emit('INFO', msg);
}
export function warn(msg: string): void {
  emit('WARN', msg);
}
export function error(msg: string): void {
  emit('ERROR', msg);
}
export function debug(msg: string): void {
  if (debugEnabled) emit('DEBUG', msg);
}

/** 关闭日志文件（进程退出前）。 */
export function closeLog(): void {
  if (logFile !== null) {
    try {
      closeSync(logFile);
    } catch {
      /* ignore */
    }
    logFile = null;
  }
}
