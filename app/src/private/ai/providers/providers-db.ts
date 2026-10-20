import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import type { ActionResult } from "@/lib/action";
import { PROVIDERS_COPY } from "@/lib/copy/edition";
import { openOrNull, seal } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { type OwnLimit, quotaGroups, type QuotaGroup } from "@/private/ai/quota";
import { AI_DEFAULT_MODEL_SETTING } from "@/private/ai/types";
import { aiProviders, aiQuota } from "@/private/db/schema";
import { pendingIds, SYNC_SETTING } from "./model-sync";
import { models as listUpstreamModels, type OpenConnection, testGenerate, UpstreamError } from "./adapter";
import { type ConnectForm, isPresetKind, keyHint, type PresetKind, PRESETS, providerSlug, type ProviderSecret, validateForm } from "./presets";
import { isOfferedModel, MANUAL_MODEL_ID, mergeListedModels, routeModel, type RoutingPin, type StoredModel, staleModelLists, testCandidates } from "./routing";

// Provider connections in ops.ai_providers. The secret is sealed as one JSON string (R3) and opened only here; the
// UI gets ConnectionView (keyHint = last 3 characters). Reads for the gateway go through a 60 s in-memory cache,
// dropped on every write made by this instance.

export type ConnectionView = {
  id: string; kind: PresetKind; name: string; slug: string; baseUrl: string; keyHint: string; enabled: boolean; isDefault: boolean;
  models: StoredModel[]; limits: OwnLimit[]; lastTestAt: Date | null; lastTestStatus: number | null; lastError: string | null; createdAt: Date;
};

// Never ciphertext or iv (R3).
const VIEW = {
  id: aiProviders.id, kind: aiProviders.kind, name: aiProviders.name, baseUrl: aiProviders.baseUrl, keyHint: aiProviders.keyHint,
  enabled: aiProviders.enabled, isDefault: aiProviders.isDefault, models: aiProviders.models, limits: aiProviders.limits,
  lastTestAt: aiProviders.lastTestAt, lastTestStatus: aiProviders.lastTestStatus, lastError: aiProviders.lastError, createdAt: aiProviders.createdAt,
};

export const MAX_CONNECTIONS = 5;
export const MAX_CUSTOM = 3;
const CACHE_MS = 60_000;

let cache: { at: number; conns: OpenConnection[] } | null = null;
export function dropConnectionCache(): void {
  cache = null;
}

function toView(r: { kind: string; name: string } & Omit<ConnectionView, "kind" | "slug">): ConnectionView {
  const kind = (isPresetKind(r.kind) ? r.kind : "custom") as PresetKind;
  return { ...r, kind, slug: providerSlug(kind, r.name) };
}

export async function listConnections(): Promise<ConnectionView[]> {
  const rows = await db().select(VIEW).from(aiProviders).orderBy(asc(aiProviders.createdAt));
  return rows.map(toView);
}

// Every connection with its secret opened, for the gateway. A secret that can't be opened (encryption key changed)
// or a kind without a preset (Cloudflare/Groq/OpenRouter were dropped) leaves that connection out.
// `fresh` skips the cache (the connection Test must use what is stored now, not this instance's copy).
export async function openConnections(now = Date.now(), fresh = false): Promise<OpenConnection[]> {
  if (!fresh && cache && now - cache.at < CACHE_MS) return cache.conns;
  const rows = await db().select().from(aiProviders);
  const key = serverEnv().OPS_ENCRYPTION_KEY;
  const conns: OpenConnection[] = [];
  for (const r of rows) {
    if (!isPresetKind(r.kind)) continue;
    const plain = openOrNull({ ciphertext: r.ciphertext, iv: r.iv }, key);
    if (!plain) continue;
    let secret: ProviderSecret;
    try { secret = JSON.parse(plain) as ProviderSecret; } catch { continue; }
    conns.push({
      id: r.id, kind: r.kind, name: r.name, slug: providerSlug(r.kind, r.name), baseUrl: r.baseUrl, secret,
      enabled: r.enabled, isDefault: r.isDefault, models: r.models, limits: r.limits, updatedAt: r.updatedAt,
    });
  }
  cache = { at: now, conns };
  return conns;
}

export async function openConnection(id: string): Promise<OpenConnection | null> {
  return (await openConnections()).find((c) => c.id === id) ?? null;
}

// The owner's default model for the console's own AI (Models page "Make default"), or null when unset/unreadable.
// One primary-key read; a failure only falls back to the provider's own default.
export async function consoleDefaultModel(): Promise<string | null> {
  try {
    const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, AI_DEFAULT_MODEL_SETTING)).limit(1);
    return typeof row?.value === "string" && row.value.trim() ? row.value.trim() : null;
  } catch {
    console.warn("reading ai.defaultModel failed; using the provider's default model");
    return null;
  }
}

