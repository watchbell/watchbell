import type { DepSeverity } from "@/db/schema";
import type { FoundVuln } from "@/lib/deps/osv";

// Watchbell 1.4 pre-deploy check: the result of one run, its verdict, and the pull request comment. The comment starts
// with a marker carrying the counts as JSON, which is what the console's Pull requests card reads (./marker.ts).
// Warning only (owner, 4 Nov): nothing here fails a job. A secret's value is never read from gitleaks' report. Pure.

export type Secret = { rule: string; file: string; line: number; commit: string };
export type Part<T> = { ok: true; items: T } | { ok: false; reason: string };
export type EnvAdded = { example: string[]; code: string[] };
export type PrecheckResult = {
  sha: string; dir: string; packages: Part<FoundVuln[]>; secrets: Part<Secret[]>; next: { from: string | null; to: string | null }; env: Part<EnvAdded>;
  // Set when the base branch's lockfile is missing or unreadable, so every package was compared against nothing.
  baseNote?: string | null;
};
export type Verdict = "fix" | "check" | "ok";

export const MARKER = "<!-- watchbell-precheck";
export const SECRETS_MAX = 50;
export const BODY_MAX = 60_000;
const ROWS_MAX = 30;
const CUT = "\n\n…and more in the job summary.";

// What the marker carries; read back by ./marker.ts (kept apart so the bundled script doesn't carry zod).
export type Marker = {
  v: 1; sha: string; verdict: Verdict; at: string;
  counts: { critical: number; high: number; moderate: number; low: number; secrets: number; env: number };
};

export function parseGitleaks(text: string | null): Secret[] | null {
  if (!text) return null;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(j)) return null;
  const out: Secret[] = [];
  // One past the cap is kept so the comment can say "more than 50" (review, 1.4).
  for (const f of j.slice(0, SECRETS_MAX + 1)) {
    if (typeof f !== "object" || f === null) continue;
    const o = f as Record<string, unknown>;
    const rule = typeof o.RuleID === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(o.RuleID) ? o.RuleID : "unknown";
    const file = typeof o.File === "string" ? o.File.slice(0, 300) : "";
    const line = typeof o.StartLine === "number" && Number.isInteger(o.StartLine) && o.StartLine >= 0 ? o.StartLine : 0;
    const commit = typeof o.Commit === "string" && /^[0-9a-f]{7,40}$/.test(o.Commit) ? o.Commit.slice(0, 7) : "";
    out.push({ rule, file, line, commit });
  }
  return out;
}

const RANK: Record<DepSeverity, number> = { critical: 4, high: 3, moderate: 2, low: 1, unknown: 0 };

// One entry per package@version, at its worst advisory's severity.
function worstPerPackage(vulns: FoundVuln[]): Map<string, DepSeverity> {
  const by = new Map<string, DepSeverity>();
  for (const v of vulns) {
    const k = `${v.package}@${v.installedVersion}`;
    const had = by.get(k);
    if (!had || RANK[v.severity] > RANK[had]) by.set(k, v.severity);
  }
  return by;
}

function tally(r: PrecheckResult): Marker["counts"] {
  const c = { critical: 0, high: 0, moderate: 0, low: 0, secrets: 0, env: 0 };
  if (r.packages.ok) for (const s of worstPerPackage(r.packages.items).values()) c[s === "unknown" ? "low" : s]++;
  if (r.secrets.ok) c.secrets = Math.min(r.secrets.items.length, SECRETS_MAX);
  if (r.env.ok) c.env = r.env.items.example.length + r.env.items.code.length;
  return c;
}

