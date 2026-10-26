// Spec §7.6: public status feeds, every 5 minutes, no keys. Sizes and shapes checked on 12 Oct 2026 (see the plan's
// provider table): Statuspage for Vercel and Cloudflare, a Statuspage-compatible summary for Supabase (no incidents
// key), Status.io for Neon, Google's incidents.json for Firebase and Google Cloud.
import type { FeedIncident } from "@/db/schema";
import { abortPromise, readCapped } from "@/lib/collector/http-check";

export type FeedProvider = "vercel" | "supabase" | "neon" | "cloudflare" | "firebase" | "gcp";
type Parsed = { state: "ok" | "warn" | "err" | "info"; indicator: string; description: string; incidents: FeedIncident[] };
export type FeedReading = Parsed & { provider: FeedProvider };

export const FEEDS: Record<FeedProvider, { label: string; feedText: string; page: string }> = {
  vercel: { label: "Vercel", feedText: "vercel-status.com · Statuspage", page: "https://www.vercel-status.com" },
  supabase: { label: "Supabase", feedText: "status.supabase.com · summary.json", page: "https://status.supabase.com" },
  neon: { label: "Neon", feedText: "neonstatus.com · Status.io API", page: "https://neonstatus.com" },
  cloudflare: { label: "Cloudflare", feedText: "cloudflarestatus.com · Statuspage", page: "https://www.cloudflarestatus.com" },
  firebase: { label: "Firebase", feedText: "status.firebase.google.com · incidents.json", page: "https://status.firebase.google.com" },
  gcp: { label: "Google Cloud", feedText: "status.cloud.google.com · incidents.json", page: "https://status.cloud.google.com" },
};
export const FEED_ORDER: FeedProvider[] = ["vercel", "supabase", "neon", "cloudflare", "firebase", "gcp"];

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);
const list = (v: unknown) => (Array.isArray(v) ? v.map(obj).filter((x): x is Record<string, unknown> => x !== null) : []);
const cut = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// M7: a link from a feed ends up as an href on the Provider status page. Only https links on a status host are kept
// (stspg.io is Atlassian Statuspage's own shortlink domain), so a feed can't put javascript: or a lookalike site there.
const LINK_HOSTS = ["stspg.io", "vercel-status.com", "cloudflarestatus.com", "supabase.com", "neonstatus.com", "status.io", "status.firebase.google.com", "status.cloud.google.com"];
export function safeLink(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && LINK_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)) ? u.toString() : null;
  } catch {
    return null;
  }
}
const INDICATOR: Record<string, Parsed["state"]> = { none: "ok", minor: "warn", major: "err", critical: "err", maintenance: "info" };

// Owner 19 Oct ("klo minor kuning"): a page's overall indicator also counts its components, and Cloudflare always has
// some of its 480 data centres down somewhere, so its indicator sits at "major" all the time. An open incident is
// coloured by its own impact instead; with none open, Cloudflare's data centres count only for the configured colos.
const IMPACT_RANK = ["none", "minor", "major", "critical"];
const IMPACT_STATE: Record<string, Parsed["state"]> = { none: "warn", minor: "warn", major: "err", critical: "err" };
const IMPACT_TEXT: Record<string, string> = { none: "Open incident", minor: "Minor incident", major: "Major incident", critical: "Critical incident" };

// 1.2.3 (owner 24 Oct): what Watchbell watches of a provider. Firebase: the products the console reads; an incident
// elsewhere (Test Lab, Crashlytics…) is grey information. Supabase: an incident only on the control plane (dashboard,
// Management API, billing…) isn't a database problem, so it is information too.
export const FIREBASE_USED = /firestore|authentication|hosting/i;
export const SUPABASE_CONTROL_PLANE = /management api|mgmt api|dashboard|billing|support|docs|marketplace|branching|^cli\b|analytics/i;
const productsLine = (p: string[]) => p.slice(0, 3).join(", ");

