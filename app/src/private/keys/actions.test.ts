import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const PROVIDER = "223e4567-e89b-42d3-a456-426614174000";
const owner = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };

const h = vi.hoisted(() => {
  class KeyLimitError extends Error {}
  class KeyNameTakenError extends Error {}
  class KeyNotFoundError extends Error {}
  return {
    requireActionMember: vi.fn(), revalidatePath: vi.fn(), createKey: vi.fn(), revokeKey: vi.fn(), updateKey: vi.fn(), hasManualModel: vi.fn(),
    KeyLimitError, KeyNameTakenError, KeyNotFoundError,
  };
});
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("./keys-db", () => ({
  createKey: h.createKey, revokeKey: h.revokeKey, updateKey: h.updateKey,
  KeyLimitError: h.KeyLimitError, KeyNameTakenError: h.KeyNameTakenError, KeyNotFoundError: h.KeyNotFoundError,
}));

vi.mock("@/private/ai/providers/providers-db", () => ({ hasManualModel: h.hasManualModel }));

import { changeKeyAction, createKeyAction, revokeKeyAction } from "./actions";

const form = { name: "portfolio-advisor", scopes: ["ai:invoke"], expiry: "90d", ratePerMin: 20 };

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(owner);
  h.createKey.mockResolvedValue({ key: `wp_${"z".repeat(40)}`, row: { name: "portfolio-advisor", prefix: "wp_zzzz" } });
  h.revokeKey.mockResolvedValue(undefined);
  h.updateKey.mockResolvedValue(undefined);
});

describe("owner only (R2)", () => {
  it("every action asks for the owner role and stops for anyone else", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    const results = await Promise.all([createKeyAction(form), revokeKeyAction(UUID), changeKeyAction(UUID, { kind: "rate", ratePerMin: 5 })]);
    for (const r of results) expect(r).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledTimes(3);
    for (const call of h.requireActionMember.mock.calls) expect(call[0]).toBe("owner");
    expect(h.createKey).not.toHaveBeenCalled();
    expect(h.revokeKey).not.toHaveBeenCalled();
    expect(h.updateKey).not.toHaveBeenCalled();
  });
});

describe("createKeyAction", () => {
  it("creates the key and returns the secret once in data", async () => {
    const r = await createKeyAction(form);
    expect(h.createKey).toHaveBeenCalledWith(form, "mem-1");
    expect(r).toMatchObject({ ok: true, data: { key: `wp_${"z".repeat(40)}`, name: "portfolio-advisor", prefix: "wp_zzzz" } });
    expect(h.revalidatePath).toHaveBeenCalledWith("/ai/keys");
  });
  it("reports each bad field and creates nothing", async () => {
    const r = await createKeyAction({ ...form, name: "Bad Name", scopes: [], ratePerMin: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.fieldErrors ?? {}).sort()).toEqual(["name", "ratePerMin", "scopes"]);
    expect(h.createKey).not.toHaveBeenCalled();
  });
  it("R7: the 21st active key is a form error", async () => {
    h.createKey.mockRejectedValue(new h.KeyLimitError());
    expect(await createKeyAction(form)).toEqual({ ok: false, error: "At most 20 active keys. Revoke one first." });
  });
  it("a name an active key has is a field error", async () => {
    h.createKey.mockRejectedValue(new h.KeyNameTakenError());
    expect(await createKeyAction(form)).toMatchObject({ ok: false, fieldErrors: { name: "A key with this name exists." } });
  });
  it("anything else becomes the generic message, with no detail", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.createKey.mockRejectedValue(new Error("insert into ops.api_keys … key_hash = abc"));
    expect(await createKeyAction(form)).toEqual({ ok: false, error: "Something went wrong. Try again." });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("key_hash");
    spy.mockRestore();
  });
});

describe("revokeKeyAction", () => {
  it("revokes by id and refreshes the keys and agents pages", async () => {
    expect(await revokeKeyAction(UUID)).toMatchObject({ ok: true });
    expect(h.revokeKey).toHaveBeenCalledWith(UUID, "mem-1");
    expect(h.revalidatePath).toHaveBeenCalledWith("/ai/agents");
  });
  it("a bad id or an already revoked key is a plain message", async () => {
    expect(await revokeKeyAction("nope")).toMatchObject({ ok: false });
    expect(h.revokeKey).not.toHaveBeenCalled();
    h.revokeKey.mockRejectedValue(new h.KeyNotFoundError());
    expect(await revokeKeyAction(UUID)).toEqual({ ok: false, error: "That key is already revoked or gone." });
  });
});

