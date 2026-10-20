"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { KEYS_COPY } from "@/lib/copy/edition";
import { GATEWAY_MODEL_PREFIXES } from "@/private/ai/providers/presets";
import { hasManualModel } from "@/private/ai/providers/providers-db";
import { MANUAL_MODEL_ID } from "@/private/ai/providers/routing";
import { isAllowedModel } from "@/private/ai/types";
import { expiryDate, keyFormSchema, rateSchema, renameSchema } from "./key";
import { createKey, KeyLimitError, KeyNameTakenError, KeyNotFoundError, revokeKey, updateKey } from "./keys-db";
import { EXPIRY_CHOICES, KEY_LIMIT_MESSAGE } from "./scopes";

// R2: every action here is the owner's alone, checked again on the server whatever the page showed.
const deps = { requireActionMember };

const NAME_TAKEN = "A key with this name exists.";
const GONE = "That key is already revoked or gone.";

export type CreatedKey = { key: string; name: string; prefix: string };

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    if (!(field in out)) out[field] = issue.message;
  }
  return out;
}

// Only the Create key dialog ever receives the secret, once, in this answer. It is not logged and not stored.
export async function createKeyAction(input: unknown): Promise<ActionResult<CreatedKey>> {
  return runGuarded("owner", async (actor) => {
    const parsed = keyFormSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    try {
      const { key, row } = await createKey(parsed.data, actor.id);
      revalidatePath("/ai/keys");
      return { ok: true, message: `Key ${row.name} created.`, data: { key, name: row.name, prefix: row.prefix } };
    } catch (e) {
      if (e instanceof KeyLimitError) return { ok: false, error: KEY_LIMIT_MESSAGE };
      if (e instanceof KeyNameTakenError) return { ok: false, error: "Check the highlighted fields.", fieldErrors: { name: NAME_TAKEN } };
      throw e;
    }
  }, deps);
}

export async function revokeKeyAction(id: unknown): Promise<ActionResult> {
  return runGuarded("owner", async (actor) => {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) return { ok: false, error: GONE };
    try {
      await revokeKey(parsed.data, actor.id);
    } catch (e) {
      if (e instanceof KeyNotFoundError) return { ok: false, error: GONE };
      throw e;
    }
    revalidatePath("/ai/keys");
    revalidatePath("/ai/agents");
    return { ok: true, message: "Key revoked. Calls with it answer 401 within a minute." };
  }, deps);
}

// A pinned model must be one the gateway may serve at all (Gemini only, owner ruling 13 Oct; a provider prefix is
// stripped first, as the gateway does), or a model id the owner added on the pinned custom provider (checked against
// the stored list in changeKeyAction, since that needs a read).
const PIN_MESSAGE = KEYS_COPY.pinMessage;
const googlePin = (m: string) => isAllowedModel(m.includes("/") ? m.slice(m.indexOf("/") + 1) : m, GATEWAY_MODEL_PREFIXES);
const modelPin = z.string().trim().max(240).transform((m) => (m === "" ? null : m)).nullable().refine(
  (m) => m === null || googlePin(m) || (MANUAL_MODEL_ID.test(m) && m.length <= 161),
  PIN_MESSAGE,
);

const changeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("rename"), name: renameSchema }),
  z.strictObject({ kind: z.literal("rate"), ratePerMin: rateSchema }),
  z.strictObject({ kind: z.literal("expiry"), expiry: z.enum(EXPIRY_CHOICES) }),
  z.strictObject({ kind: z.literal("routing"), providerId: z.uuid().nullable(), model: modelPin }),
]);

// Rename, Change rate limit, Change expiry (counted from now), Change routing. Applies within a minute at most.
export async function changeKeyAction(id: unknown, change: unknown): Promise<ActionResult> {
  return runGuarded("owner", async (actor) => {
    const keyId = z.uuid().safeParse(id);
    if (!keyId.success) return { ok: false, error: GONE };
    const parsed = changeSchema.safeParse(change);
    if (!parsed.success) return { ok: false, error: "Check the highlighted fields.", fieldErrors: fieldErrors(parsed.error) };
    const c = parsed.data;
    if (c.kind === "routing" && c.providerId !== null && c.model !== null && !googlePin(c.model) && !(await hasManualModel(c.providerId, c.model))) {
      return { ok: false, error: "Check the highlighted fields.", fieldErrors: { model: PIN_MESSAGE } };
    }
    try {
      if (c.kind === "rename") await updateKey(keyId.data, { name: c.name }, actor.id);
      else if (c.kind === "rate") await updateKey(keyId.data, { ratePerMin: c.ratePerMin }, actor.id);
      else if (c.kind === "expiry") await updateKey(keyId.data, { expiresAt: expiryDate(c.expiry, new Date()) }, actor.id);
      else await updateKey(keyId.data, { providerId: c.providerId, model: c.providerId === null ? null : c.model }, actor.id);
    } catch (e) {
      if (e instanceof KeyNotFoundError) return { ok: false, error: GONE };
      if (e instanceof KeyNameTakenError) return { ok: false, error: "Check the highlighted fields.", fieldErrors: { name: NAME_TAKEN } };
      throw e;
    }
    revalidatePath("/ai/keys");
    return { ok: true, message: "Key updated." };
  }, deps);
}
