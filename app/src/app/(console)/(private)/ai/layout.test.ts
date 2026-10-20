import { beforeEach, describe, expect, it, vi } from "vitest";

// Follow-up A2: `next build` prerenders every /ai/* route, and this layout used to read the database there (no request,
// no database), which logged "reading ai.defaultModel failed" once per route. connection() first: during the build it
// stops the render before any read; at request time it resolves and the reads run as before.
const { connection, hasEnabledProvider, provider, readAgSettings } = vi.hoisted(() => ({
  connection: vi.fn<() => Promise<void>>(),
  hasEnabledProvider: vi.fn(async () => true),
  provider: vi.fn(async () => ({ name: "Google Gemini", model: "gemini/gemini-3.8-flash" })),
  readAgSettings: vi.fn(),
}));
vi.mock("next/server", () => ({ connection }));
vi.mock("@/private/ai/views-db", () => ({ hasEnabledProvider }));
vi.mock("@/private/assist/ports", () => ({ ports: { provider } }));
vi.mock("@/private/ai/extras", () => ({ readAgSettings, isFresh: () => false, enabledModels: () => [] }));
vi.mock("@/private/ui/no-provider", () => ({ NoProviderBanner: () => null }));
vi.mock("@/private/ui/subnav", () => ({ AiSubnav: () => null }));

import AiLayout from "./layout";

describe("AI layout", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads nothing while there is no request (the build's prerender)", async () => {
    const prerender = new Error("prerender: request-time API");
    connection.mockRejectedValueOnce(prerender);
    await expect(AiLayout({ children: null })).rejects.toBe(prerender);
    expect(hasEnabledProvider).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(readAgSettings).not.toHaveBeenCalled();
  });

  it("at request time reads the provider state as before", async () => {
    connection.mockResolvedValueOnce(undefined);
    await AiLayout({ children: null });
    expect(hasEnabledProvider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(connection.mock.invocationCallOrder[0]).toBeLessThan(hasEnabledProvider.mock.invocationCallOrder[0]);
  });
});
