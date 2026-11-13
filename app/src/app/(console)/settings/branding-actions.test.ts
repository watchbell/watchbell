import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";
import { png } from "@/lib/png-fixture";

const member = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), refresh: vi.fn(), saveBrand: vi.fn(), saveBrandLogo: vi.fn(), recordAction: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("next/cache", () => ({ refresh: h.refresh, revalidatePath: vi.fn() }));
vi.mock("@/lib/data/branding-db", () => ({ saveBrand: h.saveBrand, saveBrandLogo: h.saveBrandLogo, readBrand: vi.fn() }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: h.recordAction }));

import { removeBrandLogo, saveBranding } from "./branding-actions";

const form = (fields: Record<string, string | Blob>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.recordAction.mockResolvedValue(undefined);
});

describe("saveBranding (1.7)", () => {
  it("is the owner's alone", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await saveBranding(form({ name: "X" }))).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.saveBrand).not.toHaveBeenCalled();
  });

  it("saves the parsed brand, and the logo when one is uploaded", async () => {
    const logo = new Blob([png(128, 128) as Uint8Array<ArrayBuffer>], { type: "image/png" });
    const r = await saveBranding(form({ name: "Studio Nusa", accent: "#0f766e", senderName: "Studio Nusa", publicUrl: "", poweredBy: "on", logo }));
    expect(r.ok).toBe(true);
    expect(h.saveBrand).toHaveBeenCalledWith(expect.objectContaining({ name: "Studio Nusa", accent: "#0f766e", poweredBy: true }));
    expect(h.saveBrandLogo).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  it("refuses a bad colour or logo with the reason and saves nothing", async () => {
    const r = await saveBranding(form({ accent: "#fde047" }));
    expect(r).toMatchObject({ ok: false, fieldErrors: { accent: expect.stringMatching(/light background/) } });
    const bad = await saveBranding(form({ logo: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }) }));
    expect(bad).toMatchObject({ ok: false, fieldErrors: { logo: expect.stringMatching(/PNG/) } });
    expect(h.saveBrand).not.toHaveBeenCalled();
    expect(h.saveBrandLogo).not.toHaveBeenCalled();
  });

  it("removes the logo on request (owner only)", async () => {
    expect((await removeBrandLogo()).ok).toBe(true);
    expect(h.saveBrandLogo).toHaveBeenCalledWith(null);
  });
});
