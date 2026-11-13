import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const APP = "11111111-1111-4111-8111-111111111111";
const member = { id: "mem-1", userId: "user-1", email: "op@example.com", role: "operator" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), checkPullRequests: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/data/pr-checks-db", () => ({ checkPullRequests: h.checkPullRequests }));

import { DEMO_PR_CHECKS } from "@/lib/precheck/pr-checks";
import { prChecksAction } from "./pr-actions";

const data = { repo: "me/site", rows: [], checkedAt: "x" };

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.checkPullRequests.mockResolvedValue({ ok: true, data });
});
afterEach(() => vi.unstubAllEnvs());

describe("prChecksAction (Operator+, on demand)", () => {
  it("refuses a viewer before reading anything", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await prChecksAction(APP)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("operator");
    expect(h.checkPullRequests).not.toHaveBeenCalled();
  });
  it("refuses a malformed id", async () => {
    expect((await prChecksAction("x")).ok).toBe(false);
    expect(h.checkPullRequests).not.toHaveBeenCalled();
  });
  it("answers the pull requests", async () => {
    expect(await prChecksAction(APP)).toEqual({ ok: true, data });
    expect(h.checkPullRequests).toHaveBeenCalledWith(APP);
  });
  it("passes an error through", async () => {
    h.checkPullRequests.mockResolvedValue({ ok: false, error: "Link a repository first." });
    expect(await prChecksAction(APP)).toEqual({ ok: false, error: "Link a repository first." });
  });
  it("demo mode answers made-up pull requests and reads nothing", async () => {
    vi.stubEnv("WATCHBELL_MODE", "demo");
    const r = await prChecksAction(APP);
    expect(r.ok && r.data?.rows).toEqual(DEMO_PR_CHECKS.rows);
    expect(h.checkPullRequests).not.toHaveBeenCalled();
  });
});
