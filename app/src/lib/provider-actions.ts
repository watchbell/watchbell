import { minutesText } from "@/lib/rate-limit";

// Stage 6: the shared, pure pieces of every provider action (spec §12). Server actions build an ActionOutcome and
// hand it to `finish` (lib/data/provider-action-db.ts), which audits it and records the account's write access.

export type ProviderName = "vercel" | "supabase" | "neon" | "cloudflare";

export type WriteFailure = {
  ok: false;
  kind: "auth" | "scope" | "missing" | "transient" | "format" | "busy";
  error: string;
  status?: number;
};

// `audit.message` is short, sanitised text (names and short ids only, never a token, URL query or provider body).
// A done outcome may carry its own `audit.detail` (slice 2: a DNS edit's "content a → b"); a failure's detail is its error.
export type ActionOutcome =
  | { done: true; message: string; audit: { message: string; resourceId: string; detail?: string } } // the provider accepted the write
  | { done: false; message: string } // a no-op or a refusal: no provider call was made, nothing is audited
  | { done: false; failed: WriteFailure; audit: { message: string; resourceId: string } };

export const STALE = "This changed since you opened it. Reload and try again.";
export const INVALID = "Something in that request wasn't valid.";

// A6: a token without write access gets one sentence, never the provider's body.
export function scopeMessage(p: ProviderName, ctx: { team?: string; project?: string }): string {
  if (p === "supabase") return "This token is read-only; replace it with one that has Project admin write.";
  if (p === "cloudflare") return "This Cloudflare token can't edit DNS; add \"Zone → DNS → Edit\" to it, or replace it with a token that has it.";
  if (p === "vercel") {
    return `This token can't change projects in team ${ctx.team || "this team"}; replace it with one whose scope includes that team.`;
  }
  return `This API key can't manage project ${ctx.project || "this project"}; replace it with a personal or organization key, or a key for this project.`;
}

// A4: the member quota (10 per 10 minutes) and the per-target cooldown (1 per minute).
export function cooldownText(which: "member" | "target", retryAfter: number): string {
  return which === "member"
    ? `Too many actions. Try again in ${minutesText(retryAfter)}.`
    : "That was just done. Wait a minute before trying again.";
}

// The provider's short reason for an audit `detail`: one line, at most 200 characters.
export function shortDetail(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
