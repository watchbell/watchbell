import { describe, expect, it } from "vitest";
import type { DnsRecord } from "./rules";
import { auditText, canEdit, planEdit, sameRecord, validateEdit, withRecord } from "./dns-edit";

const rec = (over: Partial<DnsRecord> = {}): DnsRecord => ({
  id: "r1", type: "CNAME", name: "tiket.example.com", content: "d5e6f7.vercel-dns-017.com", proxied: true, ttl: 1, comment: null, ...over,
});
const v = (content: string, ttl = 1, proxied = false) => ({ content, ttl, proxied });

describe("canEdit", () => {
  it("only A, AAAA, CNAME and TXT", () => {
    for (const t of ["A", "AAAA", "CNAME", "TXT"]) expect(canEdit(t)).toBe(true);
    for (const t of ["MX", "NS", "SRV", "CAA", "a", ""]) expect(canEdit(t)).toBe(false);
  });
});

describe("validateEdit", () => {
  const a = { type: "A", name: "example.com" };
  it("A needs a dotted IPv4 address", () => {
    expect(validateEdit(a, v(" 76.76.21.21 "))).toEqual({ ok: true, values: v("76.76.21.21") });
    for (const bad of ["76.76.21.256", "76.76.21", "1.2.3.4.5", "example.com", "01.2.3.4", ""]) {
      expect(validateEdit(a, v(bad))).toMatchObject({ ok: false, field: "content" });
    }
  });
  it("AAAA needs an IPv6 address without a zone index", () => {
    expect(validateEdit({ type: "AAAA", name: "example.com" }, v("2606:4700:4700::1111"))).toEqual({ ok: true, values: v("2606:4700:4700::1111") });
    expect(validateEdit({ type: "AAAA", name: "example.com" }, v("2606:4700::ABCD"))).toEqual({ ok: true, values: v("2606:4700::abcd") });
    for (const bad of ["fe80::1%eth0", "76.76.21.21", "2606:::1", "gggg::1", "example.com"]) {
      expect(validateEdit({ type: "AAAA", name: "example.com" }, v(bad))).toMatchObject({ ok: false, field: "content" });
    }
  });
  it("CNAME needs a hostname with a dot, not the record itself; the trailing dot goes and case is folded", () => {
    const c = { type: "CNAME", name: "www.example.com" };
    expect(validateEdit(c, v("Cname.Vercel-DNS.com."))).toEqual({ ok: true, values: v("cname.vercel-dns.com") });
    expect(validateEdit(c, v("_acme.example.com"))).toEqual({ ok: true, values: v("_acme.example.com") });
    for (const bad of ["localhost", "a..b.com", "-a.example.com", "a b.com", "http://x.com", "www.example.com", `${"a".repeat(64)}.com`]) {
      expect(validateEdit(c, v(bad))).toMatchObject({ ok: false, field: "content" });
    }
  });
  it("TXT takes 1–2048 printable characters on one line", () => {
    const t = { type: "TXT", name: "example.com" };
    expect(validateEdit(t, v("v=spf1 include:_spf.mx.cloudflare.net ~all"))).toEqual({ ok: true, values: v("v=spf1 include:_spf.mx.cloudflare.net ~all") });
    expect(validateEdit(t, v("x".repeat(2048)))).toMatchObject({ ok: true });
    for (const bad of ["", "x".repeat(2049), "line\nbreak", "tab\there"]) expect(validateEdit(t, v(bad))).toMatchObject({ ok: false, field: "content" });
  });
  it("TTL is Auto (1) or a whole number from 60 to 86400", () => {
    for (const ttl of [1, 60, 300, 86400]) expect(validateEdit(a, v("1.2.3.4", ttl))).toMatchObject({ ok: true });
    for (const ttl of [0, 2, 59, 86401, 300.5, Number.NaN]) expect(validateEdit(a, v("1.2.3.4", ttl))).toMatchObject({ ok: false, field: "ttl" });
  });
  it("only A, AAAA and CNAME can be proxied, and a proxied record's TTL is Auto", () => {
    expect(validateEdit({ type: "TXT", name: "example.com" }, v("hello", 1, true))).toMatchObject({ ok: false, field: "proxied" });
    expect(validateEdit(a, v("1.2.3.4", 3600, true))).toEqual({ ok: true, values: v("1.2.3.4", 1, true) });
  });
  it("refuses a type the console doesn't edit", () => {
    expect(validateEdit({ type: "MX", name: "example.com" }, v("mx.example.com"))).toMatchObject({ ok: false });
  });
});

