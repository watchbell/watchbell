import { describe, expect, it } from "vitest";
import type { Rec } from "@/lib/advisor/rules";
import {
  accountAlias, type AliasBook, aliasLetters, appAlias, buildAliasBook, dbAlias, displayName, hideAlert, hideEmails, hideEvent, hideNames, hideRec, isDbKind, maskText,
  realNames, searchText,
} from "./display-name";

const at = (s: string) => new Date(`2026-10-${s}T00:00:00Z`);
const row = (id: string, kind: string, name: string, day: string) => ({ id, kind, name, firstSeenAt: at(day) });

describe("aliasLetters", () => {
  it("counts a…z, then aa…az, ba… (bijective base 26)", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(aliasLetters)).toEqual(["a", "b", "z", "aa", "ab", "az", "ba", "zz", "aaa"]);
  });
});

describe("buildAliasBook", () => {
  it("letters every database kind in one sequence by first seen, then id", () => {
    const book = buildAliasBook([
      row("n1", "neon_project", "ticketer", "03"),
      row("s2", "supabase_project", "someone@gmail.com's Project", "01"),
      row("s1", "supabase_project", "other", "01"),
      row("f1", "firestore", "family", "02"),
      row("app", "app", "web", "01"),
      row("z", "zone", "example.com", "01"),
    ]);
    expect(book.db).toEqual([
      { id: "s1", name: "other", alias: "db-a" },
      { id: "s2", name: "someone@gmail.com's Project", alias: "db-b" },
      { id: "f1", name: "family", alias: "db-c" },
      { id: "n1", name: "ticketer", alias: "db-d" },
    ]);
    expect(book.app).toEqual([{ id: "app", name: "web", alias: "app-a" }]);
  });

  it("is stable whatever order the rows come in", () => {
    const rows = [row("b", "neon_project", "x", "01"), row("a", "neon_project", "y", "01"), row("c", "firestore", "z", "02")];
    expect(buildAliasBook(rows)).toEqual(buildAliasBook([...rows].reverse()));
  });

  it("accepts the timestamp as an ISO string (a cached copy)", () => {
    const book = buildAliasBook([{ id: "a", kind: "firestore", name: "x", firstSeenAt: "2026-10-02T00:00:00.000Z" }, row("b", "firestore", "y", "01")]);
    expect(book.db.map((d) => d.alias)).toEqual(["db-a", "db-b"]);
    expect(book.db[0].id).toBe("b");
  });
});

const book: AliasBook = {
  db: [
    { id: "s1", name: "someone@gmail.com's Project", alias: "db-a" },
    { id: "n1", name: "ticketer", alias: "db-b" },
    { id: "n2", name: "ticketer-staging", alias: "db-c" },
    { id: "f1", name: "Family (prod)", alias: "db-d" },
    { id: "f2", name: "portfolio", alias: "db-e" },
  ],
  app: [{ id: "a1", name: "Portfolio", alias: "app-a" }],
};

describe("isDbKind / dbAlias / displayName", () => {
  it("knows the database kinds", () => {
    expect(["supabase_project", "neon_project", "firestore", "db", "fs"].every(isDbKind)).toBe(true);
    expect(["app", "zone", "domain", "neon_branch", "br", null].some(isDbKind)).toBe(false);
  });

  it("gives a database its alias, and an unknown database a placeholder, never its name", () => {
    expect(dbAlias(book, "n1")).toBe("db-b");
    expect(dbAlias(book, "nope")).toBe("db-?");
    expect(displayName({ id: "s1", kind: "supabase_project", name: "someone@gmail.com's Project" }, book)).toBe("db-a");
    expect(displayName({ id: "n9", kind: "neon_project", name: "secret" }, book)).toBe("db-?");
  });

  it("keeps any other name, without emails", () => {
    expect(displayName({ id: "a", kind: "app", name: "web" }, book)).toBe("web");
    expect(displayName({ id: "x", kind: "account", name: "me@example.com" }, book)).toBe("[email hidden]");
  });
});

describe("hideEmails", () => {
  it("replaces every email address", () => {
    expect(hideEmails("Supabase · someone@gmail.com and a.b+c@sub.example.co.id.")).toBe("Supabase · [email hidden] and [email hidden].");
  });
  it("leaves text without one alone", () => {
    for (const s of ["web /api/health", "@scope/pkg", "user@localhost", "50 @ 3 ms", ""]) expect(hideEmails(s)).toBe(s);
  });
});

