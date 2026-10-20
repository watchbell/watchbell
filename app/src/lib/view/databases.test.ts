import { describe, expect, it } from "vitest";
import type { DbRow } from "@/lib/data/databases-db";
import type { AliasBook } from "./display-name";
import { bytesText, dbBanners, firebaseCell, firebaseRows, neonBlocks, neonCell, slotCards, supabaseCell, supabaseRows } from "./databases";

const now = new Date("2026-10-12T05:00:00Z"); // 12:00 WIB
const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
const row = (over: Partial<DbRow>): DbRow => ({
  id: "r", name: "portfolio", externalId: "aaaaaaaaaaaaaaaaaaaa", kind: "supabase_project", account: "utama", state: "ok",
  stateSince: new Date("2026-09-14T00:00:00Z"), collectedAt: now, data: {}, usedBy: [], ...over,
});

// Privacy: the stable letters (lib/view/display-name.ts).
const book: AliasBook = {
  db: [
    { id: "s", name: "quillpad", alias: "db-a" }, { id: "p", name: "portfolio", alias: "db-b" }, { id: "l", name: "acme-shop", alias: "db-c" },
    { id: "t", name: "ticketer", alias: "db-d" }, { id: "m", name: "someone@gmail.com's Project", alias: "db-e" },
  ],
  app: [{ id: "a", name: "web-Quillpad", alias: "app-a" }],
};

describe("database aliases (privacy)", () => {
  it("every view carries the database's alias, never needing its name", () => {
    expect(supabaseRows([row({ id: "m", name: "someone@gmail.com's Project" })], now, book)[0].alias).toBe("db-e");
    expect(neonBlocks([row({ id: "t", kind: "neon_project", name: "ticketer" })], now, book)[0].alias).toBe("db-d");
    expect(firebaseRows([row({ id: "x", kind: "firestore", name: "secret" })], book)[0].alias).toBe("db-?");
  });

  it("a paused project's banner names databases by alias and hides an email account label", () => {
    const inputs = [
      { id: "p", account: "me@gmail.com", name: "portfolio", status: "ACTIVE_HEALTHY", freeOrg: true },
      { id: "l", account: "me@gmail.com", name: "acme-shop", status: "ACTIVE_HEALTHY", freeOrg: true },
      { id: "m", account: "me@gmail.com", name: "someone@gmail.com's Project", status: "INACTIVE", freeOrg: true },
    ];
    const rows = supabaseRows([row({ id: "m", name: "someone@gmail.com's Project", account: "me@gmail.com", state: "paused", data: { status: "INACTIVE" } })], now, book);
    expect(dbBanners(rows, slotCards(inputs), book)).toEqual([{
      key: "db-m", tone: "warning", title: "Supabase project db-e is paused",
      body: "Account [email hidden] already uses both free slots (db-b, db-c). Pause one of them first, or move db-e to an account with a free slot.",
      action: { label: "Open Supabase", href: "/supabase" },
    }]);
  });

  it("Overview's Neon cell names the project by alias", () => {
    const neon = row({ id: "t", kind: "neon_project", name: "ticketer", state: "idle", data: { computeSeconds: 148_320, endpoints: [{ id: "ep", branchId: "br", state: "idle", pendingState: null, disabled: false, minCu: 0.25, maxCu: 2, lastActive: ago(1) }] } });
    expect(neonCell([neon], now, book).sub).toBe("db-d idle · 41 of 100 CU-h");
  });
});

describe("bytesText", () => {
  it("reads MB below a GB and one decimal above", () => {
    expect([bytesText(null), bytesText(148_897_792), bytesText(1.5 * 1024 ** 3)]).toEqual(["—", "142 MB", "1.5 GB"]);
  });
});

describe("supabaseRows", () => {
  it("shows size against 500 MB, last traffic and risk", () => {
    const [v] = supabaseRows([row({ data: { status: "ACTIVE_HEALTHY", region: "ap-southeast-1", pgVersion: "17.4.1.054", sizeBytes: 148_897_792, sizeAt: ago(9), lastTrafficAt: ago(96), trafficAt: ago(1) } })], now);
    expect(v.sub).toBe("ap-southeast-1 · Postgres 17.4");
    expect(v.status).toEqual({ state: "ok", label: "Active healthy" });
    expect(v.size).toEqual({ text: "142 MB", pct: 28.4, asOf: "today 03:00" });
    expect(v.traffic).toBe("4 d ago");
    expect(v.risk).toMatchObject({ state: "warn", text: "Pauses in ~3 days" });
  });
  it("explains an empty size and a missing permission instead of showing 0", () => {
    const [a] = supabaseRows([row({ data: { status: "ACTIVE_HEALTHY" } })], now);
    expect([a.size, a.sizeNote]).toEqual([null, "Read once a day while the project is in use"]);
    const [b] = supabaseRows([row({ data: { status: "ACTIVE_HEALTHY", sizeError: "Missing permission: database_read." } })], now);
    expect(b.sizeNote).toBe("Missing permission: database_read.");
  });
  it("greys a project the API couldn't read, with what it last was (D6)", () => {
    const [v] = supabaseRows([row({ state: "unknown", data: { status: "INACTIVE", lastGoodState: "paused" } })], now);
    expect([v.status, v.stale]).toEqual([{ state: "unknown", label: "Unknown · last seen paused" }, true]);
  });
});

