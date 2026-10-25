import { describe, expect, it } from "vitest";
import { capLines, firstErrorIndex, isErrorLine, MAX_BUILD_LINES } from "./build-logs";

const line = (text: string, kind: "stdout" | "stderr" | "command" | "delimiter" = "stdout") => ({ at: null, kind, text });

// Task 4 build logs (owner 24 Oct): error lines are highlighted and the drawer jumps to the first one.
describe("isErrorLine", () => {
  it.each([
    "Error: Cannot find module 'zod'",
    "Type error: Property 'x' does not exist on type 'Y'.",
    "Failed to compile.",
    "npm ERR! code ERESOLVE",
    'Error: Command "npm run build" exited with 1',
    "Module not found: Can't resolve './foo'",
    "Build failed because of webpack errors",
  ])("flags %s", (t) => expect(isErrorLine(line(t))).toBe(true));

  it.each([
    "Compiled successfully",
    "npm warn deprecated inflight@1.0.6: This module is not supported",
    "Warning: React version not specified",
    "Running build in Washington, D.C., USA (East) – iad1",
    "✓ Linting and checking validity of types, 0 errors",
    "error-boundary.tsx compiled",
    "Tests: 0 failed, 12 passed",
  ])("leaves %s alone", (t) => expect(isErrorLine(line(t, "stderr"))).toBe(false));

  it("a command or delimiter line is never an error", () => {
    expect(isErrorLine(line("npm run build -- --error", "command"))).toBe(false);
    expect(isErrorLine(line("Build Error", "delimiter"))).toBe(false);
  });
});

describe("firstErrorIndex and capLines", () => {
  it("finds the first error line, or -1", () => {
    expect(firstErrorIndex([line("ok"), line("Error: boom"), line("Error: again")])).toBe(1);
    expect(firstErrorIndex([line("ok")])).toBe(-1);
  });

  it("keeps the last 2,000 lines and says it cut", () => {
    const many = Array.from({ length: MAX_BUILD_LINES + 5 }, (_, i) => line(`l${i}`));
    const c = capLines(many);
    expect(MAX_BUILD_LINES).toBe(2000);
    expect(c.lines).toHaveLength(2000);
    expect(c.lines[0].text).toBe("l5");
    expect(c.truncated).toBe(true);
    expect(capLines([line("a")])).toEqual({ lines: [line("a")], truncated: false });
  });
});
