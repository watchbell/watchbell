import { parseEnvExample } from "@/lib/env-check/check";

// Watchbell 1.4 pre-deploy check: env names a pull request starts to need, so they can be set on Vercel before the
// merge. Names only, from .env.example and from process.env reads on the PR's added lines. Pure.

// Set by Node, CI or Vercel itself, never by the owner.
export const ENV_IGNORE = /^(?:NODE_ENV|CI|PORT|NEXT_RUNTIME|VERCEL(?:_[A-Z0-9_]*)?)$/;
const READS = [/process\.env\.([A-Z_][A-Z0-9_]{0,99})\b/g, /process\.env\[["']([A-Z_][A-Z0-9_]{0,99})["']\]/g];

export function addedEnvNames(baseExample: string | null, headExample: string | null, addedLines: string[]): { example: string[]; code: string[] } {
  const had = new Set(baseExample ? parseEnvExample(baseExample) : []);
  const listed = new Set(headExample ? parseEnvExample(headExample) : []);
  const example = [...listed].filter((k) => !had.has(k)).sort();
  const code = new Set<string>();
  for (const line of addedLines) {
    for (const re of READS) for (const m of line.matchAll(re)) if (!listed.has(m[1]) && !ENV_IGNORE.test(m[1])) code.add(m[1]);
  }
  return { example, code: [...code].sort() };
}