export async function resolveModel(model: string, pin: RoutingPin): Promise<{ conn: OpenConnection; upstream: string; publicId: string } | "provider_not_connected" | "model_not_enabled"> {
  const conns = await openConnections();
  const r = routeModel(conns, model, pin);
  if (typeof r === "string") return r;
  return { conn: r.conn as OpenConnection, upstream: r.model.upstream, publicId: r.publicId };
}

// Lists the models, then makes one tiny generation call (owner finding 07:58: listing alone can succeed on a project
// that is denied generation). Keeps the owner's enabled choices; a fresh connection gets the default model on.
type Probe = { ok: true; models: StoredModel[]; ms: number; testModel: string } | { ok: false; error: string; status: number };

async function probe(kind: PresetKind, name: string, baseUrl: string, secret: ProviderSecret, previous: StoredModel[] = []): Promise<Probe> {
  const conn = { kind, name, baseUrl, secret };
  let listed;
  try {
    listed = await listUpstreamModels(conn);
  } catch (e) {
    if (e instanceof UpstreamError) return { ok: false, error: e.message, status: e.info.status };
    throw e;
  }
  // Manual ids (custom connections) are never in /models: they are kept as they are, and when the server lists no
  // Google model the first enabled manual one is what the tiny generation tests.
  const manual = previous.filter((p) => p.manual === true);
  const candidates: { id: string; upstream: string }[] = testCandidates(listed, previous, kind);
  if (!candidates.length) {
    const m = manual.find((x) => x.enabled);
    if (m) candidates.push(m);
  }
  if (!candidates.length) return { ok: false, error: kind === "custom" ? `${name} answered but lists no models.` : PROVIDERS_COPY.noGoogleModels(name), status: 200 };
  // Custom servers: up to 3 models within ~50 s (Vercel allows 60), so one model that is down doesn't fail the whole
  // connection. The error names what was tried.
  const deadline = Date.now() + 50_000;
  const tried: string[] = [];
  let last: { ok: false; status: number; error: string } | null = null;
  for (const c of candidates) {
    const left = deadline - Date.now();
    if (left < 5_000) break;
    const t = await testGenerate(conn, c.upstream, Math.min(25_000, left), kind === "custom" ? 512 : 16);
    if (t.ok) return { ok: true, models: mergeListedModels(previous, listed, kind, c.id), ms: t.ms, testModel: c.id };
    tried.push(c.id);
    last = t;
  }
  const error = tried.length > 1 ? `${last?.error ?? "Test failed."} Tried ${tried.join(", ")}.` : (last?.error ?? "Test failed.");
  return { ok: false, error, status: last?.status ?? 0 };
}

function sealSecret(secret: ProviderSecret) {
  return seal(JSON.stringify(secret), serverEnv().OPS_ENCRYPTION_KEY);
}

export async function connect(kindRaw: string, form: ConnectForm): Promise<ActionResult<{ id: string; models: string[] }>> {
  if (!isPresetKind(kindRaw)) return { ok: false, error: "That provider isn't offered." };
  const kind = kindRaw;
  const v = validateForm(kind, form);
  if (!v.ok) return { ok: false, error: Object.values(v.fieldErrors)[0], fieldErrors: v.fieldErrors };
  const existing = await db().select({ id: aiProviders.id, kind: aiProviders.kind, name: aiProviders.name, isDefault: aiProviders.isDefault }).from(aiProviders);
  if (existing.length >= MAX_CONNECTIONS) return { ok: false, error: `At most ${MAX_CONNECTIONS} provider connections. Remove one first.` };
  if (kind !== "custom" && existing.some((e) => e.kind === kind)) return { ok: false, error: `${PRESETS[kind].name} is already connected. Replace its key instead.` };
  if (kind === "custom") {
    if (existing.filter((e) => e.kind === "custom").length >= MAX_CUSTOM) return { ok: false, error: `At most ${MAX_CUSTOM} custom connections.` };
    const slug = providerSlug(kind, v.value.name);
    if (existing.some((e) => e.kind === "custom" && providerSlug("custom", e.name) === slug)) {
      return { ok: false, error: "A connection with that name exists.", fieldErrors: { name: "A connection with that name exists." } };
    }
  }
  const p = await probe(kind, v.value.name, v.value.baseUrl, v.value.secret);
  if (!p.ok) return { ok: false, error: p.error };
  const sealed = sealSecret(v.value.secret);
  const makeDefault = form.makeDefault === true || !existing.some((e) => e.isDefault);
  const now = new Date();
  const id = await db().transaction(async (tx) => {
    if (makeDefault) await tx.update(aiProviders).set({ isDefault: false }).where(eq(aiProviders.isDefault, true));
    const [row] = await tx.insert(aiProviders).values({
      kind, name: v.value.name, baseUrl: v.value.baseUrl, ciphertext: sealed.ciphertext, iv: sealed.iv, keyVersion: sealed.keyVersion,
      keyHint: keyHint(v.value.secret.apiKey), enabled: true, isDefault: makeDefault, models: p.models, limits: [],
      lastTestAt: now, lastTestStatus: 200, lastError: null, updatedAt: now,
    }).returning({ id: aiProviders.id });
    return row?.id ?? "";
  });
  dropConnectionCache();
  return { ok: true, message: `${v.value.name} answered in ${p.ms} ms and listed ${p.models.length} model${p.models.length === 1 ? "" : "s"}. ${kind === "custom" ? "Every listed model is on; switch any off under Models." : `${p.testModel} is on; turn on others under Models.`}`, data: { id, models: p.models.map((m) => m.id) } };
}

