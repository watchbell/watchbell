import { describe, expect, it } from "vitest";
import { listEnvNames, parseEnvNames } from "./vercel-env";

// GET /v10/projects/{id}/env: one entry per variable and target set. Only the name, the targets and a branch are kept;
// a value Vercel sends along (plain or encrypted) never reaches the result.
describe("parseEnvNames", () => {
  it("keeps the name and the targets and never the value", () => {
    const r = parseEnvNames({ envs: [{ key: "DATABASE_URL", target: ["production", "preview"], type: "encrypted", value: "secret-value" }] });
    expect(r).toEqual([{ key: "DATABASE_URL", targets: ["production", "preview"], branch: null }]);
    expect(JSON.stringify(r)).not.toContain("secret-value");
  });

  it("reads a single target, a git branch, and drops unknown target names", () => {
    expect(parseEnvNames({ envs: [
      { key: "A", target: "production" },
      { key: "B", target: ["preview", "staging-env"], gitBranch: "staging" },
    ] })).toEqual([
      { key: "A", targets: ["production"], branch: null },
      { key: "B", targets: ["preview"], branch: "staging" },
    ]);
  });

  it("skips entries without a usable name and refuses an answer that isn't an env list", () => {
    expect(parseEnvNames({ envs: [{ target: ["production"] }, { key: "1BAD", target: ["production"] }, { key: "has space" }, { key: "OK" }] }))
      .toEqual([{ key: "OK", targets: [], branch: null }]);
    expect(parseEnvNames("nope")).toBeNull();
    expect(parseEnvNames({ envs: "x" })).toBeNull();
  });
});

describe("listEnvNames", () => {
  it("asks the project's env list for the team, without decrypting", async () => {
    const seen: string[] = [];
    const fetch = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ envs: [{ key: "A", target: ["production"], value: "v" }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const r = await listEnvNames("tok", "team_1", "prj_1", { fetch });
    expect(r).toEqual({ ok: true, data: [{ key: "A", targets: ["production"], branch: null }] });
    expect(seen[0]).toBe("https://api.vercel.com/v10/projects/prj_1/env?teamId=team_1");
    expect(seen[0]).not.toContain("decrypt");
  });

  it("reports an answer it can't read", async () => {
    const fetch = (async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 })) as unknown as typeof globalThis.fetch;
    const r = await listEnvNames("tok", "team_1", "prj_1", { fetch });
    expect(r.ok).toBe(false);
  });
});
