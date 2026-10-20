import { DEMO_UNAVAILABLE } from "@/lib/demo/simulate";
import { isDemo } from "@/lib/mode";
import type { SendResult } from "./telegram";

// Discord webhooks (docs.discord.com/developers/resources/webhook): the URL is the secret; only Discord's own hosts are
// accepted, so a pasted URL can't make the console post anywhere else.
const HOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,}$/;

export function webhookProblem(url: string): string | null {
  return HOOK.test(url.trim()) ? null : "Paste the whole webhook URL from Discord.";
}

export async function sendDiscord(url: string, content: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<SendResult> {
  if (isDemo()) return { ok: false, kind: "config", error: DEMO_UNAVAILABLE }; // the demo never posts anywhere
  if (webhookProblem(url)) return { ok: false, kind: "config", error: "The saved Discord webhook URL isn't valid." };
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 5000), cache: "no-store",
      body: JSON.stringify({ content: content.slice(0, 2000), username: "Watchbell", allowed_mentions: { parse: [] } }),
    });
  } catch {
    return { ok: false, kind: "transient", error: "Discord didn't answer." };
  }
  if (res.status === 204 || res.ok) return { ok: true };
  if (res.status === 429) {
    const body = (await res.json().catch(() => null)) as { retry_after?: number } | null;
    const s = Math.ceil(body?.retry_after ?? 5);
    return { ok: false, kind: "transient", retryAfterS: s, error: `Discord asked us to wait ${s} s.` };
  }
  if (res.status === 404 || res.status === 401) return { ok: false, kind: "config", error: "Discord says this webhook no longer exists." };
  return { ok: false, kind: res.status >= 500 ? "transient" : "config", error: `Discord returned an error (${res.status}).` };
}
