import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sendDiscord, webhookProblem } from "./discord";

const unmatched: string[] = [];
const server = setupServer(http.all("*", ({ request }) => { unmatched.push(`${request.method} ${request.url}`); return HttpResponse.error(); }));
afterEach(() => { const leaked = unmatched.splice(0); expect(leaked).toEqual([]); });
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const HOOK = "https://discord.com/api/web" + "hooks/123456789012345678/abcdefghijklmnopqrstuvwxyz-ABCDEF_0123";

describe("webhookProblem", () => {
  it("accepts Discord's own webhook URLs only", () => {
    expect(webhookProblem(HOOK)).toBeNull();
    expect(webhookProblem(HOOK.replace("discord.com", "discordapp.com"))).toBeNull();
    for (const bad of ["https://evil.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz", HOOK.replace("https", "http"), `${HOOK}?wait=1`, "https://discord.com/api/webhooks/x/y", ""]) {
      expect(webhookProblem(bad)).toBe("Paste the whole webhook URL from Discord.");
    }
  });
});

describe("sendDiscord", () => {
  it("posts the content with mentions off and answers ok on 204", async () => {
    let body: unknown;
    server.use(http.post(HOOK, async ({ request }) => { body = await request.json(); return new HttpResponse(null, { status: 204 }); }));
    expect(await sendDiscord(HOOK, "hello")).toEqual({ ok: true });
    expect(body).toEqual({ content: "hello", username: "Watchbell", allowed_mentions: { parse: [] } });
  });
  it("cuts content to Discord's 2,000 characters", async () => {
    let body: { content: string } | null = null;
    server.use(http.post(HOOK, async ({ request }) => { body = (await request.json()) as { content: string }; return new HttpResponse(null, { status: 204 }); }));
    await sendDiscord(HOOK, "x".repeat(2500));
    expect(body!.content).toHaveLength(2000);
  });
  it("reports flood control as transient with a rounded-up wait", async () => {
    server.use(http.post(HOOK, () => HttpResponse.json({ retry_after: 1.5 }, { status: 429 })));
    expect(await sendDiscord(HOOK, "x")).toEqual({ ok: false, kind: "transient", retryAfterS: 2, error: "Discord asked us to wait 2 s." });
  });
  it("reports a deleted webhook as a config problem", async () => {
    server.use(http.post(HOOK, () => new HttpResponse(null, { status: 404 })));
    expect(await sendDiscord(HOOK, "x")).toEqual({ ok: false, kind: "config", error: "Discord says this webhook no longer exists." });
  });
  it("never posts to a URL that isn't a Discord webhook", async () => {
    expect(await sendDiscord("https://evil.com/hook", "x")).toEqual({ ok: false, kind: "config", error: "The saved Discord webhook URL isn't valid." });
  });
});
