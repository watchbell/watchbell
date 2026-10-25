import { describe, expect, it, vi } from "vitest";
import { buildLogs, parseBuildEvents } from "./vercel-build-logs";

// GET /v3/deployments/{id}/events: one event per output chunk (stdout, stderr), the commands Vercel runs and the step
// delimiters; other types (exit, deployment-state …) are skipped. Text sits in payload.text (older answers: text).
describe("parseBuildEvents", () => {
  it("keeps stdout, stderr, command and delimiter, one line per text line", () => {
    const lines = parseBuildEvents([
      { type: "delimiter", created: 1, payload: { text: "Running build in Washington, D.C." } },
      { type: "command", created: 2, payload: { text: "npm run build" } },
      { type: "stdout", created: 3, payload: { text: "> next build\n  ▲ Next.js 16.4.1\n" } },
      { type: "stderr", created: 4, text: "Error: boom" },
      { type: "exit", created: 5, payload: { info: {} } },
      { type: "stdout", created: 6, payload: {} },
      "nonsense",
    ]);
    expect(lines).toEqual([
      { at: 1, kind: "delimiter", text: "Running build in Washington, D.C." },
      { at: 2, kind: "command", text: "npm run build" },
      { at: 3, kind: "stdout", text: "> next build" },
      { at: 3, kind: "stdout", text: "  ▲ Next.js 16.4.1" },
      { at: 4, kind: "stderr", text: "Error: boom" },
    ]);
  });

  it("strips ANSI colour codes and answers null for something that isn't a list", () => {
    expect(parseBuildEvents([{ type: "stderr", created: 1, payload: { text: "\u001b[31mError\u001b[39m: x" } }])).toEqual([{ at: 1, kind: "stderr", text: "Error: x" }]);
    expect(parseBuildEvents({ error: "x" })).toBeNull();
  });
});

describe("buildLogs", () => {
  const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

  it("asks for the newest build's last 2,000 events with the team id and the token, oldest first in the answer", async () => {
    const f = ok([{ type: "stdout", created: 2, payload: { text: "second" } }, { type: "stdout", created: 1, payload: { text: "first" } }]);
    const r = await buildLogs("tok", "team_a", "dpl_abc12345", { fetch: f as unknown as typeof fetch });
    expect(r).toEqual({ ok: true, data: { lines: [{ at: 1, kind: "stdout", text: "first" }, { at: 2, kind: "stdout", text: "second" }], truncated: false } });
    const [url, init] = (f.mock.calls[0] as unknown as [string, RequestInit]);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://api.vercel.com/v3/deployments/dpl_abc12345/events");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ teamId: "team_a", builds: "1", direction: "backward", limit: "2000" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  // Review T4c Important 2: 2,000 events back means the start of the build may be missing, even in 2,000 lines.
  it("exactly 2,000 events (the API's limit) is marked as cut", async () => {
    const events = Array.from({ length: 2000 }, (_, i) => ({ type: "stdout", created: 2000 - i, payload: { text: `l${2000 - i}` } }));
    const r = await buildLogs("tok", "t", "dpl_abc12345", { fetch: ok(events) as unknown as typeof fetch });
    expect(r.ok && r.data.truncated).toBe(true);
    expect(r.ok && r.data.lines).toHaveLength(2000);
    const few = await buildLogs("tok", "t", "dpl_abc12345", { fetch: ok(events.slice(0, 1999)) as unknown as typeof fetch });
    expect(few.ok && few.data.truncated).toBe(false);
  });

  // Review T4c Minor 1: the order comes from `created`, not from trusting `direction=backward`.
  it("sorts by time whichever way Vercel answers", async () => {
    const asc = ok([{ type: "stdout", created: 1, payload: { text: "first" } }, { type: "stdout", created: 2, payload: { text: "second" } }]);
    const r = await buildLogs("tok", "t", "dpl_abc12345", { fetch: asc as unknown as typeof fetch });
    expect(r.ok && r.data.lines.map((l) => l.text)).toEqual(["first", "second"]);
  });

  it("a refusal is a failure, a strange answer a format failure", async () => {
    const denied = vi.fn(async () => new Response("{}", { status: 403 }));
    expect((await buildLogs("tok", "t", "dpl_abc12345", { fetch: denied as unknown as typeof fetch })).ok).toBe(false);
    const odd = ok({ nope: true });
    expect(await buildLogs("tok", "t", "dpl_abc12345", { fetch: odd as unknown as typeof fetch })).toMatchObject({ ok: false, kind: "format" });
  });
});
