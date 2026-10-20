import type { ApiKeyContext } from "@/private/auth/api-key";

// Shared AI gateway types (Task 1). Provider presets live in src/private/ai/providers (Task 3).
export type ProviderKind = "cloudflare" | "groq" | "openrouter" | "gemini" | "custom";
export const PROVIDER_KINDS = ["cloudflare", "groq", "openrouter", "gemini", "custom"] as const satisfies readonly ProviderKind[];

// "agent": a run of Antigravity on the owner's VM, reported over MCP report_usage (0021).
export type CallKind = "chat" | "models" | "mcp" | "status" | "me" | "console" | "agent";

export type UsageRecord = {
  at: Date; keyId: string | null; client: ApiKeyContext["client"] | null; providerId: string | null; model: string | null;
  kind: CallKind; tool: string | null; tokensIn: number | null; tokensOut: number | null; latencyMs: number; status: number;
  errorClass: string | null; stream: boolean;
  // 0021: cached-input and thinking tokens (agent runs only; left out = null).
  tokensCached?: number | null; tokensThinking?: number | null;
};

export type QuotaObservation = {
  providerId: string; scope: string; metric: string; limit: number | null; remaining: number | null; used: number | null;
  resetAt: Date | null; source: "header" | "own";
};

// Which models may WRITE through MCP (submit_ai_note, answer_question). Owner rulings 07:35 and 08:45: gemini*,
// antigravity*, @cf/google/gemma* and claude* (Claude models used inside Antigravity). The list is prefixes; the owner
// can override it in ops.settings under AI_ALLOWED_MODELS_SETTING (a JSON string array). The provider gateway keeps
// its own stricter lists (GATEWAY_MODEL_PREFIXES / CLOUDFLARE_MODEL_PREFIXES in providers/presets: no claude, there is
// no Anthropic provider).
export const AI_ALLOWED_MODELS_SETTING = "ai.allowedModels";
// The console's own default model (a public id such as "gemini/gemini-3.8-flash"), set on the Models page.
export const AI_DEFAULT_MODEL_SETTING = "ai.defaultModel";
export const AI_ALLOWED_MODELS_DEFAULT: readonly string[] = ["gemini", "antigravity", "@cf/google/gemma", "claude"];

// A model id as an agent reports it (report_models, report_usage, report_activity): lowercase letters, digits and
// @ / . _ -, at most 80 characters.
export const MODEL_ID_RE = /^[a-z0-9@/._-]{1,80}$/;

// Raw prefix match, case-insensitive, no normalisation (the gateway's routing uses it with its own lists).
export function isAllowedModel(model: string | null | undefined, allowed: readonly string[] = AI_ALLOWED_MODELS_DEFAULT): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return allowed.some((p) => p.length > 0 && m.startsWith(p.toLowerCase()));
}

const RAW_MODEL_RE = /^[A-Za-z0-9@._:/+ ()[\]-]{1,120}$/;
export const MODEL_RE = /^[a-z0-9@._:/+-]{1,120}$/;

// "Claude Opus 4.6 (Thinking)" → "claude-opus-4.6-thinking"; "Gemini 3.8 Flash" → "gemini-3.8-flash". Null when the
// value can't be a model name at all.
export function normalizeModel(model: unknown): string | null {
  if (typeof model !== "string") return null;
  const raw = model.trim();
  if (!RAW_MODEL_RE.test(raw)) return null;
  const m = raw.toLowerCase().replace(/[\s()[\]]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return MODEL_RE.test(m) ? m : null;
}

// "google/gemini-3.8-flash" → "gemini-3.8-flash"; "@cf/…" ids keep their slashes.
export function stripProvider(model: string): string {
  const m = model.trim();
  if (m.startsWith("@")) return m;
  const slash = m.indexOf("/");
  return slash < 0 ? m : m.slice(slash + 1);
}

// The final rule for agent-written content: normalise (lowercase, spaces/brackets → "-"), strip a provider/ prefix,
// then prefix-match. Returns the normalised model when allowed (that is what gets stored), else null.
export function allowedModel(model: unknown, allowed: readonly string[] = AI_ALLOWED_MODELS_DEFAULT): string | null {
  const m = normalizeModel(model);
  if (!m) return null;
  return isAllowedModel(stripProvider(m), allowed) ? m : null;
}

export type QuestionContextKind = "app" | "alert" | "general";
export type QuestionStatus = "pending" | "answered" | "expired";
// "office" (0023, owner 14 Oct): a Kantor Virtual question for the Manager, read only by the local Claude Code hook.
export type QuestionPurpose = "ask" | "ping" | "office";
export type NoteSeverity = "info" | "warn" | "crit";
