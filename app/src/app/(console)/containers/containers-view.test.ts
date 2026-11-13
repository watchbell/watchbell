import { describe, expect, it, vi } from "vitest";

vi.mock("./containers-actions", () => ({ containerListAction: vi.fn(), containerDetailAction: vi.fn(), containerVerbAction: vi.fn() }));

import { bytes, containerState } from "./containers-view";

describe("containerState", () => {
  it("puts trouble first in the console's state words", () => {
    expect(containerState({ state: "running", health: "unhealthy" })).toBe("err");
    expect(containerState({ state: "restarting", health: null })).toBe("warn");
    expect(containerState({ state: "running", health: "starting" })).toBe("warn");
    expect(containerState({ state: "running", health: "healthy" })).toBe("ok");
    expect(containerState({ state: "paused", health: null })).toBe("paused");
    expect(containerState({ state: "exited", health: null })).toBe("off");
  });
});

describe("bytes", () => {
  it("reads memory the way people say it", () => {
    expect(bytes(null)).toBe("—");
    expect(bytes(187_000_000)).toBe("187 MB");
    expect(bytes(1_500_000_000)).toBe("1.5 GB");
    expect(bytes(4_000)).toBe("4 kB");
  });
});
