import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const APP = "11111111-1111-4111-8111-111111111111";
const member = { id: "mem-1", userId: "user-1", email: "op@example.com", role: "operator" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), checkAppEnv: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/data/env-check-db", () => ({ checkAppEnv: h.checkAppEnv }));

import { DEMO_ENV_CHECK } from "@/lib/env-check/check";
import { envCheckAction } from "./env-actions";

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.checkAppEnv.mockResolvedValue({ ok: true, data: { findings: [], names: 2, example: "found", examplePath: ".env.example", checkedAt: "x" } });
});
afterEach(() => vi.unstubAllEnvs());

describe("envCheckAction (Operator+, on demand)", () => {
  it("refuses a viewer before reading anything", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await envCheckAction(APP)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("operator");
    expect(h.checkAppEnv).not.toHaveBeenCalled();
  });

  it("refuses a malformed id", async () => {
    expect((await envCheckAction("x' or 1=1")).ok).toBe(false);
    expect(h.checkAppEnv).not.toHaveBeenCalled();
  });

  it("answers the check", async () => {
    expect(await envCheckAction(APP)).toEqual({ ok: true, data: { findings: [], names: 2, example: "found", examplePath: ".env.example", checkedAt: "x" } });
    expect(h.checkAppEnv).toHaveBeenCalledWith(APP);
  });

  it("demo mode answers made-up findings and reads nothing", async () => {
    vi.stubEnv("WATCHBELL_MODE", "demo");
    const r = await envCheckAction(APP);
    expect(r).toEqual({ ok: true, data: { ...DEMO_ENV_CHECK, checkedAt: expect.any(String) } });
    // Stamped when asked, so the demo never reads "Checked 3 months ago".
    expect(Date.now() - Date.parse(r.ok ? r.data!.checkedAt : "")).toBeLessThan(5_000);
    expect(h.checkAppEnv).not.toHaveBeenCalled();
  });
});
