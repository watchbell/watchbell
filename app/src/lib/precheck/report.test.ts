import { describe, expect, it } from "vitest";
import type { FoundVuln } from "@/lib/deps/osv";
import { parseMarker } from "./marker";
import { commentBody, MARKER, parseGitleaks, type PrecheckResult, type Secret, verdictLine, verdictOf } from "./report";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const vuln = (pkg: string, severity: FoundVuln["severity"], id = `GHSA-${pkg}`): FoundVuln => ({
  package: pkg, installedVersion: "1.0.0", vulnId: id, aliases: [], severity, fixedVersion: "1.0.1", summary: "", dev: false, source: "osv",
});
const secret: Secret = { rule: "generic-api-key", file: "src/config.ts", line: 12, commit: "abc1234" };
const result = (o: Partial<PrecheckResult> = {}): PrecheckResult => ({
  sha: SHA, dir: ".", packages: { ok: true, items: [] }, secrets: { ok: true, items: [] }, next: { from: "16.4.2", to: "16.4.2" },
  env: { ok: true, items: { example: [], code: [] } }, ...o,
});

describe("parseGitleaks", () => {
  it("keeps the rule, file, line and short commit, never the secret", () => {
    const text = JSON.stringify([{ RuleID: "generic-api-key", File: "src/config.ts", StartLine: 12, Commit: "abc1234def", Secret: "abc123SECRET", Match: "key=abc123SECRET" }]);
    const out = parseGitleaks(text);
    expect(out).toEqual([secret]);
    expect(JSON.stringify(out)).not.toContain("abc123SECRET");
  });
  it("is null for a missing, empty or broken report", () => {
    expect(parseGitleaks(null)).toBeNull();
    expect(parseGitleaks("")).toBeNull();
    expect(parseGitleaks("not json")).toBeNull();
    expect(parseGitleaks("{}")).toBeNull();
  });
  it("reads an empty report as no secrets", () => {
    expect(parseGitleaks("[]")).toEqual([]);
  });
  // Review minor 9: one past the cap is kept so the comment can say "more than 50".
  it("keeps 50 and one more to mark that there are more", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ RuleID: "r", File: `f${i}`, StartLine: i, Commit: "abcdef0" }));
    expect(parseGitleaks(JSON.stringify(many))).toHaveLength(51);
  });
});

describe("verdictOf", () => {
  it("is fix for a high advisory or a secret", () => {
    expect(verdictOf(result({ packages: { ok: true, items: [vuln("a", "high")] } }))).toBe("fix");
    expect(verdictOf(result({ secrets: { ok: true, items: [secret] } }))).toBe("fix");
  });
  it("is check for env names, a moderate advisory or a part not checked", () => {
    expect(verdictOf(result({ env: { ok: true, items: { example: ["B"], code: [] } } }))).toBe("check");
    expect(verdictOf(result({ packages: { ok: true, items: [vuln("a", "moderate")] } }))).toBe("check");
    expect(verdictOf(result({ secrets: { ok: false, reason: "gitleaks didn't run" } }))).toBe("check");
  });
  it("is ok when nothing turned up", () => {
    expect(verdictOf(result())).toBe("ok");
  });
});

describe("verdictLine", () => {
  it("names what to fix", () => {
    const r = result({ packages: { ok: true, items: [vuln("a", "high"), vuln("b", "high"), vuln("b", "moderate", "GHSA-x")] }, secrets: { ok: true, items: [secret] } });
    expect(verdictLine(r)).toBe("**Fix before merging:** 2 new high-severity packages, 1 possible secret.");
  });
  it("names what to check", () => {
    expect(verdictLine(result({ env: { ok: true, items: { example: [], code: ["C"] } } }))).toBe("**Check before merging:** 1 new env name to set on Vercel.");
  });
  it("says when nothing turned up", () => {
    expect(verdictLine(result())).toBe("**No new problems found.**");
  });
});

describe("commentBody and parseMarker", () => {
  it("round-trips the marker", () => {
    const r = result({ packages: { ok: true, items: [vuln("a", "critical")] }, env: { ok: true, items: { example: ["B"], code: [] } } });
    const body = commentBody(r, new Date("2026-11-04T01:00:00Z"));
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain("### Watchbell pre-deploy check");
    expect(body).toContain("Warning only: this check never blocks merging. Commit 0123456.");
    expect(parseMarker(body)).toEqual({
      v: 1, sha: SHA, verdict: "fix", at: "2026-11-04T01:00:00.000Z",
      counts: { critical: 1, high: 0, moderate: 0, low: 0, secrets: 0, env: 1 },
    });
  });
  it("never puts a secret's value in the comment", () => {
    expect(commentBody(result({ secrets: { ok: true, items: [secret] } }), new Date())).toContain("`src/config.ts` line 12");
  });
  it("is null for a broken or missing marker", () => {
    expect(parseMarker("<!-- watchbell-precheck {bad -->")).toBeNull();
    expect(parseMarker("just a comment")).toBeNull();
    expect(parseMarker(`<!-- watchbell-precheck {"v":1,"sha":"zz","verdict":"ok","counts":{},"at":"x"} -->`)).toBeNull();
  });
  it("cuts a body over 60,000 characters", () => {
    const long = Array.from({ length: 50 }, (_, i) => ({ ...secret, file: `${"d/".repeat(1000)}${i}.ts` }));
    const body = commentBody(result({ secrets: { ok: true, items: long } }), new Date());
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body.endsWith("…and more in the job summary.")).toBe(true);
    expect(parseMarker(body)?.counts.secrets).toBe(50);
  });
});

describe("review minors (1.4)", () => {
  it("says more than 50 secrets when gitleaks found more", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ ...secret, line: i }));
    const r = result({ secrets: { ok: true, items: many } });
    expect(verdictLine(r)).toBe("**Fix before merging:** more than 50 possible secrets.");
    const body = commentBody(r, new Date());
    expect(body).toContain("line 49 ");
    expect(body).not.toContain("line 50 ");
    expect(body).toContain("…and more secrets than listed here.");
    expect(parseMarker(body)?.counts.secrets).toBe(50);
  });
  it("calls a Next.js version new when the base had none", () => {
    expect(commentBody(result({ next: { from: null, to: "16.4.3" } }), new Date())).toContain("**Next.js:** 16.4.3 (new)");
  });
  it("says what the packages were compared against when the base lockfile is missing or unreadable", () => {
    const note = "The base branch's package-lock.json couldn't be read, so every package counts as new.";
    expect(commentBody(result({ baseNote: note }), new Date())).toContain(note);
  });
});
