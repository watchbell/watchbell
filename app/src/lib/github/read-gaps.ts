// 1.2.3: what the last GitHub sync couldn't read with the read-only token (403), kept per account in ops.settings so
// Connections can say so. Pure; github-db.ts reads and writes the setting.

export type ReadGaps = { at: string; actionsDenied: number; contentsDenied: number };

export const readGapsKey = (accountId: string) => `github.readGaps.${accountId}`;

export function parseReadGaps(v: unknown): ReadGaps | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
  if (typeof o.at !== "string") return null;
  return { at: o.at, actionsDenied: n(o.actionsDenied), contentsDenied: n(o.contentsDenied) };
}

const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const repos = (n: number) => `${n} repositor${n === 1 ? "y" : "ies"}`;

// One line for the account in Connections, or null when the last sync read everything. `actionsSince` is the last
// time an Actions status was read for a repository the token can't read any more (null when never).
export function readGapsText(gaps: ReadGaps | null, actionsSince: Date | null): string | null {
  if (!gaps) return null;
  const parts: string[] = [];
  if (gaps.actionsDenied) {
    parts.push(`Actions can't be read on ${repos(gaps.actionsDenied)}${actionsSince ? ` (last read ${day(actionsSince)})` : ""}: give the token Actions: Read.`);
  }
  if (gaps.contentsDenied) parts.push(`package.json can't be read on ${repos(gaps.contentsDenied)}: give the token Contents: Read.`);
  return parts.length ? parts.join(" ") : null;
}
