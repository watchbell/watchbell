import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import { reports, reportSends } from "@/db/report-schema";
import * as schema from "@/db/schema";
import { DEFAULT_BRAND } from "@/lib/branding";
import type { ReportRow } from "@/lib/data/report-db";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));

import { claimSend, dueReportSends, markSend, reportMail, runReportSends, type SendIo, settleStaleClaims } from "./send";

const Z = "Asia/Jakarta";
let client: PGlite;
let reportId = "";

beforeAll(async () => {
  client = await PGlite.create();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
  const [r] = await db.insert(reports).values({ clientName: "PT Kopi Sejahtera", recipients: ["owner@kopi.example"] }).returning();
  reportId = r.id;
}, 60_000);
afterAll(async () => client?.close());

describe("dueReportSends (1.7)", () => {
  it("is due on the 1st to the 3rd of a month (install zone), for the month before", () => {
    expect(dueReportSends(new Date("2026-10-31T20:00:00Z"), Z)).toEqual({ month: "2026-10", day: 1, due: true }); // 03:00 WIB 1 Nov
    expect(dueReportSends(new Date("2026-11-02T20:00:00Z"), Z)).toEqual({ month: "2026-10", day: 3, due: true });
    expect(dueReportSends(new Date("2026-11-03T20:00:00Z"), Z)).toMatchObject({ day: 4, due: false });
    expect(dueReportSends(new Date("2026-12-31T20:00:00Z"), Z)).toEqual({ month: "2026-12", day: 1, due: true });
  });
});

describe("claimSend (1.7)", () => {
  it("claims once: two runs racing for the same report and month get one claim", async () => {
    const now = new Date("2026-10-31T20:00:00Z");
    const got = await Promise.all([claimSend(reportId, "2026-10", now), claimSend(reportId, "2026-10", now)]);
    expect(got.filter(Boolean)).toHaveLength(1);
  });

  it("a failed try can be claimed again the next day; a sent or finally failed month never", async () => {
    await markSend(reportId, "2026-10", { status: "retry", error: "The mail server took too long to answer." }, new Date());
    expect(await claimSend(reportId, "2026-10", new Date("2026-11-01T20:00:00Z"))).toBe(true);
    await markSend(reportId, "2026-10", { status: "sent" }, new Date("2026-11-01T20:01:00Z"));
    expect(await claimSend(reportId, "2026-10", new Date("2026-11-02T20:00:00Z"))).toBe(false);
    const [row] = await (h.db as ReturnType<typeof drizzle>).select().from(reportSends).where(eq(reportSends.reportId, reportId));
    expect(row).toMatchObject({ status: "sent", attempts: 2, lastError: null });
    expect(await claimSend(reportId, "2026-09", new Date("2026-10-02T20:00:00Z"))).toBe(true);
    await markSend(reportId, "2026-09", { status: "failed", error: "x" }, new Date());
    expect(await claimSend(reportId, "2026-09", new Date())).toBe(false);
  });
});

const row = (o: Partial<ReportRow> = {}): ReportRow => ({
  id: "r1", clientName: "PT Kopi Sejahtera", title: null, lang: "id", note: null, emailOpening: null, recipients: ["owner@kopi.example", "it@kopi.example"],
  autoSend: true, sender: "resend", sites: [{ monitorId: "m", displayName: "Toko", position: 0 }], lastSend: null, ...o,
});
const io = (o: Partial<SendIo> = {}): SendIo & { marks: unknown[] } => {
  const marks: unknown[] = [];
  return {
    zone: Z,
    list: async () => [row(), row({ id: "off", autoSend: false }), row({ id: "nobody", recipients: [] }), row({ id: "nosender", sender: null })],
    claim: async () => true,
    settle: async () => 0,
    make: async () => ({ bytes: new Uint8Array([1, 2, 3]), filename: "PT-Kopi-Sejahtera-2026-10.pdf" }),
    mail: vi.fn(async () => ({ ok: true as const })),
    brand: async () => ({ ...DEFAULT_BRAND, senderName: "Studio Nusa", name: "Studio Nusa" }),
    mark: async (id, month, outcome) => {
      marks.push([id, month, outcome]);
    },
    marks,
    ...o,
  };
};

// Review I-3: a run killed after the mail went out leaves a held claim. The next run never sends it again: the month is
// marked failed with "may have been sent", and the ReportSendFailed alert asks the owner to check.
describe("a send whose outcome is unknown (review I-3)", () => {
  it("is settled as failed and never claimed again", async () => {
    const DAY1 = new Date("2026-08-31T20:00:00Z");
    expect(await claimSend(reportId, "2026-08", DAY1)).toBe(true); // ...and the run dies before markSend
    expect(await settleStaleClaims(new Date("2026-08-31T20:05:00Z"))).toBe(0); // still held
    expect(await settleStaleClaims(new Date("2026-09-01T20:00:00Z"))).toBe(1);
    expect(await claimSend(reportId, "2026-08", new Date("2026-09-01T20:00:00Z"))).toBe(false);
    const [row] = await (h.db as ReturnType<typeof drizzle>).select().from(reportSends).where(eq(reportSends.month, "2026-08"));
    expect(row).toMatchObject({ status: "failed" });
    expect(row.lastError).toMatch(/may have been sent/);
  });
});

