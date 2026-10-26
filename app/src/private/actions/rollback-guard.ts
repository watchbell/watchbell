import { isVersion } from "@/lib/deps/lockfile";
import { compareVersions } from "@/lib/security/semver";
import { clock, dayMonth, zoneLabel } from "@/lib/time";

// Watchbell 1.2.2 (D17, seen 24 Oct): a rollback proposal for a down or slow app only when the problem really follows
// a fresh deploy, and never back to a deployment whose Next.js has known advisories. Pure.
//   problemSince: when this problem started, counting the same rule's earlier episodes on the same check. HighLatency:
//     each one that resolved less than CHRONIC_GAP_MS before the next one began (days of flapping are one problem, not a
//     new one). MonitorDown (fix round 1, review I2): only one still open when the live deployment went live, or resolved
//     at most DOWN_NEAR_DEPLOY_MS before it, so an earlier, unrelated outage never hides a new bad deploy.
//   previousNext: the previous production deployment's Next.js status, from the Security card's check (ops.app_security:
//     one row per app, the latest check) and its transitions in Events (NextVulnerable / NextClean, written only when the
//     status changes, so the absence of one says the status stayed the same). A failed or unreadable check (error /
//     unknown) keeps the version and findings last read (security-db.ts save), and is judged by those (review C1); a site
//     that isn't Next.js at all has no Next.js advisory (review I1). "unknown" when it can't be told: such a rollback
//     still waits for the owner, says so in its reason, and never auto-runs.

export const CHRONIC_GAP_MS = 24 * 3_600_000;
export const DOWN_NEAR_DEPLOY_MS = 15 * 60_000;
export const ALERT_HISTORY_MS = 7 * 86_400_000; // how far back the episodes are read
// A previous deployment live for less than this may never have been checked (the check runs after each production
// deploy and every 6 hours), so the transitions say nothing about it.
export const PREVIOUS_CHECKED_MS = 3_600_000;
export const NEXT_EVENT_REASONS = ["NextVulnerable", "NextClean"] as const;
// lib/security/check.ts: the site answered and loads no /_next/ script at all.
export const NOT_NEXT_REASON = "not a Next.js site";
// Vercel's project framework presets that build with Next.js (resources.meta.framework).
const NEXT_FRAMEWORKS = new Set(["nextjs", "blitzjs"]);

type Episode = { startedAt: Date; resolvedAt: Date | null };

export function problemSince(startedAt: Date, history: readonly Episode[], o: { ruleKey?: string; liveAt?: Date | null; gapMs?: number } = {}): Date {
  let since = startedAt.getTime();
  const down = o.ruleKey === "MonitorDown";
  if (down && !o.liveAt) return startedAt;
  const near = o.liveAt ? o.liveAt.getTime() - DOWN_NEAR_DEPLOY_MS : 0;
  const gap = o.gapMs ?? CHRONIC_GAP_MS;
  for (const e of [...history].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())) {
    if (e.startedAt.getTime() >= since) continue;
    const linked = down ? e.resolvedAt === null || e.resolvedAt.getTime() >= near : e.resolvedAt === null || e.resolvedAt.getTime() >= since - gap;
    if (linked) since = e.startedAt.getTime();
  }
  return new Date(since);
}

export type NextStatus = "ok" | "vulnerable" | "unknown";
export type PreviousNext = { status: NextStatus; version: string | null };
export type NextCheck = { version: string | null; status: string; findings: readonly { fixed: string | null }[]; checkedAt: Date; reason?: string | null };
export type NextEvent = { at: Date; reason: string | null; message: string };

