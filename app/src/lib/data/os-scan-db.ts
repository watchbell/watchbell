import "server-only";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { mode } from "@/lib/mode";
import { type HostDeps, type OsScan, scanHost } from "@/lib/os/scan";

// OS vulnerabilities (owner 12 Nov): the machine a self-hosted Watchbell runs on. One scan stored in ops.settings
// (key os_scan); the daily job and the owner's Scan now write it. A scan that fails keeps the last good findings
// and says when and why it failed. Read-only on the host: dpkg-query and apt list, no shell, nothing installed.

export type OsState = "off-cloud" | "demo" | "on";
export type StoredScan = OsScan & { failedAt?: string };

export const OFF_CLOUD = "OS checks are part of the self-hosted edition.";
const KEY = "os_scan";
const EXEC_TIMEOUT_MS = 30_000;

export function osState(env: Record<string, string | undefined> = process.env): OsState {
  const m = mode(env);
  return m === "cloud" ? "off-cloud" : m === "demo" ? "demo" : "on";
}

export function readStored(v: unknown): StoredScan | null {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Partial<StoredScan>;
  if (!["ok", "error", "unsupported"].includes(s.status ?? "") || typeof s.scannedAt !== "string" || !Array.isArray(s.updates) || typeof s.backlog !== "object") return null;
  return s as StoredScan;
}

export type OsScanDeps = {
  state(): OsState;
  scan(): Promise<OsScan>;
  read(): Promise<unknown>;
  write(v: StoredScan): Promise<void>;
};

const hostDeps: HostDeps = {
  platform: process.platform,
  readFile: (p) => readFile(p, "utf8").catch(() => null),
  mtime: (p) => stat(p).then((s) => s.mtime).catch(() => null),
  exec: (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (e, stdout) => {
      resolve(e ? { ok: false, error: (e as NodeJS.ErrnoException).code === "ENOENT" ? `${cmd} isn't installed` : e.message.split("\n")[0].slice(0, 160) } : { ok: true, stdout });
    });
  }),
};

const DEFAULT_DEPS: OsScanDeps = {
  state: () => osState(),
  scan: () => scanHost(hostDeps, fetch, new Date()),
  read: async () => (await db().select({ value: settings.value }).from(settings).where(eq(settings.key, KEY)).limit(1))[0]?.value ?? null,
  write: async (value) => {
    await db().insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  },
};

export async function loadOsScan(deps: OsScanDeps = DEFAULT_DEPS): Promise<StoredScan | null> {
  return readStored(await deps.read());
}

export async function runOsScan(deps: OsScanDeps = DEFAULT_DEPS): Promise<{ ok: true; data: StoredScan } | { ok: false; error: string }> {
  const s = deps.state();
  if (s === "off-cloud") return { ok: false, error: OFF_CLOUD };
  if (s === "demo") return { ok: false, error: "Scanning is off in the demo." };
  const next = await deps.scan();
  const prev = readStored(await deps.read());
  const value: StoredScan = next.status === "error" && prev && prev.status === "ok"
    ? { ...prev, error: next.error, failedAt: next.scannedAt }
    : next;
  await deps.write(value);
  return { ok: true, data: value };
}
