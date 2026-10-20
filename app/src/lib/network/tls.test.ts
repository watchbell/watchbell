import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { parseCertDate, readCertificate } from "./tls";

// A fake TLS socket: emits secureConnect (or error / timeout) on the next tick, like node:tls does.
function fakeConnect(outcome: "ok" | "error" | "timeout", cert: Record<string, unknown> = { valid_to: "Dec  9 23:59:59 2026 GMT", issuer: { O: "Let's Encrypt", CN: "R11" } }, authorized = true) {
  const calls: Record<string, unknown>[] = [];
  const connect = (opts: Record<string, unknown>) => {
    calls.push(opts);
    const s = Object.assign(new EventEmitter(), {
      authorized, authorizationError: authorized ? null : "CERT_HAS_EXPIRED",
      getPeerCertificate: () => cert, end: () => undefined, destroy: () => undefined, setTimeout: () => undefined,
    });
    setTimeout(() => (outcome === "ok" ? s.emit("secureConnect") : outcome === "error" ? s.emit("error", new Error("ECONNRESET")) : s.emit("timeout")), 0);
    return s;
  };
  return { connect, calls };
}

describe("parseCertDate", () => {
  it("reads OpenSSL's valid_to text", () => {
    expect(parseCertDate("Dec  9 23:59:59 2026 GMT")?.toISOString()).toBe("2026-12-09T23:59:59.000Z");
    expect(parseCertDate("Nov 20 23:59:59 2019 GMT")?.toISOString()).toBe("2019-11-20T23:59:59.000Z");
  });
  it("is null for anything else", () => {
    expect(parseCertDate("tomorrow")).toBeNull();
    expect(parseCertDate(undefined)).toBeNull();
  });
});

describe("readCertificate", () => {
  const lookup = async () => ["76.76.21.21"];
  it("connects to the checked address with SNI and reads expiry, issuer and trust", async () => {
    const f = fakeConnect("ok");
    const r = await readCertificate("app.example.com", { lookup, connect: f.connect });
    expect(r).toEqual({ ok: true, notAfter: new Date("2026-12-09T23:59:59Z"), issuer: "Let's Encrypt", authorized: true, authError: null });
    expect(f.calls[0]).toMatchObject({ host: "76.76.21.21", port: 443, servername: "app.example.com", rejectUnauthorized: false });
  });
  it("still reads an untrusted (expired) certificate, and says so", async () => {
    const f = fakeConnect("ok", { valid_to: "Jan  1 00:00:00 2020 GMT", issuer: { CN: "Old CA" } }, false);
    expect(await readCertificate("app.example.com", { lookup, connect: f.connect })).toMatchObject({ ok: true, authorized: false, authError: "CERT_HAS_EXPIRED", issuer: "Old CA" });
  });
  it("refuses a host that resolves to any private address, without connecting", async () => {
    const f = fakeConnect("ok");
    expect(await readCertificate("app.example.com", { lookup: async () => ["76.76.21.21", "10.0.0.5"], connect: f.connect })).toEqual({ ok: false, error: "Blocked address" });
    expect(f.calls).toHaveLength(0);
  });
  it("review M6: a connect that throws is a failed read, and leaves no timer behind", async () => {
    const throwing = () => { throw new Error("EINVAL"); };
    expect(await readCertificate("app.example.com", { lookup, connect: throwing as never, timeoutMs: 20 })).toEqual({ ok: false, error: "Couldn't connect" });
    await new Promise((r) => setTimeout(r, 60)); // a leftover timer would throw a ReferenceError here
  });
  it("review M6: prefers an IPv4 address (Vercel's egress is IPv4-only) once every address passed the check", async () => {
    const f = fakeConnect("ok");
    await readCertificate("app.example.com", { lookup: async () => ["2606:4700:4700::1111", "76.76.21.21"], connect: f.connect });
    expect(f.calls[0]).toMatchObject({ host: "76.76.21.21" });
    const g = fakeConnect("ok");
    await readCertificate("app.example.com", { lookup: async () => ["2606:4700:4700::1111"], connect: g.connect });
    expect(g.calls[0]).toMatchObject({ host: "2606:4700:4700::1111" });
  });
  it("refuses IP literals and localhost names", async () => {
    const f = fakeConnect("ok");
    expect(await readCertificate("127.0.0.1", { lookup, connect: f.connect })).toEqual({ ok: false, error: "Blocked address" });
    expect(await readCertificate("localhost", { lookup, connect: f.connect })).toEqual({ ok: false, error: "Blocked address" });
    expect(f.calls).toHaveLength(0);
  });
  it("reports a connection error, a timeout and no address in the console's words", async () => {
    expect(await readCertificate("app.example.com", { lookup, connect: fakeConnect("error").connect })).toEqual({ ok: false, error: "Couldn't connect" });
    expect(await readCertificate("app.example.com", { lookup, connect: fakeConnect("timeout").connect, timeoutMs: 5000 })).toEqual({ ok: false, error: "No answer within 5 s" });
    expect(await readCertificate("app.example.com", { lookup: async () => [], connect: fakeConnect("ok").connect })).toEqual({ ok: false, error: "The name doesn't resolve" });
  });
  it("a certificate without a readable expiry is an error", async () => {
    expect(await readCertificate("app.example.com", { lookup, connect: fakeConnect("ok", { valid_to: "?" }).connect })).toEqual({ ok: false, error: "The certificate has no readable expiry date" });
  });
});
