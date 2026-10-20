import { Masked } from "@/components/alias";
import { Card } from "@/components/kit";
import { Status } from "@/components/status";
import type { ChannelKind } from "@/db/schema";
import type { ChannelView } from "@/lib/data/notify-db";
import type { State } from "@/lib/status";
import type { NotifyChannel, NotifyLangs } from "@/lib/notify/lang";
import { ago, zoneName } from "@/lib/time";
import { ChannelControls } from "./channel-dialog";
import { LanguageSelect } from "./language-select";
import { TelegramApprovals } from "./telegram-approvals";

const ROWS: { kind: ChannelKind; label: string; help: string }[] = [
  { kind: "telegram", label: "Telegram bot", help: "Free. One message per collector run, listing every alert that opened, repeated (every 6 h) or resolved." },
  { kind: "discord", label: "Discord webhook", help: "Free. Same messages as Telegram." },
  { kind: "email_digest", label: "Daily email digest", help: "Sent through Resend at 07:00 {zone}: what fired, what resolved, uptime and stored errors of the last 24 h. Free plan: 100 emails a day, we send 1." },
];

// The mockup's form-row: a 260 px label column with its help, then the status and the buttons.
const ROW = "grid grid-cols-[260px_minmax(0,1fr)] items-center gap-4 border-b border-line py-3 last:border-b-0 max-[720px]:grid-cols-1 max-[720px]:gap-1";

// `shot`: the same text with the hint (a chat's title, an address's first letters) left out, for screenshot mode.
function status(v: ChannelView, now: Date): { state: State; text: string; shot: string } {
  if (v.envMissing) return { state: "unknown", text: v.envMissing, shot: v.envMissing };
  if (!v.connected) return { state: "off", text: "Not connected", shot: "Not connected" };
  if (!v.enabled) return { state: "off", text: `Off · ${v.hint}`, shot: "Off" };
  const sent = v.lastSentAt ? `last sent ${ago(v.lastSentAt, now)}` : "never sent";
  const line = (hint: string) => (v.kind === "email_digest" ? `Every day at 07:00 · to ${hint} · ${sent}` : `Connected · ${hint} · ${sent}`);
  return { state: v.lastError ? "warn" : "ok", text: line(v.hint ?? ""), shot: line(v.kind === "email_digest" ? "[email hidden]" : "hidden") };
}

// Alerts → Notifications. Everyone reads the statuses; only Owners get the buttons. `hint` is already masked on the
// server (R7). The quiet rules are built in and say why a message may not arrive.
// `approvals`: the Telegram approval buttons exist (Stage 9 slice 7, only with the private feature's handler).
const DEFAULT_LANGS: NotifyLangs = { telegram: "en", discord: "en", email: "en" };
const LANG_CHANNEL: Record<ChannelView["kind"], NotifyChannel> = { telegram: "telegram", discord: "discord", email_digest: "email" };
const LANG_LABEL = { en: "English", id: "Bahasa Indonesia" };

export function ChannelsCard({ views, owner, now, approvals = false, langs = DEFAULT_LANGS }: { views: ChannelView[]; owner: boolean; now: Date; approvals?: boolean; langs?: NotifyLangs }) {
  return (
    <Card title="Channels">
      <div>
        {ROWS.map((r) => {
          const v = views.find((x) => x.kind === r.kind)!;
          const s = status(v, now);
          return (
            <div key={r.kind} className={ROW}>
              <div>
                <div className="font-medium">{r.label}</div>
                <div className="text-[12.5px] text-ink-soft">{r.help.replace("{zone}", zoneName())}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Status state={s.state}><Masked kind="text" real={s.text} masked={s.shot} /></Status>
                {owner ? <LanguageSelect channel={LANG_CHANNEL[v.kind]} label={r.label} saved={langs[LANG_CHANNEL[v.kind]]} /> : <span className="text-[12.5px] text-ink-soft">{LANG_LABEL[langs[LANG_CHANNEL[v.kind]]]}</span>}
                {owner && <ChannelControls kind={v.kind} connected={v.connected} enabled={v.enabled} envMissing={v.envMissing} />}
                {v.lastError && <span className="basis-full text-[12.5px] text-err">The last send failed: <Masked kind="text" real={v.lastError} /></span>}
                {owner && approvals && v.kind === "telegram" && v.connected && v.envMissing === null && <TelegramApprovals />}
              </div>
            </div>
          );
        })}
        <div className={ROW}>
          <div>
            <div className="font-medium">Quiet rules</div>
            <div className="text-[12.5px] text-ink-soft">Built in, not editable.</div>
          </div>
          <ul className="m-0 list-disc pl-[18px] text-[13px] text-ink-soft">
            <li>While CollectorStale fires, no other alert is sent: the data is stale.</li>
            <li>A paused database mutes MonitorDown and HighLatency of the apps linked to it.</li>
            <li>An alert resolves after 2 good evaluations in a row, so a flapping site doesn&apos;t page twice.</li>
          </ul>
        </div>
      </div>
    </Card>
  );
}
