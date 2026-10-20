import { MODEL_ID_RE, stripProvider } from "./types";
import type { CallRecord } from "./usage";

// Antigravity's own runs on the owner's VM (owner 13 Oct, Usage & Analytics). The VM reports every `agy -p` run over
// MCP (report_usage: the official `--output-format json` usage block) and what is running right now (report_activity).
// Pure: mapping a run to an ai_usage row, the ops.settings values (activity, the owner's quota estimates) and the
// quota bars. No DB and no "server-only" (type-only imports), so client code may import the types.

export const AG_ACTIVITY_SETTING = "antigravity.activity";
export const AG_LIMITS_SETTING = "antigravity.limits";
// A run that started longer ago than this is stale: the VM died or forgot to report the end.
export const ACTIVITY_STALE_MS = 15 * 60_000;
export const RUN_MAX_AGE_MS = 24 * 3_600_000;
// Clock skew between the VM and Watchbell that still counts as "now".
export const RUN_SKEW_MS = 60_000;
export const RUN_PURPOSES = ["ask", "ping", "advisor"] as const;
export const RUN_STATUSES = ["ok", "error", "limit"] as const;
export const MAX_RUN_TOKENS = 10_000_000;
export const MAX_RUN_MS = 3_600_000;
export const MAX_RUNS = 20;
export const MAX_RUN_QUESTIONS = 20;

export type RunPurpose = (typeof RUN_PURPOSES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type AgentRun = {
  model: string; purpose: RunPurpose; status: RunStatus; inputTokens: number; cachedTokens: number; outputTokens: number; thinkingTokens: number;
  durationMs: number; at?: string; questions?: number;
};

const STATUS_CODE: Record<RunStatus, { status: number; errorClass: string | null }> = {
  ok: { status: 200, errorClass: null },
  error: { status: 500, errorClass: "agent_error" },
  limit: { status: 429, errorClass: "quota" },
};

// Null when the run's time is acceptable: not in the future (a minute of skew is fine) and at most 24 h old.
export function runTimeProblem(at: string | undefined, now: Date): string | null {
  if (at === undefined) return null;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return "at must be an ISO 8601 date-time";
  if (t > now.getTime() + RUN_SKEW_MS) return "at is in the future";
  if (t < now.getTime() - RUN_MAX_AGE_MS) return "at is older than 24 h; leave such runs out";
  return null;
}

// One ai_usage row (kind 'agent') of the calling key and its detected client; tool = the purpose.
export function runRecord(run: AgentRun, key: { keyId: string; client: CallRecord["client"] }, now: Date): CallRecord {
  const { status, errorClass } = STATUS_CODE[run.status];
  return {
    at: run.at ? new Date(run.at) : now, keyId: key.keyId, client: key.client, providerId: null, model: run.model, kind: "agent", tool: run.purpose,
    tokensIn: run.inputTokens, tokensCached: run.cachedTokens, tokensOut: run.outputTokens, tokensThinking: run.thinkingTokens,
    latencyMs: run.durationMs, status, errorClass, stream: false,
  };
}

// ---- What is running now (report_activity) ----

export type AgRunning = { model: string; purpose: RunPurpose; startedAt: string; questions?: number };
export type AgActivity = { running: AgRunning | null; updatedAt: string };

const validDate = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

// The stored value, or null when there is none. A run older than 15 minutes (or unreadable) reads as idle.
export function parseActivity(value: unknown, now: Date): AgActivity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!validDate(v.updatedAt)) return null;
  const r = (v.running ?? null) as Record<string, unknown> | null;
  let running: AgRunning | null = null;
  if (r && typeof r === "object" && typeof r.model === "string" && MODEL_ID_RE.test(r.model) && RUN_PURPOSES.includes(r.purpose as RunPurpose)
    && validDate(r.startedAt) && now.getTime() - Date.parse(r.startedAt) <= ACTIVITY_STALE_MS) {
    running = { model: r.model, purpose: r.purpose as RunPurpose, startedAt: r.startedAt };
    if (Number.isInteger(r.questions) && (r.questions as number) >= 0) running.questions = r.questions as number;
  }
  return { running, updatedAt: v.updatedAt };
}

