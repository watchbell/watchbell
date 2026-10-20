import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpBase } from "../../test/tmp-base";
import { createShutdown, installSignalHandlers, stopRequestFile, watchStopRequest } from "./shutdown";

describe("createShutdown", () => {
  it("stops the jobs, then closes the database, then exits 0, once", async () => {
    const order: string[] = [];
    const exit = vi.fn((c: number) => void order.push(`exit${c}`));
    const run = createShutdown({
      stops: [() => order.push("a"), () => order.push("b")],
      closeDb: async () => void order.push("close"),
      exit,
    });
    await Promise.all([run(), run()]);
    await run();
    expect(order).toEqual(["a", "b", "close", "exit0"]);
  });

  it("still closes the database and exits 1 when a stop or the close fails", async () => {
    const exit = vi.fn();
    const closeDb = vi.fn(async () => {
      throw new Error("boom");
    });
    await createShutdown({
      stops: [
        () => {
          throw new Error("x");
        },
      ],
      closeDb,
      exit,
    })();
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("stopRequestFile", () => {
  it("is <WATCHPOST_DATA_DIR>/stop-request, ./data by default, resolved from the working directory", () => {
    expect(stopRequestFile({})).toBe(path.resolve("data", "stop-request"));
    expect(stopRequestFile({ WATCHPOST_DATA_DIR: "./var/wp" })).toBe(path.resolve("var", "wp", "stop-request"));
  });
});

describe("watchStopRequest", () => {
  const dir = mkdtempSync(path.join(tmpBase, "stop-request "));
  const file = path.join(dir, "stop-request");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    rmSync(file, { force: true });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });
  afterEach(() => vi.useRealTimers());

  it("keeps a request written while the server was starting and stops at the first poll", () => {
    const startedAt = Date.now() - 10_000;
    writeFileSync(file, "during startup"); // mtime: now, after startedAt
    const shutdown = vi.fn(async () => {});
    watchStopRequest({ file, shutdown, intervalMs: 500, startedAt });
    expect(existsSync(file)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(existsSync(file)).toBe(false);
  });

  it("treats a file from just before the start (within the margin) as a startup request", () => {
    writeFileSync(file, "");
    const t = new Date(Date.now() - 1000);
    utimesSync(file, t, t);
    const shutdown = vi.fn(async () => {});
    watchStopRequest({ file, shutdown, startedAt: Date.now(), marginMs: 2000 });
    vi.advanceTimersByTime(1000);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("drops a request left from before the start, then runs shutdown once when the file appears", () => {
    writeFileSync(file, "old");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(file, old, old);
    const shutdown = vi.fn(async () => {});
    watchStopRequest({ file, shutdown, intervalMs: 500, startedAt: Date.now() - 60_000 });
    expect(existsSync(file)).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(shutdown).not.toHaveBeenCalled();
    writeFileSync(file, "");
    vi.advanceTimersByTime(499);
    expect(shutdown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, "");
    vi.advanceTimersByTime(5000);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("polls every second by default, never keeps the process alive, and can be cancelled", () => {
    const unref = vi.fn();
    const real = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
      const t = real(fn, ms);
      const wrapped = Object.assign(t, { unref: () => (unref(), t) });
      return wrapped;
    }) as typeof setInterval);
    const shutdown = vi.fn(async () => {});
    const cancel = watchStopRequest({ file, shutdown });
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(unref).toHaveBeenCalledTimes(1);
    cancel();
    writeFileSync(file, "");
    vi.advanceTimersByTime(5000);
    expect(shutdown).not.toHaveBeenCalled();
  });
});

describe("installSignalHandlers", () => {
  it("runs the clean stop on SIGTERM, SIGINT and SIGHUP (a closed terminal), and only then", () => {
    const on = vi.spyOn(process, "on").mockImplementation(() => process);
    try {
      installSignalHandlers({ stops: [], closeDb: async () => undefined, tty: true });
      expect(on.mock.calls.map(([sig]) => sig).sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
      on.mockClear();
      // No terminal (nohup, systemd): a hang-up is ignored, it does not stop the server.
      const closeDb = vi.fn(async () => undefined);
      installSignalHandlers({ stops: [], closeDb, tty: false });
      expect(on.mock.calls.map(([sig]) => sig).sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
      (on.mock.calls.find(([sig]) => sig === "SIGHUP")![1] as () => void)();
      expect(closeDb).not.toHaveBeenCalled();
      on.mockClear();
      installSignalHandlers({ stops: [], closeDb: async () => undefined, signals: false });
      expect(on).not.toHaveBeenCalled();
    } finally {
      on.mockRestore();
    }
  });
});
