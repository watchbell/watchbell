// Which event rows should flash: those that were not on the page when it opened (`seen`) and whose flash has not
// finished yet (`flashed`, filled from onAnimationEnd). A row filtered out and back in therefore doesn't flash again.
export function freshIds(seen: ReadonlySet<string>, flashed: ReadonlySet<string>, rows: readonly { id: string }[]): Set<string> {
  return new Set(rows.filter((r) => !seen.has(r.id) && !flashed.has(r.id)).map((r) => r.id));
}
