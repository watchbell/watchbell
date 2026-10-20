import { afterEach, describe, expect, it, vi } from "vitest";
import { startTelegramPoller, type PollerDeps } from "./telegram-poll";

const TOKEN = "123456:fake-token-for-tests-only-000000";
const upd = (id: number) => ({ update_id: id, callback_query: { id: `q${id}`, from: { id: 1 }, data: "p:x", message: { message_id: 2, chat: { id: -3 } } } });

type GetResult = Awaited<ReturnType<PollerDeps["getUpdates"]>>;

// Runs the poller against scripted getUpdates answers; once the script is spent the poller is stopped.
async function run(script: GetResult[], over: Partial<PollerDeps> = {}) {
  let offset = 0;
  const writes: number[] = [];
  const handled: number[] = [];
  const sleeps: number[] = [];
  const ref: { poller?: { stop(): void } } = {};
  let calls = 0;
  const deps: PollerDeps = {
    token: async () => TOKEN,
    enabled: async () => true,
    offset: { read: async () => offset, write: async (n) => { offset = n; writes.push(n); } },
    getUpdates: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 1)); // like a real long poll: yields to timers
      const next = script[calls++];
      if (calls >= script.length) setTimeout(() => ref.poller?.stop(), 0);
      return next ?? { ok: true as const, updates: [] };
    }),
    handle: async (u) => { handled.push(u.update_id); },
    sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setTimeout(r, 1)); },
    ...over,
  };
  ref.poller = startTelegramPoller(deps);
  await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(script.length));
  await new Promise((r) => setTimeout(r, 20));
  return { deps, writes, handled, sleeps, calls: () => calls };
}

afterEach(() => vi.restoreAllMocks());

describe("startTelegramPoller", () => {
  it("handles updates in order and stores last update_id + 1", async () => {
    const r = await run([{ ok: true, updates: [upd(10), upd(11)] }]);
    expect(r.handled).toEqual([10, 11]);
    expect(r.writes).toEqual([11, 12]);
    expect(r.deps.getUpdates).toHaveBeenNthCalledWith(1, TOKEN, 0);
  });
  it("a conflict (a webhook is set) never deletes the webhook: it says how to switch and backs off 60 s", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await run([{ ok: false, error: "Telegram: Conflict", conflict: true }, { ok: true, updates: [upd(1)] }]);
    expect(r.sleeps[0]).toBe(60_000);
    expect(warn).toHaveBeenCalledWith("telegram poll: Telegram has a webhook set; turn approvals on in Alerts → Notifications to switch this install to polling");
    expect(r.handled).toEqual([1]);
  });
  it("keeps backing off on every conflict, never polling in a tight loop", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const conflict = { ok: false as const, error: "Telegram: Conflict", conflict: true };
    const r = await run([conflict, conflict, conflict]);
    expect(r.sleeps.slice(0, 3)).toEqual([60_000, 60_000, 60_000]);
  });
  it("a handler that throws still advances the offset and is logged with its cause, never the token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handled: number[] = [];
    const r = await run([{ ok: true, updates: [upd(1), upd(2)] }], {
      handle: async (u) => { handled.push(u.update_id); if (u.update_id === 1) throw new Error(`boom at https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`); },
    });
    expect(handled).toEqual([1, 2]);
    expect(r.writes).toEqual([2, 3]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^telegram poll: handling an update failed: boom at /);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN.split(":")[1]);
  });
  it("waits 10 s after another error, says why, and skips the offset for nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await run([{ ok: false, error: "Couldn't reach Telegram. Try again." }, { ok: true, updates: [] }]);
    expect(r.sleeps[0]).toBe(10_000);
    expect(r.writes).toEqual([]);
    expect(warn).toHaveBeenCalledWith("telegram poll: getUpdates failed: Couldn't reach Telegram. Try again.");
  });
  it("a loop error is logged with its cause and waits 10 s", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let reads = 0;
    const r = await run([{ ok: true, updates: [] }], {
      offset: { read: async () => { if (reads++ === 0) throw new Error("connection refused"); return 0; }, write: async () => {} },
    });
    expect(r.sleeps[0]).toBe(10_000);
    expect(warn).toHaveBeenCalledWith("telegram poll: loop error: connection refused");
  });
  it("does nothing while approvals are off", async () => {
    const getUpdates = vi.fn();
    let n = 0;
    const sleeps: number[] = [];
    const p = startTelegramPoller({
      token: async () => TOKEN, enabled: async () => false, offset: { read: async () => 0, write: async () => {} },
      getUpdates, handle: async () => {}, sleep: async (ms) => { sleeps.push(ms); n++; await new Promise((r) => setTimeout(r, 1)); },
    });
    await vi.waitFor(() => expect(n).toBeGreaterThan(1));
    p.stop();
    expect(getUpdates).not.toHaveBeenCalled();
  });
  it("stop() ends the loop", async () => {
    const getUpdates = vi.fn(async () => { await new Promise((r) => setTimeout(r, 1)); return { ok: true as const, updates: [] }; });
    const p = startTelegramPoller({
      token: async () => TOKEN, enabled: async () => true, offset: { read: async () => 0, write: async () => {} },
      getUpdates, handle: async () => {}, sleep: async () => {},
    });
    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalled());
    p.stop();
    await new Promise((r) => setTimeout(r, 20));
    const after = getUpdates.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(getUpdates.mock.calls.length).toBe(after);
  });
});
