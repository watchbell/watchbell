import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("bootstrap-owner", () => {
  it("refuses to run without its environment and says which variables are needed", () => {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("./bootstrap-owner.mts", import.meta.url))], {
      // Only what Node needs to start on Windows, none of the app's variables.
      // Cast: Next's global ProcessEnv type requires NODE_ENV, which this env deliberately leaves out.
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/OWNER_EMAIL/);
  });

  it("never prints a malformed DATABASE_URL, password included", () => {
    // `#` in the password makes the URL unparseable; postgres throws before any connection is opened.
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("./bootstrap-owner.mts", import.meta.url))], {
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        NEXT_PUBLIC_SUPABASE_URL: "https://dummy.supabase.co",
        SUPABASE_SECRET_KEY: "dummy-secret",
        DATABASE_URL: "postgresql://postgres:pa#ss@host:6543/postgres",
        OWNER_EMAIL: "owner@example.com",
      } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/URL-encode/);
    expect(run.stderr).not.toContain("pa#ss");
  });
});
