import { z } from "zod";
import type { State } from "@/lib/status";
import { longDate } from "@/lib/view/format";

// R1: end-of-life hints for the Next.js version the security check reads. endoflife.date API v1 (MIT project, no key,
// beta), fetched once a day by the collector's "eol" task and kept in ops.settings ("eol.nextjs"). A cycle is a major.
// A failure keeps yesterday's data; with none the line says "Unknown", never "supported".

export const EOL_URL = "https://endoflife.date/api/v1/products/nextjs/";
export const EOL_SETTINGS_KEY = "eol.nextjs";
export const EOL_WARN_DAYS = 60;
export type Cycle = { name: string; isEol: boolean; eolFrom: string | null; latest: string | null };
export type EolData = { cycles: Cycle[]; checkedAt: string };

const schema = z.object({ result: z.object({ releases: z.array(z.object({
  name: z.string(), isEol: z.boolean(), eolFrom: z.string().nullish(), latest: z.object({ name: z.string() }).nullish(),
})).min(1) }) });

export function parseEol(body: unknown): Cycle[] | null {
  const p = schema.safeParse(body);
  return p.success ? p.data.result.releases.map((r) => ({ name: r.name, isEol: r.isEol, eolFrom: r.eolFrom ?? null, latest: r.latest?.name ?? null })) : null;
}

export async function fetchNextCycles(opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<{ ok: true; cycles: Cycle[] } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(EOL_URL, { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 8000), cache: "no-store" });
  } catch {
    return { ok: false, error: "Couldn't reach endoflife.date" };
  }
  if (!res.ok) return { ok: false, error: `endoflife.date returned an error (${res.status})` };
  const cycles = parseEol(await res.json().catch(() => null));
  return cycles ? { ok: true, cycles } : { ok: false, error: "endoflife.date answered in a format the console doesn't recognise" };
}

const DAY = 86_400_000;

export function eolLine(version: string | null, data: EolData | null, now: Date): { state: State; text: string; note: string | null } {
  if (!version) return { state: "unknown", text: "Unknown until the version is read", note: null };
  if (!data) return { state: "unknown", text: "Unknown · endoflife.date hasn't been read yet", note: null };
  const major = version.split(".")[0];
  const cycle = data.cycles.find((c) => c.name === major);
  if (!cycle) return { state: "unknown", text: `Unknown · endoflife.date has no cycle ${major}`, note: null };
  const newest = data.cycles.find((c) => !c.isEol)?.latest ?? null;
  const latestNote = newest ? `latest is ${newest}` : null;
  const eol = cycle.eolFrom ? new Date(`${cycle.eolFrom}T00:00:00Z`) : null;
  if (cycle.isEol || (eol && eol.getTime() <= now.getTime())) {
    return { state: "err", text: `Next.js ${major} reached end of life${eol ? ` on ${longDate(eol)}` : ""}`, note: latestNote };
  }
  if (eol) {
    const days = Math.ceil((eol.getTime() - now.getTime()) / DAY);
    return { state: days <= EOL_WARN_DAYS ? "warn" : "ok", text: `Next.js ${major} reaches end of life on ${longDate(eol)} (in ${days} day${days === 1 ? "" : "s"})`, note: latestNote };
  }
  return { state: "ok", text: `Next.js ${major} is supported`, note: cycle.latest && cycle.latest !== version ? `${cycle.latest} is the latest ${major}.x` : null };
}
