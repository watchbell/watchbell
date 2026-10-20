import { describe, expect, it } from "vitest";
import { BANNER_COPY } from "@/lib/copy/edition";
import { aiBanner, providersInfo } from "./ai-banner";

describe("aiBanner: the AI section's provider banner", () => {
  it("is hidden while a provider is connected, and on Bring your own key itself", () => {
    expect(aiBanner({ show: false, antigravityModels: 3, pathname: "/ai" })).toBeNull();
    expect(aiBanner({ show: true, antigravityModels: null, pathname: "/ai/providers" })).toBeNull();
    expect(aiBanner({ show: true, antigravityModels: 2, pathname: "/ai/providers/x" })).toBeNull();
  });
  it("Antigravity connected: an info banner with a quiet link, no Connect a provider button", () => {
    const b = aiBanner({ show: true, antigravityModels: 3, pathname: "/ai/playground" });
    expect(b).toEqual({
      kind: "antigravity",
      title: BANNER_COPY.agentTitle(3),
      body: expect.any(String),
      link: { href: "/ai/providers", text: "Real-time provider (optional) →" },
    });
    expect(JSON.stringify(b)).not.toContain("Connect a provider");
  });
  it("counts one model in the singular, and zero models still means connected", () => {
    expect(aiBanner({ show: true, antigravityModels: 1, pathname: "/ai" })?.title).toBe(BANNER_COPY.agentTitle(1));
    expect(aiBanner({ show: true, antigravityModels: 0, pathname: "/ai" })?.kind).toBe("antigravity");
  });
  it("nothing connected: the warning with the Connect a provider button", () => {
    expect(aiBanner({ show: true, antigravityModels: null, pathname: "/ai/models" })).toEqual({
      kind: "none",
      title: "No AI provider is connected",
      body: expect.stringContaining("503 provider_not_connected"),
      action: { href: "/ai/providers", text: "Connect a provider" },
    });
  });
});

describe("aiBanner with a provider (owner 14 Oct)", () => {
  it("shows which provider and model answer, as an info banner", () => {
    expect(aiBanner({ show: false, antigravityModels: null, pathname: "/ai/ask", provider: { name: "test", model: "test/prrojects" } })).toEqual({
      kind: "provider", title: "Answers come from your provider test (test/prrojects).", body: expect.any(String), link: { href: "/ai/models", text: "Change the default model →" },
    });
  });
  it("still steps aside on Bring your own key", () => {
    expect(aiBanner({ show: false, antigravityModels: null, pathname: "/ai/providers", provider: { name: "test", model: "test/x" } })).toBeNull();
  });
});

describe("providersInfo: Bring your own key's own info box", () => {
  it("Antigravity reported within 24 h: a provider is only for instant answers", () => {
    expect(providersInfo(true)).toEqual({ title: BANNER_COPY.infoAgentTitle, body: BANNER_COPY.infoAgentBody });
  });
  it("otherwise: no provider connected", () => {
    expect(providersInfo(false)).toEqual({ title: "No provider connected", body: BANNER_COPY.infoBody });
  });
});
