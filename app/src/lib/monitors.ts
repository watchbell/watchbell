// Pure monitor rules shared by the collector, Sync and the Uptime page.
import { parsePath } from "@/lib/body-rule";
import type { CheckResult } from "@/lib/collector/http-check";
import { GRACES_S, MAX_HEARTBEATS, PERIODS_S } from "@/lib/heartbeat";
import { urlProblem } from "@/lib/net/public-host";
import { ago } from "@/lib/time";

// A monitor is checked only while its app is watched (`paused` is Sync's flag) and the owner hasn't paused it.
export function isChecked(m: { paused: boolean; ownerPaused: boolean }): boolean {
  return !m.paused && !m.ownerPaused;
}

// Sync resumes the monitors of watched apps, except the ones the owner paused on the Uptime page.
export function resumeIds(rows: { id: string; paused: boolean; ownerPaused: boolean }[]): string[] {
  return rows.filter((r) => r.paused && !r.ownerPaused).map((r) => r.id);
}

export const TIMEOUTS_S = [3, 5, 10] as const;

// A cap on cost, not a promise that every monitor is checked every minute. A run has 20 s with 6 checks in flight, so
// 20 monitors are 4 waves: at the 5 s default timeout the last wave can be cut short, and with 10 s timeouts a run
// gets through only about half of them. What a run skips is checked first by the next one (the collector takes the
// least recently checked first), so even when every site times out each monitor is checked every minute or two.
export const MAX_MONITORS = 20;

export type MonitorForm = { url: string; expectedStatus: string; timeoutS: string; bodyContains?: string; jsonPath?: string; jsonEquals?: string };
export type MonitorValues = {
  url: string; expectedStatus: number; timeoutMs: number; bodyContains: string | null; jsonPath: string | null; jsonEquals: string | null;
};

// Add/Edit monitor. Errors use the mockup's wording. Input may come from a crafted request, so nothing is assumed.
export function parseMonitorForm(
  f: { url?: unknown; expectedStatus?: unknown; timeoutS?: unknown; bodyContains?: unknown; jsonPath?: unknown; jsonEquals?: unknown } | null | undefined,
): { ok: true; value: MonitorValues } | { ok: false; fieldErrors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const rawUrl = String(f?.url ?? "").trim();
  let url: URL | null = null;
  try {
    url = new URL(rawUrl);
  } catch {
    url = null;
  }
  if (!url || !url.hostname || rawUrl.length > 2048 || urlProblem(url) === "scheme") {
    errors.url = "Enter a full https:// address.";
  } else if (urlProblem(url) === "blocked") {
    // The collector fetches this every minute: no private networks, no loopback, no odd ports (checked again at fetch time).
    errors.url = "Use a public https address.";
  }
  const code = String(f?.expectedStatus ?? "").trim();
  if (!/^[1-5]\d\d$/.test(code)) errors.expectedStatus = "Enter an HTTP status between 100 and 599.";
  const timeout = Number(f?.timeoutS);
  if (!(TIMEOUTS_S as readonly number[]).includes(timeout)) errors.timeoutS = "Pick a timeout.";
  // U2: a keyword or a JSON field, not both. The three are trimmed.
  const keyword = String(f?.bodyContains ?? "").trim();
  const path = String(f?.jsonPath ?? "").trim();
  const equals = String(f?.jsonEquals ?? "").trim();
  if (keyword.length > 200) errors.bodyContains = "Keep the keyword under 200 characters.";
  if (!path && equals) errors.jsonPath = "Add a JSON path for the value.";
  if (path) {
    if (path.length > 100 || !parsePath(path)) errors.jsonPath = "Use dots and [0] only, like checks.db or items[0].state.";
    else if (!equals) errors.jsonEquals = "Enter the value it must equal.";
    else if (equals.length > 200) errors.jsonEquals = "Keep the value under 200 characters.";
    if (keyword && !errors.bodyContains) errors.bodyContains = "Use either a keyword or a JSON field.";
  }
  if (Object.keys(errors).length || !url) return { ok: false, fieldErrors: errors };
  url.hash = "";
  return {
    ok: true,
    value: {
      url: url.toString(), expectedStatus: Number(code), timeoutMs: timeout * 1000,
      bodyContains: keyword || null, jsonPath: path || null, jsonEquals: path ? equals : null,
    },
  };
}

// U3: Add/Edit heartbeat. The name is what the Uptime row, the alert and the event show; it must have a letter or digit
// (its slug keys the row, one name per app) and no control or invisible characters. Period and grace come from the
// dialog's lists.
export type HeartbeatForm = { name: string; periodS: string; graceS: string };
export type HeartbeatValues = { name: string; periodS: number; graceS: number };
const NAME_MAX = 60;
// C0 and C1 controls and DEL.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// 5b final review M9: characters that reorder or hide text, so a name could disguise a job in a Telegram or email
// alert: the soft hyphen, the Arabic letter mark, zero-width space/joiners and LRM/RLM, the bidi embeddings and
// overrides (LRE…RLO), word joiner and invisible operators, the bidi isolates (LRI…PDI) and the BOM. Tested on the raw
// input, since whitespace folding would turn a BOM into a space.
const INVISIBLE = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

