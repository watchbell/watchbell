import { readEnvNamed } from "./brand-env";

export type Mode = "cloud" | "selfhost" | "demo";

// WATCHBELL_MODE (or the old WATCHPOST_MODE). Unset or empty means cloud, the original Vercel + Supabase deployment.
export function mode(source: Record<string, string | undefined> = process.env): Mode {
  const set = readEnvNamed(source, "MODE");
  const raw = (set?.value ?? "").trim().toLowerCase();
  if (raw === "") return "cloud";
  if (raw === "cloud" || raw === "selfhost" || raw === "demo") return raw;
  throw new Error(`${set?.name ?? "WATCHBELL_MODE"} must be cloud, selfhost or demo`);
}

export const isCloud = (): boolean => mode() === "cloud";
export const isDemo = (source: Record<string, string | undefined> = process.env): boolean => mode(source) === "demo";

// Selfhost and demo both run without Supabase Auth: their sign-in state lives in the process's own database (selfhost)
// or a stateless signed cookie (demo). Use this where the two behave the same and only cloud differs; use isDemo() or
// mode() === "selfhost" where they differ. Cloud is the only mode that talks to Supabase Auth.
export const usesLocalAuth = (source: Record<string, string | undefined> = process.env): boolean => mode(source) !== "cloud";

// True when DATABASE_URL points at a hosted Supabase database (*.supabase.co, *.supabase.com incl. the pooler). A
// selfhost run started from a folder whose .env.local holds the cloud DATABASE_URL would otherwise run its scheduler
// and Telegram poller against production.
export function hostedSupabaseDb(source: Record<string, string | undefined> = process.env): boolean {
  const raw = (source.DATABASE_URL ?? "").trim();
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ["supabase.co", "supabase.com"].some((d) => host === d || host.endsWith(`.${d}`));
}

// Fail-closed variant for the "don't touch a remote database by accident" guards: true for hosted Supabase, and also for
// any non-pglite DATABASE_URL we can't vouch for (doesn't parse, empty host, or several comma-separated hosts, which a
// URL parser could read as something harmless). A normal self-managed postgres://user:pw@db.local:5432/x is not a risk.
export function remoteDbRisk(source: Record<string, string | undefined> = process.env): boolean {
  const raw = (source.DATABASE_URL ?? "").trim();
  if (!raw || raw.toLowerCase().startsWith("pglite:")) return false;
  if (hostedSupabaseDb(source)) return true;
  if (raw.includes(",")) return true;
  try {
    return new URL(raw).hostname === "";
  } catch {
    return true;
  }
}
