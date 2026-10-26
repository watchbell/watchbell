// Watchbell 1.2.3 (owner 25 Oct: "how are updates announced?"): self-hosted, the console says when npm has a newer
// Watchbell, and once after an update, "What's new". The CLI hands the server its version (WATCHBELL_VERSION); the
// 12-hourly "node" task asks registry.npmjs.org for the latest (one plain GET, nothing about the user), unless
// WATCHBELL_NO_UPDATE_CHECK is set. Pure; collector/self-update.ts reads and writes the two settings rows.

export const LATEST_KEY = "watchbell.latest";
export const SEEN_KEY = "watchbell.seenVersion";
export const REGISTRY_LATEST_URL = "https://registry.npmjs.org/watchbell/latest";

const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
export const isVersion = (v: unknown): v is string => typeof v === "string" && SEMVER.test(v);

export function runningVersion(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.WATCHBELL_VERSION?.trim();
  return isVersion(v) ? v : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export type Latest = { version: string; checkedAt: string };
export const parseLatest = (v: unknown): Latest | null => {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return isVersion(o.version) && typeof o.checkedAt === "string" ? { version: o.version, checkedAt: o.checkedAt } : null;
};
export const parseSeen = (v: unknown): string | null => (v && typeof v === "object" && isVersion((v as Record<string, unknown>).version) ? (v as { version: string }).version : null);

export type UpdateNotice = { kind: "update"; running: string; latest: string } | { kind: "updated"; version: string } | null;

// What the owner's console shows: a newer version first; else, once after an update, What's new. The first install
// shows nothing (the task records it as seen).
export function updateNotice(i: { running: string | null; latest: Latest | null; seen: string | null }): UpdateNotice {
  if (!i.running) return null;
  if (i.latest && compareVersions(i.latest.version, i.running) > 0) return { kind: "update", running: i.running, latest: i.latest.version };
  if (i.seen && compareVersions(i.running, i.seen) > 0) return { kind: "updated", version: i.running };
  return null;
}

// The CHANGELOG section of a version on GitHub ("## 1.2.3" → #123).
export const whatsNewUrl = (version: string) => `https://github.com/watchbell/watchbell/blob/main/CHANGELOG.md#${version.replace(/\./g, "")}`;

// npm's answer for the latest version, or why not. Never throws.
export async function fetchLatestVersion(opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(REGISTRY_LATEST_URL, {
      method: "GET", headers: { Accept: "application/json", "Accept-Encoding": "gzip" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 6_000), cache: "no-store",
    });
  } catch {
    return { ok: false, error: "Couldn't reach registry.npmjs.org" };
  }
  if (!res.ok) return { ok: false, error: `registry.npmjs.org returned an error (${res.status})` };
  try {
    const body = (await res.json()) as { version?: unknown };
    return isVersion(body.version) ? { ok: true, version: body.version } : { ok: false, error: "registry.npmjs.org answered without a version" };
  } catch {
    return { ok: false, error: "registry.npmjs.org answered in a format the console doesn't recognise" };
  }
}
