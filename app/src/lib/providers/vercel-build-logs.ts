// Task 4 build logs (owner 24 Oct): a deployment's build output, read server-side with the app's team id and the stored
// Vercel token (never sent to the browser). GET https://api.vercel.com/v3/deployments/{id}/events answers a list of
// events: stdout and stderr chunks, the commands Vercel runs, and step delimiters (other types are skipped). `builds=1`
// asks for the build output only, `direction=backward&limit=2000` for the newest events, which are sorted by their
// `created` time (stable, so either answer order works). A full page of 2,000 events means older ones may be missing, so
// the log is marked as cut even when it parses to 2,000 lines or fewer (review T4c, Important 2).
// Parsed defensively: an event we can't read is skipped, never thrown on. Not cached.
import { callJson, type FetchOpts, formatFailure, type Result } from "./http";
import { type BuildLine, type BuildLineKind, type BuildLog, capLines, MAX_BUILD_LINES } from "@/lib/view/build-logs";

const KINDS: readonly BuildLineKind[] = ["stdout", "stderr", "command", "delimiter"];
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function parseBuildEvents(raw: unknown): BuildLine[] | null {
  if (!Array.isArray(raw)) return null;
  const out: BuildLine[] = [];
  for (const item of raw) {
    const e = rec(item);
    if (!e || !(KINDS as readonly unknown[]).includes(e.type)) continue;
    const payload = rec(e.payload);
    const text = typeof payload?.text === "string" ? payload.text : typeof e.text === "string" ? e.text : null;
    if (text === null) continue;
    const created = typeof e.created === "number" ? e.created : typeof payload?.date === "number" ? payload.date : null;
    const parts = text.replace(ANSI, "").replace(/\r/g, "").split("\n");
    if (parts.length > 1 && parts.at(-1) === "") parts.pop();
    for (const p of parts) out.push({ at: created, kind: e.type as BuildLineKind, text: p });
  }
  return out;
}

export async function buildLogs(token: string, teamId: string, deploymentId: string, opts: FetchOpts = {}): Promise<Result<BuildLog>> {
  const q = new URLSearchParams({ teamId, builds: "1", direction: "backward", limit: String(MAX_BUILD_LINES) });
  const r = await callJson("Vercel", `https://api.vercel.com/v3/deployments/${encodeURIComponent(deploymentId)}/events?${q}`, { token }, { timeoutMs: 10_000, ...opts });
  if (!r.ok) return r;
  const lines = parseBuildEvents(r.data);
  if (!lines || !Array.isArray(r.data)) return formatFailure("Vercel", "the build log");
  // Events without a time keep their place relative to each other; with times, oldest first.
  const timed = lines.every((l) => l.at !== null);
  const ordered = timed ? lines.map((l, i) => ({ l, i })).sort((a, b) => a.l.at! - b.l.at! || a.i - b.i).map((x) => x.l) : [...lines].reverse();
  const cut = capLines(ordered);
  return { ok: true, data: { lines: cut.lines, truncated: cut.truncated || r.data.length >= MAX_BUILD_LINES } };
}
