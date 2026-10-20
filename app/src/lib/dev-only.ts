// Stage 8 cleanup ("when local dev ends"): every localhost or test-only allowance in the code asks here, so none of
// them applies in a production build. `next dev` and vitest run with NODE_ENV "development" / "test"; `next build`,
// `next start` and Vercel run with "production". Pure; pass the env in tests.

import { DEV_ONLY_COPY } from "@/lib/copy/edition";

type Env = Record<string, string | undefined>;

export const isDevRuntime = (env: Env = process.env): boolean => env.NODE_ENV !== "production";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
export const isLocalHost = (host: string): boolean => LOCAL_HOST.test(host.replace(/:\d{1,5}$/, ""));

export function isLocalUrl(raw: string): boolean {
  try {
    return LOCAL_HOST.test(new URL(raw).hostname);
  } catch {
    return false;
  }
}

// Cloudflare's published Turnstile testing site keys (developers.cloudflare.com/turnstile/troubleshooting/testing):
// 1x… always passes, 2x… always blocks, 3x… forces an interactive challenge. With the matching test secret any
// token passes, so in production one of these means the bot check is off.
export const isTurnstileTestKey = (key: string): boolean => /^[123]x0{20}[A-Z]{2}$/.test(key.trim());

// What production must not carry. Empty in development and tests.
export function devOnlyProblems(env: Env): string[] {
  if (isDevRuntime(env)) return [];
  const out: string[] = [];
  if (env.NEXT_PUBLIC_TURNSTILE_SITE_KEY && isTurnstileTestKey(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY)) {
    out.push("NEXT_PUBLIC_TURNSTILE_SITE_KEY is a Cloudflare test key");
  }
  if (env.SITE_URL && isLocalUrl(env.SITE_URL)) out.push("SITE_URL points at localhost");
  for (const name of DEV_ONLY_COPY.env) if (env[name]) out.push(`${name} is set (ignored in production)`);
  return out;
}
