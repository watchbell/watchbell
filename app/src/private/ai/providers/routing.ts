import { isAllowedModel } from "@/private/ai/types";
import { planModelSync } from "./model-sync";
import { CLOUDFLARE_MODEL_PREFIXES, CONSOLE_DEFAULT_MODEL, GATEWAY_MODEL_PREFIXES } from "./presets";

// Model routing (pure). Public model ids are "provider/model"; a bare id goes to the default connection (or to the
// key's pinned provider). No failover and no rotation between accounts: one id resolves to exactly one connection.

// `manual`: an id the owner added on a custom connection (one its /models doesn't list, e.g. a combo). Older rows have no
// `manual` key, so it is optional and absent means listed.
// `lastTest`: the latest one-model test from Models (Test / Scan all); optional, older rows have none.
export type ModelTest = { ok: boolean; ms: number; status?: number; error?: string; at: string };
// Model sync (owner 16 Oct, model-sync.ts): `removed` = no longer in the router's /models (kept, off, for history);
// `pending` = new or back in the list and waiting for its first sync test (off until it passes); `addedAt` = when
// a refresh first saw it (the "new" badge); `manualOff` = the owner switched it off on Models, so the sync leaves it.
export type StoredModel = {
  id: string; upstream: string; enabled: boolean; ctx?: number; out?: number; manual?: boolean; lastTest?: ModelTest;
  removed?: boolean; removedAt?: string; pending?: boolean; addedAt?: string; manualOff?: boolean;
};
// kind: "custom" = the owner's own server, whose every listed model is offered (owner 14 Oct); presets keep the filter.
export type RoutableConnection = { id: string; slug: string; enabled: boolean; isDefault: boolean; models: StoredModel[]; kind?: string };
export type RoutingPin = { providerId: string | null; model: string | null } | null;

export function splitModelId(id: string): { provider: string | null; model: string } {
  const s = id.trim();
  if (s.startsWith("@cf/")) return { provider: null, model: s }; // a full Workers AI id
  const i = s.indexOf("/");
  if (i <= 0) return { provider: null, model: s };
  const provider = s.slice(0, i).toLowerCase();
  const model = s.slice(i + 1);
  // Gemini's native names are "models/gemini-…"; that prefix is not a provider.
  if (provider === "models") return { provider: null, model };
  return { provider, model };
}

// Only Google models go through the gateway (owner): Gemini/Antigravity by name, and on Workers AI only
// "@cf/google/gemma…". Checked on the provider's own (upstream) id.
export function isGatewayModel(upstream: string): boolean {
  const s = upstream.trim();
  if (s.startsWith("@cf/")) return isAllowedModel(s, CLOUDFLARE_MODEL_PREFIXES);
  return isAllowedModel(splitModelId(s).model, GATEWAY_MODEL_PREFIXES);
}

// A manual model id (owner rule): 1–120 characters of letters, digits and . _ : / @ -.
export const MANUAL_MODEL_ID = /^[A-Za-z0-9._:/@-]{1,120}$/;

// What the gateway offers: on a preset (Gemini, Workers AI) listed models only when they are Google models
// (isGatewayModel); on a custom server (the owner's own) every model it lists (owner 14 Oct); a manual model always,
// because the owner added and tested it on purpose.
export function isOfferedModel(m: { upstream: string; manual?: boolean }, kind?: string): boolean {
  return m.manual === true || kind === "custom" || isGatewayModel(m.upstream);
}

