import { after } from "next/server";
import { webhookSecret } from "@/lib/data/telegram-bot-db";
import { demoRouteGone } from "@/lib/demo/simulate";
import { notifyEnv } from "@/lib/notify/env";
import { noteRejected, parseUpdate, secretMatches } from "@/lib/notify/telegram-bot";
import { handleUpdate } from "@/lib/notify/telegram-updates";
import { updateDeps } from "@/lib/notify/update-deps";

export const dynamic = "force-dynamic";
// The answer goes back at once; an approval then runs the action after the response (after()), like the office route.
export const maxDuration = 60;

// POST /api/telegram/webhook (Stage 9 slice 7). Telegram calls it with the header X-Telegram-Bot-Api-Secret-Token set
// to the secret the console gave setWebhook (sealed in ops.settings); the proxy lets it through without any session work
// (proxy.ts), so that header is the only credential. A missing or wrong secret, or no webhook switched on → 401, and
// nothing is logged but a counter. A valid request always gets 200 quickly, whatever it carries: an update the console
// doesn't handle, or a body that isn't one, is dropped (Telegram would otherwise retry it).
const MAX_BODY_BYTES = 64 * 1024;
const HEADERS = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };

export async function POST(req: Request): Promise<Response> {
  const gone = demoRouteGone(); // the demo has no Telegram bot
  if (gone) return gone;
  const secret = await webhookSecret().catch(() => null);
  const given = req.headers.get("x-telegram-bot-api-secret-token");
  if (!secret || !secretMatches(given, secret)) {
    noteRejected();
    return new Response("Unauthorized", { status: 401, headers: HEADERS });
  }
  const ok = new Response("OK", { status: 200, headers: HEADERS });
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return ok;
  const raw = await req.text().catch(() => "");
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return ok;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return ok;
  }
  const update = parseUpdate(body);
  const token = notifyEnv().telegramToken;
  if (!update || !token) return ok;
  after(async () => handleUpdate(update, await updateDeps()));
  return ok;
}
