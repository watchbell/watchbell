import { logCause } from "@/lib/collector/safe-error";
import { getUpdates as realGetUpdates, parseUpdate, type TgUpdate } from "./telegram-bot";

// Selfhost: a laptop has no public https URL, so Telegram can't push updates. Instead the app long-polls getUpdates and
// hands every update to the same handler the webhook route uses. The offset (last update_id + 1) is kept in
// ops.settings so a restart neither replays nor skips button presses. Never throws; warn lines carry the cause
// (logCause hides tokens and URL credentials), never the token or update contents.
// The poller never deletes a webhook itself: a webhook may belong to the cloud install of the same bot (a selfhost run
// started with the cloud .env.local). Turning approvals on in the console (enableApprovals) is the explicit switch.

export type PollerDeps = {
  token: () => Promise<string | null>;
  enabled: () => Promise<boolean>;
  offset: { read(): Promise<number>; write(n: number): Promise<void> };
  getUpdates: typeof realGetUpdates;
  handle: (u: TgUpdate) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

export const IDLE_MS = 10_000;
export const ERROR_WAIT_MS = 10_000;
export const CONFLICT_WAIT_MS = 60_000;
const CONFLICT_HINT = "telegram poll: Telegram has a webhook set; turn approvals on in Alerts → Notifications to switch this install to polling";

const realSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); });

// The real deps, loaded lazily so importing this module stays free of the database.
async function defaultDeps(): Promise<PollerDeps> {
  const [{ notifyEnv }, bot, db, { updateDeps }, { handleUpdate }] = await Promise.all([
    import("./env"), import("./telegram-bot"), import("@/lib/data/telegram-bot-db"), import("./update-deps"), import("./telegram-updates"),
  ]);
  return {
    token: async () => notifyEnv().telegramToken,
    enabled: db.webhookOn, // the same switch the console toggle sets (a stored secret = approvals on)
    offset: { read: db.readPollOffset, write: db.writePollOffset },
    getUpdates: bot.getUpdates,
    handle: async (u) => handleUpdate(u, await updateDeps()),
  };
}

export function startTelegramPoller(deps?: PollerDeps): { stop(): void } {
  let stopped = false;
  void (async () => {
    const d = deps ?? (await defaultDeps());
    const sleep = d.sleep ?? realSleep;
    while (!stopped) {
      try {
        const token = (await d.enabled()) ? await d.token() : null;
        if (!token) {
          await sleep(IDLE_MS);
          continue;
        }
        const r = await d.getUpdates(token, await d.offset.read());
        if (!r.ok) {
          if (r.conflict) {
            // A webhook is registered for this bot: leave it alone, say how to switch, and check again in a minute.
            console.warn(CONFLICT_HINT);
            await sleep(CONFLICT_WAIT_MS);
            continue;
          }
          console.warn(`telegram poll: getUpdates failed: ${r.error}`);
          await sleep(ERROR_WAIT_MS);
          continue;
        }
        for (const raw of r.updates) {
          if (stopped) break;
          const id = (raw as { update_id?: unknown } | null)?.update_id;
          const update = parseUpdate(raw);
          if (update) {
            try {
              await d.handle(update);
            } catch (e) {
              console.warn(`telegram poll: handling an update failed: ${logCause(e)}`);
            }
          }
          // Advance even when handling failed or the update was not one we read: no endless redelivery.
          if (typeof id === "number") await d.offset.write(id + 1);
        }
      } catch (e) {
        console.warn(`telegram poll: loop error: ${logCause(e)}`);
        await sleep(ERROR_WAIT_MS);
      }
    }
  })().catch((e: unknown) => console.warn(`telegram poll: could not start: ${logCause(e)}`));
  return { stop: () => { stopped = true; } };
}
