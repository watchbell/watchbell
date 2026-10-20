import "server-only";
import { asc, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, resources } from "@/db/schema";
import { type AliasBook, buildAliasBook } from "@/lib/view/display-name";

// Bounded (R8): far beyond what one owner syncs, and the earliest rows come first, so a letter never moves.
export const ALIAS_ROWS = 2000;
export const ALIAS_ACCOUNTS = 200;

// The stable letters behind db-a, app-a, site-a.example and account-1 (lib/view/display-name.ts): every database, app,
// zone and domain row ever synced, watched or not, gone or not, so unticking or losing one never shifts the others;
// and the accounts by when they were added (labels only, never a credential column). Two small indexed reads, sent
// together.
export async function readAliasBook(): Promise<AliasBook> {
  const [rows, accountRows] = await Promise.all([
    db().select({
      id: resources.id, kind: resources.kind, name: resources.name, firstSeenAt: resources.firstSeenAt, parentId: resources.parentId,
      team: sql<string | null>`${resources.meta}->>'teamSlug'`, // M5: a Vercel app's team slug, masked in screenshot mode
    }).from(resources)
      .where(inArray(resources.kind, ["app", "supabase_project", "neon_project", "firestore", "turso_database", "upstash_redis", "d1_database", "zone", "domain"]))
      .orderBy(asc(resources.firstSeenAt), asc(resources.id)).limit(ALIAS_ROWS),
    db().select({ id: accounts.id, label: accounts.label, createdAt: accounts.createdAt }).from(accounts)
      .orderBy(asc(accounts.createdAt), asc(accounts.id)).limit(ALIAS_ACCOUNTS),
  ]);
  return buildAliasBook(rows, accountRows);
}
