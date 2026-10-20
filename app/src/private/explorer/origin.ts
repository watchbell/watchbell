// The origin the explorer and openapi.json describe: the host this request came in on (so a local test shows
// localhost, production shows its own domain), never hard-coded. Pure; falls back when the host header is unusable.

type HeaderBag = { get(name: string): string | null };

// Stage 8 cleanup: plain http for a localhost host only in development; production always says https.
export function originFrom(headers: HeaderBag, fallback: string, dev: boolean = process.env.NODE_ENV !== "production"): string {
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0].trim();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return fallback.replace(/\/+$/, "");
  const proto = (headers.get("x-forwarded-proto") ?? "").split(",")[0].trim().toLowerCase();
  const scheme = proto === "http" || proto === "https" ? proto : dev && /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https";
  return `${scheme}://${host}`;
}
