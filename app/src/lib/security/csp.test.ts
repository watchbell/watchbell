import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { themeInitScript } from "@/lib/theme";
import { cspHeader, isPrerenderedPath, newNonce, themeScriptHash } from "./csp";
import { OFFICE_FRAME_PATH, STATIC_HTML_PATHS } from "./static-html";

const directives = (h: string) => Object.fromEntries(h.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));

describe("CSP header", () => {
  it("dynamic pages: nonce + strict-dynamic + the theme script's hash, nothing inline, no eval in production", async () => {
    const hash = await themeScriptHash();
    expect(hash).toBe(`'sha256-${createHash("sha256").update(themeInitScript).digest("base64")}'`);
    const d = directives(cspHeader({ nonce: "abc123==", themeHash: hash, dev: false }));
    expect(d["script-src"]).toEqual(["'self'", "'nonce-abc123=='", "'strict-dynamic'", hash]);
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(d["img-src"]).toEqual(["'self'", "data:", "https:"]);
    expect(d["connect-src"]).toEqual(["'self'"]);
    expect(d["frame-src"]).toEqual(["'self'", "https://challenges.cloudflare.com"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'none'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
  });

  it("dev adds eval and the dev server's websocket; pages rendered ahead of time allow inline scripts without a nonce", () => {
    const dev = directives(cspHeader({ nonce: "n", themeHash: "'sha256-x'", dev: true }));
    expect(dev["script-src"]).toContain("'unsafe-eval'");
    expect(dev["connect-src"]).toEqual(["'self'", "ws:", "wss:"]);
    const pre = directives(cspHeader({ nonce: null, themeHash: "'sha256-x'", dev: false }));
    expect(pre["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(isPrerenderedPath("/s/acme")).toBe(true);
    for (const p of STATIC_HTML_PATHS) expect(isPrerenderedPath(p)).toBe(true);
    expect(isPrerenderedPath("/settings")).toBe(false);
  });

  // Review T2b-fix m-3: the console frames the office (same origin), and the office file uses Google Fonts.
  it("same-origin frames are allowed everywhere; the office file may be framed by the console and load its fonts", () => {
    const page = directives(cspHeader({ nonce: "n", themeHash: "'sha256-x'", dev: false }));
    expect(page["frame-src"]).toEqual(["'self'", "https://challenges.cloudflare.com"]);
    expect(page["frame-ancestors"]).toEqual(["'none'"]);
    expect(page["font-src"]).toEqual(["'self'", "data:"]);
    const office = directives(cspHeader({ nonce: null, themeHash: "'sha256-x'", dev: false, staticFile: true }));
    expect(office["frame-ancestors"]).toEqual(["'self'"]);
    expect(office["style-src"]).toEqual(["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]);
    expect(office["font-src"]).toEqual(["'self'", "data:", "https://fonts.gstatic.com"]);
    expect(office["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
  });

  // Review T2b-fix I-2: an explicit list of static files, never a ".html" suffix (dynamic console pages answer those too).
  // The list differs per edition (pinned in static-html.test.ts; the open source edition lists none, review T2b-fix3 I-1),
  // so this holds in both. next.config.ts frames the same file (static-html-config.test.ts).
  it("only the listed static files go without a nonce", () => {
    expect(STATIC_HTML_PATHS.every((p) => p === OFFICE_FRAME_PATH)).toBe(true);
    expect(isPrerenderedPath(OFFICE_FRAME_PATH)).toBe(STATIC_HTML_PATHS.includes(OFFICE_FRAME_PATH));
    for (const p of ["/apps/x.html", "/anything.html", "/repos/1.html", "/office/kantor-virtual.html/x", "/office/kantor-virtual.htm", "/x/office/kantor-virtual.html"]) {
      expect(isPrerenderedPath(p)).toBe(false);
    }
  });

  it("a fresh nonce per call, in the form Next reads", () => {
    const a = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(a);
  });
});
