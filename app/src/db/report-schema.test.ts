import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { deployDays, reports, reportSends, reportSites } from "./report-schema";

// Watchbell 1.7 (monthly client report): the report, its sites, its monthly sends, and the daily deploy summary.
describe("report tables (1.7)", () => {
  it("has the columns the plan names", () => {
    expect(getTableName(reports)).toBe("reports");
    expect(Object.keys(getTableColumns(reports)).sort()).toEqual(
      ["autoSend", "clientName", "createdAt", "emailOpening", "id", "lang", "note", "recipients", "sender", "title", "updatedAt"],
    );
    expect(Object.keys(getTableColumns(reportSites)).sort()).toEqual(["displayName", "monitorId", "position", "reportId"]);
    expect(Object.keys(getTableColumns(reportSends)).sort()).toEqual(["attempts", "claimedAt", "lastError", "month", "reportId", "sentAt", "status"]);
    expect(Object.keys(getTableColumns(deployDays)).sort()).toEqual(["day", "failed", "ok", "resourceId"]);
  });

  it("locks the four tables down in the cloud migration and checks their values", () => {
    const sql = readFileSync(join(__dirname, "../../drizzle/0063_reports_lockdown.sql"), "utf8").toLowerCase();
    for (const t of ["reports", "report_sites", "report_sends", "deploy_days"]) {
      expect(sql).toContain(`alter table ops.${t} enable row level security`);
      expect(sql).toContain(`revoke all on ops.${t} from anon, authenticated`);
      expect(sql).toContain(`create policy ops_app_all on ops.${t}`);
    }
    for (const check of ["char_length(client_name) between 1 and 120", "jsonb_array_length(recipients) <= 5", "lang in ('id', 'en')", "month ~ '^\\d{4}-\\d{2}$'", "char_length(note) <= 1000", "char_length(last_error) <= 300"]) {
      expect(sql).toContain(check);
    }
  });

  it("ships the self-host migration", () => {
    const journal = JSON.parse(readFileSync(join(__dirname, "../../drizzle-selfhost/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain("0011_reports");
  });
});
