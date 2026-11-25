// Optional launcher-owned session transport. Never consult a disk store or
// browser in this mode, including on macOS where XDG_CONFIG_HOME is ignored.
import { closeSync, fstatSync, readSync } from "node:fs";

const descriptor = process.env.OL_SESSION_FD;
export const injectedSessionMode = descriptor !== undefined;
let cached: { baseUrl: string; cookie: string; savedAt: number } | undefined;
let failure: Error | undefined;

export function rejectInjectedSession(): never {
  cached = undefined;
  failure = new Error("Injected session rejected or expired; refresh through the launcher. No browser/store fallback.");
  throw failure;
}

export function loadInjectedSession(baseUrl: string): { cookie: string; savedAt: number } {
  if (failure) throw failure;
  if (!cached) {
    let fd: number | undefined;
    try {
      if (!descriptor || !/^[0-9]+$/.test(descriptor)) throw new Error();
      const number = Number(descriptor);
      if (!Number.isSafeInteger(number) || number < 3 || number > 0x7fffffff) throw new Error();
      fd = number;
      const stat = fstatSync(fd);
      if (!stat.isFIFO() && !stat.isSocket()) throw new Error();
      const buffer = Buffer.alloc(16385);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > 16384) throw new Error();
      const value = JSON.parse(buffer.subarray(0, size).toString("utf8"));
      if (typeof value.baseUrl !== "string" || !/^https?:\/\//.test(value.baseUrl) ||
          new URL(value.baseUrl).origin !== value.baseUrl || typeof value.cookie !== "string" ||
          !/^[\x20-\x7e]+$/.test(value.cookie) || !value.cookie.trim()) throw new Error();
      cached = { baseUrl: value.baseUrl, cookie: value.cookie, savedAt: Date.now() };
    } catch {
      failure = new Error("Invalid injected session; no browser/store fallback.");
      throw failure;
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed/invalid */ } }
    }
  }
  if (new URL(baseUrl).origin !== cached.baseUrl) throw new Error("Injected session origin mismatch.");
  return { cookie: cached.cookie, savedAt: cached.savedAt };
}
