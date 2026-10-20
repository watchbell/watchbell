import { describe, expect, it } from "vitest";
import { USAGE_COPY } from "@/lib/copy/edition";
import { compactNumber, providerUsage, type ProviderUsageRow, VM_PROVIDER_ID } from "./provider-usage";

const now = new Date("2026-10-14T03:00:00Z"); // 10:00 WIB; the WIB day started 2026-10-13T17:00Z
const row = (at: string, o: Partial<ProviderUsageRow> = {}): ProviderUsageRow => ({
  at: new Date(at), kind: "chat", providerId: "p1", tokensIn: 100, tokensCached: 50, tokensOut: 20, tokensThinking: 5, status: 200, ...o,
});
const providers = [{ id: "p1", name: "Groq", kind: "groq", enabled: true }, { id: "p2", name: "Router", kind: "openai_compat", enabled: true }];

describe("providerUsage", () => {
  it("counts today (WIB) and the last 7 days per provider: requests, tokens, errors", () => {
    const out = providerUsage([
      row("2026-10-14T02:00:00Z"),
      row("2026-10-13T17:30:00Z", { status: 429, tokensIn: null, tokensCached: null, tokensOut: null, tokensThinking: null }),
      row("2026-10-13T16:59:00Z"), // yesterday in WIB
      row("2026-10-08T00:00:00Z"), // 6 days ago
      row("2026-10-06T00:00:00Z"), // older than 7 days
      row("2026-10-14T02:00:00Z", { kind: "mcp" }), // plumbing, not model work
      row("2026-10-14T02:00:00Z", { kind: "models", providerId: "p2" }),
      row("2026-10-14T02:00:00Z", { providerId: "gone" }),
    ], providers, now);
    expect(out[0]).toEqual({
      ...providers[0],
      today: { requests: 2, input: 100, cached: 50, output: 25, errors: 1 },
      week: { requests: 4, input: 300, cached: 150, output: 75, errors: 1 },
    });
    expect(out[1].today.requests).toBe(1);
    expect(out).toHaveLength(2);
  });

  it("Antigravity's runs (agent, no provider) are their own entry, only when there are any", () => {
    expect(providerUsage([], providers, now).map((p) => p.id)).toEqual(["p1", "p2"]);
    const out = providerUsage([row("2026-10-14T01:00:00Z", { kind: "agent", providerId: null })], providers, now);
    expect(out.at(-1)).toMatchObject({ id: VM_PROVIDER_ID, name: USAGE_COPY.providerName, today: { requests: 1 } });
  });

  it("formats compact numbers", () => {
    expect([compactNumber(950), compactNumber(1200), compactNumber(2_500_000)]).toEqual(["950", "1.2K", "2.5M"]);
  });
});
