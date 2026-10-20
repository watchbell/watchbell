// DNS → ?zone=: the id goes to the cached zone read only when it is one of the watched zones (review m3). Anything else
// (missing, malformed, unknown, an unwatched zone) becomes null, which reads the first zone under one shared key.
export function zoneParam(zone: string | undefined, options: { id: string }[]): string | null {
  return zone && options.some((o) => o.id === zone) ? zone : null;
}