describe("slotCards / dbBanners", () => {
  const inputs = [
    { id: "p", account: "utama", name: "portfolio", status: "ACTIVE_HEALTHY", freeOrg: true },
    { id: "l", account: "utama", name: "acme-shop", status: "ACTIVE_HEALTHY", freeOrg: true },
    { id: "s", account: "utama", name: "quillpad", status: "INACTIVE", freeOrg: true },
    { id: "k", account: "kedua", name: "ai-dev", status: "ACTIVE_HEALTHY", freeOrg: null },
  ];
  it("counts slots per account and flags a full one", () => {
    expect(slotCards(inputs)).toEqual([
      { account: "kedua", used: 1, total: 2, left: 1, planUnknown: true, active: ["ai-dev"], activeIds: ["k"] },
      { account: "utama", used: 2, total: 2, left: 0, planUnknown: false, active: ["portfolio", "acme-shop"], activeIds: ["p", "l"] },
    ]);
  });
  it("explains a paused project with the account's slots (mockup copy)", () => {
    expect(dbBanners(supabaseRows([row({ id: "s", name: "quillpad", state: "paused", data: { status: "INACTIVE" }, usedBy: [{ id: "a", name: "web-Quillpad" }] })], now, book), slotCards(inputs), book)).toEqual([{
      key: "db-s", tone: "warning", title: "Supabase project db-a is paused",
      body: "web-Quillpad gets errors until it's restored. Account utama already uses both free slots (db-b, db-c). Pause one of them first, or move db-a to an account with a free slot.",
      action: { label: "Open Supabase", href: "/supabase" },
    }]);
  });
});

describe("neonBlocks / neonCell", () => {
  const neon = row({
    kind: "neon_project", name: "ticketer", state: "idle",
    data: {
      region: "aws-ap-southeast-1", pgVersion: 17, computeSeconds: 148_320, transferBytes: 1_932_735_283, periodEnd: "2026-11-01T00:00:00Z",
      endpoints: [{ id: "ep-quiet-sun-a1b2c3", branchId: "br-main", state: "idle", pendingState: null, disabled: false, minCu: 0.25, maxCu: 2, lastActive: ago(1) }],
      branches: [{ id: "br-dev", name: "dev", isDefault: false, logicalSize: 32_505_856 }, { id: "br-main", name: "main", isDefault: true, logicalSize: 56_623_104 }],
    },
  });
  it("puts the default branch first and reads CU-hours, storage and transfer", () => {
    const [b] = neonBlocks([neon], now);
    expect(b.cu).toEqual({ value: 41.2, pct: 41.2 });
    expect(b.storage.text).toBe("85 MB");
    expect(b.resets).toBe("1 Nov");
    expect(b.branches.map((x) => [x.name, x.status.label, x.autoscaling])).toEqual([["main", "Idle", "0.25–2 CU"], ["dev", "No compute", "—"]]);
  });
  it("summarises one project, and a provider that stopped answering", () => {
    expect(neonCell([{ ...neon, id: "t" }], now, book)).toEqual({ state: "idle", sub: "db-d idle · 41 of 100 CU-h" });
    expect(neonCell([{ ...neon, state: "unknown", collectedAt: new Date(now.getTime() - 14 * 60_000) }], now)).toEqual({ state: "unknown", sub: "API not responding · data from 14 min ago" });
    expect(neonCell([], now)).toEqual({ state: "unknown", sub: "No projects watched yet" });
  });
});

describe("supabaseCell / firebaseCell", () => {
  it("counts accounts and paused projects", () => {
    expect(supabaseCell([row({}), row({ account: "kedua" }), row({ state: "paused", data: { status: "INACTIVE" } })], now)).toEqual({ state: "paused", sub: "2 accounts · 1 paused" });
  });
  it("counts reachable Firestore projects", () => {
    const fs = (state: "ok" | "err") => row({ kind: "firestore", state });
    expect(firebaseCell([fs("ok"), fs("ok"), fs("ok")], now)).toEqual({ state: "ok", sub: "3 projects reachable" });
    expect(firebaseCell([fs("ok"), fs("err")], now)).toEqual({ state: "err", sub: "1 of 2 unreachable" });
  });
});

describe("firebaseRows, a failed health read", () => {
  it("says which role is missing, not just Unknown (I4)", () => {
    const fs = (state: "err" | "unknown", data: Record<string, unknown>) => row({ kind: "firestore", state, data });
    const views = firebaseRows([
      fs("err", { pingKind: "scope", pingReason: "PERMISSION_DENIED" }),
      fs("err", { pingKind: "scope", pingReason: "SERVICE_DISABLED" }),
      fs("err", { pingKind: "transient", pingReason: "RESOURCE_EXHAUSTED" }),
      fs("unknown", { pingKind: "transient" }),
    ]);
    expect(views.map((v) => v.health)).toEqual([
      { state: "err", label: "No access: needs datastore.viewer" },
      { state: "err", label: "Firestore API is off in this project" },
      { state: "err", label: "Daily quota used up" },
      { state: "unknown", label: "Unknown" },
    ]);
  });
});

describe("firebaseRows", () => {
  it("shows today's counts, or why they can't be read", () => {
    const [a, b] = firebaseRows([
      row({ kind: "firestore", name: "nova-wallet", data: { latencyMs: 84, reads: 2100, writes: 310, deletes: 12, authUsers: 42 } }),
      row({ kind: "firestore", name: "devdock", data: { latencyMs: 102, reads: null, opsError: "Not readable: the service account needs monitoring.viewer", authUsers: 2 } }),
    ]);
    expect(a.health).toEqual({ state: "ok", label: "Reachable · 84 ms" });
    expect(a.ops).toEqual({ reads: { n: 2100, pct: 4.2 }, writes: { n: 310, pct: 1.55 }, deletes: { n: 12, pct: 0.06 } });
    expect(b.ops).toEqual({ note: "Not readable: the service account needs monitoring.viewer" });
    expect(a.users).toBe(42);
  });
});
