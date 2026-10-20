import { isUuid } from "@/lib/ids";
import type { LogFilter, LogStatus } from "@/private/ai/views-db";

// The Logs page's filters live in the URL (a plain GET form, no client state): ?key=&status=&client=&model=&page=.
// Anything that isn't recognised is dropped, never passed on.
export type SearchParams = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? "";
const STATUSES: LogStatus[] = ["ok", "limit", "error"];

export function parseLogParams(sp: SearchParams): { filter: LogFilter; page: number } {
  const filter: LogFilter = {};
  const key = one(sp.key);
  if (isUuid(key)) filter.keyId = key;
  const status = STATUSES.find((s) => s === one(sp.status));
  if (status) filter.status = status;
  const client = one(sp.client).trim().slice(0, 60);
  if (client) filter.client = client;
  const model = one(sp.model).trim().slice(0, 80);
  if (model) filter.model = model;
  const page = Math.floor(Number(one(sp.page)));
  return { filter, page: Number.isFinite(page) && page >= 1 ? Math.min(page, 2000) : 1 };
}

// The query string for a filter + page (for the pager's links and the CSV export).
export function logQuery(f: LogFilter, page = 1): string {
  const q = new URLSearchParams();
  if (f.keyId) q.set("key", f.keyId);
  if (f.status) q.set("status", f.status);
  if (f.client) q.set("client", f.client);
  if (f.model) q.set("model", f.model);
  if (page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `?${s}` : "";
}
