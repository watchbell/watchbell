import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";

const APP = "11111111-1111-4111-8111-111111111111";
const member = { id: "mem-1", userId: "user-1", email: "op@example.com", role: "operator" as const };
const h = vi.hoisted(() => ({ requireActionMember: vi.fn(), generateBuildFiles: vi.fn(), openBuildFilesPr: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/data/buildfiles-db", () => ({ generateBuildFiles: h.generateBuildFiles }));
vi.mock("@/lib/data/buildfiles-pr", () => ({ openBuildFilesPr: h.openBuildFilesPr }));

import { DEMO_BUILD_FILES } from "@/lib/buildfiles/demo";
import { buildFilesAction, buildFilesPrAction } from "./buildfiles-actions";

const data = { files: [], facts: {}, repo: null, branch: null };

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(member);
  h.generateBuildFiles.mockResolvedValue({ ok: true, data });
});
afterEach(() => vi.unstubAllEnvs());

describe("buildFilesAction (Operator+, on demand)", () => {
  it("refuses a viewer before reading anything", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await buildFilesAction(APP)).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("operator");
    expect(h.generateBuildFiles).not.toHaveBeenCalled();
  });
  it("refuses a malformed id", async () => {
    expect((await buildFilesAction("x")).ok).toBe(false);
    expect(h.generateBuildFiles).not.toHaveBeenCalled();
  });
  it("answers the files, or the error", async () => {
    expect(await buildFilesAction(APP)).toEqual({ ok: true, data });
    h.generateBuildFiles.mockResolvedValue({ ok: false, error: "nope" });
    expect(await buildFilesAction(APP)).toEqual({ ok: false, error: "nope" });
  });
  it("demo mode answers made-up files and reads nothing", async () => {
    vi.stubEnv("WATCHBELL_MODE", "demo");
    const r = await buildFilesAction(APP);
    expect(r.ok && r.data?.files.length).toBe(DEMO_BUILD_FILES.files.length);
    expect(h.generateBuildFiles).not.toHaveBeenCalled();
  });
});

describe("buildFilesPrAction (owner only)", () => {
  it("asks for the owner and opens the pull request as them", async () => {
    h.openBuildFilesPr.mockResolvedValue({ ok: true, message: "Pull request #3 opened.", data: { number: 3, url: "u", skipped: [] } });
    expect(await buildFilesPrAction(APP)).toEqual({ ok: true, message: "Pull request #3 opened.", data: { number: 3, url: "u", skipped: [] } });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.openBuildFilesPr).toHaveBeenCalledWith(member, APP);
  });
  it("refuses an operator and a bad id before writing anything", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect((await buildFilesPrAction(APP)).ok).toBe(false);
    h.requireActionMember.mockResolvedValue(member);
    expect((await buildFilesPrAction("x")).ok).toBe(false);
    expect(h.openBuildFilesPr).not.toHaveBeenCalled();
  });
  it("is off in the demo", async () => {
    vi.stubEnv("WATCHBELL_MODE", "demo");
    expect(await buildFilesPrAction(APP)).toEqual({ ok: false, error: "Pull requests are off in the demo." });
    expect(h.openBuildFilesPr).not.toHaveBeenCalled();
  });
});
