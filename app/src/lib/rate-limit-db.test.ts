import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ count: 1, sweepFails: false }));

vi.mock("@/db/client", () => ({
  db: () => ({
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({ returning: async () => [{ count: state.count }] }),
      }),
    }),
    delete: () => ({
      where: async () => {
        if (state.sweepFails) throw new Error("connection reset");
      },
    }),
  }),
}));

import { limit } from "./rate-limit-db";

afterEach(() => {
  state.sweepFails = false;
  vi.restoreAllMocks();
});

describe("limit", () => {
  it("still decides when the sweep of old windows fails", async () => {
    state.sweepFails = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(limit({ name: "t", max: 5, windowSeconds: 60 }, "a@example.com")).resolves.toMatchObject({ allowed: true });
    expect(warn).toHaveBeenCalledWith("rate limit sweep failed");
  });
});
