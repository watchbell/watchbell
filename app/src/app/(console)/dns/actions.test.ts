import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/action";
import { INVALID, scopeMessage, STALE } from "@/lib/provider-actions";

const ZONE = "123e4567-e89b-42d3-a456-426614174000";
const ACCOUNT = "223e4567-e89b-42d3-a456-426614174000";
const REC = "fedcba9876543210fedcba9876543210";
const owner = { id: "mem-1", userId: "user-1", email: "owner@example.com", role: "owner" as const };

const h = vi.hoisted(() => ({
  requireActionMember: vi.fn(),
  loadTarget: vi.fn(),
  targetQuota: vi.fn(),
  finish: vi.fn(),
  getDnsRecord: vi.fn(),
  updateDnsRecord: vi.fn(),
  storeRecord: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireActionMember: h.requireActionMember }));
vi.mock("@/lib/data/provider-action-db", () => ({ loadTarget: h.loadTarget, targetQuota: h.targetQuota, finish: h.finish }));
vi.mock("@/lib/providers/cloudflare", () => ({ getDnsRecord: h.getDnsRecord, updateDnsRecord: h.updateDnsRecord }));
vi.mock("@/lib/data/dns-edit-db", () => ({ storeRecord: h.storeRecord }));

import { editDnsRecordAction } from "./actions";

const target = {
  resource: { id: ZONE, name: "example.com", externalId: "0123456789abcdef0123456789abcdef", meta: {} },
  account: { id: ACCOUNT, label: "utama", provider: "cloudflare", scopeNote: null },
  token: "cf_secret",
};
const live = { id: REC, type: "CNAME", name: "tiket.example.com", content: "d5e6f7.vercel-dns-017.com", proxied: true, ttl: 1, comment: null };
const shown = { content: "d5e6f7.vercel-dns-017.com", ttl: 1, proxied: true };
const dnsOnly = { ...shown, proxied: false };
const call = (before: unknown = shown, after: unknown = dnsOnly) => editDnsRecordAction(ZONE, REC, before as never, after as never);

beforeEach(() => {
  vi.resetAllMocks();
  h.requireActionMember.mockResolvedValue(owner);
  h.targetQuota.mockResolvedValue(null);
  h.loadTarget.mockResolvedValue(target);
  h.finish.mockImplementation(async (o: { message?: string; failed?: { error: string }; audit?: unknown }) => (
    !o.audit ? { ok: false, error: o.message } : o.failed ? { ok: false, error: o.failed.error } : { ok: true, message: o.message }
  ));
  h.getDnsRecord.mockResolvedValue({ ok: true, data: live });
  h.updateDnsRecord.mockImplementation(async (_t: string, _z: string, _r: string, body: Record<string, unknown>) => ({ ok: true, data: { ...live, ...body } }));
  h.storeRecord.mockResolvedValue(undefined);
});

