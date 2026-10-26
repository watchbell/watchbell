import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import type { Notice } from "@/lib/alerts/compose";
import { DEMO_UNAVAILABLE } from "@/lib/demo/simulate";
import { isDemo } from "@/lib/mode";
import { isBlockedAddress, urlProblem } from "@/lib/net/public-host";
import type { SendResult } from "./telegram";

// 1.2.3 (owner 24 Oct: n8n and anything else): a generic outgoing webhook. Watchbell POSTs one JSON document per
// message to an https address on a public host, the same rule as monitors (lib/net/public-host.ts), checked at save
// time and again before every send, with no redirects followed. An optional secret signs the body (HMAC-SHA256), so
// the receiver can tell the message came from this Watchbell.

export const WEBHOOK_SIGNATURE_HEADER = "X-Watchbell-Signature";
export const WEBHOOK_TIMESTAMP_HEADER = "X-Watchbell-Timestamp";

export function webhookUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "Paste the whole address, starting with https://.";
  }
  const p = urlProblem(u);
  if (p === "scheme") return "Use an https:// address without a user name or password in it.";
  if (p === "blocked") return "Use an address on the public internet, on port 443. Watchbell doesn't post into private networks.";
  return null;
}

export function secretProblem(secret: string): string | null {
  return secret === "" || (secret.length >= 16 && secret.length <= 200) ? null : "Use a secret of 16 to 200 characters, or leave it empty.";
}

export type WebhookPayload = {
  source: "watchbell";
  event: "alerts" | "test";
  sentAt: string;
  text: string;
  link: string | null;
  alerts: { status: "firing" | "repeat" | "resolved"; rule: string; severity: string; title: string; message: string; startedAt: string; causedBy: string | null; provider: string | null }[];
};

const STATUS: Record<Notice["kind"], WebhookPayload["alerts"][number]["status"]> = { open: "firing", repeat: "repeat", resolve: "resolved" };

export function webhookPayload(text: string, notices: Notice[], now: Date, link: string | null): WebhookPayload {
  return {
    source: "watchbell", event: notices.length ? "alerts" : "test", sentAt: now.toISOString(), text: text.slice(0, 4000), link,
    alerts: notices.slice(0, 20).map((n) => ({
      status: STATUS[n.kind], rule: n.ruleKey, severity: n.severity, title: n.title, message: n.message, startedAt: n.startedAt.toISOString(),
      causedBy: n.causedBy, provider: n.provider,
    })),
  };
}

// "sha256=<hex>" of `${timestamp}.${body}`, so a captured message can't be replayed later with a new timestamp.
export const signBody = (secret: string, timestamp: string, body: string) => `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

async function resolveAddresses(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true })).map((a) => a.address);
}

export async function sendWebhook(
  config: { url: string; secret: string }, payload: WebhookPayload,
  opts: { fetch?: typeof fetch; lookup?: (host: string) => Promise<string[]>; timeoutMs?: number } = {},
): Promise<SendResult> {
  if (isDemo()) return { ok: false, kind: "config", error: DEMO_UNAVAILABLE }; // the demo never posts anywhere
  if (webhookUrlProblem(config.url)) return { ok: false, kind: "config", error: "The saved webhook address isn't allowed any more." };
  const url = new URL(config.url.trim());
  try {
    const addresses = await (opts.lookup ?? resolveAddresses)(url.hostname);
    if (!addresses.length || addresses.some(isBlockedAddress)) return { ok: false, kind: "config", error: "The webhook host resolves to a private address; Watchbell won't post there." };
  } catch {
    return { ok: false, kind: "transient", error: "The webhook host didn't resolve." };
  }
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.parse(payload.sentAt) / 1000));
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "Watchbell-Webhook/1.0", [WEBHOOK_TIMESTAMP_HEADER]: timestamp };
  if (config.secret) headers[WEBHOOK_SIGNATURE_HEADER] = signBody(config.secret, timestamp, body);
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url.toString(), { method: "POST", headers, body, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
  } catch {
    return { ok: false, kind: "transient", error: "The webhook didn't answer." };
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.ok) return { ok: true };
  if (res.status >= 300 && res.status < 400) return { ok: false, kind: "config", error: "The webhook answered with a redirect; Watchbell doesn't follow them. Use the final address." };
  if (res.status === 429) {
    const s = Math.min(600, Math.max(1, Number(res.headers.get("retry-after")) || 30));
    return { ok: false, kind: "transient", retryAfterS: s, error: `The webhook asked to wait ${s} s.` };
  }
  return { ok: false, kind: res.status >= 500 ? "transient" : "config", error: `The webhook returned an error (${res.status}).` };
}