export function parseStatuspage(input: { status?: unknown; incidents?: unknown; maintenances?: unknown; components?: unknown }, opts: { colos?: string[]; controlPlane?: RegExp } = {}): Parsed | null {
  const status = obj(input.status);
  const indicator = str(status?.indicator);
  if (!status || !indicator || !(indicator in INDICATOR)) return null;
  const open = list(input.incidents);
  const incidents: FeedIncident[] = open.slice(0, 5).map((i) => {
    const products = list(i.components).map((c) => str(c.name)).filter((n): n is string => !!n).map((n) => cut(n, 60));
    return {
      name: cut(str(i.name) ?? "Incident"), impact: str(i.impact) ?? "unknown", startedAt: str(i.started_at) ?? str(i.created_at), url: safeLink(i.shortlink),
      ...(products.length ? { products } : {}), ...(str(i.updated_at) ? { updatedAt: str(i.updated_at) } : {}),
      // Supabase often lists no components (25 Oct: "Elevated Mgmt API Error Rates"), so the name decides then.
      ...(opts.controlPlane ? { relevant: products.length ? !products.every((p) => opts.controlPlane!.test(p)) : !opts.controlPlane.test(str(i.name) ?? "") } : {}),
    };
  });
  // Every open incident only on the control plane: information, named.
  if (opts.controlPlane && incidents.length && incidents.every((i) => i.relevant === false)) {
    const first = incidents[0];
    const prefix = first.products?.length ? `${productsLine(first.products)}: ` : "";
    const note = " (projects and databases aren't affected)";
    return { state: "info", indicator: "info", description: `${cut(`${prefix}${first.name}`, 160 - note.length)}${note}`, incidents };
  }
  const colos = (opts.colos ?? []).map((c) => c.replace(/\W/g, "")).filter(Boolean);
  const colo = colos.length ? new RegExp(`\\b(${colos.join("|")})\\b`) : null;
  const active = list(input.maintenances).filter((m) => ["in_progress", "verifying"].includes(str(m.status) ?? "") && (!colo || colo.test(str(m.name) ?? "")));
  const description = cut(str(status.description) ?? "");
  const maintenance = (): Parsed => {
    const m = active[0];
    return { state: "info", indicator: "maintenance", description: cut(`Scheduled maintenance · ${str(m.name) ?? ""}`),
      incidents: active.slice(0, 5).map((x) => ({ name: cut(str(x.name) ?? "Maintenance"), impact: "maintenance", startedAt: str(x.scheduled_for), url: safeLink(x.shortlink) })) };
  };
  if (open.length) {
    const counted = opts.controlPlane ? open.filter((_, n) => incidents[n]?.relevant !== false) : open;
    const worst = counted.map((i) => str(i.impact) ?? "").filter((i) => IMPACT_RANK.includes(i)).sort((a, b) => IMPACT_RANK.indexOf(b) - IMPACT_RANK.indexOf(a))[0] ?? "minor";
    const state = IMPACT_STATE[worst];
    // With components known (Supabase), name what the first counted incident affects.
    const named = opts.controlPlane ? incidents.find((i) => i.relevant !== false && i.products?.length) : undefined;
    const text = named ? cut(`${productsLine(named.products!)}: ${named.name}`) : state === INDICATOR[indicator] && indicator !== "none" ? description : IMPACT_TEXT[worst];
    return { state, indicator: worst, description: text, incidents };
  }
  const components = Array.isArray(input.components) ? list(input.components) : null;
  if (colos.length && components) {
    const near = new RegExp(`\\((${colos.join("|")})\\)\\s*$`);
    const down = components.filter((c) => near.test(str(c.name) ?? "") && (str(c.status) ?? "operational") !== "operational");
    if (down.length) {
      const c = down.find((x) => str(x.status) === "major_outage") ?? down[0];
      const major = str(c.status) === "major_outage";
      return { state: major ? "err" : "warn", indicator: major ? "major" : "minor",
        description: cut(`${near.exec(str(c.name) ?? "")?.[1]} data centre: ${(str(c.status) ?? "").replace(/_/g, " ")}`), incidents };
    }
    return active.length ? maintenance() : { state: "ok", indicator: "none", description: `No open incidents near ${colos.join(", ")}`, incidents };
  }
  if (indicator === "none" && active.length) return maintenance();
  return { state: INDICATOR[indicator], indicator, description, incidents };
}