describe("hideNames", () => {
  it("replaces each database name with its alias, then hides any other email", () => {
    expect(hideNames("Supabase project someone@gmail.com's Project is paused", book)).toBe("Supabase project db-a is paused");
    expect(hideNames("web now uses ticketer (Neon). Ask x@y.com.", book)).toBe("web now uses db-b (Neon). Ask [email hidden].");
  });

  it("prefers the longest name and matches whole names only", () => {
    expect(hideNames("ticketer-staging and ticketer", book)).toBe("db-c and db-b");
    expect(hideNames("ticketerx, xticketer, ticketer_2, my-ticketer", book)).toBe("ticketerx, xticketer, ticketer_2, my-ticketer");
    expect(hideNames("DatabasePaused · ticketer", book)).toBe("DatabasePaused · db-b");
  });

  it("ignores case and treats regex characters literally", () => {
    expect(hideNames("TICKETER is down; family (prod) too", book)).toBe("db-b is down; db-d too");
    expect(hideNames("Family (prodx)", book)).toBe("Family (prodx)");
  });

  it("hides an email that is part of a name it doesn't know", () => {
    expect(hideNames("other@gmail.com's Project", { db: [], app: [] })).toBe("[email hidden]'s Project");
  });

  it("leaves a database name that is also an app's name: the app is shown by that name anyway", () => {
    expect(hideNames("portfolio · Deployment ready", book)).toBe("portfolio · Deployment ready");
  });

  it("replaces the name of the database the text is about, even when an app has the same name", () => {
    expect(hideNames("Supabase project portfolio is paused.", book, "f2")).toBe("Supabase project db-e is paused.");
    expect(hideNames("portfolio uses 400 MB", book, "a1")).toBe("portfolio uses 400 MB");
    expect(hideNames("ticketer uses 400 MB", book, null)).toBe("db-b uses 400 MB");
  });

  it("passes null and empty text through", () => {
    expect(hideNames(null, book)).toBeNull();
    expect(hideNames("", book)).toBe("");
  });
});

describe("searchText", () => {
  it("joins what is shown with the real names, so a filter matches either", () => {
    expect(searchText(["db-a", "web"], ["someone@gmail.com's Project"])).toBe("db-a web someone@gmail.com's Project");
  });
});

describe("hideRec", () => {
  const rec = (o: Partial<Rec>): Rec => ({ key: "k", severity: "info", appId: null, subject: "", title: "", why: "", fix: "", href: "/", ...o });
  it("names an unlinked database by its alias, even one named like an app", () => {
    expect(hideRec(rec({ key: "db-unlinked:f2", subject: "portfolio", title: "Database isn't linked to any app" }), book).subject).toBe("db-e");
  });
  it("hides names and emails in every text field", () => {
    const r = hideRec(rec({ key: "no-slot:me@gmail.com", subject: "supabase · me@gmail.com", title: "Account me@gmail.com has no free slot", why: "ticketer is active", fix: "Pause ticketer." }), book);
    expect([r.key, r.subject, r.title, r.why, r.fix]).toEqual(["no-slot:me@gmail.com", "supabase · [email hidden]", "Account [email hidden] has no free slot", "db-b is active", "Pause db-b."]);
  });
});

describe("hideEvent / hideAlert", () => {
  it("names a database's event by its alias and cleans the text, old rows included", () => {
    const e = hideEvent({ resource: "portfolio", resourceId: "f2", message: "Supabase project portfolio is paused", detail: "Owner: me@x.io" }, book);
    expect([e.resource, e.message, e.detail]).toEqual(["db-e", "Supabase project db-e is paused", "Owner: [email hidden]"]);
  });
  it("keeps an app's event as it is, except database names inside it", () => {
    const e = hideEvent({ resource: "Portfolio", resourceId: "a1", message: "Database link: Portfolio → ticketer", detail: null }, book);
    expect([e.resource, e.message, e.detail]).toEqual(["Portfolio", "Database link: Portfolio → db-b", null]);
  });
  it("cleans an alert's title, message and cause", () => {
    const a = hideAlert({ title: "portfolio", message: "portfolio uses 450 MB of 500 MB (90%).", causedBy: null, resourceId: "f2" }, book);
    expect([a.title, a.message, a.causedBy]).toEqual(["db-e", "db-e uses 450 MB of 500 MB (90%).", null]);
    const b = hideAlert({ title: "web /", message: "web.example.com/ returned HTTP 500 on 3 consecutive checks.", causedBy: "DatabasePaused · ticketer", resourceId: "x" }, book);
    expect([b.title, b.message, b.causedBy]).toEqual(["web /", "web.example.com/ returned HTTP 500 on 3 consecutive checks.", "DatabasePaused · db-b"]);
  });
});

