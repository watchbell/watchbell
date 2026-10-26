// A2: one message per channel per delivery, listing every notice. Telegram gets HTML (parse_mode "HTML": only &, < and >
// need escaping), Discord gets plain markdown with mentions off. Both stay inside their limits (4,096 / 2,000).
import type { Severity } from "@/db/schema";
import type { NotifyLang } from "@/lib/notify/lang";
import { clock, zoneLabel } from "@/lib/time";
import type { Pending } from "./lifecycle";
import { type MessageTemplates, renderTemplate, SAMPLE_DETAIL, type TemplateValues } from "./message-template";
import { translateAlertText } from "./translate-id";

// `threshold` (1.2.4): the rule's number, for a custom text's {threshold}.
export type Notice = { kind: Pending; ruleKey: string; severity: Severity; title: string; message: string; startedAt: Date; causedBy: string | null; provider: string | null; threshold?: number | null };

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
  en: { firing: "firing", resolved: "resolved", since: "since", open: "Open alerts", more: "more on the Alerts page", causedBy: "caused by", incident: "reports an incident", step: "Next step", test: "test" },
  id: { firing: "aktif", resolved: "pulih", since: "sejak", open: "Buka Alerts", more: "lagi di halaman Alerts", causedBy: "karena", incident: "lagi ada insiden", step: "Yang perlu kamu lakukan", test: "tes" },
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
    // Review T1: the office proposes the update PR only for an app linked to its GitHub repository.
    FrameworkVulnerable: "if the app's GitHub repository isn't linked yet, link it on the app page to get an update PR from the office; or update next yourself.",
    // Watchbell 1.2.1: the app moved; nothing to redeploy.
    MonitorDomainMoved: "press Update monitor on the Uptime page (or approve the proposal) so the monitor checks the new domain; the app itself is fine.",
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
    FrameworkVulnerable: "kalau repo GitHub app-nya belum di-link, link di halaman app biar office bikinin PR update; atau update next sendiri.",
    MonitorDomainMoved: "pencet Update monitor di halaman Uptime (atau approve usulannya) biar monitor ngecek domain baru; app-nya sendiri aman.",
  },
};
// The step alone, for a custom text's {step} (its own words go before it).
export const stepText = (ruleKey: string, lang: NotifyLang = "en"): string | null => (Object.hasOwn(NEXT_STEP[lang], ruleKey) ? NEXT_STEP[lang][ruleKey] ?? null : null);
export const nextStep = (ruleKey: string, lang: NotifyLang = "en"): string | null => {
  const s = stepText(ruleKey, lang);
  return s ? `${TEXT[lang].step}: ${s}` : null;
};

// `templates` (1.2.4): a rule with a custom text in this language is written from it (message-template.ts), its first
// line bold like Watchbell's own. Every other rule keeps the lines below, unchanged.
// `opts.test` (owner 26 Oct, Rules › Edit › Send test): the head says "Watchbell (tes)" and the alerts' text is the sample
// sentence in this language, so nobody in the chat takes it for a real alert.
export function composeMessage(list: Notice[], now: Date, siteUrl: string, lang: NotifyLang = "en", templates: MessageTemplates = {}, opts: { test?: boolean } = {}): { telegram: string; discord: string } {
  const url = `${siteUrl.replace(/\/+$/, "")}/alerts`;
  const tx = TEXT[lang];
  const head = (n: Notice) => `${WORD[lang][n.kind]} · ${SEVERITY_WORD[lang][n.severity]} · `;
  const message = (n: Notice) => (opts.test ? SAMPLE_DETAIL[lang] : lang === "id" ? translateAlertText(n.ruleKey, n.message) : n.message);
  const name = opts.test ? `Watchbell (${tx.test})` : "Watchbell";
  const step = (n: Notice): string | null => (n.kind === "resolve" ? null : nextStep(n.ruleKey, lang));
  const extra = (n: Notice) => [n.causedBy ? `${tx.causedBy} ${n.causedBy}` : "", n.provider ? `${n.provider} ${tx.incident}` : ""].filter(Boolean).join(" · ");
  const more = (k: number) => `\n+${k} ${tx.more}`;
  const values = (n: Notice, clean: (s: string) => string): TemplateValues => ({
    status: WORD[lang][n.kind], severity: SEVERITY_WORD[lang][n.severity], rule: n.ruleKey, target: clean(n.title), detail: clean(message(n)), cause: clean(extra(n)),
    step: n.kind === "resolve" ? "" : stepText(n.ruleKey, lang) ?? "", since: `${clock(n.startedAt)} ${zoneLabel(n.startedAt)}`,
    threshold: n.threshold == null ? "" : n.threshold.toLocaleString("en-US"),
  });
  // [first line, the rest] of the rule's custom text, or null when it has none in this language.
  const custom = (n: Notice, clean: (s: string) => string): [string, string] | null => {
    const t = Object.hasOwn(templates, n.ruleKey) ? templates[n.ruleKey]?.[lang] : undefined;
    if (!t) return null;
    const [first = "", ...rest] = renderTemplate(t, values(n, clean)).split("\n");
    return [first, rest.join("\n")];
  };
  const unmark = (s: string) => s.replace(/[*_`~|\[\]<>]/g, "");
  const telegram = build(list, 4096,
    (n) => {
      const c = custom(n, (s) => s);
      if (c) return `\n<b>${esc(c[0])}</b>${c[1] ? `\n${esc(c[1])}` : ""}`;
      return `\n<b>${head(n)}${esc(n.ruleKey)} · ${esc(n.title)}</b>\n${esc(message(n))}${extra(n) ? `\n<i>${esc(extra(n))}</i>` : ""}${step(n) ? `\n👉 ${esc(step(n)!)}` : ""}\n${tx.since} ${clock(n.startedAt)} ${zoneLabel(n.startedAt)}`;
    },
    `<b>${name}</b>: ${summary(list, lang)} · ${clock(now)} ${zoneLabel(now)}`, `\n<a href="${esc(url)}">${tx.open}</a>`, more);
  const discord = build(list, 2000,
    (n) => {
      const c = custom(n, unmark);
      if (c) return `\n**${c[0]}**${c[1] ? `\n${c[1]}` : ""}`;
      return `\n**${head(n)}${n.ruleKey} · ${unmark(n.title)}**\n${unmark(message(n))}${extra(n) ? `\n_${extra(n)}_` : ""}${step(n) ? `\n👉 ${step(n)}` : ""}`;
    },
    `**${name}**: ${summary(list, lang)} · ${clock(now)} ${zoneLabel(now)}`, `\n${url}`, more);
  return { telegram, discord };
}
