import { describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({ db: () => { throw new Error("no database in this test"); } }));

import { ASSIST_COPY } from "@/lib/copy/edition";
import type { BuildLine } from "@/lib/view/build-logs";
import { type ExplainDeps, explainBuildWith, explainLines } from "./build-explain";

const out = (text: string): BuildLine => ({ at: null, kind: "stdout", text });
const err = (text: string): BuildLine => ({ at: null, kind: "stderr", text });
const FAILED: BuildLine[] = [
  { at: null, kind: "command", text: "npm run build" },
  out("Creating an optimized production build ..."),
  out("Failed to compile."),
  err("./src/app/page.tsx:12:5 Type error: Property 'total' does not exist on type 'Order'."),
  out("Error: Command \"npm run build\" exited with 1"),
];

function deps(over: Partial<ExplainDeps> = {}): ExplainDeps & { complete: ReturnType<typeof vi.fn> } {
  return {
    overQuota: async () => null,
    provider: async () => ({ name: "Groq", model: "groq/llama" }),
    complete: vi.fn(async () => ({ text: "  The Order type has no total.\nAdd it in src/types.ts.  ", model: "groq/llama", ms: 900 })),
    ...over,
  } as ExplainDeps & { complete: ReturnType<typeof vi.fn> };
}

describe("explainLines (1.3 Explain with AI)", () => {
  it("never sends more than 120 lines, and keeps an early stderr line", () => {
    const lines = [out("start"), err("warn: something early on stderr"), ...Array.from({ length: 400 }, (_, i) => out(`step ${i}`))];
    const sent = explainLines(lines);
    expect(sent.length).toBeLessThanOrEqual(120);
    expect(sent).toContain("warn: something early on stderr");
    expect(sent.at(-1)).toBe("step 399");
  });

  it("keeps error-looking lines before the rest, in log order", () => {
    const lines = [out("Module not found: Can't resolve './x'"), ...Array.from({ length: 300 }, (_, i) => out(`noise ${i}`))];
    const sent = explainLines(lines);
    expect(sent[0]).toBe("Module not found: Can't resolve './x'");
    expect(sent).toHaveLength(120);
  });

  it("cuts secrets out of every line", () => {
    const sent = explainLines([err(`fetch failed with token ghp_${"a".repeat(36)}`)]);
    expect(sent[0]).toContain("«redacted»");
    expect(sent[0]).not.toContain("ghp_");
  });

  it("removes secrets before a long line is cut, so no half token is sent", () => {
    const sent = explainLines([err(`${"x".repeat(380)} failed ghp_${"a".repeat(36)}`)]);
    expect(sent[0]).not.toContain("ghp_");
  });
});

describe("explainBuildWith", () => {
  it("asks the provider for what broke, the likely fix and the file, in at most 6 short lines", async () => {
    const d = deps();
    expect(await explainBuildWith(d, { app: "acme-shop", lines: FAILED, memberId: "m1" }))
      .toEqual({ ok: true, text: "The Order type has no total.\nAdd it in src/types.ts.", model: "groq/llama" });
    expect(d.complete).toHaveBeenCalledTimes(1);
    const [messages, opts] = d.complete.mock.calls[0];
    expect(opts).toEqual({ purpose: "ask-ai", maxTokens: 400 });
    const all = messages.map((m: { content: string }) => m.content).join("\n");
    expect(all).toMatch(/what broke/i);
    expect(all).toMatch(/likely fix/i);
    expect(all).toMatch(/file/i);
    expect(all).toMatch(/6 short lines/);
    expect(all).toContain("Property 'total' does not exist");
  });

  it("too little to explain: fewer than 3 lines, or nothing that looks like an error; no provider call", async () => {
    const d = deps();
    const msg = { ok: false, error: "There is too little in the build log to explain." };
    expect(await explainBuildWith(d, { app: "a", lines: [err("Failed"), out("x")], memberId: "m1" })).toEqual(msg);
    expect(await explainBuildWith(d, { app: "a", lines: [out("Compiled"), out("Collecting pages"), out("Done in 30s")], memberId: "m1" })).toEqual(msg);
    expect(d.complete).not.toHaveBeenCalled();
  });

  it("over the AI quota, or no provider: says so and calls nothing", async () => {
    const over = deps({ overQuota: async () => "Too many AI requests. Try again in 4 min." });
    expect(await explainBuildWith(over, { app: "a", lines: FAILED, memberId: "m1" })).toEqual({ ok: false, error: "Too many AI requests. Try again in 4 min." });
    expect(over.complete).not.toHaveBeenCalled();
    const none = deps({ provider: async () => null });
    expect(await explainBuildWith(none, { app: "a", lines: FAILED, memberId: "m1" })).toEqual({ ok: false, error: ASSIST_COPY.noProvider });
    expect(none.complete).not.toHaveBeenCalled();
  });

  it("a provider failure is one safe sentence", async () => {
    const d = deps({ complete: vi.fn(async () => { throw new Error("upstream said: key sk-live-abc"); }) });
    expect(await explainBuildWith(d, { app: "a", lines: FAILED, memberId: "m1" })).toEqual({ ok: false, error: "The AI provider couldn't answer. Try again." });
  });
});