// ---- Part 2: screenshot mode -------------------------------------------------------------------------------------

describe("buildAliasBook, screenshot mode letters", () => {
  const rows = [
    { ...row("w", "app", "web", "01") }, { ...row("p", "app", "portfolio", "02") },
    { ...row("d2", "domain", "www.example.com", "03"), parentId: "p" },
    { ...row("d1", "domain", "example.com", "02"), parentId: "p" },
    { ...row("d3", "domain", "web.example.com", "02"), parentId: "w" },
    { ...row("d4", "domain", "orphan.io", "04"), parentId: null },
    { ...row("z1", "zone", "example.com", "01") },
  ];
  const accounts = [
    { id: "acc2", label: "kedua", createdAt: at("05") },
    { id: "acc1", label: "me@gmail.com", createdAt: at("01") },
  ];
  const book = buildAliasBook(rows, accounts);

  it("numbers accounts by when they were added", () => {
    expect(book.account).toEqual([{ id: "acc1", name: "me@gmail.com", alias: "account-1" }, { id: "acc2", name: "kedua", alias: "account-2" }]);
  });

  it("gives an app's domains its letter, a second one a number, and a zone or orphan domain a site letter", () => {
    const hosts = Object.fromEntries((book.host ?? []).map((h) => [h.name, h.alias]));
    expect(hosts).toMatchObject({
      "example.com": "app-b.example", "www.example.com": "app-b-2.example", "web.example.com": "app-a.example",
      "orphan.io": "site-a.example", "web.vercel.app": "app-a-vercel.example", "portfolio.vercel.app": "app-b-vercel.example",
    });
  });

  it("a zone named like an app's domain keeps the app's alias (one host, one alias)", () => {
    expect((book.host ?? []).filter((h) => h.name === "example.com")).toHaveLength(1);
  });

  it("an app with no domain of its own gets app-x.example for its vercel.app host", () => {
    const b = buildAliasBook([row("w", "app", "web", "01")]);
    expect(b.host).toEqual([{ id: "w:vercel", name: "web.vercel.app", alias: "app-a.example" }]);
  });
});

describe("appAlias / accountAlias", () => {
  const b: AliasBook = { db: [], app: [{ id: "w", name: "web", alias: "app-a" }], account: [{ id: "a", name: "utama", alias: "account-1" }] };
  it("looks a name up, with a placeholder for one it doesn't know", () => {
    expect([appAlias(b, "web"), appAlias(b, "nope"), accountAlias(b, "utama"), accountAlias(b, "x")]).toEqual(["app-a", "app-?", "account-1", "account-?"]);
  });
});

describe("maskText", () => {
  const b: AliasBook = {
    db: [{ id: "d", name: "ticketer", alias: "db-a" }],
    app: [{ id: "w", name: "web", alias: "app-a" }, { id: "p", name: "orbit-blog", alias: "app-b" }, { id: "x", name: "example", alias: "app-c" }],
    account: [{ id: "u", name: "utama", alias: "account-1" }],
    host: [
      { id: "h1", name: "web.example.com", alias: "app-a.example" }, { id: "h2", name: "example.com", alias: "site-a.example" },
      { id: "h3", name: "web.vercel.app", alias: "app-a-vercel.example" },
    ],
  };

  it("masks apps, accounts, databases and emails as whole names", () => {
    expect(maskText("orbit-blog is down; web is fine. ticketer (utama) · me@x.io", b)).toBe("app-b is down; app-a is fine. db-a (account-1) · [email hidden]");
    expect(maskText("webhook, cobweb, web_2", b)).toBe("webhook, cobweb, web_2");
  });

  it("masks a host and keeps the path; a subdomain keeps its first label", () => {
    expect(maskText("https://web.example.com/api/health?x=1", b)).toBe("https://app-a.example/api/health?x=1");
    expect(maskText("web.example.com/ returned HTTP 500", b)).toBe("app-a.example/ returned HTTP 500");
    expect(maskText("api.example.com and example.com.", b)).toBe("api.site-a.example and site-a.example.");
  });

  it("hides other vercel.app hosts and any other URL's host, never a version number or a file name", () => {
    expect(maskText("web-git-main-acme.vercel.app", b)).toBe("preview.example");
    expect(maskText("see https://unknown-host.io/x", b)).toBe("see https://site.example/x");
    expect(maskText("Postgres 17.4 in next.config.ts, 0.25–2 CU", b)).toBe("Postgres 17.4 in next.config.ts, 0.25–2 CU");
  });

  it("doesn't touch what it wrote itself (an app named example)", () => {
    expect(maskText("web.example.com", b)).toBe("app-a.example");
  });
});