async function rowFor(id: string) {
  const [row] = await db().select({ ...VIEW }).from(aiProviders).where(eq(aiProviders.id, id)).limit(1);
  return row ? toView(row) : null;
}

export async function replaceSecret(id: string, form: ConnectForm): Promise<ActionResult<{ name: string; kind: string; models: string[] }>> {
  const row = await rowFor(id);
  if (!row) return { ok: false, error: "That connection no longer exists." };
  const v = validateForm(row.kind, { ...form, name: row.name, baseUrl: row.kind === "custom" ? form.baseUrl || row.baseUrl : undefined });
  if (!v.ok) return { ok: false, error: Object.values(v.fieldErrors)[0], fieldErrors: v.fieldErrors };
  const p = await probe(row.kind, row.name, v.value.baseUrl, v.value.secret, row.models);
  if (!p.ok) return { ok: false, error: p.error };
  const sealed = sealSecret(v.value.secret);
  const now = new Date();
  await db().update(aiProviders).set({
    ciphertext: sealed.ciphertext, iv: sealed.iv, keyVersion: sealed.keyVersion, keyHint: keyHint(v.value.secret.apiKey), baseUrl: v.value.baseUrl,
    models: p.models, lastTestAt: now, lastTestStatus: 200, lastError: null, updatedAt: now,
  }).where(eq(aiProviders.id, id));
  dropConnectionCache();
  return { ok: true, message: `${row.name}: new key works (${p.ms} ms). Model list refreshed.`, data: { name: row.name, kind: row.kind, models: p.models.map((m) => m.id) } };
}

export async function testConnection(id: string): Promise<ActionResult> {
  const conn = (await openConnections(Date.now(), true)).find((c) => c.id === id);
  if (!conn) {
    const row = await rowFor(id);
    return row ? { ok: false, error: "Can't read the stored key. The encryption key changed. Replace the key." } : { ok: false, error: "That connection no longer exists." };
  }
  const p = await probe(conn.kind, conn.name, conn.baseUrl, conn.secret, conn.models);
  const now = new Date();
  await db().update(aiProviders).set(p.ok
    ? { models: p.models, lastTestAt: now, lastTestStatus: 200, lastError: null, updatedAt: now }
    : { lastTestAt: now, lastTestStatus: p.status, lastError: p.error, updatedAt: now }).where(eq(aiProviders.id, id));
  dropConnectionCache();
  if (p.ok && pendingIds(p.models).length) await markSyncPending(now);
  return p.ok ? { ok: true, message: `${conn.name} answered in ${p.ms} ms. Model list refreshed.` } : { ok: false, error: p.error };
}

export async function setEnabled(id: string, on: boolean): Promise<ActionResult> {
  const r = await db().update(aiProviders).set({ enabled: on, updatedAt: new Date() }).where(eq(aiProviders.id, id)).returning({ name: aiProviders.name });
  dropConnectionCache();
  return r[0] ? { ok: true, message: `${r[0].name}: ${on ? "on" : "off"}. Takes effect on the next request.` } : { ok: false, error: "That connection no longer exists." };
}

export async function makeDefault(id: string): Promise<ActionResult> {
  const name = await db().transaction(async (tx) => {
    await tx.update(aiProviders).set({ isDefault: false }).where(eq(aiProviders.isDefault, true));
    const r = await tx.update(aiProviders).set({ isDefault: true, updatedAt: new Date() }).where(eq(aiProviders.id, id)).returning({ name: aiProviders.name });
    return r[0]?.name ?? null;
  });
  dropConnectionCache();
  return name ? { ok: true, message: `${name} is the default provider.` } : { ok: false, error: "That connection no longer exists." };
}

