import { createElement as h } from "react";
import { AliasProvider } from "@/components/alias";
import { EMPTY_BOOK } from "@/lib/view/display-name";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppsWhere, type WhereRow } from "./apps-where";

const rows: WhereRow[] = [
  { id: "a1", name: "acme-shop", domain: "shop.example", runsOn: "Vercel", detail: "acme", state: "ok", label: "Running" },
  { id: "a2", name: "orbit-blog", domain: "", runsOn: "Vercel", detail: null, state: "warn", label: "Degraded" },
];

describe("Where your apps run", () => {
  it("lists each app with where it runs and its state, linking to the app", () => {
    const out = renderToStaticMarkup(h(AppsWhere, { rows }));
    expect(out).toContain('href="/apps/a1"');
    expect(out).toContain("acme-shop");
    expect(out).toContain("shop.example");
    expect(out).toContain("Vercel");
    expect(out).toContain("Degraded");
  });
  it("says what to do when there are none yet, without promising an automatic pick-up (review I2)", () => {
    expect(renderToStaticMarkup(h(AppsWhere, { rows: [] }))).toContain("No applications watched yet. Deploy one above, then tick it under Sync on Connections.");
  });
  it("screenshot mode hides app names, domains and the team (review I5)", () => {
    const out = renderToStaticMarkup(h(AliasProvider, { book: EMPTY_BOOK, shot: true, children: h(AppsWhere, { rows }) }));
    expect(out).not.toContain("acme-shop");
    expect(out).not.toMatch(/>acme</);
  });
});