describe("changeKeyAction", () => {
  it("renames, with the same name rule as creating", async () => {
    await changeKeyAction(UUID, { kind: "rename", name: "new-name" });
    expect(h.updateKey).toHaveBeenCalledWith(UUID, { name: "new-name" }, "mem-1");
    expect(await changeKeyAction(UUID, { kind: "rename", name: "No Good" })).toMatchObject({ ok: false, fieldErrors: { name: expect.any(String) } });
  });
  it("changes the rate limit within 1-600", async () => {
    await changeKeyAction(UUID, { kind: "rate", ratePerMin: 45 });
    expect(h.updateKey).toHaveBeenCalledWith(UUID, { ratePerMin: 45 }, "mem-1");
    expect((await changeKeyAction(UUID, { kind: "rate", ratePerMin: 601 })).ok).toBe(false);
  });
  it("changes the expiry counted from now, or to never", async () => {
    const before = Date.now();
    await changeKeyAction(UUID, { kind: "expiry", expiry: "30d" });
    const at = (h.updateKey.mock.calls[0][1] as { expiresAt: Date }).expiresAt.getTime();
    expect(at - before).toBeGreaterThanOrEqual(30 * 86_400_000 - 1000);
    await changeKeyAction(UUID, { kind: "expiry", expiry: "never" });
    expect(h.updateKey.mock.calls[1][1]).toEqual({ expiresAt: null });
  });
  it("pins a provider and a Gemini model, or clears the pin", async () => {
    await changeKeyAction(UUID, { kind: "routing", providerId: PROVIDER, model: "gemini-3.8-flash" });
    expect(h.updateKey.mock.calls[0][1]).toEqual({ providerId: PROVIDER, model: "gemini-3.8-flash" });
    await changeKeyAction(UUID, { kind: "routing", providerId: PROVIDER, model: "google/antigravity-preview-latest" });
    expect(h.updateKey.mock.calls[1][1]).toEqual({ providerId: PROVIDER, model: "google/antigravity-preview-latest" });
    await changeKeyAction(UUID, { kind: "routing", providerId: PROVIDER, model: "" });
    expect(h.updateKey.mock.calls[2][1]).toEqual({ providerId: PROVIDER, model: null });
    await changeKeyAction(UUID, { kind: "routing", providerId: null, model: "gemini-x" });
    expect(h.updateKey.mock.calls[3][1]).toEqual({ providerId: null, model: null });
  });
  it("refuses a model that isn't Gemini", async () => {
    const r = await changeKeyAction(UUID, { kind: "routing", providerId: PROVIDER, model: "claude-sonnet" });
    expect(r).toMatchObject({ ok: false, fieldErrors: { model: expect.stringContaining("Gemini") } });
    expect(h.updateKey).not.toHaveBeenCalled();
  });
  it("pins a model id the owner added on that custom provider (any name), checked against the provider", async () => {
    h.hasManualModel.mockResolvedValue(true);
    expect((await changeKeyAction(UUID, { kind: "routing", providerId: PROVIDER, model: "test/prrojects" })).ok).toBe(true);
    expect(h.hasManualModel).toHaveBeenCalledWith(PROVIDER, "test/prrojects");
    expect(h.updateKey.mock.calls[0][1]).toEqual({ providerId: PROVIDER, model: "test/prrojects" });
    h.hasManualModel.mockResolvedValue(false);
    const r = await changeKeyAction(UUID, { kind: "routing", providerId: PROVIDER, model: "prrojects" });
    expect(r).toMatchObject({ ok: false, fieldErrors: { model: expect.stringContaining("added on Models") } });
    expect(h.updateKey).toHaveBeenCalledTimes(1);
    expect((await changeKeyAction(UUID, { kind: "routing", providerId: PROVIDER, model: "bad id;" })).ok).toBe(false);
  });
  it("rejects an unknown change, extra fields and a bad id", async () => {
    expect((await changeKeyAction(UUID, { kind: "delete" })).ok).toBe(false);
    expect((await changeKeyAction(UUID, { kind: "rate", ratePerMin: 5, scopes: ["write:notes"] })).ok).toBe(false);
    expect((await changeKeyAction("x", { kind: "rate", ratePerMin: 5 })).ok).toBe(false);
    expect(h.updateKey).not.toHaveBeenCalled();
  });
  it("maps a taken name and a gone key", async () => {
    h.updateKey.mockRejectedValueOnce(new h.KeyNameTakenError());
    expect(await changeKeyAction(UUID, { kind: "rename", name: "taken" })).toMatchObject({ ok: false, fieldErrors: { name: "A key with this name exists." } });
    h.updateKey.mockRejectedValueOnce(new h.KeyNotFoundError());
    expect(await changeKeyAction(UUID, { kind: "rate", ratePerMin: 5 })).toEqual({ ok: false, error: "That key is already revoked or gone." });
  });
});
