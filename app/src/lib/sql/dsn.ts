// Stage 9 slice 2: the owner's "SQL access" connection string for one Supabase or Neon database. It is parsed here,
// sealed at rest and turned into explicit driver options when used (never handed to the driver as a URL, so a stray
// query parameter can't become a startup setting). No error text in this file ever repeats the string or a part of it.

export type SqlProvider = "supabase" | "neon";

export type Dsn = { host: string; port: number; user: string; password: string; database: string };

export type ParsedDsn =
  | { ok: true; dsn: Dsn; role: string; endpointId: string | null }
  | { ok: false; error: string };

const MAX_DSN = 1000;
export const SUPABASE_POOLER = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/;
const NEON_HOST = /^(ep-[a-z0-9-]+?)(-pooler)?\.[a-z0-9.-]+\.neon\.tech$/;
const ROLE = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;

export const SUPABASE_REF = /^[a-z0-9]{20}$/;

function decode(v: string): string | null {
  try {
    return decodeURIComponent(v);
  } catch {
    return null;
  }
}

// `expectedRef` is the watched Supabase project's ref: the pooler user is `role.ref`, so a string copied from another
// project is refused before it is ever tried.
export function parseDsn(raw: unknown, provider: SqlProvider, expectedRef?: string): ParsedDsn {
  if (typeof raw !== "string") return { ok: false, error: "Paste a connection string." };
  const text = raw.trim();
  if (!text) return { ok: false, error: "Paste a connection string." };
  if (text.length > MAX_DSN || /\s/.test(text)) return { ok: false, error: "That doesn't look like a connection string." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "That doesn't look like a connection string. It starts with postgresql://." };
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") return { ok: false, error: "The string must start with postgresql://." };
  const host = url.hostname.toLowerCase();
  const user = decode(url.username);
  const password = decode(url.password);
  const database = decode(url.pathname.replace(/^\//, "")) || "postgres";
  const port = url.port ? Number(url.port) : 5432;
  if (!user || !password) return { ok: false, error: "The string needs a user and a password (user:password@host)." };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "The port in that string isn't valid." };
  if (database.length > 63 || /[/\\]/.test(database)) return { ok: false, error: "The database name in that string isn't valid." };
  if (provider === "supabase") {
    if (!SUPABASE_POOLER.test(host)) {
      return { ok: false, error: "Use the Supabase pooler string (host …pooler.supabase.com). The direct db.…supabase.co host is IPv6-only and can't be reached from Vercel." };
    }
    const dot = user.lastIndexOf(".");
    const role = dot > 0 ? user.slice(0, dot) : "";
    const ref = dot > 0 ? user.slice(dot + 1) : "";
    if (!ROLE.test(role) || !SUPABASE_REF.test(ref)) return { ok: false, error: "The pooler user must look like watchpost_ro.<project-ref>." };
    if (expectedRef && ref !== expectedRef) return { ok: false, error: "That string belongs to a different Supabase project." };
    if (role === "postgres" || role === "supabase_admin" || role === "service_role") return { ok: false, error: `Don't use the ${role} role here. Create the read-only role shown above.` };
    return { ok: true, dsn: { host, port, user, password, database }, role, endpointId: null };
  }
  const m = NEON_HOST.exec(host);
  if (!m) return { ok: false, error: "Use the Neon connection string (host ep-….neon.tech)." };
  if (!ROLE.test(user)) return { ok: false, error: "The user in that string isn't a valid role name." };
  if (/_owner$/.test(user)) return { ok: false, error: `Don't use the ${user} role here: it owns the database. Create the read-only role shown above.` };
  return { ok: true, dsn: { host, port, user, password, database }, role: user, endpointId: m[1] };
}
