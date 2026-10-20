import type { ConsoleSnapshot } from "./types";

// `GET /api/v1/status?include=apps,monitors` (pure). Absent or empty = everything.
export const SECTIONS = ["apps", "monitors", "alerts", "advisor"] as const;
export type Section = (typeof SECTIONS)[number];

export function parseInclude(raw: string | null): { ok: true; include: Section[] } | { ok: false; error: string } {
  if (raw === null || raw.trim() === "") return { ok: true, include: [...SECTIONS] };
  const parts = raw.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const bad = parts.find((p) => !(SECTIONS as readonly string[]).includes(p));
  if (bad !== undefined) return { ok: false, error: `Unknown section "${bad.slice(0, 30)}". Use ${SECTIONS.join(", ")}.` };
  const include = SECTIONS.filter((s) => parts.includes(s));
  return include.length ? { ok: true, include } : { ok: true, include: [...SECTIONS] };
}

// The answer carries only the requested sections (the snapshot fills the others with empty values).
export function selectSections(s: ConsoleSnapshot, include: readonly Section[]): Partial<ConsoleSnapshot> & { generatedAt: string } {
  const out: Partial<ConsoleSnapshot> & { generatedAt: string } = { generatedAt: s.generatedAt };
  if (include.includes("apps")) out.apps = s.apps;
  if (include.includes("monitors")) out.monitors = s.monitors;
  if (include.includes("alerts")) out.alerts = s.alerts;
  if (include.includes("advisor")) out.advisor = s.advisor ?? [];
  return out;
}
