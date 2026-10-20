import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/auth/actions", () => ({ signOut: vi.fn() }));

import { AliasProvider } from "@/components/alias";
import { EMPTY_BOOK } from "@/lib/view/display-name";
import { Topbar } from "./topbar";

const render = (shot: boolean) => renderToStaticMarkup(h(AliasProvider, {
  book: EMPTY_BOOK, shot,
  children: h(Topbar, { user: { email: "owner@example.com", role: "owner" }, alerts: 0, onToggleNav: () => {}, onOpenPalette: () => {} }),
}));

describe("Topbar screenshot mode (privacy)", () => {
  it("has an eye toggle, off by default, and no pill", () => {
    const out = render(false);
    expect(out).toMatch(/aria-label="Screenshot mode"[^>]*aria-pressed="false"/);
    expect(out).not.toContain("Screenshot mode is on");
  });
  it("while on: the toggle is pressed, a pill says so and turns it off, and the address and its initials are gone", () => {
    const out = render(true);
    expect(out).toMatch(/aria-label="Screenshot mode"[^>]*aria-pressed="true"/);
    expect(out).toContain('aria-label="Screenshot mode is on. Turn it off"');
    expect(out).not.toContain("owner@example.com");
    expect(out).not.toMatch(/>ow</);
  });
});

// The extension's drawer (ExtensionDrawer): the core has no words of its own for it, the extension's link names it.
describe("Topbar extension drawer button", () => {
  const office = { href: "/office", frame: "/office/kantor-virtual.html?api=/api/office/state&floors=1", label: "Kantor virtual", title: "Kantor Virtual", openLabel: "Buka penuh →" };
  const renderAs = (role: "owner" | "operator" | "viewer", withOffice = true) => renderToStaticMarkup(h(AliasProvider, {
    book: EMPTY_BOOK, shot: false,
    children: h(Topbar, { user: { email: "x@example.com", role }, office: withOffice ? office : undefined, alerts: 0, onToggleNav: () => {}, onOpenPalette: () => {} }),
  }));

  it("shows the owner a closed office button right after the data sources toggle, with no iframe until opened", () => {
    const out = renderAs("owner");
    expect(out).toMatch(/aria-label="Kantor virtual"[^>]*aria-pressed="false"/);
    expect(out.indexOf('aria-label="Show data sources"')).toBeLessThan(out.indexOf('aria-label="Kantor virtual"'));
    expect(out.indexOf('aria-label="Kantor virtual"')).toBeLessThan(out.indexOf('aria-label="Screenshot mode"'));
    expect(out).not.toContain("<iframe");
  });

  it("labels the button, and only the button, with the extension's words", () => {
    const out = renderToStaticMarkup(h(AliasProvider, {
      book: EMPTY_BOOK, shot: false,
      children: h(Topbar, { user: { email: "x@example.com", role: "owner" }, office: { href: "/x", frame: "/x.html", label: "Some tool", title: "Some Tool", openLabel: "Open" }, alerts: 0, onToggleNav: () => {}, onOpenPalette: () => {} }),
    }));
    expect(out).toMatch(/aria-label="Some tool"[^>]*aria-pressed="false"/);
    expect(out).not.toMatch(/kantor|office/i);
  });

  it.each(["operator", "viewer"] as const)("hides it from a %s", (role) => {
    expect(renderAs(role)).not.toContain("Kantor virtual");
  });

  it("hides it when the private feature isn't there (no office link)", () => {
    expect(renderAs("owner", false)).not.toContain("Kantor virtual");
  });
});
