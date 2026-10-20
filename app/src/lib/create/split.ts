import type { CreateRequestView } from "@/lib/create/types";

// A create page lists what still needs a decision ("Waiting for approval") apart from what already ended
// ("Recent requests"). Finished ones stay for a day, newest first, a few at most; then they leave the page.
export const RECENT_HOURS = 24;
export const RECENT_MAX = 5;

const PENDING: ReadonlySet<CreateRequestView["status"]> = new Set(["requested", "approved", "running"]);
export const isPending = (i: Pick<CreateRequestView, "status">) => PENDING.has(i.status);

export function splitRequests<T extends Pick<CreateRequestView, "status">>(items: T[]): { pending: T[]; finished: T[] } {
  return { pending: items.filter(isPending), finished: items.filter((i) => !isPending(i)) };
}

// Drops finished requests older than RECENT_HOURS (by when they were asked: a request lives minutes to hours) and keeps
// the newest RECENT_MAX of the rest. Pending ones always stay.
export function trimFinished<T extends Pick<CreateRequestView, "status" | "createdAt">>(items: T[], now: Date, hours = RECENT_HOURS, max = RECENT_MAX): T[] {
  const cutoff = now.getTime() - hours * 3_600_000;
  const finished = items
    .filter((i) => !isPending(i) && new Date(i.createdAt).getTime() >= cutoff)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, max);
  const keep = new Set<T>(finished);
  return items.filter((i) => isPending(i) || keep.has(i));
}
