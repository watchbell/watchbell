import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// next/navigation and sonner need a Next runtime; the server-render smoke tests only need their shapes.
vi.mock("next/navigation", () => ({ usePathname: () => "/ai/connect", useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/(console)/(private)/ai/quota/actions", () => ({ saveLimits: vi.fn() }));

import { ConnectView } from "@/app/(console)/(private)/ai/connect/connect-view";
import { LimitsForm } from "@/app/(console)/(private)/ai/quota/limits-form";
import { CodeTabs } from "./code-tabs";
import { Ring } from "./ring";
import { activeSub, AI_SUBS, AiSubnav } from "./subnav";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("AiSubnav", () => {
  it("maps a path to its sub-page", () => {
    expect([activeSub("/ai"), activeSub("/ai/"), activeSub("/ai/keys"), activeSub("/ai/connect/x"), activeSub("/ai/quota")]).toEqual(["overview", "keys", "connect", "quota"].flatMap((x, i) => (i === 0 ? ["overview", "overview"] : [x])).slice(0, 5));
    expect(activeSub("/ai/nope")).toBe("overview");
  });
  it("lists the eleven sub-pages and the API explorer, the current one marked", () => {
    const out = html(h(AiSubnav, {}));
    expect(AI_SUBS).toHaveLength(11);
    expect(AI_SUBS[1]).toMatchObject({ key: "usage", label: "Usage", href: "/ai/usage" });
    expect(AI_SUBS[2]).toMatchObject({ key: "ask", label: "Ask", href: "/ai/ask" });
    expect(activeSub("/ai/usage")).toBe("usage");
    expect(activeSub("/ai/ask")).toBe("ask");
    for (const s of AI_SUBS) expect(out).toContain(`href="${s.href}"`);
    expect(out).toContain('href="/api-docs"');
    expect(out.match(/aria-current="page"/g)?.length).toBe(1);
    expect(out).toMatch(/href="\/ai\/connect"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/ai\/connect"/);
  });
});

describe("Ring", () => {
  it("draws the remaining arc and its tone", () => {
    expect(html(h(Ring, { pctLeft: 50 }))).toContain("stroke-brand");
    expect(html(h(Ring, { pctLeft: 20 }))).toContain("stroke-warn-icon");
    expect(html(h(Ring, { pctLeft: 5 }))).toContain("stroke-err");
    expect(html(h(Ring, { pctLeft: 50 }))).toContain('aria-label="50 % remaining"');
  });
});

describe("CodeTabs", () => {
  it("shows the first tab and a Copy button, comment lines dimmed", () => {
    const out = html(h(CodeTabs, { tabs: [["A", "# note\nrun it"], ["B", "other"]] }));
    expect(out).toContain("run it");
    expect(out).not.toContain("other");
    expect(out).toContain("Copy");
    expect(out).toContain("text-code-dim");
  });
});

describe("ConnectView", () => {
  const out = html(h(ConnectView, { siteUrl: "https://watch.example.test", seen: [] }));
  // The private edition opens on Antigravity's config (connect-view.extras.test.ts); both open on the console's origin.
  it("opens on the first agent's config, for the console's own origin", () => {
    expect(out).toContain("https://watch.example.test/api/v1/mcp");
    expect(out).toContain("mcpServers");
  });
  it("has the server toggle (production / local test), production selected for a public SITE_URL", () => {
    expect(out).toContain("Production");
    expect(out).toContain("Local test");
    expect(out).toMatch(/aria-checked="true"[^>]*>Production/);
  });
  it("local SITE_URL selects Local test and offers the known production URL", () => {
    const local = html(h(ConnectView, { siteUrl: "http://localhost:3100", seen: [] }));
    expect(local).toMatch(/aria-checked="true"[^>]*>Local test/);
    expect(local).toContain("http://localhost:3100/api/v1/mcp");
  });
  it("lists the tools incl. submit_ai_note, and both automation prompts' daily one first", () => {
    expect(out).toContain("submit_ai_note");
    expect(out).toContain("list_pending_questions");
    expect(out).toContain("Daily check");
    expect(out).toContain("Answer questions");
    expect(out).toContain("gemini-3.8-flash");
  });
  it("has the 24/7 server section: OpenClaw, Gemini CLI, cron, heartbeat, outbound-only note, Uptime link", () => {
    expect(out).toContain("Run on a server (24/7)");
    expect(out).toContain("outbound HTTPS");
    expect(out).toMatch(/Watchbell never connects into the \w+ or your\s+tailnet/);
    expect(out).toContain('href="/uptime"');
    expect(out).toContain("Telegram");
  });
  it("never shows a key or the retired aggregator name, and has the not-supported cards", () => {
    expect(out).not.toMatch(/w[bp]_[A-Za-z0-9]{40}/);
    expect(out).not.toMatch(/9router/i);
    expect(out).toContain("What agents can&#x27;t do");
    expect(out).toContain("Not supported");
  });
  it("says what it saw when an agent has connected", () => {
    const seen = html(h(ConnectView, { siteUrl: "https://watch.example.test", seen: [{ name: "antigravity/1.2", key: "laptop", ago: "3 min ago" }] }));
    expect(seen).toContain("antigravity/1.2");
    expect(seen).toContain("3 min ago");
    expect(seen).not.toContain("Waiting for a new agent");
  });
});

describe("LimitsForm", () => {
  it("shows each connection's limits as editable rows", () => {
    const out = html(h(LimitsForm, { providers: [{ id: "p1", name: "Google Gemini", limits: [{ metric: "requests", scope: "all", limit: 1000, window: "day" }] }] }));
    expect(out).toContain("Google Gemini");
    expect(out).toContain('value="1000"');
    expect(out).toContain("Add limit");
  });
});