// ---- The owner's quota estimates (Usage page) ----

export type Family = "gemini" | "claude";
export function modelFamily(model: string | null | undefined): Family | null {
  if (!model) return null;
  const m = stripProvider(model.startsWith("ag/") ? model.slice(3) : model).toLowerCase();
  if (m.startsWith("gemini")) return "gemini";
  if (m.startsWith("claude")) return "claude";
  return null;
}

export type AgLimitKey = "gemini5h" | "geminiWeek" | "claude5h" | "claudeWeek";
export type AgLimits = Record<AgLimitKey, number | null>;
export const LIMIT_FIELDS: { key: AgLimitKey; label: string; family: Family; windowMs: number; window: string }[] = [
  { key: "gemini5h", label: "Gemini · 5 h", family: "gemini", windowMs: 5 * 3_600_000, window: "5 h" },
  { key: "geminiWeek", label: "Gemini · week", family: "gemini", windowMs: 7 * 86_400_000, window: "7 days" },
  { key: "claude5h", label: "Claude · 5 h", family: "claude", windowMs: 5 * 3_600_000, window: "5 h" },
  { key: "claudeWeek", label: "Claude · week", family: "claude", windowMs: 7 * 86_400_000, window: "7 days" },
];
export const MAX_LIMIT = 1_000_000_000_000;
export const EMPTY_LIMITS: AgLimits = { gemini5h: null, geminiWeek: null, claude5h: null, claudeWeek: null };

const positiveInt = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= MAX_LIMIT ? (v as number) : null);

export function parseLimits(value: unknown): AgLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_LIMITS };
  const v = value as Record<string, unknown>;
  return { gemini5h: positiveInt(v.gemini5h), geminiWeek: positiveInt(v.geminiWeek), claude5h: positiveInt(v.claude5h), claudeWeek: positiveInt(v.claudeWeek) };
}

// A form field: blank = no limit; digits with , . _ or space separators; 1 … 10^12.
export function parseLimitInput(raw: unknown): { ok: true; value: number | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const s = raw.trim();
  if (!s) return { ok: true, value: null };
  if (!/^\d{1,3}([,._ ]?\d{3})*$|^\d+$/.test(s)) return { ok: false };
  const n = Number(s.replace(/[,._ ]/g, ""));
  const value = positiveInt(n);
  return value === null ? { ok: false } : { ok: true, value };
}

export type AgentTokenRow = {
  at: Date; model: string | null; tokensIn: number | null; tokensCached: number | null; tokensOut: number | null; tokensThinking: number | null;
};
export type LimitBar = {
  key: AgLimitKey; label: string; family: Family; window: string; limit: number | null; used: number; remaining: number | null;
  pct: number | null; runs: number; resetsAt: Date | null;
};

// What counts against a limit: new input + output + thinking (cached input excluded).
export const countedTokens = (r: Pick<AgentTokenRow, "tokensIn" | "tokensOut" | "tokensThinking">): number =>
  (r.tokensIn ?? 0) + (r.tokensOut ?? 0) + (r.tokensThinking ?? 0);

export function limitBars(rows: AgentTokenRow[], limits: AgLimits, now: Date): LimitBar[] {
  return LIMIT_FIELDS.map((f) => {
    const since = now.getTime() - f.windowMs;
    const inside = rows.filter((r) => modelFamily(r.model) === f.family && r.at.getTime() > since && r.at.getTime() <= now.getTime() + RUN_SKEW_MS);
    const used = inside.reduce((s, r) => s + countedTokens(r), 0);
    const oldest = inside.reduce<number | null>((m, r) => (m === null || r.at.getTime() < m ? r.at.getTime() : m), null);
    const limit = limits[f.key];
    return {
      key: f.key, label: f.label, family: f.family, window: f.window, limit, used,
      remaining: limit === null ? null : Math.max(0, limit - used),
      pct: limit === null ? null : Math.min(100, Math.round((used / limit) * 100)),
      runs: inside.length, resetsAt: oldest === null ? null : new Date(oldest + f.windowMs),
    };
  });
}
