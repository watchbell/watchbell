// App ↔ database links (spec §8.5). The console never reads an app's environment variables, so it can only suggest a
// database by name; the owner confirms or changes it on the app page.

// Stage 8 adds Turso, Upstash Redis and Cloudflare D1.
export const DB_KINDS = ["supabase_project", "neon_project", "firestore", "turso_database", "upstash_redis", "d1_database"] as const;
export type DbKind = (typeof DB_KINDS)[number];
export type DbProvider = "supabase" | "neon" | "firebase" | "turso" | "upstash" | "d1";

const PROVIDER: Record<DbKind, DbProvider> = {
  supabase_project: "supabase", neon_project: "neon", firestore: "firebase", turso_database: "turso", upstash_redis: "upstash", d1_database: "d1",
};
export const dbProvider = (kind: DbKind): DbProvider => PROVIDER[kind];
export const dbHref = (kind: DbKind) => (`/${PROVIDER[kind]}` as `/${DbProvider}`);
export const DB_PROVIDER_NAME: Record<DbProvider, string> = { supabase: "Supabase", neon: "Neon", firebase: "Firebase", turso: "Turso", upstash: "Upstash", d1: "Cloudflare D1" };

// "web-Quillpad" → "quillpad", "portfolio-site" → "portfolio", "acme-shop" → "acmeshop".
export function baseName(name: string): string {
  return name.toLowerCase()
    .replace(/^webs?[-_]/, "")
    .replace(/[-_](vercel|web|app|site|fe|frontend)$/, "")
    .replace(/[^a-z0-9]/g, "");
}

// region and ident tell same-named databases apart in the Edit link dialog (lib/databases/option.ts).
export type DbOption = { id: string; name: string; kind: DbKind; account: string; region: string | null; ident: string | null };

// One clear match or nothing: an exact base name first; else a unique containing name of 4+ characters.
export function suggestDatabase(appName: string, options: DbOption[]): string | null {
  const a = baseName(appName);
  if (!a) return null;
  const exact = options.filter((o) => baseName(o.name) === a);
  if (exact.length) return exact.length === 1 ? exact[0].id : null;
  const partial = options.filter((o) => {
    const b = baseName(o.name);
    return b.length >= 4 && a.length >= 4 && (a.includes(b) || b.includes(a));
  });
  return partial.length === 1 ? partial[0].id : null;
}

// The dialog's order: the suggested database first, then the current one, then the ones that match the app's name (an
// exact base name before a containing one, so two "ticketer" and "dbTicketer" come up together even when no single one
// can be suggested), then the rest. Stable within each group, so the list stays by name.
export function orderOptions(appName: string, options: DbOption[], suggested: string | null, current: string | null): DbOption[] {
  const a = baseName(appName);
  const rank = (o: DbOption) => {
    if (o.id === suggested) return 0;
    if (o.id === current) return 1;
    const b = baseName(o.name);
    if (a && b === a) return 2;
    if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return 3;
    return 4;
  };
  return options.map((o, i) => ({ o, i, r: rank(o) })).sort((x, y) => x.r - y.r || x.i - y.i).map((x) => x.o);
}