export function verdictOf(r: PrecheckResult): Verdict {
  const c = tally(r);
  if (c.critical || c.high || c.secrets) return "fix";
  if (c.moderate || c.low || c.env || !r.packages.ok || !r.secrets.ok || !r.env.ok) return "check";
  return "ok";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function verdictLine(r: PrecheckResult): string {
  const verdict = verdictOf(r);
  if (verdict === "ok") return "**No new problems found.**";
  const sev = r.packages.ok ? [...worstPerPackage(r.packages.items).values()] : [];
  const n = (s: DepSeverity) => sev.filter((x) => x === s).length;
  const items: string[] = [];
  for (const s of ["critical", "high"] as const) if (n(s)) items.push(plural(n(s), `new ${s}-severity package`));
  const secrets = r.secrets.ok ? r.secrets.items.length : 0;
  if (secrets > SECRETS_MAX) items.push(`more than ${SECRETS_MAX} possible secrets`);
  else if (secrets) items.push(plural(secrets, "possible secret"));
  for (const s of ["moderate", "low"] as const) if (n(s)) items.push(plural(n(s), `new ${s}-severity package`));
  if (n("unknown")) items.push(plural(n("unknown"), "new package with an advisory of unknown severity", "new packages with advisories of unknown severity"));
  const env = r.env.ok ? r.env.items.example.length + r.env.items.code.length : 0;
  if (env) items.push(`${plural(env, "new env name")} to set on Vercel`);
  const skipped = [!r.packages.ok && "packages", !r.secrets.ok && "secrets", !r.env.ok && "env names"].filter(Boolean);
  if (skipped.length) items.push(`${skipped.join(", ")} not checked`);
  return `**${verdict === "fix" ? "Fix" : "Check"} before merging:** ${items.join(", ")}.`;
}

const code = (v: string) => `\`${v.replace(/[`\r\n]/g, "")}\``;

function packagesSection(p: Part<FoundVuln[]>): string[] {
  if (!p.ok) return [`Not checked: ${p.reason}`];
  if (!p.items.length) return ["No advisories on the packages this pull request adds or changes."];
  const rows = [...p.items].sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.package.localeCompare(b.package));
  const out = ["| Package | Version | Severity | Advisory | Fixed in |", "|---|---|---|---|---|"];
  for (const v of rows.slice(0, ROWS_MAX)) out.push(`| ${code(v.package)} | ${v.installedVersion} | ${v.severity} | ${v.vulnId} | ${v.fixedVersion ?? "no fix yet"} |`);
  if (rows.length > ROWS_MAX) out.push("", `…and ${rows.length - ROWS_MAX} more.`);
  return out;
}

function secretsSection(p: Part<Secret[]>): string[] {
  if (!p.ok) return [`Not checked: ${p.reason}`];
  if (!p.items.length) return ["None found in this pull request's commits."];
  return [
    ...p.items.slice(0, SECRETS_MAX).map((s) => `- ${code(s.file)} line ${s.line} (rule ${s.rule}${s.commit ? `, commit ${s.commit}` : ""})`),
    ...(p.items.length > SECRETS_MAX ? ["- …and more secrets than listed here."] : []),
    "",
    "Remove each one and rotate it: it stays in the branch's history even after a fix commit.",
  ];
}

function nextSection(n: PrecheckResult["next"]): string {
  if (!n.to) return n.from ? `Removed (was ${n.from}).` : "Not installed.";
  if (!n.from) return `${n.to} (new)`;
  return n.from !== n.to ? `${n.from} → ${n.to}` : `${n.to} (unchanged)`;
}

function envSection(p: Part<EnvAdded>): string[] {
  if (!p.ok) return [`Not checked: ${p.reason}`];
  const { example, code: inCode } = p.items;
  if (!example.length && !inCode.length) return ["None new."];
  const out: string[] = [];
  if (example.length) out.push(`- New in .env.example: ${example.map(code).join(", ")}`);
  if (inCode.length) out.push(`- Read in code but not in .env.example: ${inCode.map(code).join(", ")}`);
  out.push("", "Set them on Vercel (Production and Preview) before merging.");
  return out;
}

export function commentBody(r: PrecheckResult, at: Date): string {
  const marker: Marker = { v: 1, sha: r.sha, verdict: verdictOf(r), counts: tally(r), at: at.toISOString() };
  const body = [
    `${MARKER} ${JSON.stringify(marker)} -->`,
    "### Watchbell pre-deploy check",
    "",
    verdictLine(r),
    "",
    `**Packages**${r.dir !== "." ? ` (in ${code(r.dir)})` : ""}`,
    "",
    ...packagesSection(r.packages),
    ...(r.baseNote ? ["", r.baseNote] : []),
    "",
    "**Secrets**",
    "",
    ...secretsSection(r.secrets),
    "",
    `**Next.js:** ${nextSection(r.next)}`,
    "",
    "**Env names**",
    "",
    ...envSection(r.env),
    "",
    `Warning only: this check never blocks merging. Commit ${r.sha.slice(0, 7)}.`,
  ].join("\n");
  return body.length <= BODY_MAX ? body : body.slice(0, BODY_MAX - CUT.length) + CUT;
}
