import { DEMO_UNAVAILABLE } from "@/lib/demo/simulate";
import { isDemo } from "@/lib/mode";
import type { SendResult } from "./telegram";

// Resend (resend.com/docs/api-reference/emails/send-email). Free: 100 a day; we send the digest once a day with an
// idempotency key per WIB day, so a retried run can't send it twice. A User-Agent is required (403 code 1010 without).
export async function sendEmail(
  key: string, mail: { from: string; to: string; subject: string; html: string; text: string; idempotencyKey: string }, opts: { fetch?: typeof fetch } = {},
): Promise<SendResult> {
  if (isDemo()) return { ok: false, kind: "config", error: DEMO_UNAVAILABLE }; // the demo never sends mail
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(5000), cache: "no-store",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "OpsConsole/1.0", "Idempotency-Key": mail.idempotencyKey },
      body: JSON.stringify({ from: mail.from, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }),
    });
  } catch {
    return { ok: false, kind: "transient", error: "Resend didn't answer." };
  }
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  if (res.status === 429 || res.status >= 500) return { ok: false, kind: "transient", error: `Resend returned an error (${res.status}).` };
  return { ok: false, kind: "config", error: `Resend: ${String(body?.message ?? res.status).slice(0, 200)}` };
}
