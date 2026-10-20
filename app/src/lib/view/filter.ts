export type FilterRow = { key: string; state: string; text: string; group?: string; tags?: string[] };

// The mockup's table filter: any visible text in the row (case-insensitive) AND the state select AND the account select.
// `tag`: an optional toggle chip (e.g. Models "Working only"): only rows carrying that tag.
export function filterRows<T extends FilterRow>(rows: T[], f: { text: string; state: string; group?: string; tag?: string }): T[] {
  const q = f.text.trim().toLowerCase();
  return rows.filter((r) => (!f.state || r.state === f.state) && (!f.group || r.group === f.group) && (!f.tag || (r.tags ?? []).includes(f.tag)) && (!q || r.text.toLowerCase().includes(q)));
}