describe("runReportSends (1.7)", () => {
  const DAY1 = new Date("2026-10-31T20:00:00Z");

  it("sends each due report once, with the PDF, in the report's language, to its recipients", async () => {
    const x = io();
    expect(await runReportSends(DAY1, x)).toEqual({ sent: 1, failed: 0, left: 0 });
    const m = (x.mail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(m).toMatchObject({ sender: "resend", to: ["owner@kopi.example", "it@kopi.example"], fromName: "Studio Nusa", idempotencyKey: "report-r1-2026-10", filename: "PT-Kopi-Sejahtera-2026-10.pdf" });
    expect(m.subject).toBe("Laporan pemantauan website · Oktober 2026 · PT Kopi Sejahtera");
    expect(m.text).toContain("Powered by Watchbell");
    expect(x.marks).toEqual([["r1", "2026-10", { status: "sent" }]]);
  });

  it("starts no new report once the run's time is up, and leaves it for the next run", async () => {
    const x = io();
    expect(await runReportSends(DAY1, x, Date.now() - 1)).toEqual({ sent: 0, failed: 0, left: 1 });
    expect(x.mail).not.toHaveBeenCalled();
  });

  it("does nothing outside the 1st–3rd or when another run holds the claim", async () => {
    const x = io();
    expect(await runReportSends(new Date("2026-11-10T00:00:00Z"), x)).toEqual({ sent: 0, failed: 0, left: 0 });
    const y = io({ claim: async () => false });
    expect(await runReportSends(DAY1, y)).toEqual({ sent: 0, failed: 0, left: 0 });
    expect(y.mail).not.toHaveBeenCalled();
  });

  it("retries on the 2nd and 3rd, then gives up as failed; recipients never reach the logs", async () => {
    const logs: string[] = [];
    const spies = (["log", "warn", "error", "info"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); }));
    const fail = { mail: vi.fn(async () => ({ ok: false as const, kind: "transient" as const, error: "The mail server took too long to answer." })) };
    const d1 = io(fail);
    expect(await runReportSends(DAY1, d1)).toEqual({ sent: 0, failed: 1, left: 0 });
    expect(d1.marks[0]).toEqual(["r1", "2026-10", { status: "retry", error: "The mail server took too long to answer." }]);
    const d3 = io(fail);
    await runReportSends(new Date("2026-11-02T20:00:00Z"), d3);
    expect(d3.marks[0]).toEqual(["r1", "2026-10", { status: "failed", error: "The mail server took too long to answer." }]);
    spies.forEach((s) => s.mockRestore());
    expect(logs.join("\n")).not.toMatch(/kopi\.example/);
  });

  // Review I-5: a sending report whose websites all went away still goes through retry → failed → alert.
  it("an auto-send report without websites is a failed try, not silently skipped", async () => {
    const x = io({ list: async () => [row({ sites: [] })], make: async () => ({ error: "no-sites" as const }) });
    expect(await runReportSends(DAY1, x)).toEqual({ sent: 0, failed: 1, left: 0 });
    expect(x.marks[0]).toEqual(["r1", "2026-10", { status: "retry", error: "The report has no websites." }]);
  });

  it("a report that can't be made is a failed try with the reason", async () => {
    const x = io({ make: async () => ({ error: "no-sites" as const }) });
    expect(await runReportSends(DAY1, x)).toEqual({ sent: 0, failed: 1, left: 0 });
    expect(x.marks[0]).toEqual(["r1", "2026-10", { status: "retry", error: "The report has no websites." }]);
  });
});

// Review I-8: the report email shows the brand's logo from its public address (no logo without one).
describe("reportMail (1.7)", () => {
  it("puts the logo at the top of the HTML when there is one and a public address to load it from", () => {
    const made = { bytes: new Uint8Array([1]), filename: "x.pdf" };
    const brand = { ...DEFAULT_BRAND, name: "Studio Nusa", hasLogo: true, publicUrl: "https://monitor.studio.example" };
    expect(reportMail(row(), "2026-10", brand, made, "resend", undefined, "https://ops.example.com").html).toContain('<img src="https://monitor.studio.example/brand-icon"');
    expect(reportMail(row(), "2026-10", { ...brand, publicUrl: null }, made, "resend", undefined, "https://ops.example.com").html).toContain('<img src="https://ops.example.com/brand-icon"');
    expect(reportMail(row(), "2026-10", { ...brand, hasLogo: false }, made, "resend", undefined, "https://ops.example.com").html).not.toContain("<img");
  });
});