describe("planEdit", () => {
  it("lists each changed field as before → after", () => {
    expect(planEdit(rec(), v("d5e6f7.vercel-dns-017.com", 1, false))).toEqual({
      ok: true, values: v("d5e6f7.vercel-dns-017.com", 1, false),
      changes: [{ field: "proxied", before: "Proxied", after: "DNS only" }],
    });
    const p = planEdit(rec({ type: "A", name: "example.com", content: "1.2.3.4", proxied: false, ttl: 300 }), v("76.76.21.21", 3600, false));
    expect(p).toMatchObject({ ok: true, changes: [{ field: "content", before: "1.2.3.4", after: "76.76.21.21" }, { field: "ttl", before: "5 min", after: "1 h" }] });
  });
  it("turning the proxy on shows the TTL becoming Auto", () => {
    expect(planEdit(rec({ type: "A", name: "example.com", content: "1.2.3.4", proxied: false, ttl: 300 }), v("1.2.3.4", 300, true))).toMatchObject({
      ok: true, changes: [{ field: "ttl", before: "5 min", after: "Auto" }, { field: "proxied", before: "DNS only", after: "Proxied" }],
    });
  });
  it("nothing changed (ignoring a trailing dot and case on a CNAME) is refused", () => {
    expect(planEdit(rec(), v("D5E6F7.vercel-dns-017.com.", 1, true))).toEqual({ ok: false, error: "Nothing to change." });
  });
  it("passes a validation error on", () => {
    expect(planEdit(rec({ type: "A", name: "example.com", content: "1.2.3.4" }), v("example.org"))).toMatchObject({ ok: false, error: expect.stringContaining("IPv4") });
  });
});

describe("sameRecord", () => {
  it("compares content (CNAME case and trailing dot folded), TTL and proxy", () => {
    expect(sameRecord(rec(), { content: "D5E6F7.vercel-dns-017.com.", ttl: 1, proxied: true })).toBe(true);
    expect(sameRecord(rec(), { content: "other.vercel-dns-017.com", ttl: 1, proxied: true })).toBe(false);
    expect(sameRecord(rec(), { content: "d5e6f7.vercel-dns-017.com", ttl: 300, proxied: true })).toBe(false);
    expect(sameRecord(rec(), { content: "d5e6f7.vercel-dns-017.com", ttl: 1, proxied: false })).toBe(false);
    expect(sameRecord(rec({ type: "TXT", content: "Abc" }), { content: "abc", ttl: 1, proxied: true })).toBe(false);
  });
});

describe("withRecord", () => {
  it("replaces the record with the same id and keeps the order; an unknown id changes nothing", () => {
    const list = [rec({ id: "a" }), rec({ id: "b" }), rec({ id: "c" })];
    const next = withRecord(list, rec({ id: "b", proxied: false }));
    expect(next.map((r) => [r.id, r.proxied])).toEqual([["a", true], ["b", false], ["c", true]]);
    expect(withRecord(list, rec({ id: "z" }))).toEqual(list);
  });
});

describe("auditText", () => {
  const r = { type: "CNAME", name: "tiket.example.com" };
  it("names a proxy switch on its own", () => {
    expect(auditText(r, [{ field: "proxied", before: "Proxied", after: "DNS only" }])).toEqual({ message: "DNS: tiket.example.com set to DNS only", detail: "proxy Proxied → DNS only" });
    expect(auditText(r, [{ field: "proxied", before: "DNS only", after: "Proxied" }]).message).toBe("DNS: tiket.example.com proxied");
  });
  it("any other change is an edit with every change in the detail", () => {
    expect(auditText(r, [{ field: "content", before: "a.vercel-dns.com", after: "b.vercel-dns.com" }, { field: "ttl", before: "Auto", after: "1 h" }])).toEqual({
      message: "DNS: CNAME tiket.example.com edited", detail: "content a.vercel-dns.com → b.vercel-dns.com · TTL Auto → 1 h",
    });
  });
});
