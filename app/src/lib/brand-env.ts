// The product was called Watchpost before it became Watchbell (20 Oct 2026). Every setting is read as WATCHBELL_<KEY>
// first and falls back to the old WATCHPOST_<KEY>, so an existing env file, an installer's service file and the owner's
// Vercel env keep working unchanged. New docs and installers write only WATCHBELL_*. Pure and client-safe.
export type EnvSource = Record<string, string | undefined>;

export const ENV_PREFIX = "WATCHBELL_";
export const LEGACY_ENV_PREFIX = "WATCHPOST_";

export const envName = (key: string): string => `${ENV_PREFIX}${key}`;

const isSet = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";

// The value and the variable that supplied it, so a message can name the one the operator actually set. An empty or
// blank WATCHBELL_<KEY> counts as unset, so it never hides a WATCHPOST_<KEY> that is set.
export function readEnvNamed(source: EnvSource, key: string): { name: string; value: string } | undefined {
  const name = envName(key);
  const legacy = `${LEGACY_ENV_PREFIX}${key}`;
  const now = source[name];
  if (isSet(now)) return { name, value: now };
  const old = source[legacy];
  if (isSet(old)) return { name: legacy, value: old };
  if (now !== undefined) return { name, value: now };
  return old !== undefined ? { name: legacy, value: old } : undefined;
}

export function readEnv(source: EnvSource, key: string): string | undefined {
  return readEnvNamed(source, key)?.value;
}
