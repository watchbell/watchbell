// The daily email digest (spec §10): what is still firing, what opened and resolved in the last 24 hours, uptime and
// stored errors per application, and the providers that aren't fine. Sent once a WIB day after 07:00; the subject, the
// text and the HTML are built here from plain data so the builder stays testable.
import type { Severity } from "@/db/schema";
import { esc, SEVERITY_WORD } from "@/lib/alerts/compose";
import { translateAlertText } from "@/lib/alerts/translate-id";
import type { NotifyLang } from "@/lib/notify/lang";
import { TZ, wibDate } from "@/lib/time";
import { pct } from "@/lib/view/format";
import { wibDay } from "@/lib/view/uptime";
import { hideEmails } from "@/lib/view/display-name";

export const DIGEST_HOUR_WIB = 7;

export function digestDue(now: Date, lastSentDay: string | null): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(now));
  return wibDay(now) !== lastSentDay && hour >= DIGEST_HOUR_WIB;
}

export type DigestInput = {
  now: Date; siteUrl: string;
  firing: { ruleKey: string; severity: Severity; title: string; message: string; startedAt: Date }[];
  opened: number;
  resolved: { ruleKey: string; title: string; took: string }[];
  apps: { name: string; uptime: number | null; errors: number }[];
  providers: { label: string; text: string }[];
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Worst first: lowest uptime, then most stored errors; an app without checks goes last.
function worstFirst(apps: DigestInput["apps"]): DigestInput["apps"] {
  return [...apps].sort((a, b) => (a.uptime ?? 101) - (b.uptime ?? 101) || b.errors - a.errors || a.name.localeCompare(b.name));
}

// tookText() (lib/view/alerts.ts) writes "6 min", "2 h 5 min", "2 d 4 h"; the Indonesian digest says it in words.
const tookId = (s: string) => s.replace(/\b(\d+) min\b/g, "$1 menit").replace(/\b(\d+) h\b/g, "$1 jam").replace(/\b(\d+) d\b/g, "$1 hari");
// Notification language (owner 19 Oct): the digest's own words per language; the alerts' stored English text is
// translated by translate-id.ts. Provider status texts come from the providers' feeds and stay as they are.
const TEXT = {
  en: {
    firing: "firing", opened: "opened", resolved: "resolved", last24: "in the last 24 hours.", stillHead: "Still firing", noFiring: "Nothing is firing.",
    resolvedHead: "Resolved", noResolved: "Nothing resolved.", appsHead: "Applications (24 h)", providersHead: "Providers", open: "Open alerts",
    after: "after", up: "up", took: (s: string) => s, noChecks: "no checks", errors: (n: number) => plural(n, "stored error"),
  },
  id: {
    firing: "aktif", opened: "baru", resolved: "pulih", last24: "dalam 24 jam terakhir.", stillHead: "Masih aktif", noFiring: "Nggak ada yang aktif.",
    resolvedHead: "Pulih", noResolved: "Nggak ada yang pulih.", appsHead: "Aplikasi (24 jam)", providersHead: "Provider", open: "Buka Alerts",
    after: "setelah", up: "aktif", took: tookId, noChecks: "belum ada cek", errors: (n: number) => `${n} error tersimpan`,
  },
};
// lib/time.ts writes English month abbreviations; these four differ in Indonesian.
const MONTH_ID: Record<string, string> = { May: "Mei", Aug: "Agu", Oct: "Okt", Dec: "Des" };
const dayOf = (d: Date, lang: NotifyLang) => {
  const { day, month } = wibDate(d);
  return `${day} ${lang === "id" ? MONTH_ID[month] ?? month : month}`;
};

export function buildDigest(d: DigestInput, lang: NotifyLang = "en"): { subject: string; html: string; text: string } {
  const tx = TEXT[lang];
  const url = `${d.siteUrl.replace(/\/+$/, "")}/alerts`;
  const day = dayOf(d.now, lang);
  const counts = `${d.firing.length} ${tx.firing}, ${d.opened} ${tx.opened}, ${d.resolved.length} ${tx.resolved}`;
  const subject = `Watchbell · ${day} · ${counts}`;
  const apps = worstFirst(d.apps);
  const message = (a: DigestInput["firing"][number]) => (lang === "id" ? translateAlertText(a.ruleKey, a.message) : a.message);
  const firing = d.firing.map((a) => `${SEVERITY_WORD[lang][a.severity]} · ${a.ruleKey} · ${a.title}: ${message(a)}`);
  const resolved = d.resolved.map((r) => `${r.ruleKey} · ${r.title} (${tx.after} ${tx.took(r.took)})`);
  const appLines = apps.map((a) => `${a.name}: ${a.uptime === null ? tx.noChecks : `${pct(a.uptime)} ${tx.up}`}, ${tx.errors(a.errors)}`);
  const providers = d.providers.map((p) => `${p.label}: ${p.text}`);

  const text = [
    `Watchbell · ${day}`,
    `${counts} ${tx.last24}`,
    "",
    tx.stillHead,
    ...(firing.length ? firing.map((l) => `- ${l}`) : [tx.noFiring]),
    "",
    tx.resolvedHead,
    ...(resolved.length ? resolved.map((l) => `- ${l}`) : [tx.noResolved]),
    ...(appLines.length ? ["", tx.appsHead, ...appLines.map((l) => `- ${l}`)] : []),
    ...(providers.length ? ["", tx.providersHead, ...providers.map((l) => `- ${l}`)] : []),
    "",
    `${tx.open}: ${url}`,
  ].join("\n");

  // Inline styles only (mail clients drop <style>); every dynamic string goes through esc().
  const h3 = (s: string) => `<h3 style="font:600 14px system-ui,sans-serif;margin:18px 0 6px">${esc(s)}</h3>`;
  const list = (items: string[], empty: string) => items.length
    ? `<ul style="margin:0;padding-left:18px">${items.map((l) => `<li style="margin:2px 0">${esc(l)}</li>`).join("")}</ul>`
    : `<p style="margin:0;color:#596170">${esc(empty)}</p>`;
  const html = [
    `<div style="font:14px/1.5 system-ui,sans-serif;color:#14171f;max-width:560px">`,
    `<h2 style="font:600 16px system-ui,sans-serif;margin:0 0 4px">Watchbell · ${esc(day)}</h2>`,
    `<p style="margin:0;color:#596170">${esc(`${counts} ${tx.last24}`)}</p>`,
    h3(tx.stillHead), list(firing, tx.noFiring),
    h3(tx.resolvedHead), list(resolved, tx.noResolved),
    ...(appLines.length ? [h3(tx.appsHead), list(appLines, "")] : []),
    ...(providers.length ? [h3(tx.providersHead), list(providers, "")] : []),
    `<p style="margin:18px 0 0"><a href="${esc(url).replace(/"/g, "&quot;")}" style="color:#1f45c9">${esc(tx.open)}</a></p>`,
    `</div>`,
  ].join("");
  // Privacy: the caller already names databases by alias (digestData); no address leaves in any form.
  return { subject: hideEmails(subject), html: hideEmails(html), text: hideEmails(text) };
}

// I4: the digest is built ONCE a WIB day (from the data at the first attempt) and stored with its attempt count; every
// retry sends that stored content, so the same Idempotency-Key always goes with the same body (Resend answers 409 when
// the body changes) and a lost response can't turn into a loop. Attempts are bounded: at most MAX_ATTEMPTS a day with
// growing gaps. A config/4xx error (an unverified From address, a bad key) stops the day at once. Either way one event
// says it wasn't sent, and the next WIB day starts fresh.
export const DIGEST_MAX_ATTEMPTS = 5;
export const DIGEST_GAPS_MIN = [5, 15, 30, 60]; // the wait after the 1st, 2nd, 3rd and 4th failed attempt

export type DigestContent = { subject: string; html: string; text: string };
export type DigestState = DigestContent & { day: string; attempts: number; lastAttemptAt: string | null; stopped: boolean; lastError: string | null };
type Sent = { ok: true } | { ok: false; kind: "config" | "transient"; error: string };

export type DigestIo = {
  lastSentDay: string | null;
  state: DigestState | null;
  build: () => Promise<DigestContent>;
  send: (c: DigestContent) => Promise<Sent>;
};
export type DigestStep = {
  acted: boolean; // a send was attempted (so the caller records the channel result)
  state: DigestState | null; // what to store; null clears it
  sentDay: string | null; // set when today's digest went out
  event: { message: string; detail: string } | null;
  result: Sent | null;
};

export async function stepDigest(now: Date, io: DigestIo): Promise<DigestStep> {
  const idle: DigestStep = { acted: false, state: io.state, sentDay: null, event: null, result: null };
  if (!digestDue(now, io.lastSentDay)) return idle;
  const day = wibDay(now);
  let st = io.state && io.state.day === day ? io.state : null;
  if (st?.stopped) return { ...idle, state: st };
  if (st && st.attempts > 0) {
    const gap = (DIGEST_GAPS_MIN[st.attempts - 1] ?? DIGEST_GAPS_MIN[DIGEST_GAPS_MIN.length - 1]) * 60_000;
    if (st.lastAttemptAt && now.getTime() - new Date(st.lastAttemptAt).getTime() < gap) return { ...idle, state: st };
  }
  st ??= { day, ...(await io.build()), attempts: 0, lastAttemptAt: null, stopped: false, lastError: null };
  const r = await io.send({ subject: st.subject, html: st.html, text: st.text });
  if (r.ok) return { acted: true, state: null, sentDay: day, event: null, result: r };
  const attempts = st.attempts + 1;
  const stopped = r.kind === "config" || attempts >= DIGEST_MAX_ATTEMPTS;
  const detail = r.kind === "config" ? `${r.error}. Fix it and the next digest goes out tomorrow.` : `${r.error} Gave up after ${attempts} attempts today.`;
  return {
    acted: true, sentDay: null, result: r,
    state: { ...st, attempts, lastAttemptAt: now.toISOString(), stopped, lastError: r.error },
    event: stopped ? { message: "Daily digest not sent", detail } : null,
  };
}
