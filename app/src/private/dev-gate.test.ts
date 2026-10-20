import { describe, expect, it } from "vitest";
import { originFrom } from "@/private/explorer/origin";
import { LOCAL_ORIGIN, originChoices } from "@/private/ui/snippets";

// Stage 8 cleanup, the private side: localhost allowances apply only when NODE_ENV !== "production" (lib/dev-only.ts).
// (The office's own allowance, the local Claude bridge, is tested in office/local-claude.test.ts.)
describe("private localhost allowances, gated", () => {
  it("the AI Connect page offers the Local test origin only in development", () => {
    expect(originChoices("https://ops.example.com", true).map((c) => c.origin)).toEqual(["https://ops.example.com", LOCAL_ORIGIN]);
    expect(originChoices("https://ops.example.com", false).map((c) => c.id)).toEqual(["production"]);
    // A console that itself runs on localhost (a local `next start`) still shows its own origin.
    expect(originChoices("http://localhost:3100", false).map((c) => c.id)).toEqual(["production", "local"]);
  });
  it("the API explorer uses plain http for a localhost host only in development", () => {
    const h = (host: string) => ({ get: (n: string) => (n === "host" ? host : null) });
    expect(originFrom(h("localhost:3100"), "https://x.example", true)).toBe("http://localhost:3100");
    expect(originFrom(h("localhost:3100"), "https://x.example", false)).toBe("https://localhost:3100");
  });
});
