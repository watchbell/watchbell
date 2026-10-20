import "server-only";
import { revalidateTag, updateTag } from "next/cache";
import { isCloud } from "@/lib/mode";

// Perf P3. Next 16 allows revalidateTag in route handlers and server actions, updateTag in server actions only.
// - expireTags: the collector (/api/collect, /api/watchdog, and Refresh now's server action) and /api/daily. The
//   profile `{ expire: 0 }` expires the entry at once: the next read waits for fresh data instead of being handed the
//   old value while it revalidates ("max" would), so a page is never staler than the database.
// - updateTags: a person's own change in a server action (Sync, link edit, Re-check, accounts, Remove from console);
//   the page they return to reads the new rows.
// The write already happened when these run, so a tag that can't be expired (no request scope, e.g. in a script) is
// logged and skipped, never turned into a failed action. The cache then catches up within CACHE_SECONDS.
// Outside cloud nothing is cached (lib/data/cached.ts reads straight through), so both are no-ops: the selfhost
// scheduler runs outside any request, where revalidateTag would throw and warn every minute.

function each(tags: readonly string[], fn: (tag: string) => void) {
  if (!isCloud()) return;
  for (const tag of new Set(tags)) {
    try {
      fn(tag);
    } catch (e) {
      if (process.env.NODE_ENV !== "test") console.warn(`cache: couldn't expire ${tag}: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`);
    }
  }
}

export function expireTags(tags: readonly string[]): void {
  each(tags, (tag) => revalidateTag(tag, { expire: 0 }));
}

export function updateTags(tags: readonly string[]): void {
  each(tags, (tag) => updateTag(tag));
}
