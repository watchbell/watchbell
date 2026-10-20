// Raw `db().execute(sql...)` results differ by driver: postgres.js returns the row list itself (an array),
// PGlite (self-host) returns `{ rows, fields }`. Call sites that read the result go through this.
export function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const rows = (res as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}
