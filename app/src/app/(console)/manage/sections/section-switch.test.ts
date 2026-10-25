import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ setSectionOn: vi.fn() }));

import { followServer } from "./section-switch";

// 1.2 review minor 3: the switch kept its first value; it now follows the server's after a re-render (another tab or
// member changed it, or the page refreshed), while a local change waits for the server.
describe("followServer", () => {
  it("keeps the local value while the server's is unchanged", () => {
    const s = { server: "on" as const, value: false };
    expect(followServer(s, "on")).toBe(s);
  });

  it("takes the server's value when it changes", () => {
    expect(followServer({ server: "on", value: true }, "off")).toEqual({ server: "off", value: false });
    expect(followServer({ server: "off", value: false }, "on")).toEqual({ server: "on", value: true });
    expect(followServer({ server: "on", value: true }, "waiting")).toEqual({ server: "waiting", value: false });
  });
});
