// What the console says when an AI provider fails (owner item #19, 25 Oct: "test failed (530)" told the owner nothing
// while the provider's tunnel was down). Pure: no I/O, no upstream bodies (R3), never a key or a base URL, only the
// connection's name and the HTTP status. English is the web UI's language; the Indonesian twin is for the office
// reports that go out in the notification language (Patroli's rooms).

export type FailureLang = "en" | "id";

// One failed attempt. status: the upstream HTTP status, 0 when nothing answered (network error, timeout).
// errorClass: classifyUpstreamError's class, or "network" / "timeout". detail: the curated upstreamMessage text, used
// only where the mapping keeps the provider's own message (other 4xx, Google's project errors).
export type ProviderFailure = { provider: string; status: number; errorClass: string; detail?: string };

// What happened after the first failure: another provider was tried (and failed too), there was none to try, the
// caller picked the model by name (no fallback), or the time budget ran out before a second try.
export type NextStep =
  | { kind: "tried"; fallback: ProviderFailure }
  | { kind: "none" }
  | { kind: "pinned" }
  | { kind: "out-of-time" };

export type FailureKind = "unreachable" | "auth" | "rate_limited" | "server" | "unreadable" | "other";

// The console's page where provider connections are added and keys replaced (AI Gateway › Bring your own key), with its
// route. Short on purpose: a dev note's error and a Patroli room's summary hold at most 200 characters.
export const PROVIDERS_PAGE = "Bring your own key (/ai/providers)";

// Every message fits MESSAGE_MAX: a dev note's error (a DB check) and a Patroli room's summary hold 200 characters.
// Connection names may be 60 characters long, so a long name is clipped with "…" until the whole message fits; the
// fixed words (what failed, what happened next, the page) are never cut.
export const MESSAGE_MAX = 200;
const NAME_MAX = 60;
const NAME_MIN = 8;
const DETAIL_MAX = 160;

// At most `max` UTF-16 units (what the 200 limits count), cut between code points: an emoji in a connection name is
// never split into a lone surrogate.
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const nameOf = (f: ProviderFailure, max: number) => clip(oneLine(f.provider) || "unnamed", max);

// 530 and the other 52x are Cloudflare's "the origin behind me is down" answers (a dropped tunnel); 502/503/504 are a
// proxy or gateway that could not reach the server.
export function isUnreachableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}

export function failureKind(f: Pick<ProviderFailure, "status" | "errorClass">): FailureKind {
  if (f.errorClass === "network" || f.errorClass === "timeout" || isUnreachableStatus(f.status)) return "unreachable";
  if (f.errorClass === "auth_rejected" || f.errorClass === "project_denied" || f.errorClass === "project_restricted" || f.status === 401 || f.status === 403) return "auth";
  if (f.errorClass === "rate_limited" || f.status === 429) return "rate_limited";
  if (f.errorClass === "bad_response") return "unreadable";
  if (f.status >= 500) return "server";
  return "other";
}

// Whether another provider may be tried after this failure: it is down, busy or broken. Never on a refused key or a
// 4xx about the request itself (the same request would fail the same way, or the key needs the owner).
export function triesAnother(f: Pick<ProviderFailure, "status" | "errorClass">): boolean {
  const k = failureKind(f);
  return k === "unreachable" || k === "rate_limited" || k === "server" || k === "unreadable";
}