export function parseHeartbeatForm(
  f: { name?: unknown; periodS?: unknown; graceS?: unknown } | null | undefined,
): { ok: true; value: HeartbeatValues } | { ok: false; fieldErrors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const raw = String(f?.name ?? "");
  const name = raw.trim().replace(/\s+/g, " ");
  if (!/[\p{L}\p{N}]/u.test(name) || CONTROL.test(name) || INVISIBLE.test(raw)) errors.name = "Name the job, like backup job.";
  else if (name.length > NAME_MAX) errors.name = `Keep the name to ${NAME_MAX} characters.`;
  const periodS = Number(f?.periodS);
  if (!(PERIODS_S as readonly number[]).includes(periodS)) errors.periodS = "Pick how often the job runs.";
  const graceS = Number(f?.graceS);
  if (!(GRACES_S as readonly number[]).includes(graceS)) errors.graceS = "Pick a grace time.";
  if (Object.keys(errors).length) return { ok: false, fieldErrors: errors };
  return { ok: true, value: { name, periodS, graceS } };
}

// Heartbeats cost the collector one database row each a minute and no request, so they have their own cap, counted
// over every heartbeat row (paused ones too): resuming one then never needs a check.
export function heartbeatLimitBlock(count: number, adding = 1): string | null {
  return count + adding > MAX_HEARTBEATS ? `The console keeps at most ${MAX_HEARTBEATS} heartbeats. Delete one first.` : null;
}

// Sync over the cap (final review I3): the monitors that don't fit are left paused by the owner's flag, and the Sync
// result says how many apps that touched, in the same words as the cap itself.
export function overLimitText(apps: number): string | null {
  if (apps <= 0) return null;
  const one = apps === 1;
  return `${apps} app${one ? "" : "s"} ${one ? "is" : "are"} over the ${MAX_MONITORS}-monitor limit, so ${one ? "its monitor stays" : "their monitors stay"} paused. Pause or delete one, then resume ${one ? "it" : "them"} on Uptime.`;
}

export function limitBlock(activeCount: number, adding = 1): string | null {
  return activeCount + adding > MAX_MONITORS ? `The console checks at most ${MAX_MONITORS} monitors. Pause or delete one first.` : null;
}

// Sync gives every watched app without a monitor its default one again, so deleting the last monitor of a watched
// app would quietly undo itself at the next sync. Pausing it is how to stop its checks.
export function deleteBlock(m: { appWatched: boolean; monitorsOfApp: number }): string | null {
  return m.appWatched && m.monitorsOfApp <= 1 ? "This is the app's only monitor, and Sync would add it back. Pause it instead." : null;
}

// Editing what a monitor checks (address, expected status or body rule) starts its state afresh; a new timeout doesn't.
export function resetsState(before: MonitorValues, after: MonitorValues): boolean {
  return before.url !== after.url || before.expectedStatus !== after.expectedStatus || before.bodyContains !== after.bodyContains
    || before.jsonPath !== after.jsonPath || before.jsonEquals !== after.jsonEquals;
}

// The saved error of a check that got an answer but failed it (a missing keyword, a wrong JSON value, a body that didn't
// arrive). null for the plain cases the status already explains ("HTTP 502", no answer), so those keep their wording.
export function bodyFailure(m: { lastStatus: number | null; lastError?: string | null }): string | null {
  return m.lastStatus !== null && m.lastError && !/^HTTP \d{3}( · DEPLOYMENT_NOT_FOUND)?$/.test(m.lastError) ? m.lastError : null;
}

// Check now → toast. (A monitor checked in the last 50 s isn't fetched at all: lastResultMessage answers instead.)
export function checkNowMessage(r: CheckResult): string {
  return r.ok ? `Answered ${r.statusCode} in ${r.latencyMs} ms.` : `Failed: ${r.error ?? "no answer"}.`;
}

// Check now on a monitor the collector checked in the last 50 s: nothing is fetched, the last result is shown instead.
// A failure is worded from the saved last_error; rows from before it existed fall back to the status.
export function lastResultMessage(
  m: { lastCheckedAt: Date; lastStatus: number | null; lastLatencyMs: number | null; expectedStatus: number; lastError?: string | null },
  now: Date,
): string {
  const when = `Checked ${ago(m.lastCheckedAt, now)}`;
  if (m.lastError) return `${when}: failed (${m.lastError}).`;
  if (m.lastStatus !== m.expectedStatus) return `${when}: failed (${m.lastStatus === null ? "no answer" : `HTTP ${m.lastStatus}`}).`;
  return m.lastLatencyMs === null ? `${when}: ${m.lastStatus}.` : `${when}: ${m.lastStatus} in ${m.lastLatencyMs} ms.`;
}
