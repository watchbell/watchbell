import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ signOut: vi.fn(async () => {}), redirect: vi.fn((url: string) => { throw new Error(`redirect:${url}`); }) }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("@/lib/auth-provider", () => ({ authProvider: () => ({ signOut: h.signOut }) }));

import { GET } from "./route";

// Watchbell 1.2.1 (audit L4): a top-level GET from any site carries SameSite=Lax cookies, so this route must only end
// the session that brought the user here, never every session the owner has.
describe("/auth/not-member", () => {
  it("signs out the local session only, then sends the user to the sign-in page", async () => {
    await expect(GET()).rejects.toThrow("redirect:/signin?error=not-member");
    expect(h.signOut).toHaveBeenCalledWith("local");
  });
});
