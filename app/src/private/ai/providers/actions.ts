"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { recordEvents } from "@/lib/data/events-write";
import { type ConnectForm, isPresetKind, PRESETS } from "./presets";
import * as store from "./providers-db";
import { MANUAL_MODEL_ID } from "./routing";

// Owner-only Server Actions for provider connections (R2: every one goes through runGuarded("owner")). Connect,
// Replace and Test call the provider, so they share the console's credential-test limit (LIMITS.credential).
// Task 4's Models and Quota pages use setProviderModel / makeDefaultProvider / setProviderLimits from here.

const deps = { requireActionMember };
const Id = z.uuid();
const Form = z.object({
  apiKey: z.string().max(500).optional(), accountId: z.string().max(64).optional(), baseUrl: z.string().max(300).optional(),
  name: z.string().max(60).optional(), makeDefault: z.boolean().optional(),
});

function refresh() {
  for (const p of ["/ai", "/ai/providers", "/ai/models", "/ai/quota", "/ai/playground"]) revalidatePath(p);
}

// Audit (spec §12), like API key changes: who connected, re-keyed or removed which provider. Name and kind only, never
// the key or its hint. A failed audit must not undo or hide the change, so it only warns.
type ProviderReason = "AiProviderConnected" | "AiProviderKeyReplaced" | "AiProviderRemoved" | "AiModelAdded" | "AiModelRemoved";
async function audit(reason: ProviderReason, message: string, kind: string, by: string): Promise<void> {
  try {
    await recordEvents([{ type: "action", kind: "ok", message: message.slice(0, 200), detail: `provider ${kind}`, resourceId: null, actorUserId: by, reason }]);
  } catch {
    console.warn("provider audit failed");
  }
}

// The store's result without its data (name/kind are for the audit line only).
const plain = <T,>(r: ActionResult<T>): ActionResult => (r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error, fieldErrors: r.fieldErrors });

const gone: ActionResult = { ok: false, error: "That connection no longer exists." };

async function throttled(memberId: string): Promise<ActionResult | null> {
  const q = await limit(LIMITS.credential, memberId);
  return q.allowed ? null : { ok: false, error: `Too many connection tests. Try again in ${minutesText(q.retryAfter)}.` };
}

export async function connectProvider(kind: string, form: ConnectForm): Promise<ActionResult<{ id: string; models: string[] }>> {
  return runGuarded("owner", async (member): Promise<ActionResult<{ id: string; models: string[] }>> => {
    const f = Form.safeParse(form);
    if (!f.success) return { ok: false, error: "Check the fields." };
    const t = await throttled(member.id);
    if (t) return t as ActionResult<{ id: string; models: string[] }>;
    const r = await store.connect(kind, f.data);
    if (r.ok) {
      refresh();
      const name = kind === "custom" ? f.data.name?.trim() || "Custom" : isPresetKind(kind) ? PRESETS[kind].name : kind;
      await audit("AiProviderConnected", `AI provider connected: ${name}`, kind, member.userId);
    }
    return r;
  }, deps);
}

// The detected model ids come back too (owner 14 Oct: the dialog shows the exact names before it closes).
export async function replaceProviderKey(id: string, form: ConnectForm): Promise<ActionResult<{ models: string[] }>> {
  return runGuarded("owner", async (member): Promise<ActionResult<{ models: string[] }>> => {
    const f = Form.safeParse(form);
    if (!Id.safeParse(id).success || !f.success) return gone;
    const t = await throttled(member.id);
    if (t) return t;
    const r = await store.replaceSecret(id, f.data);
    if (r.ok) {
      refresh();
      if (r.data) await audit("AiProviderKeyReplaced", `AI provider key replaced: ${r.data.name}`, r.data.kind, member.userId);
      return { ok: true, message: r.message, data: { models: r.data?.models ?? [] } };
    }
    return plain(r) as ActionResult<{ models: string[] }>;
  }, deps);
}

export async function testProvider(id: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (!Id.safeParse(id).success) return gone;
    const t = await throttled(member.id);
    if (t) return t;
    const r = await store.testConnection(id);
    refresh();
    return r;
  }, deps);
}

export async function setProviderEnabled(id: string, on: boolean): Promise<ActionResult> {
  return runGuarded("owner", async (): Promise<ActionResult> => {
    if (!Id.safeParse(id).success) return gone;
    const r = await store.setEnabled(id, on === true);
    refresh();
    return r;
  }, deps);
}

export async function makeDefaultProvider(id: string): Promise<ActionResult> {
  return runGuarded("owner", async (): Promise<ActionResult> => {
    if (!Id.safeParse(id).success) return gone;
    const r = await store.makeDefault(id);
    refresh();
    return r;
  }, deps);
}

export async function removeProvider(id: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (!Id.safeParse(id).success) return gone;
    const r = await store.removeConnection(id);
    refresh();
    if (r.ok && r.data) await audit("AiProviderRemoved", `AI provider removed: ${r.data.name}`, r.data.kind, member.userId);
    return plain(r);
  }, deps);
}

export async function setProviderModel(id: string, modelId: string, on: boolean): Promise<ActionResult> {
  return runGuarded("owner", async (): Promise<ActionResult> => {
    if (!Id.safeParse(id).success || typeof modelId !== "string" || modelId.length > 200) return gone;
    const r = await store.setModelEnabled(id, modelId, on === true);
    refresh();
    return r;
  }, deps);
}

export async function setProviderLimits(id: string, limits: unknown): Promise<ActionResult> {
  return runGuarded("owner", async (): Promise<ActionResult> => {
    if (!Id.safeParse(id).success) return gone;
    const r = await store.setLimits(id, limits);
    refresh();
    return r;
  }, deps);
}

// Manual model ids on a custom connection (ids its /models doesn't list, e.g. a combo). Adding one makes one tiny
// completion with it first (in the store). Both use the console's write limit; the audit line names the provider and
// the model id.
const BAD_MODEL_ID: ActionResult = { ok: false, error: "Use 1–120 letters, digits or . _ : / @ - for the model id." };

async function writeThrottled(memberId: string): Promise<ActionResult | null> {
  const q = await limit(LIMITS.monitorWrite, memberId);
  return q.allowed ? null : { ok: false, error: `Too many changes. Try again in ${minutesText(q.retryAfter)}.` };
}

function manualId(modelId: unknown): string | null {
  const m = typeof modelId === "string" ? modelId.trim() : "";
  return MANUAL_MODEL_ID.test(m) ? m : null;
}

export async function addManualModel(providerId: string, modelId: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    const m = manualId(modelId);
    if (!m) return BAD_MODEL_ID;
    if (!Id.safeParse(providerId).success) return gone;
    const t = await writeThrottled(member.id);
    if (t) return t;
    const r = await store.addManualModel(providerId, m);
    if (r.ok) {
      refresh();
      if (r.data) await audit("AiModelAdded", `AI model added on ${r.data.name}: ${m}`, "custom", member.userId);
    }
    return plain(r);
  }, deps);
}

export async function removeManualModel(providerId: string, modelId: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    const m = manualId(modelId);
    if (!m) return BAD_MODEL_ID;
    if (!Id.safeParse(providerId).success) return gone;
    const t = await writeThrottled(member.id);
    if (t) return t;
    const r = await store.removeManualModel(providerId, m);
    if (r.ok) {
      refresh();
      if (r.data) await audit("AiModelRemoved", `AI model removed from ${r.data.name}: ${m}`, "custom", member.userId);
    }
    return plain(r);
  }, deps);
}
