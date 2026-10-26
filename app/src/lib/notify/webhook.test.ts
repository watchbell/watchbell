import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { secretProblem, sendWebhook, signBody, webhookPayload, webhookUrlProblem } from "./webhook";

const NOW = new Date("2026-10-26T08:00:00Z");
const notice = { kind: "open" as const, ruleKey: "MonitorDown", severity: "critical" as const, title: "orbit-blog", message: "orbit-blog is down", startedAt: new Date("2026-10-26T07:58:00Z"), causedBy: null, provider: null };
const publicLookup = async () => ["93.184.216.34"];

describe("webhook channel (1.2.3)", () => {
  it("accepts only https on a public host, port 443", () => {
    expect(webhookUrlProblem("https://n8n.example.com/webhook/abc")).toBeNull();
    expect(webhookUrlProblem("http://n8n.example.com/webhook/abc")).toMatch(/https/);
    expect(webhookUrlProblem("https://localhost/webhook")).toMatch(/public internet/);
    expect(webhookUrlProblem("https://192.168.1.5/webhook")).toMatch(/public internet/);
    expect(webhookUrlProblem("https://n8n.example.com:5678/webhook")).toMatch(/port 443/);
    expect(webhookUrlProblem("https://user:pw@n8n.example.com/x")).toMatch(/user name/);
    expect(webhookUrlProblem("not a url")).toMatch(/whole address/);
  });

  it("a secret is optional, and long enough when set", () => {
    expect(secretProblem("")).toBeNull();
    expect(secretProblem("short")).toMatch(/16 to 200/);
    expect(secretProblem("x".repeat(16))).toBeNull();
  });

  it("builds a JSON document with the alerts in it", () => {
    const p = webhookPayload("orbit-blog is down", [notice], NOW, "https://ops.example.com/alerts");
    expect(p).toMatchObject({ source: "watchbell", event: "alerts", sentAt: NOW.toISOString(), link: "https://ops.example.com/alerts" });
    expect(p.alerts[0]).toEqual({ status: "firing", rule: "MonitorDown", severity: "critical", title: "orbit-blog", message: "orbit-blog is down", startedAt: "2026-10-26T07:58:00.000Z", causedBy: null, provider: null });
    expect(webhookPayload("test", [], NOW, null).event).toBe("test");
  });

  it("POSTs the document, signed when there is a secret, without following redirects", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const f = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    const p = webhookPayload("x", [notice], NOW, null);
    expect(await sendWebhook({ url: "https://n8n.example.com/webhook/abc", secret: "s".repeat(20) }, p, { fetch: f, lookup: publicLookup })).toEqual({ ok: true });
    const init = seen!.init;
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    const ts = String(Math.floor(NOW.getTime() / 1000));
    expect(headers["X-Watchbell-Timestamp"]).toBe(ts);
    expect(headers["X-Watchbell-Signature"]).toBe(`sha256=${createHmac("sha256", "s".repeat(20)).update(`${ts}.${init.body as string}`).digest("hex")}`);
    expect(signBody("k".repeat(16), "1", "{}")).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("refuses a host that resolves to a private address, at send time", async () => {
    const f = (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;
    const r = await sendWebhook({ url: "https://rebind.example.com/x", secret: "" }, webhookPayload("x", [], NOW, null), { fetch: f, lookup: async () => ["10.0.0.5"] });
    expect(r).toMatchObject({ ok: false, kind: "config" });
  });

  it("names redirects, rate limits and server errors", async () => {
    const answer = (status: number, headers: Record<string, string> = {}) => (async () => new Response(null, { status, headers })) as unknown as typeof fetch;
    const p = webhookPayload("x", [], NOW, null);
    const cfg = { url: "https://n8n.example.com/x", secret: "" };
    expect(await sendWebhook(cfg, p, { fetch: answer(302, { location: "https://elsewhere.example.com" }), lookup: publicLookup })).toMatchObject({ ok: false, kind: "config", error: expect.stringMatching(/redirect/) });
    expect(await sendWebhook(cfg, p, { fetch: answer(429, { "retry-after": "12" }), lookup: publicLookup })).toMatchObject({ ok: false, kind: "transient", retryAfterS: 12 });
    expect(await sendWebhook(cfg, p, { fetch: answer(503), lookup: publicLookup })).toMatchObject({ ok: false, kind: "transient" });
    expect(await sendWebhook(cfg, p, { fetch: answer(404), lookup: publicLookup })).toMatchObject({ ok: false, kind: "config" });
  });
});