const UNKNOWN: PreviousNext = { status: "unknown", version: null };
const NOT_NEXT: PreviousNext = { status: "ok", version: null };
// securityEvent's messages (lib/security/rules.ts): "… runs Next.js 16.3.8 with …" / "… vulnerabilities (now 16.4.1)".
const VERSION = /(?:Next\.js|\(now) (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;
const versionIn = (message: string): string | null => {
  const v = VERSION.exec(message)?.[1] ?? null;
  return v && isVersion(v) ? v : null;
};
// A version below one of these advisories' fixes: conservatively affected (the advisory's lower bound isn't stored).
const affected = (version: string, findings: NextCheck["findings"]): boolean =>
  findings.some((f) => !!f.fixed && isVersion(f.fixed) && compareVersions(version, f.fixed) < 0);

const otherFramework = (framework: string | null | undefined): boolean => !!framework && !NEXT_FRAMEWORKS.has(framework);
// No Next.js version or advisory ever read (save keeps both through a failed check), and the row says it isn't a Next.js
// site, or Vercel builds the project with another framework (fix round 2, re-review I-1: a failed check writes its own
// reason, so after a broken deploy only the framework still tells).
const notNext = (c: NextCheck, framework: string | null | undefined): boolean =>
  c.version === null && !c.findings.length && c.status !== "vulnerable" && (c.reason === NOT_NEXT_REASON || otherFramework(framework));

// What one stored row says. ok / vulnerable as read; an error or unknown row by the version and findings it kept: any
// finding is vulnerable, a version without findings is ok. Not Next.js (notNext) is ok; anything else ("version not
// exposed" with no version kept, a redirect away, a failed check of a Next.js or unknown-framework app) is unknown.
export function judgeCheck(c: NextCheck, framework?: string | null): PreviousNext {
  if (c.status === "vulnerable" || c.findings.length) return { status: "vulnerable", version: c.version };
  if (c.status === "ok" || c.version) return { status: "ok", version: c.version };
  return notNext(c, framework) ? NOT_NEXT : UNKNOWN;
}

export function previousNext(i: {
  currentLiveAt: Date | null; previousLiveAt: Date | null; check: NextCheck | null; events: readonly NextEvent[]; framework?: string | null;
}): PreviousNext {
  const cur = i.currentLiveAt?.getTime();
  const prev = i.previousLiveAt?.getTime();
  const c = i.check;
  // Never checked: a project Vercel builds with another framework has no Next.js; otherwise nothing is known.
  if (!c) return otherFramework(i.framework) ? NOT_NEXT : UNKNOWN;
  // Not Next.js: no Next.js advisory, whatever the deploy times (re-review M-1: before the 1 h rule below).
  if (notNext(c, i.framework)) return NOT_NEXT;
  if (cur === undefined || prev === undefined || prev >= cur) return UNKNOWN;
  const t = c.checkedAt.getTime();
  // The stored check was made while the previous deployment was live: it is that deployment's.
  if (t >= prev && t < cur) return judgeCheck(c, i.framework);
  // No check since the previous deployment went live, or it was live too briefly to be sure one ran.
  if (t < prev || cur - prev < PREVIOUS_CHECKED_MS) return UNKNOWN;
  // The current deploy's check replaced the row. Every check between two transitions has the same status.
  const events = i.events.filter((e) => e.reason === "NextVulnerable" || e.reason === "NextClean");
  const before = events.filter((e) => e.at.getTime() < cur).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  const after = events.filter((e) => e.at.getTime() >= cur).sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  let out: PreviousNext;
  if (before) out = { status: before.reason === "NextVulnerable" ? "vulnerable" : "ok", version: before.at.getTime() >= prev ? versionIn(before.message) : null };
  else if (after) out = after.reason === "NextClean" ? { status: "vulnerable", version: null } : UNKNOWN; // new advisories: was it clean before?
  else out = { status: judgeCheck(c, i.framework).status, version: null }; // no transition: like this row (whose version may be the live one)
  // Advisories found since may concern the previous version too.
  if (out.status === "ok" && c.status !== "ok" && c.findings.length) {
    if (!out.version) return UNKNOWN;
    if (affected(out.version, c.findings)) return { status: "vulnerable", version: out.version };
  }
  return out;
}

const when = (d: Date) => `${dayMonth(d)} ${clock(d)} ${zoneLabel(d)}`;
const word = (ruleKey: string) => (ruleKey === "HighLatency" ? "Slow" : "Down");
const span = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 120 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
};

// The recheck's reason when no deploy action fits (≤ 130 characters). It started before the live deploy: not that
// deploy. It started after it and the deploy is older than the rollback window (review M1): said as such, with the
// by-hand way out. It started after it inside the window, so the reason is something else, such as no previous
// deployment to go back to (re-review M-2): only when it started.
export const notTiedNote = (ruleKey: string, since: Date, liveAt: Date | null, pastWindow = false): string => {
  if (!liveAt || since.getTime() < liveAt.getTime()) return `${word(ruleKey)} since ${when(since)}, not tied to a deploy${liveAt ? ` (live since ${when(liveAt)})` : ""}: check the app.`;
  const after = span(since.getTime() - liveAt.getTime());
  return pastWindow
    ? `${word(ruleKey)} since ${when(since)}, ${after} after the deploy went live, outside the rollback window: check the app or roll back by hand.`
    : `${word(ruleKey)} since ${when(since)}, started ${after} after the deploy went live: check the app.`;
};

export const vulnerableNote = (version: string | null): string => (version
  ? `No rollback: the previous deployment runs Next.js ${version}, which has known advisories.`
  : "No rollback: the previous deployment's Next.js has known advisories.");

export const UNKNOWN_NOTE = "Previous deployment's Next.js version is unknown: check it has no known advisories before approving.";