// The id shown to callers for a model a provider lists: "models/gemini-3.8-flash" → "gemini-3.8-flash",
// "@cf/google/gemma-3-12b-it" → "gemma-3-12b-it" (mapped back through the stored model list).
export function publicModelName(upstream: string): string {
  return upstream.replace(/^models\//, "").replace(/^@cf\/[^/]+\//, "");
}

// The model a fresh connection turns on and the console uses: gemini-3.8-flash (owner), else on Workers AI the newest
// Gemma instruct model ("-it"), else the first listed.
export function pickDefaultModel<M extends { id: string; upstream: string }>(models: M[]): M | null {
  const preferred = models.find((m) => m.id === CONSOLE_DEFAULT_MODEL);
  if (preferred) return preferred;
  const version = (id: string) => (/gemma-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? "0").split(".").map(Number);
  const size = (id: string) => Number(/-(\d+(?:\.\d+)?)b-/.exec(`${id}-`)?.[1] ?? 0);
  const gemma = models.filter((m) => m.upstream.startsWith("@cf/google/gemma") && /(-it|instruct)(-|$)/.test(m.id));
  gemma.sort((a, b) => {
    const [va, vb] = [version(a.id), version(b.id)];
    for (let i = 0; i < Math.max(va.length, vb.length); i++) if ((vb[i] ?? 0) !== (va[i] ?? 0)) return (vb[i] ?? 0) - (va[i] ?? 0);
    return size(b.id) - size(a.id) || a.id.localeCompare(b.id);
  });
  return gemma[0] ?? models[0] ?? null;
}

export function publicId(conn: Pick<RoutableConnection, "slug">, model: Pick<StoredModel, "id">): string {
  return `${conn.slug}/${model.id}`;
}

export type RouteResult = { conn: RoutableConnection; model: StoredModel; publicId: string } | "provider_not_connected" | "model_not_enabled";

// The connection a bare id (or a provider-pinned key) goes to: the pinned one, else the default, else the only one.
export function defaultConnection<C extends RoutableConnection>(conns: C[], pinProviderId: string | null = null): C | null {
  const on = conns.filter((c) => c.enabled);
  if (pinProviderId) return on.find((c) => c.id === pinProviderId) ?? null;
  return on.find((c) => c.isDefault) ?? (on.length === 1 ? on[0] : null);
}

export function routeModel(conns: RoutableConnection[], requested: string, pin: RoutingPin): RouteResult {
  // A key pinned to one model always gets that model (the key's routing wins over the request).
  const wanted = (pin?.model ? pin.model : requested).trim();
  const { provider, model } = splitModelId(wanted);
  const enabled = conns.filter((c) => c.enabled);
  if (enabled.length === 0) return "provider_not_connected";
  let conn: RoutableConnection | null;
  // The ids to look for on the chosen connection. "test/ag/gemini-x" is model "ag/gemini-x" on "test"; a bare id whose
  // first segment is no connection ("ag/gemini-x", "openai/…") is looked up whole on the default connection, never
  // with its prefix stripped (so "openai/gemini-3.8-flash" can't reach gemini-3.8-flash).
  let wantedIds: string[];
  if (provider && conns.some((c) => c.slug === provider)) {
    conn = enabled.find((c) => c.slug === provider) ?? null;
    // A known but switched-off connection is "not connected".
    if (!conn) return "provider_not_connected";
    if (pin?.providerId && conn.id !== pin.providerId) return "model_not_enabled";
    wantedIds = [model];
  } else {
    conn = defaultConnection(conns, pin?.providerId ?? null);
    if (!conn) return "provider_not_connected";
    wantedIds = provider ? [wanted] : [...new Set([model, wanted])];
  }
  const m = conn.models.find((x) => x.enabled && (wantedIds.includes(x.id) || wantedIds.includes(x.upstream)));
  if (!m || !isOfferedModel(m, conn.kind)) return "model_not_enabled";
  return { conn, model: m, publicId: publicId(conn, m) };
}

// A refreshed model list (pure): every listed model keeps the owner's switch when it was known; a new one is on for a
// custom server (owner 14 Oct), else only `testModel` on a connection with nothing on yet. Models gone from /models are
// dropped; manual ids (never in /models) stay as they are, after the listed ones.
// A custom server that has a list already (owner 16 Oct, model sync): the sync's plan instead, so a vanished id is kept
// as removed and a new one waits, off, for its sync test (planModelSync).
export function mergeListedModels(previous: StoredModel[], listed: Omit<StoredModel, "enabled">[], kind: string, testModel: string | null, now: Date = new Date()): StoredModel[] {
  if (kind === "custom" && previous.length > 0) return planModelSync(previous, listed, now).models;
  const manual = previous.filter((p) => p.manual === true);
  const anyOn = previous.some((p) => p.enabled);
  return [
    ...listed.filter((m) => !manual.some((x) => x.id === m.id)).map((m) => {
      const prev = previous.find((p) => p.id === m.id);
      return { ...m, ...(prev?.lastTest ? { lastTest: prev.lastTest } : {}), enabled: prev?.enabled ?? (kind === "custom" || (!anyOn && m.id === testModel)) };
    }),
    ...manual,
  ];
}

// Custom connections whose list is older than `staleMs` (by the refresh marks, else never refreshed), enabled only.
export const MODELS_STALE_MS = 10 * 60_000;
export function staleModelLists<C extends { id: string; kind?: string; enabled: boolean }>(conns: C[], marks: Record<string, unknown>, now: Date, staleMs = MODELS_STALE_MS): C[] {
  return conns.filter((c) => {
    if (c.kind !== "custom" || !c.enabled) return false;
    const at = typeof marks[c.id] === "string" ? Date.parse(marks[c.id] as string) : NaN;
    return !Number.isFinite(at) || now.getTime() - at >= staleMs;
  });
}

// Which listed models a connect/replace test tries (owner 14 Oct: the alphabetical first model of a router can be one
// that is down, and a single 503 failed the whole replace). Presets: the one default pick. Custom servers, at most 3:
// models that were on and passed their last test, then other models that were on, then Gemini Flash (direct ids
// before agent "ag/" ones), then the rest in list order. A model that failed its last test only comes in that rest.
export function testCandidates<M extends { id: string; upstream: string }>(
  listed: M[], previous: Pick<StoredModel, "id" | "enabled" | "lastTest">[], kind: string,
): M[] {
  if (kind !== "custom") {
    const pick = pickDefaultModel(listed);
    return pick ? [pick] : [];
  }
  const prev = new Map(previous.map((p) => [p.id, p]));
  const passed = listed.filter((m) => prev.get(m.id)?.enabled && prev.get(m.id)?.lastTest?.ok === true);
  const wasOn = listed.filter((m) => prev.get(m.id)?.enabled && prev.get(m.id)?.lastTest?.ok !== false);
  const flash = listed.filter((m) => /gemini/i.test(m.id) && /flash/i.test(m.id))
    .sort((a, b) => Number(a.id.startsWith("ag/")) - Number(b.id.startsWith("ag/")) || b.id.localeCompare(a.id));
  const out: M[] = [];
  for (const m of [...passed, ...wasOn, ...flash, ...listed]) {
    if (!out.includes(m)) out.push(m);
    if (out.length === 3) break;
  }
  return out;
}
