import { Card } from "@/components/kit";
import { readRetentionDays } from "@/lib/data/settings-db";
import { RETENTION_KEYS, RETENTION_LABEL } from "@/lib/settings/retention";
import { RETENTION_SCHEDULE, retentionRows } from "@/lib/view/settings";
import { RetentionForm } from "./retention-form";

// Stage 7 (B6): editable by the Owner, audited. The daily job's retention step reads the same saved days
// (lib/data/settings-db.ts), so the page can't drift from what is really deleted.
export async function RetentionTab() {
  const days = await readRetentionDays();
  const notes = retentionRows(days);
  const rows = RETENTION_KEYS.map((key) => ({ key, kind: RETENTION_LABEL[key], note: notes.find((n) => n.kind === RETENTION_LABEL[key])?.note ?? "" }));
  return (
    <Card title="Retention" flush meta={RETENTION_SCHEDULE}>
      <p className="px-[18px] pb-3 text-ink-soft">
        Only the console&apos;s own history is deleted. Nothing is ever deleted at a provider. The monthly backup runs on the 1st, before the
        clean-up, and reads hourly rollups, events and alerts, which keep at least 60 days.
      </p>
      <RetentionForm saved={days} rows={rows} />
    </Card>
  );
}