const STATUS_IO: [number, Parsed["state"]][] = [[500, "err"], [300, "warn"], [200, "info"], [100, "ok"]];

export function parseStatusIo(json: unknown): Parsed | null {
  const overall = obj(obj(obj(json)?.result)?.status_overall);
  const code = typeof overall?.status_code === "number" ? overall.status_code : null;
  if (!overall || code === null) return null;
  const state = STATUS_IO.find(([min]) => code >= min)?.[1] ?? "ok";
  const incidents = list(obj(obj(json)?.result)?.incidents).slice(0, 5).map((i) => ({
    name: cut(str(i.name) ?? "Incident"), impact: "incident", startedAt: str(i.datetime_open), url: "https://neonstatus.com",
  }));
  return { state, indicator: String(code), description: cut(str(overall.status) ?? ""), incidents };
}

// `host` is the status site an incident's relative `uri` belongs to (Firebase's differs from Google Cloud's).
// `relevant` drops other products entirely (Google Cloud: only what Firebase rests on); `used` (Firebase, 1.2.3) keeps
// them as grey information and colours only the products Watchbell watches.
export function parseGoogle(json: unknown, now: Date, opts: { relevant?: RegExp; host?: string; used?: RegExp } = {}): Parsed | null {
  if (!Array.isArray(json)) return null;
  const host = opts.host ?? "status.cloud.google.com";
  const ongoing = list(json).filter((i) => {
    const end = str(i.end);
    return str(i.begin) !== null && (!end || new Date(end).getTime() > now.getTime());
  });
  const matters = (i: Record<string, unknown>) => !opts.relevant || list(i.affected_products).some((p) => opts.relevant!.test(str(p.title) ?? ""));
  const hits = ongoing.filter(matters);
  if (!hits.length) {
    const others = ongoing.length;
    return { state: "ok", indicator: "none", description: others && opts.relevant ? `No incidents affecting Firebase (${others} elsewhere)` : "No open incidents", incidents: [] };
  }
  const productsOf = (i: Record<string, unknown>) => list(i.affected_products).map((p) => str(p.title)).filter((t): t is string => !!t).map((t) => cut(t, 60));
  const isUsed = (i: Record<string, unknown>) => !opts.used || productsOf(i).some((t) => opts.used!.test(t));
  const incidents: FeedIncident[] = hits.slice(0, 5).map((i) => {
    const products = productsOf(i);
    return {
      name: cut(str(i.external_desc) ?? "Incident"), impact: str(i.status_impact) ?? "unknown", startedAt: str(i.begin),
      url: str(i.uri) ? safeLink(`https://${host}/${str(i.uri)}`) : null,
      ...(products.length ? { products } : {}), ...(str(i.modified) ? { updatedAt: str(i.modified) } : {}),
      ...(opts.used ? { relevant: isUsed(i) } : {}),
    };
  });
  const counted = hits.filter(isUsed);
  const label = (i: Record<string, unknown>) => {
    const p = productsOf(i);
    const desc = str(i.external_desc) ?? "Incident";
    return opts.used && p.length ? `${productsLine(p)}: ${desc}` : desc;
  };
  if (!counted.length) {
    // The note goes last and must survive the 160-character cut, so the incident text is shortened instead.
    const note = " (not Firestore, Authentication or Hosting)";
    return { state: "info", indicator: "info", description: `${cut(label(hits[0]), 160 - note.length)}${note}`, incidents };
  }
  const outage = counted.some((i) => i.status_impact === "SERVICE_OUTAGE");
  const info = counted.every((i) => i.status_impact === "SERVICE_INFORMATION");
  return { state: outage ? "err" : info ? "info" : "warn", indicator: outage ? "major" : info ? "info" : "minor", description: cut(label(counted[0])), incidents };
}

// 1.2.3 (owner 24 Oct): an incident whose feed hasn't changed for over a day is flagged; providers sometimes forget to
// close one, and it shouldn't read as current trouble without a word.
const STALE_MS = 24 * 3_600_000;
export function incidentNote(i: FeedIncident, now: Date): string | null {
  const last = Date.parse(i.updatedAt ?? i.startedAt ?? "");
  if (!Number.isFinite(last) || now.getTime() - last <= STALE_MS) return null;
  const days = Math.floor((now.getTime() - last) / (24 * 3_600_000));
  return `no update for ${days} day${days === 1 ? "" : "s"}, may be stale`;
}

