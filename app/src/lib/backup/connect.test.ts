import { describe, expect, it } from "vitest";
import { CALLBACK_CODES, CALLBACK_TEXT, checkCallback, isCallbackCode, openTicket, sealTicket, type OAuthTicket } from "./connect";

const key = Buffer.alloc(32, 7).toString("base64");
const otherKey = Buffer.alloc(32, 9).toString("base64");
const ticket: OAuthTicket = { state: "s".repeat(43), verifier: "v".repeat(86), memberId: "mem-1", exp: 1_000_000 };

describe("the sealed connect ticket", () => {
  it("round-trips and is opaque (no state or verifier in the cookie text)", () => {
    const raw = sealTicket(ticket, key);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(raw).not.toContain("sss");
    expect(openTicket(raw, key)).toEqual(ticket);
  });
  it("is null when missing, tampered, too long or sealed with another key", () => {
    const raw = sealTicket(ticket, key);
    expect(openTicket(undefined, key)).toBeNull();
    expect(openTicket(raw.slice(0, -4) + "AAAA", key)).toBeNull();
    expect(openTicket("x".repeat(5000), key)).toBeNull();
    expect(openTicket(raw, otherKey)).toBeNull();
    expect(openTicket("not-base64-json", key)).toBeNull();
  });
});

describe("checkCallback", () => {
  const base = { ticket, state: ticket.state, code: "4/0fake-code", error: null, memberId: "mem-1", now: 999_999 };
  it("accepts the matching state from the same member before it expires", () => {
    expect(checkCallback(base)).toEqual({ ok: true, code: "4/0fake-code", verifier: ticket.verifier });
  });
  it.each([
    [{ ticket: null }, "expired"],
    [{ ticket: null, error: "access_denied" }, "denied"],
    [{ now: 1_000_001 }, "expired"],
    [{ state: "t".repeat(43) }, "state"],
    [{ state: null }, "state"],
    [{ memberId: "mem-2" }, "member"],
    [{ error: "access_denied" }, "denied"],
    [{ code: null }, "missing"],
    [{ code: "x".repeat(3000) }, "missing"],
  ] as const)("refuses %o as %s", (patch, reason) => {
    expect(checkCallback({ ...base, ...patch })).toEqual({ ok: false, reason });
  });
  it("has a sentence for every code and recognises only those codes", () => {
    for (const c of CALLBACK_CODES) expect(CALLBACK_TEXT[c].text.length).toBeGreaterThan(10);
    expect(isCallbackCode("connected")).toBe(true);
    expect(isCallbackCode("<script>")).toBe(false);
    expect(isCallbackCode(null)).toBe(false);
  });
});
