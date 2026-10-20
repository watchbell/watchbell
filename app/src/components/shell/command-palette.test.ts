import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PaletteItem } from "@/lib/view/palette";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/app/(console)/palette-action", () => ({ loadPaletteSource: vi.fn() }));

import { PaletteDialog } from "./command-palette";

const items: PaletteItem[] = [
  { id: "page:overview", label: "Overview", hint: "Home", href: "/overview", icon: "dashboard" },
  { id: "app:a1", label: "web", hint: "web.example.com", href: "/apps/a1", icon: "apps" },
];
const html = (props: { items?: PaletteItem[]; loading?: boolean } = {}) =>
  renderToStaticMarkup(h(PaletteDialog, { items: props.items ?? items, loading: props.loading ?? false, onClose: () => {} }));

describe("PaletteDialog markup", () => {
  it("is a labelled modal dialog with the mockup's placeholder", () => {
    const out = html();
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
    expect(out).toContain('aria-label="Search"');
    expect(out).toContain('placeholder="Jump to a page, app, database, or domain"');
  });
  it("uses the combobox / listbox pattern with the first option selected", () => {
    const out = html();
    expect(out).toContain('role="combobox"');
    expect(out).toContain('role="listbox"');
    expect(out.match(/role="option"/g)).toHaveLength(2);
    expect(out).toMatch(/aria-activedescendant="([^"]+)-opt-0"/);
    expect(out).toContain('aria-selected="true"');
    expect(out.match(/aria-selected="false"/g)).toHaveLength(1);
  });
  it("shows the label with its hint (an app's domain) as small text", () => {
    expect(html()).toContain("<small");
    expect(html()).toContain("web.example.com");
  });
  it("says No matches for an empty list", () => {
    const out = html({ items: [] });
    expect(out).toContain("No matches");
    expect(out).not.toContain('role="listbox"');
  });
});
