import { beforeEach, describe, expect, it, vi } from "vitest";

// The integration wiring: ports must hand straight through to Task 3's gateway and Task 5's snapshot readers.
const h = vi.hoisted(() => ({ consoleTarget: vi.fn(), complete: vi.fn(), appDetail: vi.fn(), snapAdvisor: vi.fn() }));
vi.mock("@/private/ai/gateway", () => ({ consoleTarget: h.consoleTarget, complete: h.complete }));
vi.mock("@/private/console/snapshot", () => ({ appDetail: h.appDetail, snapAdvisor: h.snapAdvisor }));

import { ports } from "./ports";

const UUID = "3f1c2b9e-8d4a-4c1e-9b7a-2e5d6f7a8b9c";
const NOW = new Date("2026-10-13T01:00:00.000Z");

beforeEach(() => vi.resetAllMocks());

describe("assist ports (stage 5c wiring)", () => {
  it("provider() reports the console target's connection name and public model id", async () => {
    h.consoleTarget.mockResolvedValue({ conn: { name: "Google Gemini" }, upstream: "gemini-3.8-flash", publicId: "gemini/gemini-3.8-flash" });
    await expect(ports.provider()).resolves.toEqual({ name: "Google Gemini", model: "gemini/gemini-3.8-flash" });
    expect(h.consoleTarget).toHaveBeenCalledWith();
  });

  it("provider() is null when no provider is connected (consoleTarget throws)", async () => {
    h.consoleTarget.mockRejectedValue(Object.assign(new Error("No AI provider is connected."), { name: "GatewayError" }));
    await expect(ports.provider()).resolves.toBeNull();
  });

  it("appSnapshot() is Task 5's appDetail, so an app is found by its console uuid", async () => {
    const app = { id: "orbit-blog", name: "orbit-blog", state: "degraded", problems: [] };
    h.appDetail.mockResolvedValue(app);
    await expect(ports.appSnapshot(UUID, NOW)).resolves.toBe(app);
    expect(h.appDetail).toHaveBeenCalledWith(UUID, NOW);
    expect(ports.appSnapshot).toBe(h.appDetail);
  });

  it("advice() is snapAdvisor and complete() is the gateway's complete", async () => {
    h.snapAdvisor.mockResolvedValue([{ title: "t", app: "a", severity: "info" }]);
    await expect(ports.advice(NOW)).resolves.toHaveLength(1);
    expect(h.snapAdvisor).toHaveBeenCalledWith(NOW);
    h.complete.mockResolvedValue({ text: "ok", model: "gemini/gemini-3.8-flash", usage: { in: 1, out: 1 }, ms: 5 });
    await expect(ports.complete([{ role: "user", content: "hi" }], { purpose: "ask-ai" })).resolves.toMatchObject({ text: "ok", ms: 5 });
    expect(ports.complete).toBe(h.complete);
  });
});
