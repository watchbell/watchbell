// 1.2.4 (owner 26 Oct, the idea of Grafana's annotations): an Owner can word a rule's notification themselves, per
// notification language, from fields like {target} and {detail}. Only a changed text is stored (ops.settings, below);
// a rule without one keeps Watchbell's own wording, so later wording fixes still reach it. Pure: the Rules dialog uses
// it for the preview, compose.ts for the real message.
import type { NotifyLang } from "@/lib/notify/lang";

export const TEMPLATE_FIELDS = ["status", "severity", "rule", "target", "detail", "cause", "step", "since", "threshold"] as const;
export type TemplateField = (typeof TEMPLATE_FIELDS)[number];
export type TemplateValues = Record<TemplateField, string>;
export const TEMPLATE_LANGS: readonly NotifyLang[] = ["id", "en"];
export const TEMPLATE_MAX = 1000;

// What each field holds, for the dialog's field buttons.
export const FIELD_HELP: Record<TemplateField, string> = {
  status: "FIRING, REPEAT or RESOLVED (MUNCUL, ULANG, PULIH in Indonesian)",
  severity: "critical, warning or info",
  rule: "the rule's key, like MonitorDown",
  target: "what the alert is about: an app, a database, a domain",
  detail: "Watchbell's sentence about what it saw",
  cause: "the alert that caused this one, or a provider incident",
  step: "Watchbell's next step for rules that have one",
  since: "when the alert started: the time and the time zone",
  threshold: "the rule's number from Threshold",
};

// Watchbell's own wording written as a template: the starting text in the dialog. A rule that keeps it is sent exactly as
// before (compose.ts only uses a template that was changed).
export const DEFAULT_TEMPLATE: Record<NotifyLang, string> = {
  en: "{status} · {severity} · {rule} · {target}\n{detail}\n{cause}\nNext step: {step}\nsince {since}",
  id: "{status} · {severity} · {rule} · {target}\n{detail}\n{cause}\nYang perlu kamu lakukan: {step}\nsejak {since}",
};

// The {detail} of a made-up alert (the dialog's preview and Rules › Edit › Send test), in the message's language.
export const SAMPLE_DETAIL: Record<NotifyLang, string> = {
  en: "Test message: Watchbell's sentence about what it saw goes here.",
  id: "Pesan tes: di sini nanti kalimat Watchbell soal apa yang dilihatnya.",
};

export type RuleTemplates = Partial<Record<NotifyLang, string>>;
export type MessageTemplates = Partial<Record<string, RuleTemplates>>;
export const TEMPLATES_KEY = "alerts.messageTemplates";

const FIELD_RE = /\{([a-zA-Z_]+)\}/g;
const tidy = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();

// null when the text can be saved; otherwise what to fix.
export function templateProblem(text: string): string | null {
  if (text.length > TEMPLATE_MAX) return `Keep it under ${TEMPLATE_MAX.toLocaleString("en-US")} characters.`;
  for (const [, name] of text.matchAll(FIELD_RE)) {
    if (!(TEMPLATE_FIELDS as readonly string[]).includes(name)) return `{${name}} isn't a field. Use ${TEMPLATE_FIELDS.map((f) => `{${f}}`).join(", ")}.`;
  }
  return null;
}

// What to store for a text from the dialog: null for an empty text or Watchbell's own (nothing to keep).
export function storedTemplate(text: unknown, lang: NotifyLang): string | null {
  const t = typeof text === "string" ? tidy(text) : "";
  return !t || t === DEFAULT_TEMPLATE[lang] ? null : t;
}

// The fields filled in. A line whose fields are all empty is left out (a rule without a next step drops that line), so
// one text fits every alert of the rule; a line without fields always stays.
export function renderTemplate(text: string, values: TemplateValues): string {
  const lines = tidy(text).split("\n").flatMap((line) => {
    const names = [...line.matchAll(FIELD_RE)].map((m) => m[1]).filter((n): n is TemplateField => Object.hasOwn(values, n));
    if (names.length && names.every((n) => !values[n].trim())) return [];
    return [line.replace(FIELD_RE, (m, n: string) => (Object.hasOwn(values, n) ? values[n as TemplateField] : m))];
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The stored row, read defensively: only known languages and strings that still pass templateProblem.
export function parseTemplates(raw: unknown): MessageTemplates {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: MessageTemplates = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const t: RuleTemplates = {};
    for (const lang of TEMPLATE_LANGS) {
      const s = (v as Record<string, unknown>)[lang];
      if (typeof s === "string" && s.trim() && templateProblem(s) === null) t[lang] = s;
    }
    if (Object.keys(t).length) out[key] = t;
  }
  return out;
}
