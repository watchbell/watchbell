// A2: one message per channel per delivery, listing every notice. Telegram gets HTML (parse_mode "HTML": only &, < and >
// need escaping), Discord gets plain markdown with mentions off. Both stay inside their limits (4,096 / 2,000).
import type { Severity } from "@/db/schema";
import type { NotifyLang } from "@/lib/notify/lang";
import { clock } from "@/lib/time";
import type { Pending } from "./lifecycle";
import { translateAlertText } from "./translate-id";

export type Notice = { kind: Pending; ruleKey: string; severity: Severity; title: string; message: string; startedAt: Date; causedBy: string | null; provider: string | null };

// Notification language (owner 19 Oct): the frame of the message in English or Indonesian; the alert text itself is
// stored in English and translated by translate-id.ts.
const WORD: Record<NotifyLang, Record<Pending, string>> = {
  en: { open: "FIRING", repeat: "REPEAT", resolve: "RESOLVED" },
  id: { open: "MUNCUL", repeat: "ULANG", resolve: "PULIH" },
};
export const SEVERITY_WORD: Record<NotifyLang, Record<Severity, string>> = {
  en: { critical: "critical", warning: "warning", info: "info" },
  id: { critical: "kritis", warning: "peringatan", info: "info" },
};
const TEXT = {
  en: { firing: "firing", resolved: "resolved", since: "since", open: "Open alerts", more: "more on the Alerts page", causedBy: "caused by", incident: "reports an incident", step: "Next step" },
  id: { firing: "aktif", resolved: "pulih", since: "sejak", open: "Buka Alerts", more: "lagi di halaman Alerts", causedBy: "gara-gara", incident: "lagi ada insiden", step: "Langkah" },
} satisfies Record<NotifyLang, Record<string, string>>;
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

function summary(list: Notice[], lang: NotifyLang): string {
  const firing = list.filter((n) => n.kind !== "resolve").length;
  const resolved = list.length - firing;
  return [firing ? `${firing} ${TEXT[lang].firing}` : "", resolved ? `${resolved} ${TEXT[lang].resolved}` : ""].filter(Boolean).join(", ");
}

function build(list: Notice[], max: number, line: (n: Notice) => string, head: string, foot: string, more: (k: number) => string): string {
  const sorted = [...list].sort((a, b) => (a.kind === "resolve" ? 1 : 0) - (b.kind === "resolve" ? 1 : 0) || ORDER[a.severity] - ORDER[b.severity]);
  const out: string[] = [head];
  let used = head.length + foot.length + 40;
  for (let i = 0; i < sorted.length; i++) {
    const l = line(sorted[i]);
    if (used + l.length + 1 > max) { out.push(more(sorted.length - i)); break; }
    out.push(l);
    used += l.length + 1;
  }
  out.push(foot);
  return out.join("\n").slice(0, max);
}

// Owner 17 Oct: the rules no Kantor Virtual action can fix (a payment, a token, a quota) carry the owner's next step on
// FIRING / REPEAT. The others get an officer's proposal: safe ones run, risky ones wait for the Telegram buttons.
const NEXT_STEP: Record<NotifyLang, Partial<Record<string, string>>> = {
  en: {
    CollectorStale: "the watchdog already runs the collector itself every 5 minutes. Check the job on cron-job.org and the latest Vercel deploy.",
    DomainExpiringSoon: "renew the domain at its registrar; Watchbell can't pay for it.",
    StorageAlmostFull: "delete old data or shorten retention in that database; the free tier can't add storage.",
    NeonComputeHigh: "cut queries or make Neon auto-suspend sooner; the quota resets at the start of the month.",
    FirestoreQuotaHigh: "cut Firestore reads (cache in the app); the quota resets daily.",
    DbQuotaHigh: "cut queries to that database until its quota resets.",
    ComputeHigh: "check the Pool card on the Supabase page (idle connections close automatically at 10 of 15); for CPU or disk, look for heavy queries.",
    DnsProxiedToVercel: "turn off the proxy (orange cloud) for that record in Cloudflare; Vercel needs DNS only.",
    CredentialExpiring: "create a new token and replace it in Settings → Connections before it expires.",
  },
  // The owner's own words, as they were before 62caff7.
  id: {
    CollectorStale: "watchdog udah jalanin collector sendiri tiap 5 menit. Cek job di cron-job.org dan deploy terakhir di Vercel.",
    DomainExpiringSoon: "perpanjang domain di registrar-nya, Watchbell nggak bisa bayar.",
    StorageAlmostFull: "hapus data lama atau pendekin retensi di database itu, free tier nggak bisa nambah storage.",
    NeonComputeHigh: "kurangin query atau percepat auto-suspend Neon, kuota reset awal bulan.",
    FirestoreQuotaHigh: "kurangin read Firestore (cache di app), kuota reset tiap hari.",
    DbQuotaHigh: "kurangin query ke database itu sampai kuotanya reset.",
    ComputeHigh: "cek kartu Pool di halaman Supabase (koneksi nganggur ditutup otomatis di 10 dari 15), kalau CPU/disk cari query yang berat.",
    DnsProxiedToVercel: "matiin proxy (awan oranye) record itu di Cloudflare, Vercel butuh DNS only.",
    CredentialExpiring: "bikin token baru dan ganti di Settings → Connections sebelum habis.",
  },
};
export const nextStep = (ruleKey: string, lang: NotifyLang = "en"): string | null => {
  const s = Object.hasOwn(NEXT_STEP[lang], ruleKey) ? NEXT_STEP[lang][ruleKey] : undefined;
  return s ? `${TEXT[lang].step}: ${s}` : null;
};

export function composeMessage(list: Notice[], now: Date, siteUrl: string, lang: NotifyLang = "en"): { telegram: string; discord: string } {
  const url = `${siteUrl.replace(/\/+$/, "")}/alerts`;
  const tx = TEXT[lang];
  const head = (n: Notice) => `${WORD[lang][n.kind]} · ${SEVERITY_WORD[lang][n.severity]} · `;
  const message = (n: Notice) => (lang === "id" ? translateAlertText(n.ruleKey, n.message) : n.message);
  const step = (n: Notice): string | null => (n.kind === "resolve" ? null : nextStep(n.ruleKey, lang));
  const extra = (n: Notice) => [n.causedBy ? `${tx.causedBy} ${n.causedBy}` : "", n.provider ? `${n.provider} ${tx.incident}` : ""].filter(Boolean).join(" · ");
  const more = (k: number) => `\n+${k} ${tx.more}`;
  const telegram = build(list, 4096,
    (n) => `\n<b>${head(n)}${esc(n.ruleKey)} · ${esc(n.title)}</b>\n${esc(message(n))}${extra(n) ? `\n<i>${esc(extra(n))}</i>` : ""}${step(n) ? `\n👉 ${esc(step(n)!)}` : ""}\n${tx.since} ${clock(n.startedAt)} WIB`,
    `<b>Watchbell</b>: ${summary(list, lang)} · ${clock(now)} WIB`, `\n<a href="${esc(url)}">${tx.open}</a>`, more);
  const discord = build(list, 2000,
    (n) => `\n**${head(n)}${n.ruleKey} · ${n.title.replace(/[*_`~|\[\]<>]/g, "")}**\n${message(n).replace(/[*_`~|\[\]<>]/g, "")}${extra(n) ? `\n_${extra(n)}_` : ""}${step(n) ? `\n👉 ${step(n)}` : ""}`,
    `**Watchbell**: ${summary(list, lang)} · ${clock(now)} WIB`, `\n${url}`, more);
  return { telegram, discord };
}