describe("editDnsRecordAction", () => {
  it("is Owner only: an operator is refused before any quota, load or provider call", async () => {
    h.requireActionMember.mockRejectedValue(new AuthError("forbidden"));
    expect(await call()).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(h.requireActionMember).toHaveBeenCalledWith("owner");
    expect(h.targetQuota).not.toHaveBeenCalled();
    expect(h.getDnsRecord).not.toHaveBeenCalled();
    expect(h.updateDnsRecord).not.toHaveBeenCalled();
  });

  it("rejects malformed ids and values before the quota", async () => {
    for (const r of [
      await editDnsRecordAction("nope", REC, shown, dnsOnly),
      await editDnsRecordAction(ZONE, "../x", shown, dnsOnly),
      await call({ content: 1, ttl: 1, proxied: true }),
      await call(shown, { content: "x", ttl: "1", proxied: false }),
      await call(shown, { content: "x".repeat(5000), ttl: 1, proxied: false }),
      await call(null, dnsOnly),
    ]) expect(r).toEqual({ ok: false, error: INVALID });
    expect(h.targetQuota).not.toHaveBeenCalled();
  });

  it("passes the quota's message through, keyed per record, with no provider call", async () => {
    h.targetQuota.mockResolvedValue("That was just done. Wait a minute before trying again.");
    expect(await call()).toEqual({ ok: false, error: "That was just done. Wait a minute before trying again." });
    expect(h.targetQuota).toHaveBeenCalledWith("mem-1", "dns", REC);
    expect(h.loadTarget).not.toHaveBeenCalled();
  });

  it("refuses a zone that is gone, with no provider call", async () => {
    h.loadTarget.mockResolvedValue(null);
    expect((await call()).ok).toBe(false);
    expect(h.loadTarget).toHaveBeenCalledWith(ZONE, "zone");
    expect(h.getDnsRecord).not.toHaveBeenCalled();
  });

  it("a record Cloudflare no longer has is refused, not written", async () => {
    h.getDnsRecord.mockResolvedValue({ ok: false, kind: "missing", status: 404, error: "Cloudflare can't find this record any more." });
    expect(await call()).toEqual({ ok: false, error: expect.stringContaining("can't find this record") });
    expect(h.updateDnsRecord).not.toHaveBeenCalled();
  });

  it("never touches a type the console doesn't edit", async () => {
    h.getDnsRecord.mockResolvedValue({ ok: true, data: { ...live, type: "MX", content: "mx.example.com", proxied: false } });
    expect(await call({ content: "mx.example.com", ttl: 1, proxied: false }, { content: "mx2.example.com", ttl: 1, proxied: false })).toEqual({
      ok: false, error: "Only A, AAAA, CNAME and TXT records can be edited here.",
    });
    expect(h.updateDnsRecord).not.toHaveBeenCalled();
  });

  it("STALE when Cloudflare's record differs from the dialog's; the live record is stored so a reload shows it", async () => {
    const changed = { ...live, content: "other.vercel-dns-017.com" };
    h.getDnsRecord.mockResolvedValue({ ok: true, data: changed });
    expect(await call()).toEqual({ ok: false, error: STALE });
    expect(h.updateDnsRecord).not.toHaveBeenCalled();
    expect(h.storeRecord).toHaveBeenCalledWith(ZONE, changed);
  });

  it("nothing to change and invalid values are refused with no write", async () => {
    expect(await call(shown, shown)).toEqual({ ok: false, error: "Nothing to change." });
    expect(await call(shown, { content: "not a host", ttl: 1, proxied: true })).toEqual({ ok: false, error: expect.stringContaining("hostname") });
    expect(h.updateDnsRecord).not.toHaveBeenCalled();
  });

  it("Set DNS only: PATCHes the live type and name with proxied false, audits it and stores the answer", async () => {
    const r = await call();
    expect(r).toEqual({ ok: true, message: expect.stringContaining("tiket.example.com is DNS only now") });
    expect(h.updateDnsRecord).toHaveBeenCalledWith("cf_secret", target.resource.externalId, REC, { type: "CNAME", name: "tiket.example.com", content: "d5e6f7.vercel-dns-017.com", ttl: 1, proxied: false });
    const [outcome, who, accountId] = h.finish.mock.calls[0];
    expect(outcome).toMatchObject({ done: true, audit: { message: "DNS: tiket.example.com set to DNS only", resourceId: ZONE, detail: "proxy Proxied → DNS only" } });
    expect(who).toBe(owner);
    expect(accountId).toBe(ACCOUNT);
    expect(h.storeRecord).toHaveBeenCalledWith(ZONE, expect.objectContaining({ id: REC, proxied: false }));
  });

  it("a TXT edit sends no proxied field", async () => {
    const txt = { ...live, type: "TXT", name: "_test.example.com", content: "hello", proxied: false, ttl: 3600 };
    h.getDnsRecord.mockResolvedValue({ ok: true, data: txt });
    const r = await call({ content: "hello", ttl: 3600, proxied: false }, { content: "hello again", ttl: 300, proxied: false });
    expect(r.ok).toBe(true);
    expect(h.updateDnsRecord.mock.calls[0][3]).toEqual({ type: "TXT", name: "_test.example.com", content: "hello again", ttl: 300 });
    expect(h.finish.mock.calls[0][0]).toMatchObject({ audit: { message: "DNS: TXT _test.example.com edited", detail: "content hello → hello again · TTL 1 h → 5 min" } });
  });

  it("a 403 on the write answers the Cloudflare scope sentence and is handed to finish as a scope failure", async () => {
    h.updateDnsRecord.mockResolvedValue({ ok: false, kind: "scope", status: 403, error: "The token can't edit this record." });
    expect(await call()).toEqual({ ok: false, error: scopeMessage("cloudflare", {}) });
    expect(h.finish.mock.calls[0][0]).toMatchObject({ done: false, failed: { kind: "scope", error: scopeMessage("cloudflare", {}) }, audit: { message: "DNS edit failed · CNAME tiket.example.com", resourceId: ZONE } });
    expect(h.storeRecord).not.toHaveBeenCalled();
  });

  it("a 403 on the live read is the same scope answer (the token can't touch DNS), without a write", async () => {
    h.getDnsRecord.mockResolvedValue({ ok: false, kind: "scope", status: 403, error: "The token can't read this record." });
    expect(await call()).toEqual({ ok: false, error: scopeMessage("cloudflare", {}) });
    expect(h.updateDnsRecord).not.toHaveBeenCalled();
  });

  it("another refusal is passed on and audited as a failure", async () => {
    h.updateDnsRecord.mockResolvedValue({ ok: false, kind: "transient", status: 400, error: "Cloudflare refused this change (400, code 9005)." });
    expect(await call()).toEqual({ ok: false, error: "Cloudflare refused this change (400, code 9005)." });
    expect(h.finish.mock.calls[0][0]).toMatchObject({ failed: { kind: "transient" } });
  });

  it("a failed snapshot update after the write doesn't turn it into a failure", async () => {
    h.storeRecord.mockRejectedValue(new Error("db down"));
    expect((await call()).ok).toBe(true);
  });
});
