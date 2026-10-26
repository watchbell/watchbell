import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), paletteSource: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/data/palette-db", () => ({ paletteSource: h.paletteSource }));

import { loadPaletteSource } from "./palette-action";

const src = { apps: [{ id: "a1", name: "web", domain: "web.example.com" }], monitors: [] };

beforeEach(() => {
  vi.resetAllMocks();
});

describe("loadPaletteSource", () => {
  it("lets any member read it, a viewer included", async () => {
    h.requireActionMember.mockResolvedValue({ id: "m", userId: "u", email: "v@example.com", role: "viewer" });
    h.paletteSource.mockResolvedValue(src);
    expect(await loadPaletteSource()).toEqual({ ok: true, data: src });
    expect(h.requireActionMember).toHaveBeenCalledWith("viewer");
  });

  it("reads nothing for a signed-out caller", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("signed-out"));
    expect(await loadPaletteSource()).toMatchObject({ ok: false });
    expect(h.paletteSource).not.toHaveBeenCalled();
  });

  it("answers with an error, not a throw, when the read fails", async () => {
    h.requireActionMember.mockResolvedValue({ id: "m", userId: "u", email: "v@example.com", role: "viewer" });
    h.paletteSource.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadPaletteSource()).toEqual({ ok: false, error: "That didn't go through, and Watchbell couldn't tell why. Try again in a moment; if it keeps failing, the server log has the details." });
  });
});
