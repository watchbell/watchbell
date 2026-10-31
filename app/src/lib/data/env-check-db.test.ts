import { describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({ db: () => { throw new Error("no database in this test"); } }));

import type { EnvName } from "@/lib/providers/vercel-env";
import { checkAppEnv, type EnvCheckDeps } from "./env-check-db";

const APP = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-29T03:00:00.000Z");
const names: EnvName[] = [
  { key: "DATABASE_URL", targets: ["production", "preview"], branch: null },
  { key: "EXTRA", targets: ["production"], branch: null },
  { key: "BETA_FLAG", targets: ["preview"], branch: null },
];

function deps(over: Partial<EnvCheckDeps> = {}): EnvCheckDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    target: async () => ({ token: "vt", teamId: "team_1", projectId: "prj_1", rootDir: null }),
    repo: async () => ({ fullName: "acme/shop", branch: "main" }),
    githubToken: async () => "gt",
    envNames: async () => ({ ok: true, data: names }),
    file: async (_t, _r, path) => { reads.push(path); return { ok: true, data: "DATABASE_URL=\nSTRIPE_KEY=\n" }; },
    now: () => NOW,
    ...over,
  };
}

describe("checkAppEnv", () => {
  it("compares Vercel's names with the repository's .env.example at the root", async () => {
    const d = deps();
    const r = await checkAppEnv(APP, d);
    expect(r).toEqual({ ok: true, data: {
      findings: [
        { kind: "missing-production", key: "STRIPE_KEY" },
        { kind: "preview-only", key: "BETA_FLAG" },
        { kind: "not-in-example", key: "EXTRA" },
      ],
      names: 3, example: "found", examplePath: ".env.example", checkedAt: NOW.toISOString(),
    } });
    expect(d.reads).toEqual([".env.example"]);
  });

  it("reads .env.example in the app's Vercel Root Directory", async () => {
    const d = deps({ target: async () => ({ token: "vt", teamId: "team_1", projectId: "prj_1", rootDir: "apps/web" }) });
    const r = await checkAppEnv(APP, d);
    expect(d.reads).toEqual(["apps/web/.env.example"]);
    expect(r.ok && r.data.examplePath).toBe("apps/web/.env.example");
  });

  it("without a linked repository judges Vercel's settings only", async () => {
    const r = await checkAppEnv(APP, deps({ repo: async () => null }));
    expect(r.ok && r.data.example).toBe("no-repo");
    expect(r.ok && r.data.findings).toEqual([{ kind: "preview-only", key: "BETA_FLAG" }]);
  });

  it("tells a missing .env.example from one GitHub couldn't give", async () => {
    // fileText answers GitHub's 404 as a "missing" failure; data null means too large or not text.
    const none = await checkAppEnv(APP, deps({ file: async () => ({ ok: false, kind: "missing", error: "not found" }) }));
    expect(none.ok && none.data.example).toBe("none");
    const binary = await checkAppEnv(APP, deps({ file: async () => ({ ok: true, data: null }) }));
    expect(binary.ok && binary.data.example).toBe("unreadable");
    const failed = await checkAppEnv(APP, deps({ file: async () => ({ ok: false, kind: "transient", error: "timeout" }) }));
    expect(failed.ok && failed.data.example).toBe("unreadable");
  });

  it("says GitHub isn't connected when there's no token to read .env.example with", async () => {
    const d = deps({ githubToken: async () => null });
    const r = await checkAppEnv(APP, d);
    expect(r.ok && r.data.example).toBe("no-github");
    expect(r.ok && r.data.examplePath).toBe(".env.example");
    expect(d.reads).toEqual([]);
  });

  it("fails with Vercel's reason when the names can't be read, and for an app it doesn't know", async () => {
    expect(await checkAppEnv(APP, deps({ envNames: async () => ({ ok: false, kind: "auth", error: "the token was refused" }) })))
      .toEqual({ ok: false, error: "Couldn't read the environment variables: the token was refused" });
    expect(await checkAppEnv(APP, deps({ target: async () => null }))).toEqual({ ok: false, error: "That app's Vercel project can't be read. Sync Vercel and try again." });
  });

  it("counts each variable name once, however many entries Vercel has for it", async () => {
    const twice: EnvName[] = [...names, { key: "DATABASE_URL", targets: ["development"], branch: null }];
    const r = await checkAppEnv(APP, deps({ envNames: async () => ({ ok: true, data: twice }) }));
    expect(r.ok && r.data.names).toBe(3);
  });

  it("a Root Directory Watchbell can't use: no comparison with the root .env.example (it would be the wrong file)", async () => {
    const d = deps({ target: async () => ({ token: "vt", teamId: "team_1", projectId: "prj_1", rootDir: null, rootDirUnusable: "@scope/web" }) });
    const r = await checkAppEnv(APP, d);
    expect(r.ok && r.data.example).toBe("unreadable");
    expect(r.ok && r.data.findings.map((f) => f.kind)).not.toContain("not-in-example");
    expect(d.reads).toEqual([]);
  });
});
