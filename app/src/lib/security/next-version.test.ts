import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractNextVersion, isNextVersion, nextScriptUrls } from "./next-version";
import { compareVersions } from "./semver";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("nextScriptUrls", () => {
  const html = fixture("app-router.html.txt");
  const urls = nextScriptUrls(html, "https://nova-wallet.vercel.app/");

  it("keeps same-origin /_next/static scripts only, likely runtime files first, without duplicates", () => {
    expect(urls).toEqual([
      "https://nova-wallet.vercel.app/_next/static/chunks/main-app-9c8d7e6f5a4b3c2d.js",
      "https://nova-wallet.vercel.app/_next/static/chunks/4bd1b696-6f1e2c3d4a5b6c7d.js",
      "https://nova-wallet.vercel.app/_next/static/chunks/1684-0a1b2c3d4e5f6a7b.js",
      "https://nova-wallet.vercel.app/_next/static/chunks/app/page-1a2b3c4d5e6f7a8b.js?dpl=dpl_8xYz&v=1",
      "https://nova-wallet.vercel.app/_next/static/chunks/webpack-5e8c1b7a3f0d2e91.js",
      "https://nova-wallet.vercel.app/_next/static/chunks/polyfills-42372ed130431b0a.js",
    ]);
  });
  it("never follows a script on another origin", () => {
    expect(urls.some((u) => u.includes("cdn.example.net"))).toBe(false);
    expect(urls.some((u) => u.includes("/js/analytics.js"))).toBe(false);
  });
  it("resolves against the final page address after redirects", () => {
    expect(nextScriptUrls('<script src="/_next/static/chunks/main-1.js"></script>', "https://www.example.com/en")).toEqual([
      "https://www.example.com/_next/static/chunks/main-1.js",
    ]);
  });
  it("finds nothing on a site that isn't built with Next.js", () => {
    expect(nextScriptUrls(fixture("plain-site.html.txt"), "https://plain.example.com/")).toEqual([]);
  });
  it("ignores a script address it cannot parse and a non-https one", () => {
    expect(nextScriptUrls('<script src="http://a.example/_next/static/x.js"></script><script src="https://[bad/_next/static/y.js"></script>', "https://a.example/")).toEqual([]);
  });
});

describe("extractNextVersion", () => {
  it("reads the App Router runtime (window.next with appDir), not React's own version", () => {
    expect(extractNextVersion(fixture("app-router-chunk.js.txt"))).toBe("15.1.0");
  });
  it("reads the Pages Router runtime, where the version is a variable", () => {
    expect(extractNextVersion(fixture("pages-router-main.js.txt"))).toBe("14.2.3");
  });
  it("tolerates spacing, quotes, other globals and a prerelease", () => {
    expect(extractNextVersion('window.next = {\n    version: "16.4.0",\n    appDir: true\n};')).toBe("16.4.0");
    expect(extractNextVersion("self.next={version:'15.0.0-canary.12',appDir:!0}")).toBe("15.0.0-canary.12");
    expect(extractNextVersion('n.next={version:"13.5.6",appDir:!0}')).toBe("13.5.6");
    expect(extractNextVersion('{appDir:!0,version:"15.3.1"}')).toBe("15.3.1");
  });
  it("never guesses from an unrelated version string", () => {
    expect(extractNextVersion(fixture("plain-site.html.txt"))).toBeNull();
    expect(extractNextVersion('t.version="19.0.0";var o={bundleType:0,version:"19.0.0",rendererPackageName:"react-dom"}')).toBeNull();
    expect(extractNextVersion('window.next={version:u,router:r}; var u=someFn()')).toBeNull();
  });
  it("takes version beside appDir only inside the same object literal, never React's nearby version", () => {
    expect(extractNextVersion('var d={bundleType:0,version:"19.0.0",rendererPackageName:"react-dom"};var c={appDir:!0}')).toBeNull();
    expect(extractNextVersion('x={version:"15.3.1",appDir:!0}')).toBe("15.3.1");
  });
  it("reads the Pages Router variable from its last definition before window.next, not another module's", () => {
    expect(extractNextVersion('let Y="13.5.6";function h(){window.next={version:Y,router:r}}let Q=1;{let Y="19.0.0"}')).toBe("13.5.6");
    expect(extractNextVersion('let Y="12.0.0";{let Y="14.2.3";window.next={version:Y,router:r}}')).toBe("14.2.3");
    expect(extractNextVersion('window.next={version:Y,router:r};let Y="19.0.0"')).toBeNull();
  });
  it("rejects a version below 9 or that isn't semver", () => {
    expect(extractNextVersion('window.next={version:"8.1.0",appDir:!0}')).toBeNull();
    expect(extractNextVersion('window.next={version:"15.1",appDir:!0}')).toBeNull();
    expect(extractNextVersion('window.next={version:"latest",appDir:!0}')).toBeNull();
  });
});

describe("isNextVersion", () => {
  it.each([["15.1.0", true], ["9.0.0", true], ["16.0.0-canary.3", true], ["8.9.9", false], ["15.1", false], ["v15.1.0", false], ["15.1.0 ", false]])(
    "%s → %s", (v, ok) => expect(isNextVersion(v)).toBe(ok),
  );
});

describe("compareVersions", () => {
  it("orders numerically, a prerelease before its release", () => {
    expect(compareVersions("15.2.3", "15.10.0")).toBeLessThan(0);
    expect(compareVersions("15.1.0", "15.1.0")).toBe(0);
    expect(compareVersions("15.1.0-canary.0", "15.1.0")).toBeLessThan(0);
    expect(compareVersions("15.1.0-canary.2", "15.1.0-canary.10")).toBeLessThan(0);
    expect(compareVersions("16.0.0", "15.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0", "11.1.4")).toBeLessThan(0);
  });
});
