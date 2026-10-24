import "server-only";
import { eq, type SQL, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { cleanSectionsOff, type SectionId } from "@/lib/sections";
import { BUDGET_SETTING, type BudgetLimits, parseBudget } from "@/lib/settings/budget";
import { parseRetention, RETENTION_SETTING, type RetentionDays } from "@/lib/settings/retention";

// B6: the Owner's Settings overrides (ops.settings). A missing or odd row reads as the defaults.

async function readValue(key: string): Promise<unknown> {
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
  return row?.value ?? null;
}

async function writeValue(key: string, value: Record<string, unknown> | unknown[]): Promise<void> {
  await db().insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export const readRetentionDays = async (): Promise<RetentionDays> => parseRetention(await readValue(RETENTION_SETTING));
export const saveRetentionDays = (v: RetentionDays) => writeValue(RETENTION_SETTING, v);
export const readBudgetLimits = async (): Promise<BudgetLimits> => parseBudget(await readValue(BUDGET_SETTING));
export const saveBudgetLimits = (v: BudgetLimits) => writeValue(BUDGET_SETTING, v);

const NOTIFY_LANG_SETTING = "notify.language";
// Notification language per channel: { telegram, discord, email } (older rows: { lang }). Read raw (lang.ts parses it) so a bad row can't break a sender.
export const readNotifyLangSetting = (): Promise<unknown> => readValue(NOTIFY_LANG_SETTING);
// Always the full three-channel shape (the caller merges), so an old { lang } row is carried over for unchanged channels.
export const saveNotifyLangs = (v: { telegram: string; discord: string; email: string }) => writeValue(NOTIFY_LANG_SETTING, v);

// Watchbell 1.2 (D11): the sections the owner turned off (Manage › Sections), a string array of switchable SectionIds.
// Instance-wide for now; Part B (1.3) moves it to workspace_settings, and only these functions change then.
export const SECTIONS_OFF_SETTING = "sections.off";
export const readSectionsOff = async (): Promise<SectionId[]> => cleanSectionsOff(await readValue(SECTIONS_OFF_SETTING));
export const saveSectionsOff = (off: SectionId[]) => writeValue(SECTIONS_OFF_SETTING, cleanSectionsOff(off));
// The same value as a scalar subquery, so lib/data/sections-db.ts reads it in its one combined statement (parse the
// result with cleanSectionsOff, as readSectionsOff does).
export const sectionsOffSql = (): SQL => sql`(select ${settings.value} from ${settings} where ${settings.key} = ${SECTIONS_OFF_SETTING})`;