export async function removeConnection(id: string): Promise<ActionResult<{ name: string; kind: string }>> {
  const r = await db().delete(aiProviders).where(eq(aiProviders.id, id)).returning({ name: aiProviders.name, kind: aiProviders.kind });
  dropConnectionCache();
  return r[0] ? { ok: true, message: `${r[0].name} removed. Its key is deleted.`, data: { name: r[0].name, kind: r[0].kind } } : { ok: false, error: "That connection no longer exists." };
}

export async function setModelEnabled(id: string, modelId: string, on: boolean): Promise<ActionResult> {
  const row = await rowFor(id);
  if (!row) return { ok: false, error: "That connection no longer exists." };
  const model = row.models.find((m) => m.id === modelId);
  if (model && !isOfferedModel(model, row.kind)) return { ok: false, error: PROVIDERS_COPY.onlyGoogleOffered };
  if (!model) return { ok: false, error: "That model isn't on this connection's list. Test the connection to refresh it." };
  if (on && model.removed) return { ok: false, error: `${row.name} no longer lists ${modelId}. Turn it on there first; the sync brings it back.` };
  // Model sync (owner 16 Oct): a model the owner switches off is marked manualOff so the sync never turns it on again;
  // switching it on clears the mark (and a pending test: the owner chose it).
  const models = row.models.map((m) => {
    if (m.id !== modelId) return m;
    const rest = { ...m };
    delete rest.manualOff;
    delete rest.pending;
    return on ? { ...rest, enabled: true } : { ...rest, enabled: false, manualOff: true };
  });
  await db().update(aiProviders).set({ models, updatedAt: new Date() }).where(eq(aiProviders.id, id));
  dropConnectionCache();
  return { ok: true, message: `${row.slug}/${modelId}: ${on ? "on" : "off"}.` };
}

export const MAX_MANUAL_MODELS = 20;
const BAD_MODEL_ID = "Use 1–120 letters, digits or . _ : / @ - for the model id.";

// A model id the custom server doesn't list in /models (for example a combo on the owner's own router). One tiny
// completion with it must succeed before it is stored as { manual: true }; a refusal is the provider's short message
// (upstreamMessage: never its body, never the key). Uses the stored secret as it is now, not this instance's cache.
export async function addManualModel(id: string, modelId: string): Promise<ActionResult<{ name: string }>> {
  if (!MANUAL_MODEL_ID.test(modelId)) return { ok: false, error: BAD_MODEL_ID };
  const conn = (await openConnections(Date.now(), true)).find((c) => c.id === id);
  if (!conn) {
    const row = await rowFor(id);
    return row ? { ok: false, error: "Can't read the stored key. The encryption key changed. Replace the key." } : { ok: false, error: "That connection no longer exists." };
  }
  if (conn.kind !== "custom") return { ok: false, error: "Model ids can be added on custom connections only." };
  if (conn.models.some((m) => m.id === modelId || m.upstream === modelId)) return { ok: false, error: `${conn.name} already has ${modelId}.` };
  if (conn.models.filter((m) => m.manual).length >= MAX_MANUAL_MODELS) return { ok: false, error: `At most ${MAX_MANUAL_MODELS} added model ids per connection. Remove one first.` };
  // A manual id is often a router combo: its first model may think (16 tokens is too few) or fall back in turn.
  const t = await testGenerate(conn, modelId, 45_000, 512);
  if (!t.ok) return { ok: false, error: `The server refused that model: ${t.error}` };
  const models: StoredModel[] = [...conn.models, { id: modelId, upstream: modelId, enabled: true, manual: true }];
  await db().update(aiProviders).set({ models, updatedAt: new Date() }).where(eq(aiProviders.id, id));
  dropConnectionCache();
  return { ok: true, message: `${conn.name} answered with ${modelId}. It is on as ${conn.slug}/${modelId}.`, data: { name: conn.name } };
}

export async function removeManualModel(id: string, modelId: string): Promise<ActionResult<{ name: string }>> {
  const row = await rowFor(id);
  if (!row) return { ok: false, error: "That connection no longer exists." };
  if (!row.models.some((m) => m.id === modelId && m.manual === true)) return { ok: false, error: "Only model ids you added can be removed." };
  const models = row.models.filter((m) => !(m.id === modelId && m.manual === true));
  await db().update(aiProviders).set({ models, updatedAt: new Date() }).where(eq(aiProviders.id, id));
  dropConnectionCache();
  return { ok: true, message: `${row.slug}/${modelId} removed.`, data: { name: row.name } };
}

