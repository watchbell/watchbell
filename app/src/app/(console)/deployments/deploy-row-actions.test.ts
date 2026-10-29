import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../vercel-actions", () => ({
  cancelAction: vi.fn(), promoteAction: vi.fn(), promotePreviewAction: vi.fn(), redeployAction: vi.fn(), rollbackAction: vi.fn(), buildLogsAction: vi.fn(),
  releaseNotesAction: vi.fn(),
}));

import { DeployRowActions, rowLayout, visitLinks } from "./deploy-row-actions";

const labels = (xs: { label: string }[]) => xs.map((x) => x.label);

// Task 4 build logs: a button for building and failed deployments, a menu item for ready ones.
describe("rowLayout", () => {
  it("failed or building: View build logs is a button (no Visit)", () => {
    expect(rowLayout({ actions: [], logs: "button", visit: true })).toEqual({ buttons: [{ label: "View build logs", kind: "logs" }], menu: [] });
    const b = rowLayout({ actions: ["Cancel"], logs: "button", visit: true });
    expect(labels(b.buttons)).toEqual(["Cancel", "View build logs"]);
  });

  it("ready: Visit and the actions stay buttons, View build logs is in the row menu", () => {
    const r = rowLayout({ actions: ["Redeploy"], logs: "menu", visit: true });
    expect(labels(r.buttons)).toEqual(["Visit", "Redeploy"]);
    expect(labels(r.menu)).toEqual(["View build logs"]);
  });

  it("more than two items all go in the menu, the build log last", () => {
    const r = rowLayout({ actions: ["Roll back to this", "Promote"], logs: "menu", visit: true });
    expect(r.buttons).toEqual([]);
    expect(labels(r.menu)).toEqual(["Visit", "Roll back to this", "Promote", "View build logs"]);
  });

  it("no build log offered: as before", () => {
    expect(rowLayout({ actions: [], logs: null, visit: false })).toEqual({ buttons: [], menu: [] });
  });

  // Watchbell 1.3: a ready production deployment with a commit offers What changed in the menu, next to the build log.
  it("ready production deployment with a commit: What changed sits in the menu after View build logs", () => {
    const r = rowLayout({ actions: ["Redeploy"], logs: "menu", visit: true, changes: true });
    expect(labels(r.buttons)).toEqual(["Visit", "Redeploy"]);
    expect(r.menu).toEqual([{ label: "View build logs", kind: "logs" }, { label: "What changed", kind: "changes" }]);
  });

  it("a preview deployment (changes not offered) has no What changed", () => {
    const r = rowLayout({ actions: ["Promote to production"], logs: "menu", visit: true, changes: false });
    expect(labels([...r.buttons, ...r.menu])).not.toContain("What changed");
  });
});

// Watchbell 1.2.1 (Task 4): Visit on an app's current production deployment opens the app's own domain.
describe("visitLinks", () => {
  const url = "acme-shop-abc123-team.vercel.app";

  it("current production row with a primary domain: Visit is the domain, the deployment URL stays as a second link", () => {
    expect(visitLinks({ url, primaryDomain: "shop.example.com" })).toEqual({ visit: "https://shop.example.com", deployment: `https://${url}` });
  });

  it("current production row without a primary domain: Visit is the deployment URL, no second link", () => {
    expect(visitLinks({ url, primaryDomain: null })).toEqual({ visit: `https://${url}`, deployment: null });
    expect(visitLinks({ url })).toEqual({ visit: `https://${url}`, deployment: null });
  });

  it("a primary domain with no deployment URL: Visit is the domain, no second link", () => {
    expect(visitLinks({ url: null, primaryDomain: "shop.example.com" })).toEqual({ visit: "https://shop.example.com", deployment: null });
  });

  it("neither: nothing to visit", () => {
    expect(visitLinks({ url: null, primaryDomain: null })).toEqual({ visit: "", deployment: null });
  });
});

describe("DeployRowActions Visit", () => {
  const base = { appId: "a1", appName: "acme-shop", externalId: "dpl_1", sha: "abc1234", url: "acme-shop-abc123-team.vercel.app", visit: true };
  const html = (d: object) => renderToStaticMarkup(h(DeployRowActions, { d: { ...base, ...d }, actions: [], logs: null }));

  it("current production row: Visit opens the primary domain and a Deployment URL link is shown", () => {
    const out = html({ primaryDomain: "shop.example.com" });
    expect(out).toContain('href="https://shop.example.com"');
    expect(out).toContain('href="https://acme-shop-abc123-team.vercel.app"');
    expect(out).toContain("Deployment URL");
  });

  it("current production row without a primary domain: Visit is the deployment URL, no second link", () => {
    const out = html({ primaryDomain: null });
    expect(out).toContain('href="https://acme-shop-abc123-team.vercel.app"');
    expect(out).not.toContain("Deployment URL");
  });

  it("any other row (no primary domain passed): Visit is the deployment URL, no second link", () => {
    const out = html({});
    expect(out.match(/href=/g)).toHaveLength(1);
    expect(out).toContain('href="https://acme-shop-abc123-team.vercel.app"');
    expect(out).not.toContain("Deployment URL");
  });

  it("demo (links out disabled): no links at all", () => {
    expect(html({ primaryDomain: "shop.example.com", visit: false })).not.toContain("href=");
  });
});
