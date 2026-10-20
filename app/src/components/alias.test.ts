import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AliasProvider, DbName, Masked, MaskedText, maskedValue } from "@/components/alias";
import { ListFilter } from "@/components/list-filter";
import { AccountChip, Resource } from "@/components/resource";
import type { AliasBook } from "@/lib/view/display-name";

const book: AliasBook = { db: [{ id: "d1", name: "someone@gmail.com's Project", alias: "db-a" }], app: [] };
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(h(AliasProvider, { book, children: el }));

describe("database names on screen (privacy)", () => {
  it("shows the alias as a button that reveals the real name, never the name itself", () => {
    const out = html(h(DbName, { id: "d1", name: "someone@gmail.com's Project" }));
    expect(out).toContain(">db-a</button>");
    expect(out).toContain('type="button"');
    expect(out).toContain('aria-pressed="false"');
    expect(out).not.toContain("gmail");
  });
  it("shows db-? for a database the letters don't know yet, and an explicit alias first", () => {
    expect(html(h(DbName, { id: "new", name: "secret" }))).toContain(">db-?</button>");
    expect(html(h(DbName, { id: "new", name: "secret", alias: "db-k" }))).toContain(">db-k</button>");
  });
  it("Resource with a dbId shows the alias outside any link; other names lose their emails", () => {
    const db = html(h(Resource, { kind: "db", name: "someone@gmail.com's Project", dbId: "d1", href: "/supabase" }));
    expect(db).toContain("db-a");
    expect(db).not.toContain("<a ");
    expect(html(h(Resource, { kind: "app", name: "x@y.com-site", href: "/apps/1" }))).toContain(">[email hidden]-site</a>");
    expect(html(h(Resource, { kind: "usr", name: "member@example.com" }))).toContain("member@example.com");
    expect(html(h(AccountChip, { name: "me@gmail.com" }))).toContain("[email hidden]");
  });
  it("the account filter shows labels without emails", () => {
    const out = html(h(ListFilter, { placeholder: "Filter", groups: ["me@gmail.com", "utama"], head: ["A"], rows: [{ key: "1", state: "ok", text: "", group: "utama", row: h("tr") }] }));
    expect(out).toContain('value="me@gmail.com">[email hidden]</option>');
  });
});

// ---- Part 2: screenshot mode -------------------------------------------------------------------------------------

const full: AliasBook = {
  db: [{ id: "d1", name: "ticketer", alias: "db-a" }],
  app: [{ id: "a1", name: "orbit-blog", alias: "app-a" }],
  account: [{ id: "u1", name: "utama", alias: "account-1" }],
  host: [{ id: "h1", name: "web.example.com", alias: "app-a.example" }],
};
const shotHtml = (shot: boolean, el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(h(AliasProvider, { book: full, shot, children: el }));

describe("screenshot mode", () => {
  it("masks an app, an account, an address and text only while on, rendered the same on the server", () => {
    expect(shotHtml(false, h(Masked, { kind: "app", real: "orbit-blog" }))).toBe("orbit-blog");
    expect(shotHtml(true, h(Masked, { kind: "app", real: "orbit-blog" }))).toContain(">app-a</button>");
    expect(shotHtml(true, h(Masked, { kind: "account", real: "utama" }))).toContain(">account-1</button>");
    expect(shotHtml(true, h(Masked, { kind: "email", real: "me@x.io" }))).toContain(">[email hidden]</button>");
    expect(shotHtml(true, h(MaskedText, { text: "orbit-blog · https://web.example.com/api/health" }))).toContain(">app-a · https://app-a.example/api/health</button>");
    expect(shotHtml(true, h(MaskedText, { text: "Nothing to hide" }))).toBe("Nothing to hide");
  });

  it("keeps a link's real target and makes the masked name a focusable span inside it", () => {
    const out = shotHtml(true, h(Resource, { kind: "app", name: "orbit-blog", href: "/apps/a1" }));
    expect(out).toContain('href="/apps/a1"');
    expect(out).toMatch(/<span role="button" tabindex="0" aria-pressed="false"[^>]*>app-a<\/span>/);
    expect(out).not.toContain("orbit-blog");
  });

  it("an account chip and a member's address", () => {
    expect(shotHtml(true, h(AccountChip, { name: "utama" }))).toContain("account-1");
    expect(shotHtml(true, h(Resource, { kind: "usr", name: "member@example.com" }))).not.toContain("member@example.com");
  });

  it("a repository loses its owner", () => {
    expect(maskedValue("repo", "acme/orbit-blog", full, true)).toBe("owner/app-a");
    expect(maskedValue("repo", "acme/orbit-blog", full, false)).toBe("acme/orbit-blog");
  });

  it("databases stay aliased whether the mode is on or off", () => {
    expect(shotHtml(false, h(DbName, { id: "d1", name: "ticketer" }))).toContain(">db-a</button>");
    expect(shotHtml(true, h(DbName, { id: "d1", name: "ticketer" }))).toContain(">db-a</button>");
  });

  it("a filter searches the masked text too", () => {
    const rows = [{ key: "1", state: "ok", text: "orbit-blog", row: h("tr", { "data-row": "1" }) }];
    expect(shotHtml(true, h(ListFilter, { placeholder: "F", head: ["A"], rows }))).toContain('data-row="1"');
  });
});