// Stage 6 minor M5: Vercel's A6 sentence names the team slug ("can't change projects in team acme-team"), so
// screenshot mode masks team slugs too, numbered by when their first app was seen.
describe("team aliases (M5)", () => {
  const book = buildAliasBook([
    { ...row("w", "app", "web", "03"), team: "acme-team" },
    { ...row("p", "app", "portfolio", "01"), team: "acme-projects" },
    { ...row("q", "app", "other", "02"), team: "acme-projects" },
    { ...row("d", "supabase_project", "db1", "01"), team: "ignored-not-an-app" },
  ]);

  it("letters each team once, by its first app", () => {
    expect(book.team).toEqual([{ id: "team:acme-projects", name: "acme-projects", alias: "team-1" }, { id: "team:acme-team", name: "acme-team", alias: "team-2" }]);
  });

  it("maskText hides a team slug as a whole name", () => {
    expect(maskText("This token can't change projects in team acme-projects; replace it.", book)).toBe("This token can't change projects in team team-1; replace it.");
    expect(maskText("acme-projects-old stays", book)).toBe("acme-projects-old stays");
  });

  it("an app without a team adds none", () => {
    expect(buildAliasBook([row("w", "app", "web", "01")]).team).toEqual([]);
  });
});

// Watchbell 1.2.2 (D18): the owner's own Telegram chat reads the real names behind the aliases.
describe("realNames", () => {
  const b: AliasBook = {
    db: [{ id: "d", name: "orders-db", alias: "db-a" }, { id: "e", name: "ops@acme.example.com's Project", alias: "db-b" }],
    app: [{ id: "w", name: "web", alias: "app-a" }, { id: "s", name: "shop", alias: "app-b" }, { id: "n", name: "news", alias: "app-aa" }],
    account: [{ id: "u", name: "main", alias: "account-1" }],
    host: [
      { id: "h1", name: "web.example.com", alias: "app-a.example" }, { id: "h2", name: "www.web.example.com", alias: "app-a-2.example" },
      { id: "h3", name: "example.org", alias: "site-a.example" },
    ],
  };

  it("turns app, database and host aliases back into the names, whole words only", () => {
    expect(realNames("Check app-a again now. db-a is paused; app-aa and app-b are fine.", b)).toBe("Check web again now. orders-db is paused; news and shop are fine.");
    expect(realNames("app-a.example/ returned HTTP 502, api.app-a.example and app-a-2.example too; site-a.example.", b))
      .toBe("web.example.com/ returned HTTP 502, api.web.example.com and www.web.example.com too; example.org.");
    expect(realNames("app-ab, my-app-a, app-a_2, app-?, db-?", b)).toBe("app-ab, my-app-a, app-a_2, app-?, db-?");
  });

  it("keeps accounts, generic placeholders and hidden emails as they are", () => {
    expect(realNames("account-1 · site.example · preview.example · db-b", b)).toBe("account-1 · site.example · preview.example · [email hidden]'s Project");
  });

  it("is the reverse of maskText for the names it covers", () => {
    const text = "web.example.com/ is down; orders-db paused on web";
    expect(realNames(maskText(text, b), b)).toBe(text);
  });

  it("leaves text alone with an empty book", () => {
    expect(realNames("app-a db-a", { db: [], app: [] })).toBe("app-a db-a");
  });
});
