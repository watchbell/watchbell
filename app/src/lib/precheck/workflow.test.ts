import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CALLER_YAML } from "./workflow";

// These files sit in public-edition/ here and at the root of the public export (review, 1.4).
const root = (p: string) => {
  const here = fileURLToPath(new URL(`../../../../public-edition/${p}`, import.meta.url));
  return existsSync(here) ? here : fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
};
const yaml = readFileSync(root(".github/workflows/precheck.yml"), "utf8").replace(/\r\n/g, "\n");

// The bodies of every `run: |` block (the lines indented deeper than the `run:` key).
function runBlocks(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:- )?run: (.*)$/.exec(line);
    if (!m) return;
    if (m[2] !== "|") { out.push(m[2]); return; }
    const indent = m[1].length;
    const body: string[] = [];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() && next.length - next.trimStart().length <= indent) break;
      body.push(next);
    }
    out.push(body.join("\n"));
  });
  return out;
}

describe("the reusable workflow", () => {
  it("never puts an expression inside a script", () => {
    const blocks = runBlocks(yaml);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const b of blocks) expect(b).not.toContain("${{");
  });
  it("pins every action to a full commit", () => {
    const uses = [...yaml.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+@[0-9a-f]{40}$/);
  });
  it("checks gitleaks' download and redacts what it finds", () => {
    expect(yaml).toContain("sha256sum -c");
    expect(yaml).toMatch(/GITLEAKS_SHA256: "[0-9a-f]{64}"/);
    expect(yaml).toContain("--redact");
    expect(yaml).toContain("persist-credentials: false");
  });
  // Review (final, Important 1): gitleaks writes "[]" before exiting 1 on an error; a failed scan must read as not checked.
  it("never passes on the report of a scan that failed", () => {
    expect(yaml).toContain('|| { rm -f "$RUNNER_TEMP/gitleaks.json"; exit 1; }');
    expect(yaml).toContain("GITLEAKS_OUTCOME: ${{ steps.scan.outcome }}");
  });
  // Review minors 4 and 7: one run per pull request at a time, and a missing check script never turns the job red.
  it("cancels an older run of the same pull request", () => {
    expect(yaml).toContain("group: watchbell-precheck-${{ github.event.pull_request.number }}");
    expect(yaml).toContain("cancel-in-progress: true");
  });
  it("stays green when the check script can't be downloaded", () => {
    expect(yaml).toMatch(/- name: Check out the Watchbell check\n\s+continue-on-error: true/);
    expect(yaml).toContain("if: hashFiles('.watchbell/precheck/precheck.mjs') != ''");
    expect(yaml).toContain("if: hashFiles('.watchbell/precheck/precheck.mjs') == ''");
  });
  it("is only callable, never triggered by the public repository itself", () => {
    expect(yaml).toMatch(/^on:\n {2}workflow_call:\n/m);
    expect(yaml).not.toMatch(/^ {2}(?:push|pull_request|pull_request_target|schedule):/m);
  });
  it("runs the script of the release it belongs to", () => {
    const changelog = readFileSync(root("CHANGELOG.md"), "utf8");
    const newest = /^## (\d+\.\d+\.\d+)/m.exec(changelog)?.[1];
    expect(yaml).toContain(`ref: v${newest}`);
  });
});

describe("CALLER_YAML", () => {
  it("calls the workflow at a release for an app in a folder", () => {
    const y = CALLER_YAML("apps/web", "v1.4.0");
    expect(y).toContain("uses: watchbell/watchbell/.github/workflows/precheck.yml@v1.4.0");
    expect(y).toContain("working-directory: apps/web");
    expect(y).toContain("pull-requests: write");
    expect(y).toMatch(/^on:\n {2}pull_request:\n/m);
  });
  it("refuses a folder or tag that isn't one", () => {
    expect(() => CALLER_YAML("../x", "v1.4.0")).toThrow();
    expect(() => CALLER_YAML("apps/web", "main")).toThrow();
  });
});
