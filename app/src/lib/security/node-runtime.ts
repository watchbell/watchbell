import {
  NODE_CHECK_EVERY_MS, NODE_EOL_URL, NODE_INDEX_URL, nodeVerdict, parseNodeEol, parseNodeIndex, storedNodeCycles, storedNodeIndex,
} from "../../../scripts/node-runtime.mjs";
import { readEnvNamed } from "@/lib/brand-env";
import type { State } from "@/lib/status";

// Watchbell 1.2.2 (D20): the Node.js runtime under Watchbell itself (owner item #20, CVE-2026-111497 "Node2Shell"). The
// verdict is the pure scripts/node-runtime.mjs, shared with the CLI; this side reads nodejs.org and endoflife.date for
// the collector's 12-hourly "node" task, keeps the result in ops.settings ("runtime.node"), and turns it into the
// Settings › Collector line for process.version (cloud: the Vercel function's runtime; self-host: the machine's Node).

export { NODE_CHECK_EVERY_MS, NODE_EOL_URL, NODE_INDEX_URL, nodeVerdict, parseNodeEol, parseNodeIndex };
export type NodeIndex = NonNullable<ReturnType<typeof parseNodeIndex>>;
export type NodeCycle = NonNullable<ReturnType<typeof parseNodeEol>>[number];

export const NODE_SETTINGS_KEY = "runtime.node";

// Fix round 1 (I1, coordinator ruling): WATCHBELL_NO_UPDATE_CHECK, the switch that turns off the CLI's update and
// runtime checks, also turns off the server's 12-hourly reads. Same reading as the CLI (bin/watchbell.mjs switchedOn):
// set and not 0/false/no/off. The old WATCHPOST_ name counts too, like every other setting.
export function nodeCheckOff(env: Record<string, string | undefined> = process.env): { off: boolean; name: string } {
  const set = readEnvNamed(env, "NO_UPDATE_CHECK");
  const v = set?.value.trim() ?? "";
  return { off: v !== "" && !/^(0|false|no|off)$/i.test(v), name: set?.name ?? "WATCHBELL_NO_UPDATE_CHECK" };
}
export const NODE_TIMEOUT_MS = 8_000;
// A nodejs.org read older than this (the 12-hourly task missed twice) no longer proves "ok".
export const NODE_FRESH_MS = 3 * NODE_CHECK_EVERY_MS;

// What the settings row holds. Each source keeps its last good data; `*Error` is the latest read's failure (null: it
// succeeded), `*CheckedAt` the time of the latest read, good or not.
export type NodeAdvisories = {
  index: NodeIndex | null; indexCheckedAt: string | null; indexError: string | null;
  cycles: NodeCycle[] | null; cyclesCheckedAt: string | null; cyclesError: string | null;
};
export type NodeRead = { index: NodeIndex | null; indexError: string | null; cycles: NodeCycle[] | null; cyclesError: string | null };

async function getJson(url: string, site: string, fetchFn: typeof fetch, timeoutMs: number): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  let res: Response;
  try {
    // Fix round 1 (M4): gzip only. Undici would otherwise offer br, and the advisory this check exists for (Node2Shell)
    // is in Node's Brotli decoder, so a vulnerable runtime shouldn't Brotli-decode the very lists that flag it.
    res = await fetchFn(url, {
      method: "GET", headers: { Accept: "application/json", "Accept-Encoding": "gzip" }, signal: AbortSignal.timeout(timeoutMs), cache: "no-store",
    });
  } catch {
    return { ok: false, error: `Couldn't reach ${site}` };
  }
  if (!res.ok) return { ok: false, error: `${site} returned an error (${res.status})` };
  try {
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false, error: `${site} answered in a format the console doesn't recognise` };
  }
}

// Both reads at once, each with the timeout. Never throws.
export async function fetchNodeAdvisories(opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<NodeRead> {
  const f = opts.fetch ?? fetch;
  const t = opts.timeoutMs ?? NODE_TIMEOUT_MS;
  const [ix, eol] = await Promise.all([getJson(NODE_INDEX_URL, "nodejs.org", f, t), getJson(NODE_EOL_URL, "endoflife.date", f, t)]);
  const index = ix.ok ? parseNodeIndex(ix.body) : null;
  const cycles = eol.ok ? parseNodeEol(eol.body) : null;
  const odd = (site: string) => `${site} answered in a format the console doesn't recognise`;
  return {
    index, indexError: ix.ok ? (index ? null : odd("nodejs.org")) : ix.error,
    cycles, cyclesError: eol.ok ? (cycles ? null : odd("endoflife.date")) : eol.error,
  };
}

// The row after a read: a failed source keeps its last good data and records the failure.
export function mergeNodeRead(prev: NodeAdvisories | null, read: NodeRead, now: Date): NodeAdvisories {
  const at = now.toISOString();
  return {
    index: read.index ?? prev?.index ?? null, indexCheckedAt: at, indexError: read.indexError,
    cycles: read.cycles ?? prev?.cycles ?? null, cyclesCheckedAt: at, cyclesError: read.cyclesError,
  };
}

const isoOrNull = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
const textOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

// The settings row as stored, checked again (a value this code didn't write never reads as good data).
export function parseNodeAdvisories(value: unknown): NodeAdvisories | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return {
    index: storedNodeIndex(v.index), indexCheckedAt: isoOrNull(v.indexCheckedAt), indexError: textOrNull(v.indexError),
    cycles: storedNodeCycles(v.cycles), cyclesCheckedAt: isoOrNull(v.cyclesCheckedAt), cyclesError: textOrNull(v.cyclesError),
  };
}

export type RuntimeLine = { state: State; text: string; note: string | null };

// Settings › Collector → Watchbell runtime. `version` is process.version of this server. `off`: nodeCheckOff().
export function runtimeLine(version: string, data: NodeAdvisories | null, now: Date, off: { off: boolean; name: string } = { off: false, name: "" }): RuntimeLine {
  if (off.off) return { state: "off", text: `Node ${version.replace(/^v/, "")}: check turned off (${off.name})`, note: null };
  const checkedAt = data?.indexCheckedAt ? Date.parse(data.indexCheckedAt) : null;
  const indexFresh = !!data?.index && !data.indexError && checkedAt !== null && checkedAt <= now.getTime() && now.getTime() - checkedAt < NODE_FRESH_MS;
  const v = nodeVerdict(version, { index: data?.index ?? null, indexFresh, cycles: data?.cycles ?? null }, now.getTime());
  const problems = [data?.indexError, data?.cyclesError].filter((e): e is string => !!e);
  return { state: v.state, text: v.text, note: problems.length ? `Last read: ${problems.join("; ")}` : null };
}
