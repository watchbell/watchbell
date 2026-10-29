import { describe, expect, it } from "vitest";
import type { EnvName } from "@/lib/providers/vercel-env";
import { envFindings, parseEnvExample } from "./check";

const n = (key: string, targets: EnvName["targets"], branch: string | null = null): EnvName => ({ key, targets, branch });

describe("parseEnvExample", () => {
  it("reads the keys in file order, once each, skipping comments and lines that aren't assignments", () => {
    expect(parseEnvExample("# c\nexport A=1\nB=\n  C = x\nB=2\nnot a line\n")).toEqual(["A", "B", "C"]);
  });
});

describe("envFindings", () => {
  it("names a key from .env.example that Production doesn't set (a branch-scoped entry doesn't count)", () => {
    const f = envFindings([n("A", ["production"]), n("B", ["production"], "staging")], ["A", "B"]);
    expect(f).toContainEqual({ kind: "missing-production", key: "B" });
    expect(f).not.toContainEqual({ kind: "missing-production", key: "A" });
  });

  it("names a key set for Preview or Development but never Production, with or without .env.example", () => {
    expect(envFindings([n("P", ["preview"]), n("D", ["development"])], null)).toEqual([
      { kind: "preview-only", key: "D" },
      { kind: "preview-only", key: "P" },
    ]);
  });

  it("names a NEXT_PUBLIC_ key that looks secret, not the public Supabase keys", () => {
    const f = envFindings([
      n("NEXT_PUBLIC_STRIPE_SECRET", ["production"]),
      n("NEXT_PUBLIC_API_TOKEN", ["production"]),
      n("NEXT_PUBLIC_SUPABASE_ANON_KEY", ["production"]),
      n("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", ["production"]),
    ], null);
    expect(f.filter((x) => x.kind === "public-secret").map((x) => x.key)).toEqual(["NEXT_PUBLIC_API_TOKEN", "NEXT_PUBLIC_STRIPE_SECRET"]);
  });

  it("names a Production key missing from .env.example only when there is one, and ignores VERCEL_ keys", () => {
    const names = [n("A", ["production"]), n("EXTRA", ["production"]), n("VERCEL_URL", ["production"])];
    expect(envFindings(names, ["A"])).toEqual([{ kind: "not-in-example", key: "EXTRA" }]);
    expect(envFindings(names, null)).toEqual([]);
    expect(envFindings([n("VERCEL_ENV", ["preview"])], ["VERCEL_X"])).toEqual([]);
  });

  it("reports a key once per kind when Vercel lists it twice", () => {
    expect(envFindings([n("P", ["preview"]), n("P", ["development"])], null)).toEqual([{ kind: "preview-only", key: "P" }]);
  });

  it("orders by kind, then key", () => {
    const f = envFindings([n("Z", ["preview"]), n("NEXT_PUBLIC_X_SECRET", ["production"]), n("Y", ["production"])], ["M", "NEXT_PUBLIC_X_SECRET"]);
    expect(f.map((x) => x.kind)).toEqual(["missing-production", "preview-only", "public-secret", "not-in-example"]);
  });
});
