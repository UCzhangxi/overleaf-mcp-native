// Cookie persistence keyed by Overleaf host.
//
// macOS: the macOS Keychain (service "overleaf-mcp", account = Overleaf host), never on disk. The secret goes to
// `security -i` on stdin (hex-encoded), so it never appears in argv; it is read back with -w.
// Other platforms: a single JSON map at <configDir>/overleaf-mcp/cookie.json with mode 0600 (no encryption, see README).
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { logger } from "../util/logger.js";
import { injectedSessionMode, loadInjectedSession } from "./sessionFd.js";
import { execFile } from "node:child_process";

export interface StoredCookie {
  cookie: string;
  savedAt: number;
}

interface StoreShape {
  hosts: Record<string, StoredCookie>;
}

function configRoot(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

export function cookieFilePath(): string {
  return path.join(configRoot(), "overleaf-mcp", "cookie.json");
}

function hostKey(baseUrl: string): string {
  return new URL(baseUrl).host;
}

async function readStore(): Promise<StoreShape> {
  try {
    const raw = await fs.readFile(cookieFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    return { hosts: parsed.hosts ?? {} };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { hosts: {} };
    logger.warn(`cookie store unreadable, treating as empty: ${(err as Error).message}`);
    return { hosts: {} };
  }
}

async function writeStore(store: StoreShape): Promise<void> {
  const file = cookieFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}


const KEYCHAIN = process.platform === "darwin";
const SERVICE = process.env.OL_KEYCHAIN_SERVICE ?? "overleaf-mcp"; // no spaces
export const storeLabel = KEYCHAIN ? `macOS Keychain (service ${SERVICE})` : cookieFilePath();

function security(args: string[], input = ""): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = execFile("security", args, (err, out) => resolve({ code: err ? Number(err.code ?? 1) : 0, out }));
    p.stdin?.end(input);
  });
}

export async function loadStored(baseUrl: string): Promise<StoredCookie | null> {
  if (injectedSessionMode) return loadInjectedSession(baseUrl);
  if (KEYCHAIN) {
    const r = await security(["find-generic-password", "-s", SERVICE, "-a", hostKey(baseUrl), "-w"]);
    try { return r.code === 0 ? (JSON.parse(r.out.trim()) as StoredCookie) : null; } catch { return null; }
  }
  const store = await readStore();
  return store.hosts[hostKey(baseUrl)] ?? null;
}

export async function saveStored(baseUrl: string, cookie: string): Promise<void> {
  if (injectedSessionMode) throw new Error("Injected session cannot be saved to a cookie store.");
  if (KEYCHAIN) {
    const hex = Buffer.from(JSON.stringify({ cookie, savedAt: Date.now() })).toString("hex");
    await security(["-i"], `add-generic-password -U -s ${SERVICE} -a ${hostKey(baseUrl)} -X ${hex}\n`);
    if ((await loadStored(baseUrl))?.cookie !== cookie) throw new Error("could not save the cookie to the Keychain");
    return;
  }
  const store = await readStore();
  store.hosts[hostKey(baseUrl)] = { cookie, savedAt: Date.now() };
  await writeStore(store);
}

export async function clearStored(baseUrl: string): Promise<boolean> {
  if (injectedSessionMode) throw new Error("Injected session cannot access a cookie store.");
  if (KEYCHAIN) return (await security(["delete-generic-password", "-s", SERVICE, "-a", hostKey(baseUrl)])).code === 0;
  const store = await readStore();
  const key = hostKey(baseUrl);
  if (!(key in store.hosts)) return false;
  delete store.hosts[key];
  await writeStore(store);
  return true;
}