// Key routing pins (keys/actions): is `model` ("<slug>/<id>" or "<id>") a manual id on this connection, or (custom
// servers, owner 14 Oct) any model it lists?
export async function hasManualModel(providerId: string, model: string): Promise<boolean> {
  const row = await rowFor(providerId);
  if (!row) return false;
  const bare = model.startsWith(`${row.slug}/`) ? model.slice(row.slug.length + 1) : model;
  return row.models.some((m) => !m.removed && (m.manual === true || row.kind === "custom") && (m.id === bare || m.id === model));
}

const LimitsSchema = z.array(z.strictObject({
  metric: z.enum(["requests", "tokens"]),
  scope: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  limit: z.number().int().min(1).max(1_000_000_000_000),
  window: z.enum(["minute", "day", "week"]),
})).max(10);

export async function setLimits(id: string, limits: unknown): Promise<ActionResult> {
  const parsed = LimitsSchema.safeParse(limits);
  if (!parsed.success) return { ok: false, error: `Limits: ${parsed.error.issues[0]?.message ?? "invalid"}.` };
  const r = await db().update(aiProviders).set({ limits: parsed.data, updatedAt: new Date() }).where(eq(aiProviders.id, id)).returning({ name: aiProviders.name });
  dropConnectionCache();
  return r[0] ? { ok: true, message: "Limits saved." } : { ok: false, error: "That connection no longer exists." };
}

// For the Quota page (Task 4).
export async function quotaRows(now: Date): Promise<QuotaGroup[]> {
  const [stored, conns] = await Promise.all([
    db().select().from(aiQuota),
    db().select({ id: aiProviders.id, kind: aiProviders.kind, name: aiProviders.name, limits: aiProviders.limits }).from(aiProviders).orderBy(asc(aiProviders.createdAt)),
  ]);
  return quotaGroups(stored, conns, now);
}

// ---- Custom servers' model lists, re-detected (owner 14 Oct). ----

// New models wait (off) for the model sync's test: ask the minute step for a run within minutes instead of 6 h.
// A jsonb merge, so the sync's other fields stay. Never fails the caller.
export async function markSyncPending(now: Date): Promise<void> {
  try {
    await db().insert(settings).values({ key: SYNC_SETTING, value: { lastRunAt: null, pending: true } })
      .onConflictDoUpdate({ target: settings.key, set: { value: sql`${settings.value} || '{"pending":true}'::jsonb`, updatedAt: now } });
  } catch {
    console.warn("model sync: marking new models failed");
  }
}

export const MODELS_REFRESHED_SETTING = "ai.modelsRefreshedAt"; // { [providerId]: ISO time of the last list refresh }

// Lists the models of every enabled custom connection whose list is older than 10 minutes and stores the merged list
// (no generation call). The marks are written BEFORE the upstream calls, so page loads on other instances don't
// repeat the work. Returns the ids refreshed. A failing server keeps its old list.
export async function refreshStaleModelLists(now: Date = new Date()): Promise<string[]> {
  const conns = await openConnections(now.getTime());
  if (!conns.some((c) => c.kind === "custom" && c.enabled)) return [];
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, MODELS_REFRESHED_SETTING)).limit(1);
  const marks = row?.value && typeof row.value === "object" && !Array.isArray(row.value) ? (row.value as Record<string, unknown>) : {};
  const due = staleModelLists(conns, marks, now);
  if (due.length === 0) return [];
  const value = { ...Object.fromEntries(Object.entries(marks).filter(([id]) => conns.some((c) => c.id === id))), ...Object.fromEntries(due.map((c) => [c.id, now.toISOString()])) };
  await db().insert(settings).values({ key: MODELS_REFRESHED_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
  const fresh = await openConnections(now.getTime(), true);
  const done: string[] = [];
  for (const c of due) {
    const conn = fresh.find((x) => x.id === c.id);
    if (!conn) continue;
    try {
      const listed = await listUpstreamModels(conn, 10_000);
      const models = mergeListedModels(conn.models, listed, conn.kind, null, now);
      await db().update(aiProviders).set({ models, updatedAt: new Date() }).where(eq(aiProviders.id, conn.id));
      done.push(conn.id);
      if (pendingIds(models).length) await markSyncPending(now);
    } catch (e) {
      console.warn("model list refresh failed:", e instanceof Error ? e.name : "unknown");
    }
  }
  if (done.length) dropConnectionCache();
  return done;
}
