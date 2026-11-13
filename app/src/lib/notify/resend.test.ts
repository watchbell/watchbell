import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sendEmail } from "./resend";

const unmatched: string[] = [];
const server = setupServer(http.all("*", ({ request }) => { unmatched.push(`${request.method} ${request.url}`); return HttpResponse.error(); }));
afterEach(() => { const leaked = unmatched.splice(0); expect(leaked).toEqual([]); });
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const mail = { from: "Ops <noreply@example.com>", to: "me@example.com", subject: "Digest", html: "<p>x</p>", text: "x", idempotencyKey: "digest-2026-10-13" };

describe("sendEmail", () => {
  it("posts to Resend with the key, a User-Agent and an idempotency key", async () => {
    let headers: Headers | null = null;
    let body: unknown;
    server.use(http.post("https://api.resend.com/emails", async ({ request }) => {
      headers = request.headers;
      body = await request.json();
      return HttpResponse.json({ id: "em_1" });
    }));
    expect(await sendEmail("re_x", mail)).toEqual({ ok: true });
    expect(headers!.get("authorization")).toBe("Bearer re_x");
    expect(headers!.get("user-agent")).toBeTruthy();
    expect(headers!.get("idempotency-key")).toBe("digest-2026-10-13");
    expect(body).toEqual({ from: mail.from, to: ["me@example.com"], subject: "Digest", html: "<p>x</p>", text: "x" });
  });
  // Watchbell 1.7: a monthly report goes to up to 5 addresses with the PDF attached.
  it("sends to several addresses with an attachment", async () => {
    let body: Record<string, unknown> = {};
    server.use(http.post("https://api.resend.com/emails", async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ id: "em_2" });
    }));
    expect(await sendEmail("re_x", { ...mail, to: ["a@example.com", "b@example.com"], attachments: [{ filename: "r.pdf", content: "JVBERi0=" }] })).toEqual({ ok: true });
    expect(body.to).toEqual(["a@example.com", "b@example.com"]);
    expect(body.attachments).toEqual([{ filename: "r.pdf", content: "JVBERi0=" }]);
  });

  it("treats 429 as transient and a rejected message as a config problem", async () => {
    server.use(http.post("https://api.resend.com/emails", () => HttpResponse.json({ message: "slow down" }, { status: 429 })));
    expect(await sendEmail("re_x", mail)).toMatchObject({ ok: false, kind: "transient" });
    server.use(http.post("https://api.resend.com/emails", () => HttpResponse.json({ message: "Invalid from" }, { status: 422 })));
    expect(await sendEmail("re_x", mail)).toEqual({ ok: false, kind: "config", error: "Resend: Invalid from" });
  });
});