// The line under a provider's status on the Provider status page: what is affected, the incident's name unless the
// status text above already says it (25 Oct: Firebase showed the same long sentence twice), whether Watchbell watches
// it, and the stale note.
export function incidentFacts(i: FeedIncident, statusText: string, now: Date): string {
  return [
    i.products?.length && !statusText.startsWith(productsLine(i.products)) ? productsLine(i.products) : null,
    statusText.includes(i.name) ? null : i.name,
    i.relevant === false ? "not something Watchbell watches" : null,
    incidentNote(i, now),
  ].filter(Boolean).join(" · ");
}

const MAX_BYTES = 1024 * 1024;

async function getJson(url: string, f: typeof fetch): Promise<{ ok: true; json: unknown } | { ok: false; status?: number; format?: boolean }> {
  const signal = AbortSignal.timeout(5000);
  let res: Response;
  try {
    res = await f(url, { headers: { Accept: "application/json", "User-Agent": "OpsConsole-Status/1.0" }, signal, cache: "no-store" });
  } catch {
    return { ok: false };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, status: res.status };
  }
  try {
    const { bytes, truncated } = await readCapped(res, MAX_BYTES, abortPromise(signal));
    if (truncated) return { ok: false, format: true };
    return { ok: true, json: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, format: true };
  }
}

const SP = (host: string) => `https://${host}/api/v2`;

export async function readFeed(p: FeedProvider, now: Date, opts: { fetch?: typeof fetch; colos?: string[] } = {}): Promise<{ ok: true; reading: FeedReading } | { ok: false; error: string }> {
  const f = opts.fetch ?? fetch;
  const label = FEEDS[p].label;
  const fail = (r: { status?: number; format?: boolean }) => ({
    ok: false as const,
    error: r.format ? `The ${label} status feed answered in a format the console doesn't recognise.` : r.status ? `The ${label} status feed answered ${r.status}.` : `The ${label} status feed didn't answer.`,
  });
  let parsed: Parsed | null = null;
  if (p === "vercel" || p === "supabase") {
    const r = await getJson(`${SP(p === "vercel" ? "www.vercel-status.com" : "status.supabase.com")}/summary.json`, f);
    if (!r.ok) return fail(r);
    const j = obj(r.json);
    parsed = j && parseStatuspage({ status: j.status, incidents: j.incidents, maintenances: j.scheduled_maintenances }, p === "supabase" ? { controlPlane: SUPABASE_CONTROL_PLANE } : {});
  } else if (p === "cloudflare") {
    const base = SP("www.cloudflarestatus.com");
    const [s, i, m, c] = await Promise.all([getJson(`${base}/status.json`, f), getJson(`${base}/incidents/unresolved.json`, f),
      getJson(`${base}/scheduled-maintenances/active.json`, f), getJson(`${base}/components.json`, f)]);
    if (!s.ok) return fail(s);
    parsed = parseStatuspage({ status: obj(s.json)?.status, incidents: i.ok ? obj(i.json)?.incidents : [], maintenances: m.ok ? obj(m.json)?.scheduled_maintenances : [],
      components: c.ok ? obj(c.json)?.components : undefined }, { colos: opts.colos ?? ["SIN", "CGK"] });
  } else if (p === "neon") {
    const r = await getJson("https://api.status.io/1.0/status/6878fc85709daa75be6c7e3c", f);
    if (!r.ok) return fail(r);
    parsed = parseStatusIo(r.json);
  } else {
    const host = p === "firebase" ? "status.firebase.google.com" : "status.cloud.google.com";
    const r = await getJson(`https://${host}/incidents.json`, f);
    if (!r.ok) return fail(r);
    parsed = parseGoogle(r.json, now, p === "gcp" ? { relevant: /firestore|firebase|identity|monitoring/i, host } : { host, used: FIREBASE_USED });
  }
  if (!parsed) return fail({ format: true });
  return { ok: true, reading: { provider: p, ...parsed } };
}
