import type { EnvName } from "@/lib/providers/vercel-env";

// Watchbell 1.3 Env check: an app's env variable names on Vercel against its repository's .env.example. Names only;
// pure, so the card, the action and the tests share it.

export type EnvFindingKind = "missing-production" | "preview-only" | "public-secret" | "not-in-example";
export type EnvFinding = { kind: EnvFindingKind; key: string };
// The result the Environment card shows. example: whether the repository's .env.example was compared ("no-repo": no
// repository linked; "unreadable": GitHub couldn't give it).
export type EnvCheck = {
  findings: EnvFinding[]; names: number; example: "found" | "none" | "no-repo" | "unreadable"; examplePath: string | null; checkedAt: string;
};

const ORDER: readonly EnvFindingKind[] = ["missing-production", "preview-only", "public-secret", "not-in-example"];
const ASSIGN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
// Sent to the browser on purpose but named like a secret. The Supabase anon / publishable keys are public by design.
const SECRET_WORD = /(SECRET|PRIVATE|TOKEN|PASSWORD|SERVICE_ROLE)/;
// Vercel's own system variables are set by Vercel, not by the app.
const isSystem = (key: string) => key.startsWith("VERCEL_");

export function parseEnvExample(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = ASSIGN.exec(line);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

// exampleKeys null: there is no .env.example to compare with, so only Vercel's own settings are judged.
export function envFindings(names: EnvName[], exampleKeys: string[] | null): EnvFinding[] {
  const out = new Map<string, EnvFinding>();
  const add = (kind: EnvFindingKind, key: string) => out.set(`${kind}:${key}`, { kind, key });
  const own = names.filter((n) => !isSystem(n.key));
  // Production = set for the production target on every branch (a branch-scoped entry is a preview override).
  const production = new Set(own.filter((n) => n.targets.includes("production") && n.branch === null).map((n) => n.key));
  const anywhere = new Set(own.map((n) => n.key));
  for (const key of anywhere) {
    const rest = key.startsWith("NEXT_PUBLIC_") ? key.slice("NEXT_PUBLIC_".length) : null;
    if (!production.has(key) && own.some((n) => n.key === key && (n.targets.includes("preview") || n.targets.includes("development")))) add("preview-only", key);
    if (rest !== null && SECRET_WORD.test(rest)) add("public-secret", key);
  }
  if (exampleKeys) {
    const listed = exampleKeys.filter((k) => !isSystem(k));
    for (const key of listed) if (!production.has(key)) add("missing-production", key);
    for (const key of production) if (!listed.includes(key)) add("not-in-example", key);
  }
  return [...out.values()].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.key.localeCompare(b.key));
}

// Demo mode: made-up findings for a made-up app; no provider is called.
export const DEMO_ENV_CHECK: EnvCheck = {
  findings: [
    { kind: "missing-production", key: "RESEND_API_KEY" },
    { kind: "preview-only", key: "FEATURE_NEW_CHECKOUT" },
    { kind: "not-in-example", key: "OLD_ANALYTICS_ID" },
  ],
  names: 9, example: "found", examplePath: ".env.example", checkedAt: "2026-10-29T03:00:00.000Z",
};

