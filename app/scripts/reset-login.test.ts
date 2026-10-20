import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Only the mode check, which runs before the tool opens any database: the message names the variable the operator
// actually set (WATCHBELL_MODE, or the WATCHPOST_MODE of an install from before the rename).
function resetLogin(env: Record<string, string>) {
  return spawnSync(process.execPath, [fileURLToPath(new URL("./reset-login.mts", import.meta.url)), "owner@example.com"], {
    // Only what Node needs to start on Windows plus the case's own variables.
    // Cast: Next's global ProcessEnv type requires NODE_ENV, which this env deliberately leaves out.
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
}

describe("reset-login mode check", () => {
  it("names WATCHPOST_MODE when the old variable says cloud", () => {
    const run = resetLogin({ WATCHPOST_MODE: "cloud" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("reset-login is for self-hosted Watchbell only (WATCHPOST_MODE is cloud).");
  });
  it("names WATCHBELL_MODE when the new variable says demo", () => {
    const run = resetLogin({ WATCHBELL_MODE: "demo", WATCHPOST_MODE: "selfhost" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("(WATCHBELL_MODE is demo)");
  });
  it("names the variable holding an invalid value", () => {
    const run = resetLogin({ WATCHPOST_MODE: "local" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("WATCHPOST_MODE must be cloud, selfhost or demo");
  });
});