const TEXT = {
  en: {
    unreachable: (n: string) => `AI provider "${n}" is unreachable (its endpoint or tunnel is down).`,
    auth: (n: string, s: number) => `AI provider "${n}" refused the key${s ? ` (${s})` : ""}.`,
    replaceKey: `Replace it on ${PROVIDERS_PAGE}.`,
    rate_limited: (n: string) => `AI provider "${n}" is rate limited (429): its quota is used up.`,
    server: (n: string, s: number) => `AI provider "${n}" failed with a server error (${s}).`,
    unreadable: (n: string) => `AI provider "${n}" sent an answer Watchbell can't read.`,
    other: (n: string, s: number) => `AI provider "${n}" answered ${s}.`,
    tried: (n: string, why: string) => `Tried "${n}" instead, and that failed too (${why}).`,
    none: (later: boolean) => `No other provider is enabled: add one on ${PROVIDERS_PAGE}, or ${later ? "try again later" : "check the endpoint"}.`,
    pinned: () => "This model was picked by name, so no other provider was tried.",
    outOfTime: "There was no time left to try another provider.",
    why: {
      unreachable: () => "unreachable", auth: (s: number) => `key refused${s ? `, ${s}` : ""}`, rate_limited: () => "rate limited, 429",
      server: (s: number) => `server error ${s}`, unreadable: () => "unreadable answer", other: (s: number) => `answered ${s}`,
    },
  },
  id: {
    unreachable: (n: string) => `Penyedia AI "${n}" tak bisa dihubungi (endpoint atau tunnel-nya mati).`,
    auth: (n: string, s: number) => `Penyedia AI "${n}" menolak kuncinya${s ? ` (${s})` : ""}.`,
    replaceKey: `Ganti kuncinya di ${PROVIDERS_PAGE}.`,
    rate_limited: (n: string) => `Penyedia AI "${n}" kena batas pemakaian (429): kuotanya habis.`,
    server: (n: string, s: number) => `Penyedia AI "${n}" gagal karena error di servernya (${s}).`,
    unreadable: (n: string) => `Penyedia AI "${n}" mengirim jawaban yang tidak bisa dibaca Watchbell.`,
    other: (n: string, s: number) => `Penyedia AI "${n}" menjawab ${s}.`,
    tried: (n: string, why: string) => `Sudah dicoba "${n}" sebagai gantinya, tapi juga gagal (${why}).`,
    none: (later: boolean) => `Tak ada penyedia lain yang aktif: tambah di ${PROVIDERS_PAGE}, atau ${later ? "coba lagi nanti" : "cek endpoint-nya"}.`,
    pinned: () => "Model ini dipilih langsung, jadi penyedia lain tidak dicoba.",
    outOfTime: "Tidak ada waktu tersisa untuk mencoba penyedia lain.",
    why: {
      unreachable: () => "tidak bisa dihubungi", auth: (s: number) => `kunci ditolak${s ? `, ${s}` : ""}`, rate_limited: () => "kena batas pemakaian, 429",
      server: (s: number) => `error server ${s}`, unreadable: () => "jawabannya tidak terbaca", other: (s: number) => `menjawab ${s}`,
    },
  },
} as const;

// The provider's own (curated) message, one line and clipped; it never carries the upstream body.
const detailOf = (f: ProviderFailure) => (f.detail ? clip(oneLine(f.detail), DETAIL_MAX) : "");

function head(f: ProviderFailure, lang: FailureLang, nameMax: number): string {
  const t = TEXT[lang];
  const n = nameOf(f, nameMax);
  switch (failureKind(f)) {
    case "unreachable": return t.unreachable(n);
    case "auth": {
      // Google's project errors say what to do better than "replace the key" does.
      const google = f.errorClass === "project_denied" || f.errorClass === "project_restricted" ? detailOf(f) : "";
      return `${t.auth(n, f.status)} ${google || t.replaceKey}`;
    }
    case "rate_limited": return t.rate_limited(n);
    case "server": return t.server(n, f.status);
    case "unreadable": return t.unreadable(n);
    default: return detailOf(f) || t.other(n, f.status);
  }
}

function next(step: NextStep, first: ProviderFailure, lang: FailureLang, nameMax: number): string {
  const t = TEXT[lang];
  const later = failureKind(first) === "rate_limited";
  switch (step.kind) {
    case "tried": {
      const f = step.fallback;
      return t.tried(nameOf(f, nameMax), t.why[failureKind(f)](f.status));
    }
    case "none": return t.none(later);
    case "pinned": return t.pinned();
    default: return t.outOfTime;
  }
}

// The one message for a failed AI call: what went wrong with the first provider, then (when another provider could
// have helped) what happened next. A refused key or a 4xx about the request gets no next step: no fallback is tried.
// Names are clipped only as far as needed to stay within MESSAGE_MAX (the last clip is a backstop that the fixed texts
// never reach: the longest frame, Indonesian with two names, leaves more than NAME_MIN for each name).
export function providerFailureMessage(first: ProviderFailure, step: NextStep, lang: FailureLang = "en"): string {
  const render = (nameMax: number) => {
    const h = head(first, lang, nameMax);
    return triesAnother(first) ? `${h} ${next(step, first, lang, nameMax)}` : h;
  };
  for (let max = NAME_MAX; max > NAME_MIN; max--) {
    const m = render(max);
    if (m.length <= MESSAGE_MAX) return m;
  }
  return clip(render(NAME_MIN), MESSAGE_MAX);
}
