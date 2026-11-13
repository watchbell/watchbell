import { describe, expect, it } from "vitest";
import { changelogVersion, compareVersions, fetchLatestVersion, parseLatest, parseSeen, runningVersion, updateNotice, whatsNewUrl } from "./self-update";

const latest = (version: string) => ({ version, checkedAt: "2026-10-26T00:00:00Z" });

// Owner 13 Nov: the cloud edition shows its version too. It has no CLI to hand one over, so the build
// takes the newest heading of the CHANGELOG (next.config.ts, WATCHBELL_BUILD_VERSION).
describe("the console's version without the CLI (owner 13 Nov)", () => {
  it("falls back to the build's version; the CLI's wins", () => {
    expect(runningVersion({}, "1.6.0")).toBe("1.6.0");
    expect(runningVersion({ WATCHBELL_VERSION: "1.6.1" }, "1.6.0")).toBe("1.6.1");
    expect(runningVersion({}, "next")).toBeNull();
    expect(runningVersion({}, undefined)).toBeNull();
  });

  it("reads the newest version heading of the CHANGELOG", () => {
    expect(changelogVersion(["# Changelog", "", "Intro.", "", "## 1.6.0", "", "### Database", "", "## 1.3.1", ""].join("\n"))).toBe("1.6.0");
    expect(changelogVersion(["# Changelog", "", "## Unreleased", "", "## 1.2.3", ""].join("\r\n"))).toBe("1.2.3");
    expect(changelogVersion("no headings")).toBeNull();
  });

  it("cloud: What's new once per new version, from the first one; never 'a newer version is out'", () => {
    expect(updateNotice({ running: "1.6.0", latest: latest("9.0.0"), seen: null, cloud: true })).toEqual({ kind: "updated", version: "1.6.0" });
    expect(updateNotice({ running: "1.6.0", latest: null, seen: "1.3.1", cloud: true })).toEqual({ kind: "updated", version: "1.6.0" });
    expect(updateNotice({ running: "1.6.0", latest: null, seen: "1.6.0", cloud: true })).toBeNull();
  });
});

describe("self-update notices (1.2.3)", () => {
  it("reads the version the CLI hands the server, and nothing else", () => {
    expect(runningVersion({ WATCHBELL_VERSION: "1.2.3" })).toBe("1.2.3");
    expect(runningVersion({ WATCHBELL_VERSION: "latest; rm -rf /" })).toBeNull();
    expect(runningVersion({})).toBeNull();
  });

  it("compares versions numerically", () => {
    expect(compareVersions("1.2.10", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1.3.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("a newer npm version first, then What's new once after an update, nothing on a first install", () => {
    expect(updateNotice({ running: "1.2.3", latest: latest("1.2.4"), seen: "1.2.2" })).toEqual({ kind: "update", running: "1.2.3", latest: "1.2.4" });
    expect(updateNotice({ running: "1.2.3", latest: latest("1.2.3"), seen: "1.2.2" })).toEqual({ kind: "updated", version: "1.2.3" });
    expect(updateNotice({ running: "1.2.3", latest: latest("1.2.3"), seen: "1.2.3" })).toBeNull();
    expect(updateNotice({ running: "1.2.3", latest: null, seen: null })).toBeNull();
    expect(updateNotice({ running: null, latest: latest("9.0.0"), seen: null })).toBeNull(); // cloud: no version, no notice
  });

  it("parses only well-formed rows and links the CHANGELOG section", () => {
    expect(parseLatest({ version: "1.2.4", checkedAt: "x" })).toEqual({ version: "1.2.4", checkedAt: "x" });
    expect(parseLatest({ version: "<script>", checkedAt: "x" })).toBeNull();
    expect(parseSeen({ version: "1.2.2" })).toBe("1.2.2");
    expect(parseSeen("1.2.2")).toBeNull();
    expect(whatsNewUrl("1.2.3")).toBe("https://github.com/watchbell/watchbell/blob/main/CHANGELOG.md#123");
  });

  it("asks npm with one GET and never throws", async () => {
    const seen: string[] = [];
    const ok = (async (url: string, init: RequestInit) => { seen.push(`${init.method} ${url}`); return new Response(JSON.stringify({ version: "1.2.4" }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ fetch: ok })).toEqual({ ok: true, version: "1.2.4" });
    expect(seen).toEqual(["GET https://registry.npmjs.org/watchbell/latest"]);
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ fetch: down })).toEqual({ ok: false, error: "Couldn't reach registry.npmjs.org" });
    const odd = (async () => new Response(JSON.stringify({ version: "latest" }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ fetch: odd })).toEqual({ ok: false, error: "registry.npmjs.org answered without a version" });
  });
});
