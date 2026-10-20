import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Scratch space for tests: WATCHBELL_TEST_TMP (or the old WATCHPOST_TEST_TMP), else <repo>/.cache/tmp (resolved from
// this file). There is no fallback to the OS temp folder on purpose: it may sit on the system drive, so a failure here
// must be loud.
const fallback = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.cache/tmp");

export function pickBase(env: Record<string, string | undefined> = process.env): string {
  const set = env.WATCHBELL_TEST_TMP?.trim() ? env.WATCHBELL_TEST_TMP : env.WATCHPOST_TEST_TMP?.trim() ? env.WATCHPOST_TEST_TMP : "";
  if (set) return set;
  try {
    mkdirSync(fallback, { recursive: true });
  } catch (err) {
    throw new Error(`Cannot create the test scratch folder ${fallback} (${(err as Error).message}). Set WATCHBELL_TEST_TMP to a writable folder.`);
  }
  return fallback;
}

export const tmpBase: string = pickBase();
