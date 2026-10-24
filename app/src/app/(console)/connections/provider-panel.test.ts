import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireActionMember: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/connections", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { accessHint } from "@/lib/view/access";
import { type PanelAccount, ProviderPanel } from "./provider-panel";

const account = (over: Partial<PanelAccount> = {}): PanelAccount => ({
  id: "a1", label: "utama", credentialKind: "API token", scopeNote: "Zone, DNS, SSL and Certificates read", hint: null,
  expires: "No expiry", lastSync: "2 min ago", problem: null, unreadable: false, watchNew: true, monitored: { on: 2, total: 3, fresh: 1 },
  ...over,
});
const render = (props: Parameters<typeof ProviderPanel>[0]) => renderToStaticMarkup(createElement(ProviderPanel, props));

// 1.2 (spec §7): the drawer a provider tile opens.
describe("Provider drawer", () => {
  it("lists the provider's accounts with Sync, Test connection, Replace credential and Remove", () => {
    const out = render({ provider: "cloudflare", accounts: [account(), account({ id: "a2", label: "kantor" })], demo: false });
    expect(out).toContain("Accounts (2)");
    expect(out).toContain("utama");
    expect(out).toContain("kantor");
    expect(out.match(/ Sync<\/button>/g)?.length).toBe(2);
    expect(out.match(/Test connection/g)?.length).toBe(3); // one per account, one in the add form
    expect(out.match(/Replace credential/g)?.length).toBe(2);
    expect(out.match(/>Remove</g)?.length).toBe(2);
    expect(out).toContain("2</span><span class=\"text-ink-faint\"> of 3");
  });

  it("offers the guided form: Create one, It needs, Test connection and Save", () => {
    const out = render({ provider: "cloudflare", accounts: [], demo: false });
    expect(out).toContain("Connect Cloudflare");
    expect(out).toContain('href="https://dash.cloudflare.com/profile/api-tokens"');
    expect(out).toContain("Create one");
    expect(out).toContain("It needs");
    expect(out).toContain("Zone: Read, DNS: Read, SSL and Certificates: Read");
    expect(out).toContain(">Test connection<");
    expect(out).toContain(">Save<");
    expect(out).toContain("Save tests the credential first.");
  });

  it("a single-account provider that is connected offers no second account", () => {
    const out = render({ provider: "vercel", accounts: [account({ label: "acme", credentialKind: "Access token" })], demo: false });
    expect(out).not.toContain("Add another account");
    expect(out).toContain("One Vercel account per Watchbell");
  });

  it("a multi-account provider can add another", () => {
    expect(render({ provider: "neon", accounts: [account()], demo: false })).toContain("Add another account");
  });

  it("an account with a problem says so, offers Replace first and no Sync", () => {
    const out = render({ provider: "neon", accounts: [account({ problem: "Neon rejected this credential (401). Check that you copied all of it." })], demo: false });
    expect(out).toContain("Neon rejected this credential (401)");
    expect(out).not.toContain(" Sync</button>");
  });

  it("a write-capable token is flagged under Access once an action used it (today's check, accessHint)", () => {
    const note = "Zone, DNS, SSL and Certificates read";
    const flagged = render({ provider: "cloudflare", accounts: [account({ hint: accessHint("cloudflare", { write: "ok", at: "2026-10-21T00:00:00Z" }, note) })], demo: false });
    expect(flagged).toContain("Actions on: DNS edit");
    const untried = render({ provider: "cloudflare", accounts: [account({ hint: accessHint("cloudflare", undefined, note) })], demo: false });
    expect(untried).toContain("Actions: not tried yet");
    expect(untried).not.toContain("Actions on");
  });

  it("demo accounts read as demo accounts", () => {
    expect(render({ provider: "turso", accounts: [account()], demo: true })).toContain("Demo account");
  });
});
