import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ingestSources } from "./ingest-schema";
import { alerts } from "./schema";

// Watchbell 1.8.6 (Alertmanager in): the sources that may post alerts, and the labels an external alert carries.
describe("ingest tables (1.8.6)", () => {
  it("has the columns the plan names", () => {
    expect(getTableName(ingestSources)).toBe("ingest_sources");
    expect(Object.keys(getTableColumns(ingestSources)).sort()).toEqual(
      ["createdAt", "enabled", "id", "kind", "lastSeenAt", "monthKey", "name", "receivedMonth", "refusedMonth", "tokenHash", "tokenPrefix"],
    );
    expect(Object.keys(getTableColumns(alerts))).toContain("labels");
  });

  it("locks the table down in the cloud migration, checks its values and seeds the rule", () => {
    const sql = readFileSync(join(__dirname, "../../drizzle/0068_ingest_sources_lockdown.sql"), "utf8").toLowerCase();
    for (const s of [
      "alter table ops.ingest_sources enable row level security",
      "revoke all on ops.ingest_sources from anon, authenticated",
      "create policy ops_app_all on ops.ingest_sources",
      "kind in ('alertmanager')",
      "char_length(name) between 1 and 40",
      "char_length(token_prefix) = 7",
      "'externalalert'",
    ]) expect(sql).toContain(s);
  });

  it("ships the self-host migrations with the same checks and rule row", () => {
    const journal = JSON.parse(readFileSync(join(__dirname, "../../drizzle-selfhost/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toEqual(expect.arrayContaining(["0014_ingest_sources", "0015_external_alert_rule"]));
    const sql = readFileSync(join(__dirname, "../../drizzle-selfhost/0015_external_alert_rule.sql"), "utf8").toLowerCase();
    for (const s of ["kind in ('alertmanager')", "char_length(name) between 1 and 40", "char_length(token_prefix) = 7", "'externalalert'"]) expect(sql).toContain(s);
  });
});
